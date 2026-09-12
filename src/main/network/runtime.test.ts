import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkingNetworkSnapshot, type ExclusiveAccessSnapshot, type NetworkSnapshot } from "@shared/network";
import { CN_PLATFORM_IDS } from "@shared/platforms";
import { EgressGate, type GateClock } from "./egress-gate";
import type { AccountProofScope, DirectEvidenceBatch, ProofTarget } from "./direct-proof";
import type { CnPlatformId } from "@shared/platforms";
import {
  resolveOperationCatalog,
  type ExactOrigin,
  type OperationCatalogRequest,
  type ResolvedOperationCatalog,
} from "./operation-catalog";
import {
  NetworkRuntime,
  type NetworkRuntimeOptions,
  type NetworkSession,
  type SessionRegistration,
  type RuntimeProofScopeEvent,
} from "./runtime";

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
class FakeSession extends EventEmitter {
  setProxy = vi.fn<NetworkSession["setProxy"]>().mockResolvedValue(undefined);
  closeAllConnections = vi.fn<NetworkSession["closeAllConnections"]>().mockResolvedValue(undefined);
  clearHostResolverCache = vi.fn<NetworkSession["clearHostResolverCache"]>().mockResolvedValue(undefined);
  clearStorageData = vi.fn<NetworkSession["clearStorageData"]>().mockResolvedValue(undefined);
  get session(): NetworkSession {
    return this as unknown as NetworkSession;
  }
}
class FakeDownload extends EventEmitter {
  cancel = vi.fn();
}
const target: ProofTarget = {
  protocol: "https:",
  host: "member.bilibili.com",
  port: 443,
  addressFamily: "ipv4",
};
const network = { controllerReadable: true, mode: "rule", tun: true, rulesVersion: "verified-live-rules" };
const origin = (host: string): ExactOrigin => ({ protocol: "https:", host, port: 443 });
function reviewedCatalog(
  input: OperationCatalogRequest,
  reviewId = "controlled-flow-review",
): ResolvedOperationCatalog {
  const source = resolveOperationCatalog(input);
  return resolveOperationCatalog({
    ...input,
    review: {
      source: "main-process-flow-review",
      reviewId,
      evidenceRefs: ["controlled-flow-fixture"],
      platformId: source.platformId,
      operation: source.operation,
      sourceVersion: source.sourceVersion,
      selectionKey: source.selectionKey,
      flowReviewed: true,
      additionalRequiredOrigins: [],
      reviewedRequestRange: source.requiredOrigins,
    },
  });
}

describe("NetworkRuntime exclusive access", () => {
  const runtimes: NetworkRuntime[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose();
  });

  function fixture(options: Partial<NetworkRuntimeOptions> = {}) {
    let snapshot: ExclusiveAccessSnapshot = {
      state: "domestic",
      proxy: "off",
      reason: "READY",
      generation: 1,
      checkedAt: "2026-09-08T00:00:00.000Z",
      expiresAt: "2026-09-08T00:00:15.000Z",
    };
    let signal = new AbortController();
    const access = {
      read: vi.fn(() => ({ ...snapshot })),
      acquire: vi.fn(() => {
        if (snapshot.state !== "domestic" || snapshot.proxy !== "off") return null;
        const original = signal;
        return { signal: original.signal, isCurrent: () => !original.signal.aborted, release: vi.fn() };
      }),
    };
    const suspend = vi.fn();
    const runtime = new NetworkRuntime({
      enforcement: "strict",
      networkReadiness: () => true,
      exclusiveAccess: access,
      onSuspend: suspend,
      ...options,
    });
    runtimes.push(runtime);
    const session = new FakeSession();
    const register = (id = "exclusive-account", platform: CnPlatformId = "bilibili") =>
      runtime.registerSession(session.session, id, platform);
    function update(patch: Partial<ExclusiveAccessSnapshot>, revokeSource = true) {
      snapshot = { ...snapshot, ...patch };
      if (revokeSource) {
        signal.abort();
        signal = new AbortController();
      }
      runtime.syncExclusiveAccess();
    }
    return { runtime, session, register, access, suspend, update };
  }

  it.each(CN_PLATFORM_IDS)(
    "allows %s ordinary pages/resources without catalog or AF reviews",
    async (platform) => {
      const resolveScope = vi.fn(() => {
        throw new Error("must not resolve proof scope");
      });
      const resolveCatalog = vi.fn(() => {
        throw new Error("must not request a flow review");
      });
      const resolveFamilies = vi.fn(() => null);
      const f = fixture({ resolveScope, resolveCatalog, resolveFamilies });
      await f.register("exclusive-account", platform).ready;
      await f.runtime.prepareOperation("exclusive-account", {
        operation: "view-login",
        activePageOrigin: null,
      }).ready;
      for (const url of [
        "https://unlisted-cdn.example/image",
        "http://legacy-cdn.example/res",
        "wss://third-party.example/socket",
        "ws://third-party.example/socket",
      ])
        expect(f.runtime.checkSessionRequest(f.session.session, url)).toMatchObject({
          allowed: true,
          cancel: false,
        });
      expect(f.runtime.getAccountStates()[0]).toMatchObject({
        state: "allowed",
        reason: "READY",
        generation: 1,
      });
      expect(f.runtime.listProofScopes()).toEqual([]);
      expect(f.runtime.gate.registeredScopes()).toEqual([]);
      expect(resolveScope).not.toHaveBeenCalled();
      expect(resolveCatalog).not.toHaveBeenCalled();
      expect(resolveFamilies).not.toHaveBeenCalled();
    },
  );

  it("retains exact operation/navigation validation without tearing down an existing QR page", async () => {
    const f = fixture();
    await f.register().ready;
    const before = f.session.closeAllConnections.mock.calls.length;
    const lease = f.runtime.acquire("exclusive-account")!;
    for (const operation of ["view-login", "check-status", "profile", "collect", "keepalive"] as const)
      await f.runtime.prepareOperation("exclusive-account", { operation, activePageOrigin: null }).ready;
    expect(f.suspend).not.toHaveBeenCalled();
    expect(f.session.closeAllConnections).toHaveBeenCalledTimes(before);
    expect(lease.isCurrent()).toBe(true);
    expect(() =>
      f.runtime.prepareOperation("exclusive-account", {
        operation: "view-navigate",
        activePageOrigin: null,
        targetPageOrigin: origin("youtube.com"),
      }),
    ).toThrow("INVALID_BUSINESS_OPERATION_SCOPE");
    expect(() =>
      f.runtime.prepareOperation("exclusive-account", {
        operation: "collect",
        activePageOrigin: origin("bilibili.com.attacker.example"),
      }),
    ).toThrow("INVALID_BUSINESS_OPERATION_SCOPE");
    for (const url of [
      "https://user:secret@api.bilibili.com/",
      "file:///C:/test",
      "ftp://cdn.example/a",
      "invalid",
    ])
      expect(f.runtime.checkSessionRequest(f.session.session, url)).toMatchObject({
        allowed: false,
        cancel: true,
      });
    expect(f.runtime.check("exclusive-account").allowed).toBe(true);
    lease.release();
  });

  it("waits for direct mode, old pool closure and DNS reset before the first domestic request", async () => {
    const f = fixture();
    const proxy = deferred(),
      pool = deferred(),
      dns = deferred();
    f.session.setProxy.mockReturnValueOnce(proxy.promise);
    f.session.closeAllConnections.mockReturnValueOnce(pool.promise);
    f.session.clearHostResolverCache.mockReturnValueOnce(dns.promise);
    const registration = f.register();
    await settle();
    expect(f.session.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    expect(f.session.closeAllConnections).not.toHaveBeenCalled();
    expect(f.runtime.check("exclusive-account").allowed).toBe(false);
    proxy.resolve();
    await settle();
    expect(f.session.closeAllConnections).toHaveBeenCalledOnce();
    expect(f.session.clearHostResolverCache).not.toHaveBeenCalled();
    pool.resolve();
    await settle();
    expect(f.session.clearHostResolverCache).toHaveBeenCalledOnce();
    expect(f.runtime.acquire("exclusive-account")).toBeNull();
    dns.resolve();
    await registration.ready;
    expect(f.runtime.check("exclusive-account").allowed).toBe(true);
  });

  it("closes every account and task before suspension, cancels downloads and waits for cleanup", async () => {
    const f = fixture();
    await f.register().ready;
    const other = new FakeSession();
    await f.runtime.registerSession(other.session, "second", "weixin_channels").ready;
    const lease = f.runtime.acquire("exclusive-account")!;
    const otherLease = f.runtime.acquire("second")!;
    const download = new FakeDownload();
    f.session.emit("will-download", {}, download);
    const closed = deferred();
    const page = deferred();
    f.session.closeAllConnections.mockReturnValueOnce(closed.promise);
    const observed: boolean[] = [];
    f.runtime.setSuspendHandler(() => {
      observed.push(
        !f.runtime.check("exclusive-account").allowed &&
          !f.runtime.check("second").allowed &&
          lease.signal.aborted &&
          otherLease.signal.aborted,
      );
      return page.promise;
    });
    // Runtime must revoke its own derived leases even before the monitor's original signal fires.
    f.update({ state: "overseas", proxy: "on", reason: "PROXY_ENABLED", generation: 2 }, false);
    expect(observed).toEqual([true, true]);
    expect(download.cancel).toHaveBeenCalledOnce();
    expect(f.runtime.getAccountStates()[0]).toMatchObject({ state: "dormant", reason: "PROXY_ENABLED" });
    await settle();
    expect(f.session.clearStorageData).toHaveBeenCalledWith({ storages: ["serviceworkers"] });
    f.update({ state: "domestic", proxy: "off", reason: "READY", generation: 3 });
    closed.resolve();
    await settle();
    expect(f.runtime.check("exclusive-account").allowed).toBe(false); // Page teardown is still pending.
    page.resolve();
    await f.register().ready;
    expect(f.runtime.check("exclusive-account").allowed).toBe(true);
    expect(lease.isCurrent()).toBe(false);
  });

  it("does not let delayed domestic cleanup reopen the next proxy generation", async () => {
    const f = fixture();
    await f.register().ready;
    const close = deferred();
    f.session.closeAllConnections.mockReturnValueOnce(close.promise);
    f.update({ state: "checking", proxy: "off", reason: "CHECKING", generation: 2 });
    await settle();
    f.update({ state: "domestic", reason: "READY", generation: 3 });
    f.update({ state: "overseas", proxy: "on", reason: "PROXY_ENABLED", generation: 4 });
    close.resolve();
    await f.register().ready;
    expect(f.runtime.check("exclusive-account")).toMatchObject({
      allowed: false,
      reason: "PROXY_ENABLED",
      generation: 4,
    });
    expect(f.runtime.acquire("exclusive-account")).toBeNull();
  });

  it("keeps controller-off domestic usable and ignores DIRECT rules as a rescue for proxy-on", async () => {
    const f = fixture();
    await f.register().ready;
    f.runtime.onObservation({ ...checkingNetworkSnapshot(), instanceId: "controller-off", sequence: 1 });
    expect(f.runtime.check("exclusive-account").allowed).toBe(true);
    expect(f.suspend).not.toHaveBeenCalled();
    f.update({ state: "overseas", proxy: "on", reason: "PROXY_ENABLED", generation: 2 });
    f.runtime.gate.setNetworkState(network);
    f.runtime.onObservation({
      ...checkingNetworkSnapshot(),
      instanceId: "controller-rule",
      sequence: 2,
      checkedAt: new Date().toISOString(),
      rulesVersion: network.rulesVersion,
      controller: { readable: true, mode: "rule", tun: true, ruleCount: 32, version: "fixture" },
    });
    await f.register().ready;
    expect(f.runtime.check("exclusive-account")).toMatchObject({ allowed: false, reason: "PROXY_ENABLED" });
  });

  it("keeps same-generation freshness renewal free of new teardowns or task cancellation", async () => {
    const f = fixture();
    await f.register().ready;
    const lease = f.runtime.acquire("exclusive-account")!;
    const closes = f.session.closeAllConnections.mock.calls.length;
    f.update({ checkedAt: "2026-09-08T00:00:10.000Z", expiresAt: "2026-09-08T00:00:25.000Z" }, false);
    expect(f.runtime.getAccountStates()[0].proofExpiresAt).toBe("2026-09-08T00:00:25.000Z");
    expect(lease.isCurrent()).toBe(true);
    expect(f.suspend).not.toHaveBeenCalled();
    expect(f.session.closeAllConnections).toHaveBeenCalledTimes(closes);
    lease.release();
  });

  it("requires OS readiness even when the exclusive monitor reports domestic", async () => {
    let osReady = true;
    const f = fixture({ networkReadiness: () => osReady });
    await f.register().ready;
    const lease = f.runtime.acquire("exclusive-account")!;
    osReady = false;
    expect(f.runtime.check("exclusive-account")).toMatchObject({ allowed: false, reason: "NETWORK_CHANGED" });
    expect(lease.isCurrent()).toBe(false);
    expect(lease.signal.aborted).toBe(true);
  });

  it("rejects unknown, monitor errors, stale generations and contradictory domestic/on snapshots", async () => {
    const f = fixture();
    await f.register().ready;
    f.update({ state: "unavailable", proxy: "unknown", reason: "PROXY_STATE_UNKNOWN", generation: 2 });
    expect(f.runtime.check("exclusive-account").allowed).toBe(false);
    f.update({ state: "domestic", proxy: "off", reason: "READY", generation: 1 });
    expect(f.runtime.check("exclusive-account")).toMatchObject({ allowed: false, generation: 2 });
    f.update({ state: "domestic", proxy: "on", generation: 3 });
    expect(f.runtime.check("exclusive-account").allowed).toBe(false);
    f.access.read.mockImplementation(() => {
      throw new Error("controller secret must not escape");
    });
    f.runtime.syncExclusiveAccess();
    expect(f.runtime.check("exclusive-account")).toMatchObject({
      allowed: false,
      reason: "PROXY_STATE_UNKNOWN",
    });
  });

  it("aborts on monitor expiry without waiting for another task check", async () => {
    const f = fixture();
    await f.register().ready;
    const lease = f.runtime.acquire("exclusive-account")!;
    f.update({ state: "unavailable", proxy: "unknown", reason: "PROOF_EXPIRED", generation: 2 });
    expect(lease.signal.aborted).toBe(true);
    expect(f.runtime.getAccountStates()[0]).toMatchObject({ state: "dormant", reason: "PROOF_EXPIRED" });
  });

  it("rejects a reentrant monitor read instead of returning the previous domestic allowance", async () => {
    const f = fixture();
    await f.register().ready;
    const old = f.access.read.getMockImplementation()!;
    let nestedAllowed: boolean | undefined;
    f.access.read.mockImplementationOnce(() => {
      nestedAllowed = f.runtime.check("exclusive-account").allowed;
      return old();
    });
    f.runtime.syncExclusiveAccess();
    expect(nestedAllowed).toBe(false);
    // A subsequent fresh source read may restore eligibility only after the queued teardown.
    expect(f.runtime.check("exclusive-account").allowed).toBe(false);
    await f.register().ready;
    expect(f.runtime.check("exclusive-account").allowed).toBe(true);
  });

  it("does not return a domestic decision after OS-readiness synchronously revokes it", async () => {
    let callback: (() => boolean) | undefined;
    const f = fixture({ networkReadiness: () => callback?.() ?? true });
    await f.register().ready;
    callback = () => {
      callback = undefined;
      f.update({ state: "overseas", proxy: "on", reason: "PROXY_ENABLED", generation: 2 });
      return true;
    };
    expect(f.runtime.check("exclusive-account", "https://api.bilibili.com/").allowed).toBe(false);
  });

  it("refuses a monitor lease acquired across a synchronous policy transition", async () => {
    const f = fixture();
    await f.register().ready;
    const leaseSource = new AbortController();
    const release = vi.fn();
    f.access.acquire.mockImplementationOnce(() => {
      f.update({ state: "overseas", proxy: "on", reason: "PROXY_ENABLED", generation: 2 });
      return { signal: leaseSource.signal, isCurrent: () => true, release };
    });
    expect(f.runtime.acquire("exclusive-account")).toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not revive reset/removed leases even when the same UUID and Session are restored", async () => {
    const f = fixture();
    const before = f.register();
    await before.ready;
    const lease = f.runtime.acquire("exclusive-account")!;
    await f.runtime.resetAccount("exclusive-account");
    expect(lease.signal.aborted).toBe(true);
    expect(f.runtime.checkSessionRequest(f.session.session, "https://api.bilibili.com/").cancel).toBe(true);
    const restored = f.register();
    await restored.ready;
    expect(restored.contextId).not.toBe(before.contextId);
    expect(f.runtime.check("exclusive-account").allowed).toBe(true);
    expect(lease.isCurrent()).toBe(false);
    const fresh = f.runtime.acquire("exclusive-account")!;
    await f.runtime.removeAccount("exclusive-account");
    expect(fresh.signal.aborted).toBe(true);
    expect(f.runtime.getAccountStates()).toEqual([]);
  });

  it("retains sticky suspension failure and never resumes after a later domestic sample", async () => {
    const f = fixture();
    await f.register().ready;
    f.runtime.setSuspendHandler(() => Promise.reject(new Error("view did not close")));
    f.update({ state: "overseas", proxy: "on", reason: "PROXY_ENABLED", generation: 2 });
    await expect(f.register().ready).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    f.update({ state: "domestic", proxy: "off", reason: "READY", generation: 3 });
    await expect(f.register().ready).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    expect(f.runtime.check("exclusive-account")).toMatchObject({ allowed: false, reason: "GATE_REVOKED" });
    expect(f.session.clearStorageData).toHaveBeenCalled();
  });

  it("disposes idempotently, aborts tasks synchronously and waits for pending page teardown", async () => {
    const f = fixture();
    await f.register().ready;
    const lease = f.runtime.acquire("exclusive-account")!;
    const page = deferred();
    let nested: Promise<void> | undefined;
    f.runtime.setSuspendHandler(() => {
      nested = f.runtime.dispose();
      return page.promise;
    });
    const disposal = f.runtime.dispose();
    expect(nested).toBe(disposal);
    expect(f.runtime.dispose()).toBe(disposal);
    expect(lease.signal.aborted).toBe(true);
    let finished = false;
    void disposal.then(() => {
      finished = true;
    });
    await settle();
    expect(finished).toBe(false);
    page.resolve();
    await disposal;
    expect(f.runtime.check("exclusive-account").allowed).toBe(false);
  });

  it("does not make the observation policy cancel requests or alter Sessions", async () => {
    const f = fixture({ enforcement: "observe" });
    await f.register().ready;
    const download = new FakeDownload();
    f.session.emit("will-download", {}, download);
    f.update({ state: "overseas", proxy: "on", reason: "PROXY_ENABLED", generation: 2 });
    expect(f.runtime.checkSessionRequest(f.session.session, "https://api.bilibili.com/")).toMatchObject({
      allowed: false,
      cancel: false,
      enforce: false,
    });
    expect(f.session.setProxy).not.toHaveBeenCalled();
    expect(f.session.closeAllConnections).not.toHaveBeenCalled();
    expect(f.session.clearStorageData).not.toHaveBeenCalled();
    expect(f.suspend).not.toHaveBeenCalled();
    expect(download.cancel).not.toHaveBeenCalled();
  });
});

describe("NetworkRuntime Session lifecycle", () => {
  const runtimes: NetworkRuntime[] = [];
  const start = Date.parse("2026-09-07T12:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose();
    vi.useRealTimers();
  });

  function fixture(
    options: Partial<NetworkRuntimeOptions> = {},
    defaultScope = false,
    scopeTargets: readonly ProofTarget[] = [target],
    platformId: CnPlatformId = "bilibili",
  ) {
    const fake = new FakeSession();
    const clock: GateClock = {
      monotonicMs: () => Date.now() - start,
      wallTimeMs: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const gate =
      options.gate ??
      new EgressGate({
        enforcement: options.enforcement ?? "strict",
        clock,
        timing: { controllerTtlMs: 50_000, proofTtlMs: 30_000, warmupGapMs: 10 },
      });
    const makeScope = (input: SessionRegistration): AccountProofScope => ({
      accountId: input.accountId,
      platformId: input.platformId,
      contextId: input.contextId,
      catalogVersion: "controlled-reviewed-scope",
      catalogReviewed: true,
      targets: scopeTargets,
    });
    const suspend = vi.fn();
    const runtime = new NetworkRuntime({
      enforcement: "strict",
      networkReadiness: () => true, // Explicit controlled fixture, not production OS evidence.
      gate,
      onSuspend: suspend,
      resolveScope: defaultScope ? undefined : makeScope,
      resolveTarget: ({ url }) => ({
        ...target,
        protocol: url.protocol as ProofTarget["protocol"],
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
      }),
      ...options,
    });
    runtimes.push(runtime);
    const register = () => runtime.registerSession(fake.session, "account-one", platformId);
    let sample = 0;
    function evidence(): DirectEvidenceBatch {
      const scope = gate.registeredScopes()[0];
      const at = clock.monotonicMs();
      return {
        sampleId: `fresh-${++sample}`,
        generation: gate.generation,
        rulesVersion: network.rulesVersion,
        contextId: scope.contextId,
        catalogVersion: scope.catalogVersion,
        observedAtMono: at,
        targets: scope.targets.map((currentTarget) => ({
          target: { ...currentTarget },
          route: {
            source: "correlated-connection",
            contextId: scope.contextId,
            rulesVersion: network.rulesVersion,
            ruleDecision: "direct",
            connectionId: `probe-${sample}-${currentTarget.addressFamily}`,
            correlationVerified: true,
            chains: ["DIRECT"],
            observedAtMono: at,
          },
          egress: {
            target: { ...currentTarget },
            contextId: scope.contextId,
            ip: currentTarget.addressFamily === "ipv4" ? "192.0.2.1" : "2001:db8::1",
            countryCode: "CN",
            asn: 64512,
            source: "controlled-fixture",
            applicabilityVerified: true,
            observedAtMono: at,
          },
          tls: { verified: true, observedAtMono: at },
          dns: { status: "resolved", addressFamily: currentTarget.addressFamily, observedAtMono: at },
        })),
      };
    }
    async function activate() {
      await register().ready;
      gate.setNetworkState(network);
      await register().ready;
      gate.acceptEvidence("account-one", evidence());
      vi.advanceTimersByTime(10);
      return gate.acceptEvidence("account-one", evidence());
    }
    return { fake, runtime, gate, register, activate, evidence, suspend };
  }

  it("waits for direct mode and then connection close before Session readiness", async () => {
    const f = fixture();
    const proxy = deferred(),
      close = deferred();
    f.fake.setProxy.mockReturnValueOnce(proxy.promise);
    f.fake.closeAllConnections.mockReturnValueOnce(close.promise);
    const registration = f.register();
    await settle();
    expect(f.fake.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    expect(f.fake.closeAllConnections).not.toHaveBeenCalled();
    expect(f.runtime.check("account-one").allowed).toBe(false);
    proxy.resolve();
    await settle();
    expect(f.fake.closeAllConnections).toHaveBeenCalledOnce();
    expect(f.runtime.getAccountStates()[0].state).toBe("checking");
    close.resolve();
    await registration.ready;
    expect(f.runtime.check("account-one").allowed).toBe(false); // Ready does not imply proof.
  });
  it("requires current OS network readiness independently of fixture evidence", async () => {
    const f = fixture({ networkReadiness: undefined });
    await f.activate();
    await f.register().ready;
    expect(f.runtime.check("account-one")).toMatchObject({ allowed: false, reason: "NETWORK_CHANGED" });
    expect(f.runtime.getAccountStates()[0]).toMatchObject({ state: "checking", proofExpiresAt: null });
  });
  it("keeps a failed OS observation closed even when a controller sample is readable", async () => {
    let ready = true;
    const f = fixture({ networkReadiness: () => ready });
    await f.activate();
    await f.register().ready;
    expect(f.runtime.check("account-one").allowed).toBe(true);
    const lease = f.runtime.acquire("account-one")!;
    ready = false;
    f.runtime.onObservation({
      ...checkingNetworkSnapshot(),
      instanceId: "os-test",
      sequence: 1,
      checkedAt: new Date().toISOString(),
      rulesVersion: network.rulesVersion,
      controller: { readable: true, mode: "rule", tun: true, ruleCount: 30, version: "fixture" },
    });
    expect(lease.signal.aborted).toBe(true);
    expect(f.runtime.check("account-one").allowed).toBe(false);
    ready = true;
    expect(f.runtime.check("account-one").allowed).toBe(false); // Stable OS state cannot revive old proof.
    lease.release();
  });

  it("keeps registration idempotent and refuses account/Session rebinding", async () => {
    const f = fixture();
    const first = f.register();
    await first.ready;
    expect(f.register().contextId).toBe(first.contextId);
    await f.register().ready;
    expect(f.fake.setProxy).toHaveBeenCalledOnce();
    expect(f.fake.listenerCount("will-download")).toBe(1);
    expect(() => f.runtime.registerSession(f.fake.session, "other-account", "bilibili")).toThrow(
      "cannot be rebound",
    );
    expect(() => f.runtime.registerSession(new FakeSession().session, "account-one", "bilibili")).toThrow(
      "cannot be rebound",
    );
  });

  it("does not use candidate hosts as a reviewed catalog", async () => {
    const f = fixture({}, true);
    const registration = f.register();
    await registration.ready;
    expect(f.gate.registeredScopes()).toEqual([]);
    expect(f.runtime.getAccountStates()[0].state).toBe("checking");
    await f.runtime.setPageOperation("account-one", { operation: "view-home", activePageOrigin: null }).ready;
    f.gate.setNetworkState(network);
    await f.register().ready;
    const sample = {
      sampleId: "candidate-only",
      generation: f.gate.generation,
      rulesVersion: network.rulesVersion,
      contextId: registration.contextId,
      catalogVersion: f.gate.registeredScopes()[0].catalogVersion,
      observedAtMono: 0,
      targets: [],
    };
    expect(f.gate.acceptEvidence("account-one", sample).reason).toBe("CATALOG_UNVERIFIED");
    expect(f.runtime.check("account-one").allowed).toBe(false);
    const scopes = f.gate.registeredScopes();
    expect(scopes[0].targets.map((target) => target.host)).toEqual([
      "member.bilibili.com",
      "member.bilibili.com",
    ]);
    scopes[0].catalogReviewed = true;
    scopes[0].targets = [];
    expect(f.gate.registeredScopes()[0].catalogReviewed).toBe(false);
    expect(f.gate.registeredScopes()[0].targets).toHaveLength(2);
  });

  it("rejects an IPv4-only permit when the actual family is unknown", async () => {
    const f = fixture({ resolveTarget: undefined });
    expect((await f.activate()).allowed).toBe(true);
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/")).toEqual(
      expect.objectContaining({ cancel: true, reason: "UNKNOWN_TARGET" }),
    );
    expect(f.runtime.acquire("account-one")).toBeNull();
    expect(f.suspend).toHaveBeenCalledWith("account-one");
  });

  function familyFixture(
    resolveFamilies?: NetworkRuntimeOptions["resolveFamilies"],
    enforcement: "observe" | "strict" = "strict",
  ) {
    return fixture(
      { enforcement, resolveTarget: undefined, resolveFamilies, resolveCatalog: reviewedCatalog },
      true,
    );
  }
  async function declareCheck(f: ReturnType<typeof familyFixture>) {
    await f.register().ready;
    await f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null })
      .ready;
  }

  it("uses one verified family resolver for the real operation catalog and each exact request", async () => {
    const resolveFamilies = vi.fn<NonNullable<NetworkRuntimeOptions["resolveFamilies"]>>(() => ["ipv4"]);
    const f = familyFixture(resolveFamilies);
    await declareCheck(f);
    const expected = { ...origin("api.bilibili.com"), addressFamily: "ipv4" };
    expect(f.runtime.listProofScopes()[0].targets).toEqual([expected]);
    expect((await f.activate()).allowed).toBe(true);
    const requestCheck = vi.spyOn(f.gate, "checkRequest");
    expect(
      f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/x/nav?secret=omitted"),
    ).toMatchObject({ allowed: true, cancel: false });
    expect(requestCheck.mock.calls.map(([value]) => value.target)).toEqual([expected]);
    expect(resolveFamilies).toHaveBeenCalledTimes(2);
    for (const [value] of resolveFamilies.mock.calls) {
      expect(Object.keys(value).sort()).toEqual(["accountId", "contextId", "origin", "platformId"]);
      expect(value).toEqual({
        accountId: "account-one",
        platformId: "bilibili",
        contextId: f.register().contextId,
        origin: origin("api.bilibili.com"),
      });
    }
    expect(resolveFamilies.mock.calls[0][0].origin).not.toBe(resolveFamilies.mock.calls[1][0].origin);
  });

  it("keeps mixed single and dual families in one all-required operation scope", async () => {
    const f = familyFixture(({ origin: current }) =>
      current.host === "api.bilibili.com" ? ["ipv4"] : ["ipv6", "ipv4"],
    );
    await f.register().ready;
    await f.runtime.prepareOperation("account-one", { operation: "collect", activePageOrigin: null }).ready;
    const expected = [
      { ...origin("api.bilibili.com"), addressFamily: "ipv4" },
      { ...origin("member.bilibili.com"), addressFamily: "ipv4" },
      { ...origin("member.bilibili.com"), addressFamily: "ipv6" },
    ];
    expect(f.runtime.listProofScopes()[0].targets).toEqual(expected);
    expect((await f.activate()).allowed).toBe(true);
    const requestCheck = vi.spyOn(f.gate, "checkRequest");
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/x/nav").allowed).toBe(
      true,
    );
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/works").allowed).toBe(
      true,
    );
    expect(requestCheck.mock.calls.map(([value]) => value.target)).toEqual(expected);
  });

  it("does not publish a partial scope when a later required origin has no family evidence", async () => {
    const f = familyFixture(({ origin: current }) => (current.host === "api.bilibili.com" ? ["ipv4"] : null));
    await f.register().ready;
    expect(() =>
      f.runtime.prepareOperation("account-one", { operation: "collect", activePageOrigin: null }),
    ).toThrow("INVALID_BUSINESS_OPERATION_SCOPE");
    expect(f.runtime.listProofScopes()).toEqual([]);
    expect(f.gate.registeredScopes()).toEqual([]);
  });

  it("retains both families in the default catalog and request checks when no resolver is installed", async () => {
    const f = familyFixture();
    await declareCheck(f);
    expect(f.runtime.listProofScopes()[0].targets.map((value) => value.addressFamily)).toEqual([
      "ipv4",
      "ipv6",
    ]);
    await f.activate();
    const requestCheck = vi.spyOn(f.gate, "checkRequest");
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/").allowed).toBe(true);
    expect(requestCheck.mock.calls.map(([value]) => value.target.addressFamily)).toEqual(["ipv4", "ipv6"]);
  });

  it.each([
    ["null", () => null],
    ["empty", () => []],
    ["duplicate", () => ["ipv4", "ipv4"]],
    ["unknown", () => ["unknown"] as never],
    ["too many", () => ["ipv4", "ipv6", "ipv4"]],
    ["not an array", () => "ipv4" as never],
    ["async", () => Promise.resolve(["ipv4"]) as never],
    [
      "throws",
      () => {
        throw new Error("private review unavailable");
      },
    ],
  ] as const)(
    "refuses %s family results for requests and declarations without a fallback",
    async (_name, invalid) => {
      const resolveFamilies = vi.fn<NonNullable<NetworkRuntimeOptions["resolveFamilies"]>>(() => [
        "ipv4",
        "ipv6",
      ]);
      const f = familyFixture(resolveFamilies);
      await declareCheck(f);
      await f.activate();
      const lease = f.runtime.acquire("account-one")!;
      resolveFamilies.mockImplementation(invalid);
      const requestCheck = vi.spyOn(f.gate, "checkRequest");
      expect(f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/")).toMatchObject({
        allowed: false,
        cancel: true,
        reason: "UNKNOWN_TARGET",
      });
      expect(lease.signal.aborted).toBe(true);
      expect(requestCheck).not.toHaveBeenCalled();
      expect(() =>
        f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null }),
      ).toThrow("INVALID_BUSINESS_OPERATION_SCOPE");
      expect(f.gate.registeredScopes()).toEqual([]);
      expect(f.runtime.listProofScopes()).toEqual([]);
      lease.release();
    },
  );

  it.each([
    [["ipv4", "ipv6"], ["ipv4"]],
    [["ipv4"], ["ipv4", "ipv6"]],
    [["ipv4"], ["ipv6"]],
  ] as const)(
    "requires a new scope and fresh proof after family changes from %j to %j",
    async (before, after) => {
      let families: readonly ProofTarget["addressFamily"][] = before;
      const f = familyFixture(() => families);
      await declareCheck(f);
      await f.activate();
      const lease = f.runtime.acquire("account-one")!;
      families = after;
      expect(f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/").allowed).toBe(false);
      expect(lease.signal.aborted).toBe(true);
      await f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null })
        .ready;
      expect(f.runtime.listProofScopes()[0].targets.map((value) => value.addressFamily)).toEqual(
        [...after].sort(),
      );
      expect(f.runtime.check("account-one").allowed).toBe(false);
      expect(f.gate.acceptEvidence("account-one", f.evidence()).allowed).toBe(false);
      vi.advanceTimersByTime(10);
      expect(f.gate.acceptEvidence("account-one", f.evidence()).allowed).toBe(true);
      expect(f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/").allowed).toBe(true);
      lease.release();
    },
  );

  it("does not reuse family applicability after the same Session is registered with a new context", async () => {
    let reviewedContext = "";
    const f = familyFixture(({ contextId }) => (contextId === reviewedContext ? ["ipv4"] : null));
    const first = f.register();
    reviewedContext = first.contextId;
    await first.ready;
    await declareCheck(f);
    await f.activate();
    await f.runtime.removeAccount("account-one");
    const next = f.register();
    expect(next.contextId).not.toBe(reviewedContext);
    await next.ready;
    expect(() =>
      f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null }),
    ).toThrow();
    expect(f.runtime.listProofScopes()).toEqual([]);
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/").allowed).toBe(false);
  });

  it("does not overwrite a scope after a family callback synchronously changes the Gate generation", async () => {
    const resolveFamilies = vi.fn<NonNullable<NetworkRuntimeOptions["resolveFamilies"]>>(() => ["ipv4"]);
    const f = familyFixture(resolveFamilies);
    await f.register().ready;
    resolveFamilies.mockImplementation(() => {
      f.gate.invalidate("NETWORK_CHANGED");
      return ["ipv4"];
    });
    expect(() =>
      f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null }),
    ).toThrow();
    expect(f.gate.registeredScopes()).toEqual([]);
    expect(f.runtime.listProofScopes()).toEqual([]);
  });

  it("does not restore the old scope if family resolution removes and re-registers its Session", async () => {
    const resolveFamilies = vi.fn<NonNullable<NetworkRuntimeOptions["resolveFamilies"]>>(() => ["ipv4"]);
    const f = familyFixture(resolveFamilies);
    await declareCheck(f);
    const priorContext = f.register().contextId;
    let replacement: ReturnType<typeof f.register> | undefined;
    resolveFamilies.mockImplementation(() => {
      void f.runtime.removeAccount("account-one");
      replacement = f.register();
      return ["ipv4"];
    });
    expect(() =>
      f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null }),
    ).toThrow();
    await replacement!.ready;
    expect(replacement!.contextId).not.toBe(priorContext);
    expect(f.gate.registeredScopes()).toEqual([]);
    expect(f.runtime.listProofScopes()).toEqual([]);
    resolveFamilies.mockImplementation(() => ["ipv4"]);
    await declareCheck(f);
    expect(f.runtime.listProofScopes()[0].contextId).toBe(replacement!.contextId);
  });

  it("rejects a family callback that recursively declares another operation without leaving an old permit", async () => {
    const resolveFamilies = vi.fn<NonNullable<NetworkRuntimeOptions["resolveFamilies"]>>(() => ["ipv4"]);
    const f = familyFixture(resolveFamilies);
    await declareCheck(f);
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    resolveFamilies.mockImplementation(() => {
      expect(() =>
        f.runtime.prepareOperation("account-one", { operation: "profile", activePageOrigin: null }),
      ).toThrow();
      return ["ipv4"];
    });
    expect(() =>
      f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null }),
    ).toThrow();
    expect(f.gate.registeredScopes()).toEqual([]);
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  it("rejects request-time family resolution after synchronous revocation even if it returns the old family", async () => {
    const resolveFamilies = vi.fn<NonNullable<NetworkRuntimeOptions["resolveFamilies"]>>(() => ["ipv4"]);
    const f = familyFixture(resolveFamilies);
    await declareCheck(f);
    await f.activate();
    resolveFamilies.mockImplementation(() => {
      f.gate.invalidate("NETWORK_CHANGED");
      return ["ipv4"];
    });
    const requestCheck = vi.spyOn(f.gate, "checkRequest");
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/").cancel).toBe(true);
    expect(requestCheck).not.toHaveBeenCalled();
  });

  it("passes cloned identity/origin only and refuses callback target substitution", async () => {
    const f = familyFixture((input) => {
      input.origin.host = "attacker.test";
      return ["ipv4"];
    });
    await f.register().ready;
    expect(() =>
      f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null }),
    ).toThrow();
    expect(f.gate.registeredScopes()).toEqual([]);
    expect(f.register().contextId).toBeTruthy();
  });

  it("refuses request-time origin mutation without checking a substituted target", async () => {
    const resolveFamilies = vi.fn<NonNullable<NetworkRuntimeOptions["resolveFamilies"]>>(() => ["ipv4"]);
    const f = familyFixture(resolveFamilies);
    await declareCheck(f);
    await f.activate();
    resolveFamilies.mockImplementation((input) => {
      input.origin.port = 8443;
      return ["ipv4"];
    });
    const check = vi.spyOn(f.gate, "checkRequest");
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/").allowed).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("rechecks generation after reading returned family values rather than only after calling the resolver", async () => {
    const resolveFamilies = vi.fn<NonNullable<NetworkRuntimeOptions["resolveFamilies"]>>(() => ["ipv4"]);
    const f = familyFixture(resolveFamilies);
    await f.register().ready;
    resolveFamilies.mockImplementation(() =>
      Object.defineProperty(["ipv4"], "0", {
        get: () => {
          f.gate.invalidate("NETWORK_CHANGED");
          return "ipv4";
        },
      }),
    );
    expect(() =>
      f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null }),
    ).toThrow();
    expect(f.gate.registeredScopes()).toEqual([]);
  });

  it("keeps observation non-enforcing when the supplied family source is unavailable", async () => {
    const f = familyFixture(() => null, "observe");
    await f.register().ready;
    expect(() =>
      f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null }),
    ).toThrow();
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://api.bilibili.com/")).toMatchObject({
      allowed: false,
      enforce: false,
      cancel: false,
    });
    expect(f.suspend).not.toHaveBeenCalled();
    expect(f.fake.setProxy).not.toHaveBeenCalled();
    expect(f.fake.closeAllConnections).not.toHaveBeenCalled();
  });

  it("rejects ambiguous family and legacy target resolvers before installing Gate listeners", () => {
    const gate = new EgressGate();
    const stateListeners = gate.listenerCount("state");
    expect(
      () =>
        new NetworkRuntime({
          enforcement: "strict",
          gate,
          resolveFamilies: () => ["ipv4"],
          resolveTarget: () => target,
        }),
    ).toThrow("AMBIGUOUS_NETWORK_FAMILY_RESOLVER");
    expect(gate.listenerCount("state")).toBe(stateListeners);
    gate.dispose();
  });

  it.each(["https:", "wss:"] as const)(
    "allows unknown-family %s only when both exact branches have current permits",
    async (protocol) => {
      const branches: ProofTarget[] = (["ipv4", "ipv6"] as const).map((addressFamily) => ({
        ...target,
        protocol,
        addressFamily,
      }));
      const f = fixture({ resolveTarget: undefined }, false, branches);
      expect((await f.activate()).allowed).toBe(true);
      const check = vi.spyOn(f.gate, "checkRequest");
      expect(
        f.runtime.checkSessionRequest(f.fake.session, `${protocol}//member.bilibili.com/works`),
      ).toMatchObject({ allowed: true, cancel: false });
      expect(check.mock.calls.map(([request]) => request.target)).toEqual(branches);
      expect(f.runtime.acquire("account-one")).not.toBeNull();
    },
  );

  it("does not use an IPv6-only permit to authorize an unknown-family request", async () => {
    const f = fixture({ resolveTarget: undefined }, false, [{ ...target, addressFamily: "ipv6" }]);
    expect((await f.activate()).allowed).toBe(true);
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/")).toMatchObject({
      allowed: false,
      cancel: true,
      reason: "UNKNOWN_TARGET",
    });
  });

  it("rejects a dual-family request when one branch is not valid evidence", async () => {
    const branches: ProofTarget[] = [target, { ...target, addressFamily: "ipv6" }];
    const f = fixture({ resolveTarget: undefined }, false, branches);
    await f.register().ready;
    f.gate.setNetworkState(network);
    await f.register().ready;
    f.gate.acceptEvidence("account-one", f.evidence());
    vi.advanceTimersByTime(10);
    const invalid = f.evidence();
    invalid.targets[1].egress.countryCode = "JP";
    expect(f.gate.acceptEvidence("account-one", invalid).allowed).toBe(false);
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/").cancel).toBe(true);
    expect(f.runtime.acquire("account-one")).toBeNull();
  });

  it.each([
    ["returns null", () => null],
    [
      "throws",
      () => {
        throw new Error("unverified transport");
      },
    ],
    ["substitutes a host", () => ({ ...target, host: "other.example" })],
    ["substitutes a port", () => ({ ...target, port: 8443 })],
    ["substitutes a protocol", () => ({ ...target, protocol: "wss:" as const })],
    ["returns an unknown family", () => ({ ...target, addressFamily: "unknown" as never })],
    [
      "mutates the URL",
      ({ url }: SessionRegistration & { url: URL }) => {
        url.hostname = "other.example";
        return { ...target, host: url.hostname };
      },
    ],
  ] as const)(
    "rejects when an explicit resolver %s despite dual-family permits",
    async (_label, resolveTarget) => {
      const f = fixture({ resolveTarget }, false, [target, { ...target, addressFamily: "ipv6" }]);
      expect((await f.activate()).allowed).toBe(true);
      expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/")).toMatchObject({
        allowed: false,
        cancel: true,
        reason: "UNKNOWN_TARGET",
      });
      expect(f.runtime.acquire("account-one")).toBeNull();
    },
  );

  it("observation with unknown AF reports the failed branch without cancelling business", async () => {
    const f = fixture({ enforcement: "observe", resolveTarget: undefined });
    await f.activate();
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/")).toMatchObject({
      allowed: false,
      enforce: false,
      cancel: false,
    });
    expect(f.suspend).not.toHaveBeenCalled();
    expect(f.fake.closeAllConnections).not.toHaveBeenCalled();
    expect(f.fake.setProxy).not.toHaveBeenCalled();
  });

  it("supports an explicitly constrained test transport without authorizing redirects or ports", async () => {
    const f = fixture();
    await f.activate();
    expect(
      f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/works?private=omitted")
        .allowed,
    ).toBe(true);
    expect(
      f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com:8443/works").allowed,
    ).toBe(false);
    expect(f.runtime.check("account-one").allowed).toBe(false);
  });

  it("does not let a target resolver substitute a different URL", async () => {
    const f = fixture({ resolveTarget: () => target });
    await f.activate();
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://attacker.test/").cancel).toBe(true);
  });

  it.each(["about:blank", "data:text/plain,hello", "blob:https://member.bilibili.com/synthetic-id"])(
    "permits local %s while the network is closed",
    async (url) => {
      const f = fixture();
      await f.register().ready;
      expect(f.runtime.checkSessionRequest(f.fake.session, url)).toEqual(
        expect.objectContaining({ allowed: true, cancel: false, proofId: null }),
      );
      expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/").cancel).toBe(true);
    },
  );

  it.each([
    "file:///private",
    "ftp://example.com/file",
    "http://member.bilibili.com",
    "https://user:secret@member.bilibili.com",
    "not a URL",
  ])("refuses unsupported %s", async (url) => {
    const f = fixture();
    await f.activate();
    expect(f.runtime.checkSessionRequest(f.fake.session, url).cancel).toBe(true);
  });

  it("closes authority before suspension, cancels downloads, clears workers and preserves Cookies", async () => {
    const f = fixture();
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    const active = new FakeDownload(),
      done = new FakeDownload();
    f.fake.emit("will-download", {}, active);
    f.fake.emit("will-download", {}, done);
    done.emit("done");
    let closed = false;
    f.runtime.setSuspendHandler(() => {
      closed = !f.runtime.check("account-one").allowed && lease.signal.aborted;
    });
    const clearsBefore = f.fake.clearStorageData.mock.calls.length;
    f.gate.revoke("account-one");
    expect(closed).toBe(true);
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(done.cancel).not.toHaveBeenCalled();
    expect(lease.isCurrent()).toBe(false);
    await f.register().ready;
    expect(f.fake.clearStorageData.mock.calls.slice(clearsBefore)).toEqual([
      [{ storages: ["serviceworkers"] }],
    ]);
    expect(f.runtime.check("account-one").allowed).toBe(false);
  });

  it("cancels a newly created download while closed", async () => {
    const f = fixture();
    await f.register().ready;
    const download = new FakeDownload();
    f.fake.emit("will-download", {}, download);
    expect(download.cancel).toHaveBeenCalledOnce();
  });

  it("waits for all overlapping cleanup rounds and discards proofs issued during cleanup", async () => {
    const f = fixture();
    await f.activate();
    const first = deferred(),
      second = deferred();
    f.fake.clearStorageData.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    f.gate.revoke("account-one");
    const readiness = f.register().ready;
    f.gate.revoke("account-one");
    await settle();
    f.gate.acceptEvidence("account-one", f.evidence());
    vi.advanceTimersByTime(10);
    expect(f.gate.acceptEvidence("account-one", f.evidence()).allowed).toBe(true);
    expect(f.runtime.check("account-one").allowed).toBe(false);
    expect(f.runtime.getAccountStates()[0].proofExpiresAt).toBeNull();
    let resolved = false;
    void readiness.then(() => {
      resolved = true;
    });
    first.resolve();
    await settle();
    expect(resolved).toBe(false);
    expect(f.runtime.check("account-one").allowed).toBe(false);
    second.resolve();
    await readiness;
    expect(f.gate.checkAction("account-one", f.register().contextId).allowed).toBe(false);
  });

  it("keeps cleanup failures closed and still attempts to close connections", async () => {
    const f = fixture();
    await f.activate();
    f.fake.clearStorageData.mockRejectedValueOnce(new Error("private-worker-error"));
    const closesBefore = f.fake.closeAllConnections.mock.calls.length;
    f.gate.revoke("account-one");
    await expect(f.register().ready).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    expect(f.fake.closeAllConnections.mock.calls.length).toBe(closesBefore + 1);
    expect(f.runtime.getAccountStates()[0]).toEqual(
      expect.objectContaining({ state: "dormant", reason: "GATE_REVOKED" }),
    );
    await expect(f.register().ready).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
  });

  it("keeps the session unavailable until resolver cleanup finishes and rejects earlier evidence", async () => {
    const f = fixture();
    await f.activate();
    const dns = deferred();
    f.fake.clearHostResolverCache.mockReturnValueOnce(dns.promise);
    f.gate.revoke("account-one", "NETWORK_CHANGED");
    await settle();
    const readiness = f.register().ready;
    expect(f.runtime.check("account-one").allowed).toBe(false);
    f.gate.acceptEvidence("account-one", f.evidence());
    vi.advanceTimersByTime(10);
    f.gate.acceptEvidence("account-one", f.evidence());
    expect(f.runtime.check("account-one").allowed).toBe(false);
    dns.resolve();
    await readiness;
    expect(f.runtime.check("account-one").allowed).toBe(false);
    expect(f.runtime.getAccountStates()[0].proofExpiresAt).toBeNull();
  });

  it("keeps DNS cleanup failures dormant without clearing login storage or reusing old proofs", async () => {
    const f = fixture();
    await f.activate();
    const before = f.fake.clearStorageData.mock.calls.length;
    f.fake.clearHostResolverCache.mockRejectedValueOnce(new Error("private-resolver-detail"));
    f.gate.revoke("account-one", "NETWORK_CHANGED");
    await expect(f.register().ready).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    expect(f.runtime.getAccountStates()[0]).toMatchObject({ state: "dormant", reason: "GATE_REVOKED" });
    expect(f.fake.clearStorageData.mock.calls.slice(before)).toEqual([[{ storages: ["serviceworkers"] }]]);
    await expect(f.register().ready).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
  });

  it("keeps the Session closed when the page-suspension callback fails even if Chromium cleanup succeeds", async () => {
    const f = fixture();
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    const before = f.fake.clearStorageData.mock.calls.length;
    f.runtime.setSuspendHandler(() => {
      throw new Error("page close did not complete");
    });
    f.gate.revoke("account-one");
    expect(lease.signal.aborted).toBe(true);
    await expect(f.register().ready).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    expect(f.fake.clearStorageData.mock.calls.length).toBe(before + 1);
    expect(f.runtime.getAccountStates()[0]).toEqual(
      expect.objectContaining({ state: "dormant", reason: "GATE_REVOKED" }),
    );
    f.runtime.setSuspendHandler(() => undefined);
    f.gate.acceptEvidence("account-one", f.evidence());
    vi.advanceTimersByTime(10);
    f.gate.acceptEvidence("account-one", f.evidence());
    expect(f.runtime.check("account-one").allowed).toBe(false);
    expect(f.runtime.acquire("account-one")).toBeNull();
  });

  it("starts page suspension synchronously but waits for its completion after worker/connection cleanup", async () => {
    const f = fixture();
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    const pageClosed = deferred();
    const order: string[] = [];
    f.fake.clearHostResolverCache.mockImplementationOnce(async () => {
      order.push("dns-cleared");
    });
    f.runtime.setSuspendHandler(() => {
      expect(lease.signal.aborted).toBe(true);
      expect(f.runtime.check("account-one").allowed).toBe(false);
      order.push("close-started");
      return pageClosed.promise.then(() => {
        order.push("page-closed");
      });
    });
    const before = f.fake.closeAllConnections.mock.calls.length;
    f.gate.revoke("account-one");
    expect(order).toEqual(["close-started"]);
    const readiness = f.register().ready;
    let ready = false;
    void readiness.then(() => {
      ready = true;
    });
    await settle();
    expect(f.fake.closeAllConnections.mock.calls.length).toBe(before + 1);
    expect(ready).toBe(false);
    expect(f.runtime.check("account-one").allowed).toBe(false);
    expect(f.runtime.getAccountStates()[0].proofExpiresAt).toBeNull();
    expect(order).toEqual(["close-started"]);
    pageClosed.resolve();
    await readiness;
    expect(order).toEqual(["close-started", "page-closed", "dns-cleared"]);
    expect(ready).toBe(true);
    expect(f.runtime.check("account-one").allowed).toBe(false); // New proof is still required.
  });

  it("an asynchronous page-close rejection remains closed and does not skip independent connection cleanup", async () => {
    const f = fixture();
    await f.activate();
    const pageClosed = deferred(),
      workers = deferred();
    f.runtime.setSuspendHandler(() => pageClosed.promise);
    f.fake.clearStorageData.mockReturnValueOnce(workers.promise);
    const closesBefore = f.fake.closeAllConnections.mock.calls.length;
    f.gate.revoke("account-one");
    const readiness = f.register().ready;
    let finished = false;
    void readiness.catch(() => {
      finished = true;
    });
    pageClosed.reject();
    await settle();
    expect(finished).toBe(false);
    expect(f.runtime.getAccountStates()[0].state).toBe("dormant");
    workers.resolve();
    await expect(readiness).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    expect(f.fake.closeAllConnections.mock.calls.length).toBe(closesBefore + 1);
    expect(f.runtime.check("account-one").allowed).toBe(false);
  });

  it("worker cleanup failure still waits for the page-close operation to finish", async () => {
    const f = fixture();
    await f.activate();
    const pageClosed = deferred();
    f.runtime.setSuspendHandler(() => pageClosed.promise);
    f.fake.clearStorageData.mockRejectedValueOnce(new Error("worker cleanup failed"));
    const closesBefore = f.fake.closeAllConnections.mock.calls.length;
    f.gate.revoke("account-one");
    const readiness = f.register().ready;
    let finished = false;
    void readiness.catch(() => {
      finished = true;
    });
    await settle();
    expect(f.fake.closeAllConnections.mock.calls.length).toBe(closesBefore + 1);
    expect(finished).toBe(false);
    pageClosed.resolve();
    await expect(readiness).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    expect(f.runtime.check("account-one").allowed).toBe(false);
  });

  it("uses a resolved suspension step when no page handler was installed at startup", async () => {
    const f = fixture({ onSuspend: undefined });
    await f.register().ready;
    f.gate.revoke("account-one");
    await f.register().ready;
    expect(f.runtime.getAccountStates()[0].state).not.toBe("allowed");
  });

  it("retires deletion synchronously, keeps the Session guard, and restores the same identity with a new proof context", async () => {
    const f = fixture();
    await f.activate();
    const oldContext = f.register().contextId;
    const oldEvidence = f.evidence();
    const lease = f.runtime.acquire("account-one")!;
    const download = new FakeDownload();
    f.fake.emit("will-download", {}, download);
    const cleanup = deferred();
    f.fake.clearStorageData.mockReturnValueOnce(cleanup.promise);
    const removed = f.runtime.removeAccount("account-one");
    expect(lease.signal.aborted).toBe(true);
    expect(download.cancel).toHaveBeenCalledOnce();
    expect(f.gate.snapshot("account-one")).toEqual([]);
    expect(f.runtime.checkSessionRequest(f.fake.session, "about:blank").cancel).toBe(true);
    expect(f.fake.listenerCount("will-download")).toBe(1);
    expect(() => f.runtime.registerSession(f.fake.session, "other-account", "bilibili")).toThrow(
      "cannot be rebound",
    );
    expect(() => f.runtime.registerSession(new FakeSession().session, "account-one", "bilibili")).toThrow(
      "cannot be rebound",
    );
    cleanup.resolve();
    await removed;
    const restored = f.register();
    expect(restored.contextId).not.toBe(oldContext);
    await restored.ready;
    expect(f.runtime.check("account-one").allowed).toBe(false);
    expect(lease.isCurrent()).toBe(false);
    expect(f.gate.acceptEvidence("account-one", oldEvidence).allowed).toBe(false);
    await f.register().ready;
    f.gate.acceptEvidence("account-one", f.evidence());
    vi.advanceTimersByTime(10);
    expect(f.gate.acceptEvidence("account-one", f.evidence()).allowed).toBe(true);
    expect(f.runtime.check("account-one").allowed).toBe(true);
    expect(f.fake.setProxy).toHaveBeenCalledOnce();
    expect(f.fake.listenerCount("will-download")).toBe(1);
  });

  it("waits for pending retirement before a same-Session restore can become ready", async () => {
    const f = fixture();
    await f.activate();
    const first = deferred(),
      restoredCleanup = deferred();
    f.fake.clearStorageData.mockReturnValueOnce(first.promise).mockReturnValueOnce(restoredCleanup.promise);
    const removal = f.runtime.resetAccount("account-one");
    const restored = f.register();
    let ready = false;
    void restored.ready.then(() => {
      ready = true;
    });
    await settle();
    first.resolve();
    await settle();
    expect(ready).toBe(false);
    expect(f.runtime.check("account-one").allowed).toBe(false);
    restoredCleanup.resolve();
    await restored.ready;
    await removal;
    expect(f.runtime.check("account-one").allowed).toBe(false);
  });

  it("reconciles removed rows without reviving restored records or permitting a platform change", async () => {
    const f = fixture();
    await f.activate();
    await f.runtime.reconcileAccounts([]);
    expect(f.gate.snapshot()).toEqual([]);
    await f.runtime.reconcileAccounts([{ id: "account-one", platformId: "bilibili" }]);
    expect(f.gate.snapshot()).toEqual([]);
    await expect(f.runtime.reconcileAccounts([{ id: "account-one", platformId: "douyin" }])).rejects.toThrow(
      "cannot change platform",
    );
    expect(() => f.runtime.registerSession(f.fake.session, "account-one", "douyin")).toThrow(
      "cannot be rebound",
    );
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/").cancel).toBe(true);
  });

  it("preflights active and retired identity collisions without changing lifecycle state", async () => {
    const f = fixture();
    await f.activate();
    const before = f.gate.snapshot();
    const suspendCount = f.suspend.mock.calls.length;
    expect(() => f.runtime.assertAccountIdentities([{ id: "account-one", platformId: "douyin" }])).toThrow(
      "cannot change platform",
    );
    expect(f.gate.snapshot()).toEqual(before);
    expect(f.suspend).toHaveBeenCalledTimes(suspendCount);
    await f.runtime.removeAccount("account-one");
    const closes = f.fake.closeAllConnections.mock.calls.length;
    const removedGeneration = f.gate.generation;
    expect(() => f.runtime.assertAccountIdentities([{ id: "account-one", platformId: "douyin" }])).toThrow(
      "cannot change platform",
    );
    expect(() =>
      f.runtime.assertAccountIdentities([
        { id: "account-one", platformId: "bilibili" },
        { id: "new-account", platformId: "douyin" },
      ]),
    ).not.toThrow();
    expect(f.gate.snapshot()).toEqual([]);
    expect(f.gate.generation).toBe(removedGeneration);
    expect(f.fake.closeAllConnections).toHaveBeenCalledTimes(closes);
  });

  it("rejects malformed identity preflight without retiring any current account", async () => {
    const f = fixture();
    await f.activate();
    expect(() =>
      f.runtime.assertAccountIdentities([
        { id: "account-one", platformId: "bilibili" },
        { id: "account-one", platformId: "bilibili" },
      ]),
    ).toThrow("Invalid domestic");
    expect(() =>
      f.runtime.assertAccountIdentities([{ id: "new-account", platformId: "youtube" as never }]),
    ).toThrow("Invalid domestic");
    expect(f.runtime.check("account-one").allowed).toBe(true);
  });

  it("keeps failed retirement visible on repeated reconciliation", async () => {
    const f = fixture();
    await f.activate();
    f.fake.clearStorageData.mockRejectedValueOnce(new Error("worker shutdown failed"));
    await expect(f.runtime.reconcileAccounts([])).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    await expect(f.runtime.reconcileAccounts([])).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    expect(f.runtime.check("account-one").allowed).toBe(false);
  });

  it("tears down explicit account deletion in observation mode without changing its proxy settings", async () => {
    const f = fixture({ enforcement: "observe" });
    await f.register().ready;
    const download = new FakeDownload();
    f.fake.emit("will-download", {}, download);
    expect(download.cancel).not.toHaveBeenCalled();
    await f.runtime.removeAccount("account-one");
    expect(download.cancel).toHaveBeenCalledOnce();
    expect(f.suspend).toHaveBeenCalledWith("account-one");
    expect(f.fake.clearStorageData).toHaveBeenCalledWith({ storages: ["serviceworkers"] });
    expect(f.fake.setProxy).not.toHaveBeenCalled();
  });

  it("keeps initialization failure closed without changing to a proxy fallback", async () => {
    const f = fixture();
    f.fake.setProxy.mockRejectedValueOnce(new Error("raw proxy configuration failure"));
    await expect(f.register().ready).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    expect(f.fake.setProxy.mock.calls).toEqual([[{ mode: "direct" }]]);
    expect(f.runtime.check("account-one").allowed).toBe(false);
  });

  it("observation mode never changes business proxy, cancels, cleans workers or acquires leases", async () => {
    const f = fixture({ enforcement: "observe" });
    await f.register().ready;
    const item = new FakeDownload();
    f.fake.emit("will-download", {}, item);
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://unknown.example.com/").cancel).toBe(false);
    f.gate.invalidate();
    expect(f.runtime.acquire("account-one")).toBeNull();
    await f.runtime.dispose();
    expect(f.fake.setProxy).not.toHaveBeenCalled();
    expect(f.fake.closeAllConnections).not.toHaveBeenCalled();
    expect(f.fake.clearStorageData).not.toHaveBeenCalled();
    expect(item.cancel).not.toHaveBeenCalled();
    expect(f.suspend).not.toHaveBeenCalled();
  });

  it("uses only fresh observer reads and never manufactures proof from healthy lights", async () => {
    const f = fixture();
    await f.register().ready;
    const snapshot: NetworkSnapshot = {
      ...checkingNetworkSnapshot(),
      instanceId: "observer-a",
      sequence: 1,
      checkedAt: new Date().toISOString(),
      rulesVersion: network.rulesVersion,
      controller: { readable: true, mode: "rule", tun: true, version: "test", ruleCount: 1 },
    };
    snapshot.direct = {
      state: "reachable",
      country: "CN",
      asn: 64512,
      maskedIp: "192.0.*.*",
      checkedAt: snapshot.checkedAt,
      routeVerified: true,
    };
    f.runtime.onObservation(snapshot);
    await f.register().ready;
    expect(f.runtime.check("account-one").allowed).toBe(false);
    const update = vi.spyOn(f.gate, "setNetworkState");
    f.runtime.onObservation({ ...snapshot, sequence: 2, state: "dual" });
    expect(update).not.toHaveBeenCalled(); // Diagnostic publication is not a new controller read.
    f.runtime.onObservation({ ...snapshot, instanceId: "observer-b", sequence: 1 });
    expect(update).toHaveBeenCalledOnce();
    f.runtime.onObservation({ ...snapshot, sequence: 99 });
    expect(update).toHaveBeenCalledOnce(); // A retired observer cannot revive itself via a larger number.
  });

  it("does not issue leases after disposal and waits for final Session cleanup", async () => {
    const f = fixture();
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    const cleanup = deferred();
    f.fake.clearStorageData.mockReturnValueOnce(cleanup.promise);
    const disposal = f.runtime.dispose();
    expect(lease.signal.aborted).toBe(true);
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/").cancel).toBe(true);
    cleanup.resolve();
    await disposal;
    expect(f.fake.listenerCount("will-download")).toBe(0);
    expect(f.runtime.acquire("account-one")).toBeNull();
  });

  it("publishes no implicit home scope; first real operation becomes visible only after Session protection", async () => {
    const f = fixture({ resolveCatalog: reviewedCatalog }, true);
    const proxy = deferred();
    f.fake.setProxy.mockReturnValueOnce(proxy.promise);
    const events: RuntimeProofScopeEvent[] = [];
    f.runtime.subscribeProofScopes((event) => {
      events.push(event);
      if (event.type === "upsert") {
        expect(f.runtime.listProofScopes()).toEqual([event.scope]);
        expect(f.gate.registeredScopes()).toEqual([event.scope]);
        expect(f.runtime.check("account-one").allowed).toBe(false);
      }
    });
    const registered = f.register();
    expect(f.runtime.listProofScopes()).toEqual([]);
    expect(f.gate.registeredScopes()).toEqual([]);
    const selected = f.runtime.prepareOperation("account-one", {
      operation: "check-status",
      activePageOrigin: null,
    });
    expect(selected.contextId).toBe(registered.contextId);
    expect(f.gate.registeredScopes()[0].targets.map((value) => value.host)).toEqual([
      "api.bilibili.com",
      "api.bilibili.com",
    ]);
    expect(events).toEqual([]);
    await settle();
    proxy.resolve();
    await selected.ready;
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0])).toEqual(["type", "scope"]);
    expect(f.runtime.listProofScopes()[0]).not.toHaveProperty("session");
    const copy = f.runtime.listProofScopes()[0];
    (copy.targets[0] as ProofTarget).host = "tampered.example.test";
    expect(f.runtime.listProofScopes()[0].targets[0].host).toBe("api.bilibili.com");
  });

  it("lets independently reviewed same-boundary background probe/profile/collect join without destroying a QR page", async () => {
    const f = fixture({ resolveCatalog: reviewedCatalog }, true, [target], "douyin");
    await f.register().ready;
    await f.runtime.setPageOperation("account-one", { operation: "view-login", activePageOrigin: null })
      .ready;
    expect((await f.activate()).allowed).toBe(true);
    const lease = f.runtime.acquire("account-one")!;
    const scope = f.runtime.listProofScopes()[0];
    const suspends = f.suspend.mock.calls.length;
    const scopes: RuntimeProofScopeEvent[] = [];
    f.runtime.subscribeProofScopes((event) => scopes.push(event));
    for (const operation of ["check-status", "profile", "collect", "keepalive", "check-status"] as const) {
      const result = f.runtime.prepareOperation("account-one", {
        operation,
        activePageOrigin: origin("creator.douyin.com"),
      });
      await result.ready;
      expect(result.scopeVersion).toBe(scope.catalogVersion);
    }
    expect(lease.isCurrent()).toBe(true);
    expect(f.runtime.listProofScopes()).toEqual([scope]);
    expect(f.suspend).toHaveBeenCalledTimes(suspends);
    expect(scopes).toEqual([]);
    for (let i = 0; i < 8; i++) {
      expect(
        f.runtime.checkSessionRequest(f.fake.session, "https://creator.douyin.com/resource").allowed,
      ).toBe(true);
      f.runtime.acquire("account-one")!.release();
    }
    expect(scopes).toEqual([]); // Nested requests never declare or shrink a scope.
    lease.release();
  });

  it("revokes before adding a real API target, merges concurrent entries, and retains all-required AND", async () => {
    const f = fixture({ resolveCatalog: reviewedCatalog }, true);
    await f.register().ready;
    await f.runtime.setPageOperation("account-one", { operation: "view-home", activePageOrigin: null }).ready;
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    const old = f.runtime.listProofScopes()[0];
    const cleanup = deferred();
    f.fake.closeAllConnections.mockReturnValueOnce(cleanup.promise);
    const events: RuntimeProofScopeEvent[] = [];
    f.runtime.subscribeProofScopes((event) => {
      events.push(event);
      if (event.type === "remove") {
        expect(f.runtime.listProofScopes()).toEqual([]);
        expect(lease.signal.aborted).toBe(true);
        expect(f.gate.registeredScopes()[0].targets.some((value) => value.host === "api.bilibili.com")).toBe(
          true,
        );
      }
    });
    const profile = f.runtime.prepareOperation("account-one", {
      operation: "profile",
      activePageOrigin: origin("member.bilibili.com"),
    });
    expect(lease.signal.aborted).toBe(true);
    expect(profile.scopeVersion).not.toBe(old.catalogVersion);
    const suspends = f.suspend.mock.calls.length;
    const collect = f.runtime.prepareOperation("account-one", {
      operation: "collect",
      activePageOrigin: origin("member.bilibili.com"),
    });
    const probe = f.runtime.prepareOperation("account-one", {
      operation: "check-status",
      activePageOrigin: origin("member.bilibili.com"),
    });
    expect(collect.scopeVersion).toBe(profile.scopeVersion);
    expect(probe.scopeVersion).toBe(profile.scopeVersion);
    expect(f.suspend).toHaveBeenCalledTimes(suspends);
    expect(events.map((event) => event.type)).toEqual(["remove"]);
    await settle();
    cleanup.resolve();
    await Promise.all([profile.ready, collect.ready, probe.ready]);
    expect(events.map((event) => event.type)).toEqual(["remove", "upsert"]);
    expect(f.runtime.listProofScopes()[0].targets).toHaveLength(4);
    f.gate.acceptEvidence("account-one", f.evidence());
    vi.advanceTimersByTime(10);
    const failedApi = f.evidence();
    failedApi.targets.find((value) => value.target.host === "api.bilibili.com")!.egress.countryCode = "JP";
    expect(f.gate.acceptEvidence("account-one", failedApi).allowed).toBe(false);
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://member.bilibili.com/").allowed).toBe(false);
  });

  it("does not reuse a same-origin permit for an unreviewed new operation", async () => {
    const f = fixture(
      {
        resolveCatalog: (input) =>
          input.operation === "collect" ? resolveOperationCatalog(input) : reviewedCatalog(input),
      },
      true,
      [target],
      "douyin",
    );
    await f.register().ready;
    await f.runtime.setPageOperation("account-one", { operation: "view-login", activePageOrigin: null })
      .ready;
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    const selected = f.runtime.prepareOperation("account-one", {
      operation: "collect",
      activePageOrigin: origin("creator.douyin.com"),
    });
    expect(lease.signal.aborted).toBe(true);
    await selected.ready;
    expect(f.runtime.listProofScopes()[0].catalogReviewed).toBe(false);
    expect(f.gate.acceptEvidence("account-one", f.evidence()).reason).toBe("CATALOG_UNVERIFIED");
  });

  it("retires evidence when an already-used review changes, even if its origins do not", async () => {
    let version = "review-one";
    const f = fixture({ resolveCatalog: (input) => reviewedCatalog(input, version) }, true);
    await f.register().ready;
    await f.runtime.setPageOperation("account-one", { operation: "view-home", activePageOrigin: null }).ready;
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    const previous = f.runtime.listProofScopes()[0];
    version = "review-two";
    const selected = f.runtime.setPageOperation("account-one", {
      operation: "view-home",
      activePageOrigin: origin("member.bilibili.com"),
    });
    expect(selected.scopeVersion).not.toBe(previous.catalogVersion);
    expect(lease.signal.aborted).toBe(true);
    await selected.ready;
    expect(f.runtime.check("account-one").allowed).toBe(false);
  });

  it("treats reviewed optional range changes as a boundary change without forcing optional targets into the AND set", async () => {
    let extra = false;
    const f = fixture(
      {
        resolveCatalog: (input) => {
          const result = reviewedCatalog(input);
          // Even a faulty trusted resolver that forgets to bump its version cannot silently widen scope.
          if (extra)
            result.reviewedRequestRange = [...result.reviewedRequestRange, origin("static.example.test")];
          return result;
        },
      },
      true,
    );
    await f.register().ready;
    await f.runtime.setPageOperation("account-one", { operation: "view-home", activePageOrigin: null }).ready;
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    extra = true;
    await f.runtime.setPageOperation("account-one", { operation: "view-home", activePageOrigin: null }).ready;
    expect(lease.signal.aborted).toBe(true);
    expect(f.runtime.listProofScopes()[0].targets.map((value) => value.host)).toEqual([
      "member.bilibili.com",
      "member.bilibili.com",
    ]);
  });

  it("keeps page retries idempotent with the sticky background union, but custom site navigation starts a new page epoch", async () => {
    const f = fixture({ resolveCatalog: reviewedCatalog }, true);
    await f.register().ready;
    await f.runtime.setPageOperation("account-one", { operation: "view-home", activePageOrigin: null }).ready;
    await f.runtime.prepareOperation("account-one", {
      operation: "profile",
      activePageOrigin: origin("member.bilibili.com"),
    }).ready;
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    const prior = f.runtime.listProofScopes()[0];
    await f.runtime.setPageOperation("account-one", {
      operation: "view-home",
      activePageOrigin: origin("member.bilibili.com"),
    }).ready;
    expect(f.runtime.listProofScopes()).toEqual([prior]);
    expect(lease.isCurrent()).toBe(true);
    const destination = origin("www.bilibili.com");
    const site = f.runtime.setPageOperation("account-one", {
      operation: "view-navigate",
      activePageOrigin: origin("member.bilibili.com"),
      targetPageOrigin: destination,
    });
    destination.host = "tampered.example.test";
    expect(lease.signal.aborted).toBe(true);
    await site.ready;
    expect(f.runtime.listProofScopes()[0].targets.map((value) => value.host)).toEqual([
      "www.bilibili.com",
      "www.bilibili.com",
    ]);
    const version = f.runtime.listProofScopes()[0].catalogVersion;
    await f.runtime.setPageOperation("account-one", {
      operation: "view-navigate",
      activePageOrigin: origin("www.bilibili.com"),
      targetPageOrigin: origin("www.bilibili.com"),
    }).ready;
    expect(f.runtime.listProofScopes()[0].catalogVersion).toBe(version);
  });

  it("withdraws scope before reset and does not publish failed cleanup or resurrect a removed account", async () => {
    const f = fixture({ resolveCatalog: reviewedCatalog }, true);
    await f.register().ready;
    await f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null })
      .ready;
    const events: RuntimeProofScopeEvent[] = [];
    f.runtime.subscribeProofScopes(() => {
      throw new Error("broken-subscriber");
    });
    const unsubscribe = f.runtime.subscribeProofScopes((event) => {
      events.push(event);
      if (event.type === "remove") expect(f.runtime.listProofScopes()).toEqual([]);
    });
    f.fake.clearStorageData.mockRejectedValueOnce(new Error("cleanup-failed"));
    await expect(f.runtime.resetAccount("account-one")).rejects.toThrow("ACCOUNT_SESSION_PROTECTION_FAILED");
    expect(events).toEqual([{ type: "remove", accountId: "account-one" }]);
    expect(f.runtime.listProofScopes()).toEqual([]);
    expect(() =>
      f.runtime.prepareOperation("account-one", { operation: "profile", activePageOrigin: null }),
    ).toThrow("ACCOUNT_SESSION_NOT_REGISTERED");
    unsubscribe();
  });

  it("rejects missing page identity, foreign destinations and a mismatched resolver without retaining old authority", async () => {
    const f = fixture({ resolveCatalog: reviewedCatalog }, true);
    await f.register().ready;
    await f.runtime.setPageOperation("account-one", { operation: "view-home", activePageOrigin: null }).ready;
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    expect(() => f.runtime.prepareOperation("account-one", { operation: "collect" } as never)).toThrow(
      "INVALID_BUSINESS_OPERATION_SCOPE",
    );
    expect(lease.signal.aborted).toBe(true);
    expect(f.runtime.listProofScopes()).toEqual([]);
    await f.register().ready;
    expect(() =>
      f.runtime.setPageOperation("account-one", {
        operation: "view-navigate",
        activePageOrigin: null,
        targetPageOrigin: origin("foreign.example.test"),
      }),
    ).toThrow("INVALID_BUSINESS_OPERATION_SCOPE");
    const bad = fixture(
      { resolveCatalog: () => reviewedCatalog({ platformId: "douyin", operation: "view-home" }) },
      true,
    );
    await bad.register().ready;
    expect(() =>
      bad.runtime.prepareOperation("account-one", { operation: "collect", activePageOrigin: null }),
    ).toThrow("INVALID_BUSINESS_OPERATION_SCOPE");
    expect(bad.runtime.listProofScopes()).toEqual([]);
  });

  it("keeps observation declarations and declaration failures free of cancellation or Session changes", async () => {
    const f = fixture({ enforcement: "observe" }, true);
    await f.register().ready;
    await f.runtime.setPageOperation("account-one", { operation: "view-home", activePageOrigin: null }).ready;
    await f.runtime.prepareOperation("account-one", {
      operation: "collect",
      activePageOrigin: origin("member.bilibili.com"),
    }).ready;
    expect(() => f.runtime.prepareOperation("account-one", { operation: "profile" } as never)).toThrow(
      "INVALID_BUSINESS_OPERATION_SCOPE",
    );
    expect(f.runtime.checkSessionRequest(f.fake.session, "https://unrelated.example.test/").cancel).toBe(
      false,
    );
    expect(f.suspend).not.toHaveBeenCalled();
    expect(f.fake.setProxy).not.toHaveBeenCalled();
    expect(f.fake.closeAllConnections).not.toHaveBeenCalled();
    expect(f.fake.clearStorageData).not.toHaveBeenCalled();
  });

  it("refreshes changed or removed reviews synchronously without waiting for the next business entry", async () => {
    let version: string | null = "review-one";
    const f = fixture(
      {
        resolveCatalog: (input) =>
          version ? reviewedCatalog(input, version) : resolveOperationCatalog(input),
      },
      true,
    );
    await f.register().ready;
    await f.runtime.setPageOperation("account-one", { operation: "view-home", activePageOrigin: null }).ready;
    await f.activate();
    const lease = f.runtime.acquire("account-one")!;
    const previous = f.runtime.listProofScopes()[0];
    await f.runtime.refreshOperationCatalogs();
    expect(lease.isCurrent()).toBe(true);
    expect(f.runtime.listProofScopes()).toEqual([previous]);
    version = "review-two";
    const changed = f.runtime.refreshOperationCatalogs("account-one");
    expect(lease.signal.aborted).toBe(true);
    expect(f.runtime.listProofScopes()).toEqual([]);
    await changed;
    expect(f.runtime.listProofScopes()[0].catalogVersion).not.toBe(previous.catalogVersion);
    await f.activate();
    const fresh = f.runtime.acquire("account-one")!;
    version = null;
    const removed = f.runtime.refreshOperationCatalogs();
    expect(fresh.signal.aborted).toBe(true);
    await removed;
    expect(f.runtime.listProofScopes()[0].catalogReviewed).toBe(false);
    expect(f.runtime.check("account-one").allowed).toBe(false);
  });

  it("refreshes the rest of the accounts after a manifest resolver throws, with a fixed failure and no leaked URL", async () => {
    let broken = false;
    const f = fixture(
      {
        resolveCatalog: (input) => {
          if (broken && input.platformId === "bilibili")
            throw new Error("https://private.example.test/?token=secret");
          return reviewedCatalog(input, broken ? "review-two" : "review-one");
        },
      },
      true,
    );
    const second = new FakeSession();
    await f.register().ready;
    await f.runtime.registerSession(second.session, "account-two", "douyin").ready;
    await f.runtime.prepareOperation("account-one", { operation: "check-status", activePageOrigin: null })
      .ready;
    await f.runtime.prepareOperation("account-two", { operation: "check-status", activePageOrigin: null })
      .ready;
    const previous = f.runtime
      .listProofScopes()
      .find((scope) => scope.accountId === "account-two")!.catalogVersion;
    broken = true;
    await expect(f.runtime.refreshOperationCatalogs()).rejects.toThrow(/^OPERATION_CATALOG_REFRESH_FAILED$/);
    expect(f.runtime.listProofScopes().map((scope) => scope.accountId)).toEqual(["account-two"]);
    expect(f.runtime.listProofScopes()[0].catalogVersion).not.toBe(previous);
    expect(f.runtime.getAccountStates().find((state) => state.accountId === "account-one")).toMatchObject({
      state: "checking",
      proofExpiresAt: null,
    });
  });
});
