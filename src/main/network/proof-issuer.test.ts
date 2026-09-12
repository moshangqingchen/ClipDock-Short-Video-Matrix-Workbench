import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressGate, type GateClock } from "./egress-gate";
import type { AccountProofScope, ProofTarget } from "./direct-proof";
import { createLiveRuleEvidence } from "./live-rule-evidence";
import {
  ProofIssuer,
  type ProofCollectionRequest,
  type ProofCollectionResult,
  type ProofEvidenceSource,
  type ProofIssuerOptions,
} from "./proof-issuer";

const target: ProofTarget = {
  protocol: "https:",
  host: "member.bilibili.com",
  port: 443,
  addressFamily: "ipv4",
};
const scope: AccountProofScope = {
  accountId: "one",
  platformId: "bilibili",
  contextId: "controlled-one",
  catalogVersion: "reviewed-v1",
  catalogReviewed: true,
  targets: [target],
};
const network = { controllerReadable: true, mode: "rule", tun: true, rulesVersion: "live-rules" };
const start = Date.parse("2026-09-08T00:00:00Z");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function evidence(request: ProofCollectionRequest): ProofCollectionResult {
  const at = request.startedAtMono;
  return {
    kind: "evidence",
    requestId: request.requestId,
    batch: {
      sampleId: request.requestId,
      generation: request.generation,
      rulesVersion: request.rulesVersion,
      contextId: request.scope.contextId,
      catalogVersion: request.scope.catalogVersion,
      observedAtMono: at,
      targets: request.scope.targets.map((current) => ({
        target: { ...current },
        route: {
          source: "correlated-connection",
          contextId: request.scope.contextId,
          rulesVersion: request.rulesVersion,
          ruleDecision: "direct",
          connectionId: `synthetic-${request.requestId}`,
          correlationVerified: true,
          chains: ["DIRECT"],
          observedAtMono: at,
        },
        egress: {
          target: { ...current },
          contextId: request.scope.contextId,
          ip: current.addressFamily === "ipv4" ? "192.0.2.1" : "2001:db8::1",
          countryCode: "CN",
          asn: 64512,
          source: "synthetic-controlled-source",
          applicabilityVerified: true,
          observedAtMono: at,
        },
        tls: { verified: true, observedAtMono: at },
        dns: { status: "resolved", addressFamily: current.addressFamily, observedAtMono: at },
      })),
    },
  };
}

describe("ProofIssuer transient production coordination", () => {
  const disposables: { issuer: ProofIssuer; gate: EgressGate }[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });
  afterEach(() => {
    for (const item of disposables.splice(0)) {
      item.issuer.dispose();
      item.gate.dispose();
    }
    vi.useRealTimers();
  });
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  function fixture(options: Partial<ProofIssuerOptions> = {}) {
    const clock: GateClock = {
      monotonicMs: () => Date.now() - start,
      wallTimeMs: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
    // Controller refresh is an external observer responsibility; keep this fixture readable.
    const gate = options.gate ?? new EgressGate({ clock, timing: { controllerTtlMs: 120_000 } });
    gate.setNetworkState(network);
    const collect = vi
      .fn<ProofEvidenceSource["collect"]>()
      .mockImplementation(async (request) => evidence(request));
    const issuer = new ProofIssuer({ gate, clock, source: { collect }, ...options });
    disposables.push({ issuer, gate });
    const register = (current = scope) =>
      issuer.registerScope(current, { generation: gate.generation, rulesVersion: network.rulesVersion });
    register();
    const check = () => gate.checkAction(scope.accountId, scope.contextId);
    const activate = async () => {
      issuer.start();
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(check().allowed).toBe(true);
    };
    return { gate, issuer, collect, register, check, activate, clock };
  }

  it("does not sample before start, and has no successful default source", async () => {
    const f = fixture();
    await flush();
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.check().allowed).toBe(false);
    expect((await f.issuer.request("one")).status).toBe("cancelled");
    const absent = fixture({ source: undefined });
    absent.issuer.start();
    expect(await absent.issuer.request("one")).toMatchObject({
      status: "rejected",
      reason: "EGRESS_UNVERIFIED",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(absent.collect).not.toHaveBeenCalled();
    expect(absent.check().allowed).toBe(false);
  });

  it("coalesces same-scope requests and keeps 15-second warm-up separate from 10-second renewal", async () => {
    const f = fixture();
    f.issuer.start();
    const first = f.issuer.request("one");
    expect(f.issuer.request("one")).toBe(first);
    expect((await first).status).toBe("waiting");
    await flush();
    expect(f.collect).toHaveBeenCalledOnce();
    const second = f.issuer.request("one");
    expect(f.issuer.request("one")).toBe(second);
    f.register(); // Registration of the same version cannot shorten the interval.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(f.collect).toHaveBeenCalledOnce();
    expect(f.check().allowed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).status).toBe("accepted");
    const proofId = f.check().proofId;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(f.collect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.collect).toHaveBeenCalledTimes(3);
    expect(f.check().allowed).toBe(true);
    expect(f.check().proofId).not.toBe(proofId);
    expect(f.collect.mock.calls.map(([request]) => request.startedAtMono)).toEqual([0, 15_000, 25_000]);
  });

  it("never supplies a business Session or mutable scope to a producer", async () => {
    const f = fixture();
    f.issuer.start();
    await flush();
    const request = f.collect.mock.calls[0][0];
    expect(Object.keys(request).sort()).toEqual([
      "generation",
      "requestId",
      "rulesVersion",
      "scope",
      "signal",
      "startedAtMono",
    ]);
    expect(Object.isFrozen(request.scope)).toBe(true);
    expect(Object.isFrozen(request.scope.targets)).toBe(true);
    expect(Object.isFrozen(request.scope.targets[0])).toBe(true);
    expect(JSON.stringify(f.issuer.snapshot())).not.toContain("192.0.2.1");
  });

  it("renews before the controller-capped permit deadline instead of cancelling on the 10-second boundary", async () => {
    const clock: GateClock = {
      monotonicMs: () => Date.now() - start,
      wallTimeMs: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
    const gate = new EgressGate({ clock }); // Production 15-second controller freshness.
    const f = fixture({ gate });
    const observer = setInterval(() => gate.setNetworkState(network), 10_000);
    try {
      await f.activate(); // At 15s, controller evidence from 10s caps the permit at 25s.
      const revoke = vi.fn();
      gate.on("revoked", revoke);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(f.collect.mock.calls.map(([request]) => request.startedAtMono)).toEqual([
        0, 15_000, 22_000, 32_000, 42_000,
      ]);
      expect(f.check().allowed).toBe(true);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      clearInterval(observer);
    }
  });

  it("a bad scheduling hint cannot extend Gate's monotonic permission", async () => {
    const pending = deferred<ProofCollectionResult>();
    let renewal!: ProofCollectionRequest;
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
      if (request.startedAtMono < 25_000) return evidence(request);
      renewal = request;
      return pending.promise;
    });
    const f = fixture({ source: { collect }, readPermitDeadline: () => 1_000_000_000 });
    await f.activate();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.check().allowed).toBe(false);
    expect(renewal.signal.aborted).toBe(true);
    pending.resolve(evidence(renewal));
    await flush();
    expect(f.check().allowed).toBe(false);
  });

  it("does not busy-poll a nearly expired permit when controller refresh stops", async () => {
    const clock: GateClock = {
      monotonicMs: () => Date.now() - start,
      wallTimeMs: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
    const gate = new EgressGate({ clock });
    const f = fixture({ gate });
    setTimeout(() => gate.setNetworkState(network), 10_000);
    await f.activate(); // This single controller refresh caps all later permits at 25s.
    const revoke = vi.fn();
    gate.on("revoked", revoke);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.collect.mock.calls.map(([request]) => request.startedAtMono)).toEqual([0, 15_000, 22_000]);
    expect(f.check().allowed).toBe(false);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("does not sample an unreviewed catalog", async () => {
    const f = fixture();
    f.register({ ...scope, catalogReviewed: false });
    f.issuer.start();
    expect((await f.issuer.request("one")).reason).toBe("CATALOG_UNVERIFIED");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.collect).not.toHaveBeenCalled();
  });

  it("forgets an already revoked scope without starting another Session cleanup", async () => {
    const f = fixture();
    await f.activate();
    f.gate.revoke("one", "NETWORK_CHANGED");
    const revoke = vi.fn();
    f.gate.on("revoked", revoke);
    f.issuer.forgetRevokedScope("one");
    expect(revoke).not.toHaveBeenCalled();
    expect(f.issuer.snapshot().accounts).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.collect).toHaveBeenCalledTimes(2);
  });

  it("does not trust a caller's already-revoked assumption while Gate is allowed", async () => {
    const f = fixture();
    await f.activate();
    const lease = f.gate.acquireLease("one", scope.contextId).lease!;
    f.issuer.forgetRevokedScope("one");
    expect(lease.signal.aborted).toBe(true);
    expect(f.check().allowed).toBe(false);
    expect(f.issuer.snapshot().accounts).toEqual([]);
  });

  it.each(["sampleId", "route-cache", "tls-cache", "dns-cache", "future", "context", "version"])(
    "rejects %s instead of relabelling it as a new sampling round",
    async (failure) => {
      let original: ProofCollectionResult;
      const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
        const value = evidence(request);
        if (value.kind !== "evidence") throw new Error();
        if (!original) {
          original = value;
          return value;
        }
        if (original.kind !== "evidence") throw new Error();
        switch (failure) {
          case "sampleId":
            value.batch.sampleId = original.batch.sampleId;
            break;
          case "route-cache":
            value.batch.targets[0].route = original.batch.targets[0].route;
            break;
          case "tls-cache":
            value.batch.targets[0].tls = original.batch.targets[0].tls;
            break;
          case "dns-cache":
            value.batch.targets[0].dns = original.batch.targets[0].dns;
            break;
          case "future":
            value.batch.observedAtMono++;
            break;
          case "context":
            value.batch.contextId = "other-session";
            break;
          case "version":
            value.batch.rulesVersion = "old-version";
            break;
        }
        return value;
      });
      const f = fixture({ source: { collect } });
      f.issuer.start();
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.check().allowed).toBe(false);
      expect(collect).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps exit evidence's independent TTL without requiring another public echo every round", async () => {
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
      const value = evidence(request);
      if (value.kind === "evidence") value.batch.targets[0].egress.observedAtMono = 0;
      return value;
    });
    const f = fixture({ source: { collect } });
    await f.activate();
    expect(f.check().allowed).toBe(true);
  });

  it("passes constructed live-rule objects to Gate without losing their main-process provenance", async () => {
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
      const value = evidence(request);
      if (value.kind !== "evidence") throw new Error();
      const at = request.startedAtMono,
        currentTarget = request.scope.targets[0];
      const route = createLiveRuleEvidence(
        {
          target: currentTarget,
          contextId: request.scope.contextId,
          snapshot: {
            mode: "rule",
            generation: request.generation,
            rulesVersion: request.rulesVersion,
            kernelEpoch: "test-kernel",
            observedAtMono: at,
            rules: [{ type: "DOMAIN", payload: currentTarget.host, proxy: "RealDirectAlias" }],
          },
          outbound: {
            name: "RealDirectAlias",
            id: "test-outbound",
            kind: "direct",
            dialer: "none",
            policyVersion: "policy",
            kernelEpoch: "test-kernel",
            generation: request.generation,
            rulesVersion: request.rulesVersion,
            observedAtMono: at,
          },
          path: {
            source: "validated-path-profile",
            evidenceId: "test-path",
            target: currentTarget,
            contextId: request.scope.contextId,
            kernelEpoch: "test-kernel",
            generation: request.generation,
            rulesVersion: request.rulesVersion,
            outboundId: "test-outbound",
            outboundPolicyVersion: "policy",
            effectivePathPolicyVersion: "test-effective-path",
            physicalRouteClass: "test-interface-route",
            transportCompatibilityEvidenceId: "test-conformance",
            dnsPolicyEvidenceId: "test-dns",
            network: "tcp",
            possibleAddressFamilies: ["ipv4"],
            familyConstraintEvidenceId: "test-constraint",
            observedAtMono: at,
            expiresAtMono: at + 15_000,
          },
        },
        at,
      );
      if (!route.valid) throw new Error(route.reason);
      value.batch.targets[0].route = route.evidence;
      return value;
    });
    const f = fixture({ source: { collect } });
    await f.activate();
  });

  it("withdraws authority before cancelling a running renewal and discards its late success", async () => {
    const pending = deferred<ProofCollectionResult>();
    let pendingRequest!: ProofCollectionRequest;
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
      if (request.startedAtMono < 25_000) return evidence(request);
      pendingRequest = request;
      return pending.promise;
    });
    const f = fixture({ source: { collect } });
    await f.activate();
    const lease = f.gate.acquireLease("one", scope.contextId).lease!;
    await vi.advanceTimersByTimeAsync(10_000);
    const joined = f.issuer.request("one");
    const order: string[] = [];
    pendingRequest.signal.addEventListener("abort", () => {
      expect(f.check().allowed).toBe(false);
      expect(lease.signal.aborted).toBe(true);
      order.push("source-aborted");
    });
    f.issuer.cancel("one");
    expect(order).toEqual(["source-aborted"]);
    expect((await joined).status).toBe("cancelled");
    pending.resolve(evidence(pendingRequest));
    await flush();
    expect(f.check().allowed).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it("closes a failed source before retrying with fresh evidence", async () => {
    let failed = false;
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
      if (request.startedAtMono >= 25_000) {
        failed = true;
        throw new Error("private diagnostic detail");
      }
      return evidence(request);
    });
    const f = fixture({ source: { collect } });
    await f.activate();
    const lease = f.gate.acquireLease("one", scope.contextId).lease!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failed).toBe(true);
    expect(f.check().allowed).toBe(false);
    expect(lease.signal.aborted).toBe(true);
    expect(JSON.stringify(f.issuer.snapshot())).not.toContain("private diagnostic");
  });

  it("times out without freeing an uncooperative source's actual concurrency slot", async () => {
    const pending = deferred<ProofCollectionResult>();
    const requests: ProofCollectionRequest[] = [];
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
      requests.push(request);
      return pending.promise;
    });
    const f = fixture({ source: { collect }, maxConcurrent: 1, sourceTimeoutMs: 1000 });
    f.register({ ...scope, accountId: "two", contextId: "controlled-two" });
    f.issuer.start();
    const joined = f.issuer.request("one");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await joined).reason).toBe("PROOF_EXPIRED");
    expect(requests[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(collect).toHaveBeenCalledOnce();
    expect(f.issuer.snapshot().activeSources).toBe(1);
    f.issuer.stop();
    pending.resolve(evidence(requests[0]));
    await flush();
    expect(f.check().allowed).toBe(false);
    expect(f.issuer.snapshot().activeSources).toBe(0);
  });

  it("a Gate expiry aborts the in-flight renewal and its late result cannot start recovery", async () => {
    const pending = deferred<ProofCollectionResult>();
    let request!: ProofCollectionRequest;
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (value) => {
      if (value.startedAtMono < 25_000) return evidence(value);
      request = value;
      return pending.promise;
    });
    const f = fixture({ source: { collect } });
    await f.activate();
    await vi.advanceTimersByTimeAsync(10_000);
    const joined = f.issuer.request("one");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request.signal.aborted).toBe(true);
    expect((await joined).reason).toBe("PROOF_EXPIRED");
    pending.resolve(evidence(request));
    await flush();
    expect(f.check().allowed).toBe(false);
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it("a shared controller failure revokes every account before any source abort callback", async () => {
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
      if (request.startedAtMono >= 25_000 && request.scope.accountId === "one")
        return { kind: "unavailable", reason: "CONTROLLER_UNAVAILABLE" };
      return evidence(request);
    });
    const f = fixture({ source: { collect } });
    f.register({ ...scope, accountId: "two", contextId: "controlled-two" });
    await f.activate();
    expect(f.gate.checkAction("two", "controlled-two").allowed).toBe(true);
    const oldGeneration = f.gate.generation;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.gate.generation).toBeGreaterThan(oldGeneration);
    expect(f.check().allowed).toBe(false);
    expect(f.gate.checkAction("two", "controlled-two").allowed).toBe(false);
    expect(f.issuer.snapshot().accounts.every((entry) => !entry.bound)).toBe(true);
    const before = collect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(collect).toHaveBeenCalledTimes(before);
  });

  it("limits cross-account concurrency while each account has only one pending source", async () => {
    const pending = new Map<
      string,
      { request: ProofCollectionRequest; deferred: ReturnType<typeof deferred<ProofCollectionResult>> }
    >();
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
      const next = deferred<ProofCollectionResult>();
      pending.set(request.scope.accountId, { request, deferred: next });
      return next.promise;
    });
    const f = fixture({ source: { collect }, maxConcurrent: 2 });
    for (const id of ["two", "three"]) f.register({ ...scope, accountId: id, contextId: `controlled-${id}` });
    f.issuer.start();
    expect(collect).toHaveBeenCalledTimes(2);
    const first = pending.get("one")!;
    first.deferred.resolve(evidence(first.request));
    await flush();
    expect(collect).toHaveBeenCalledTimes(3);
    expect(f.issuer.snapshot().activeSources).toBe(2);
    f.issuer.stop();
    for (const value of pending.values()) value.deferred.resolve(evidence(value.request));
    await flush();
  });

  it("scope replacement cancels old callbacks and does not overlap a still-running account source", async () => {
    const pending = deferred<ProofCollectionResult>();
    let old!: ProofCollectionRequest;
    const collect = vi.fn<ProofEvidenceSource["collect"]>().mockImplementation(async (request) => {
      if (!old) {
        old = request;
        return pending.promise;
      }
      return evidence(request);
    });
    const f = fixture({ source: { collect } });
    f.issuer.start();
    f.register({
      ...scope,
      contextId: "replacement-context",
      targets: [{ ...target, host: "passport.bilibili.com" }],
    });
    expect(old.signal.aborted).toBe(true);
    expect(collect).toHaveBeenCalledOnce();
    pending.resolve(evidence(old));
    await flush();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(f.gate.checkAction("one", "replacement-context").allowed).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.gate.checkAction("one", "replacement-context").allowed).toBe(true);
    expect(f.check().allowed).toBe(false);
  });

  it("global Gate revocation clears version bindings and cannot auto-revive from an old callback", async () => {
    const f = fixture();
    await f.activate();
    const before = f.collect.mock.calls.length;
    f.gate.invalidate("NETWORK_CHANGED");
    expect(f.check().allowed).toBe(false);
    expect(f.issuer.snapshot().accounts[0].bound).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.collect).toHaveBeenCalledTimes(before);
    f.gate.setNetworkState(network);
    expect((await f.issuer.request("one")).reason).toBe("NETWORK_CHANGED");
    f.register();
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.check().allowed).toBe(true);
  });

  it("source replacement withdraws permits and requires explicit fresh binding", async () => {
    const f = fixture();
    await f.activate();
    f.issuer.setSource(undefined);
    expect(f.check().allowed).toBe(false);
    const replacement = vi
      .fn<ProofEvidenceSource["collect"]>()
      .mockImplementation(async (request) => evidence(request));
    f.issuer.setSource({ collect: replacement });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(replacement).not.toHaveBeenCalled();
    f.gate.setNetworkState(network);
    f.register();
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.check().allowed).toBe(true);
  });

  it("stops/removes/disposes without reissuing or removing the Session owner's Gate record", async () => {
    const f = fixture();
    await f.activate();
    f.issuer.stop();
    expect(f.check().allowed).toBe(false);
    const before = f.collect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.collect).toHaveBeenCalledTimes(before);
    f.issuer.start();
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.check().allowed).toBe(true);
    f.issuer.removeScope("one");
    expect(f.check().allowed).toBe(false);
    expect(f.gate.snapshot()).toHaveLength(1);
    expect(f.issuer.snapshot().accounts).toEqual([]);
    f.issuer.dispose();
    expect(() => f.issuer.start()).toThrow("disposed");
  });

  it("observation can collect truthful evidence but never grants cancellation/lease authority", async () => {
    const clock: GateClock = {
      monotonicMs: () => Date.now() - start,
      wallTimeMs: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
    const gate = new EgressGate({ enforcement: "observe", clock, timing: { controllerTtlMs: 120_000 } });
    const f = fixture({ gate });
    await f.activate();
    expect(f.check()).toMatchObject({ allowed: true, enforce: false, cancel: false });
    expect(gate.acquireLease("one", scope.contextId).lease).toBeNull();
    f.issuer.stop();
    expect(f.check().cancel).toBe(false);
  });
});
