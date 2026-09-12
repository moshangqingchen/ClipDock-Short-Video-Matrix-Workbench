import { describe, expect, it, vi } from "vitest";
import { EgressGate, type GateClock, type GateRevocation } from "./egress-gate";
import type {
  AccountProofScope,
  CorrelatedConnectionEvidence,
  DirectEvidenceBatch,
  ProofTarget,
} from "./direct-proof";

class TestClock implements GateClock {
  now = 0;
  wallOffset = Date.parse("2026-09-07T12:00:00Z");
  timers = new Map<number, { at: number; callback: () => void }>();
  private nextId = 0;
  monotonicMs = () => this.now;
  wallTimeMs = () => this.wallOffset + this.now;
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number);
  };
  advance(ms: number) {
    const until = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = until;
  }
}

const target: ProofTarget = {
  protocol: "https:",
  host: "member.bilibili.com",
  port: 443,
  addressFamily: "ipv4",
};
const scope: AccountProofScope = {
  accountId: "account-one",
  platformId: "bilibili",
  contextId: "chromium-context-validated",
  catalogReviewed: true,
  catalogVersion: "reviewed-catalog-one",
  targets: [target],
};
const network = { controllerReadable: true, mode: "rule", tun: true, rulesVersion: "live-rules-a" };

function fixture(enforcement: "observe" | "strict" = "strict") {
  const clock = new TestClock();
  const gate = new EgressGate({ clock, enforcement });
  gate.registerAccount(scope);
  let sample = 0;
  function evidence(overrides: Partial<DirectEvidenceBatch> = {}): DirectEvidenceBatch {
    const at = clock.now;
    return {
      sampleId: `round-${++sample}`,
      generation: gate.generation,
      rulesVersion: network.rulesVersion,
      contextId: scope.contextId,
      catalogVersion: scope.catalogVersion,
      observedAtMono: at,
      targets: [
        {
          target: { ...target },
          route: {
            source: "correlated-connection",
            contextId: scope.contextId,
            rulesVersion: network.rulesVersion,
            ruleDecision: "direct",
            connectionId: `current-anonymous-connection-${sample}`,
            correlationVerified: true,
            chains: ["DIRECT"],
            observedAtMono: at,
          },
          egress: {
            target: { ...target },
            contextId: scope.contextId,
            ip: "192.0.2.1",
            countryCode: "CN",
            asn: 64512,
            source: "synthetic-controlled-receiver",
            applicabilityVerified: true,
            observedAtMono: at,
          },
          tls: { verified: true, observedAtMono: at },
          dns: { status: "resolved", addressFamily: "ipv4", observedAtMono: at },
        },
      ],
      ...overrides,
    };
  }
  const check = () => gate.checkAction(scope.accountId, scope.contextId);
  function refresh() {
    gate.setNetworkState(network);
  }
  function activate() {
    refresh();
    gate.acceptEvidence(scope.accountId, evidence());
    clock.advance(10_000);
    refresh();
    clock.advance(5_000);
    refresh();
    return gate.acceptEvidence(scope.accountId, evidence());
  }
  return { gate, clock, evidence, check, refresh, activate };
}

describe("EgressGate authority", () => {
  it("exposes only a fresh rule-mode sampling version and not account permission", () => {
    const f = fixture();
    expect(f.gate.currentProofVersion()).toBeNull();
    const observations: { announced: unknown; actual: unknown }[] = [];
    const committed = vi.fn((version) => {
      observations.push({ announced: version, actual: f.gate.currentProofVersion() });
    });
    f.gate.on("network", committed);
    f.refresh();
    const version = f.gate.currentProofVersion()!;
    expect(version).toEqual({ generation: f.gate.generation, rulesVersion: network.rulesVersion });
    version.rulesVersion = "mutated-copy";
    expect(f.gate.currentProofVersion()?.rulesVersion).toBe(network.rulesVersion);
    expect(f.check().allowed).toBe(false);
    f.gate.setNetworkState({ ...network, mode: "global" });
    expect(f.gate.currentProofVersion()).toBeNull();
    f.refresh();
    f.clock.now += 15_000; // Getter must expire even if a suspended event loop has not run its timer.
    expect(f.gate.currentProofVersion()).toBeNull();
    expect(committed.mock.calls.at(-1)?.[0]).toBeNull();
    f.gate.dispose();
    expect(f.gate.currentProofVersion()).toBeNull();
    for (const item of observations) expect(item.announced).toEqual(item.actual);
  });

  it("boots closed and exposes only a transient checking projection", () => {
    const f = fixture();
    expect(f.check()).toEqual(
      expect.objectContaining({
        allowed: false,
        enforce: true,
        cancel: true,
        reason: "CHECKING",
        proofId: null,
      }),
    );
    expect(f.gate.snapshot()).toEqual([
      {
        accountId: scope.accountId,
        state: "checking",
        reason: "CHECKING",
        generation: 1,
        checkedAt: null,
        proofExpiresAt: null,
      },
    ]);
    const projection = f.gate.snapshot();
    projection[0].state = "allowed";
    expect(f.check().allowed).toBe(false);
    f.gate.dispose();
  });

  it("requires two new successful rounds 15 seconds apart in the same scope", () => {
    const f = fixture();
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(false);
    f.clock.advance(10_000);
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(false);
    f.clock.advance(5_000);
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(true);
    expect(f.gate.snapshot()[0]).toEqual(
      expect.objectContaining({
        state: "allowed",
        reason: "READY",
        proofExpiresAt: "2026-09-07T12:00:30.000Z",
      }),
    );
    f.gate.dispose();
  });

  it("does not count reused IDs or renamed cached observations as new rounds", () => {
    const f = fixture();
    f.refresh();
    const first = f.evidence();
    f.gate.acceptEvidence(scope.accountId, first);
    f.clock.advance(10_000);
    f.refresh();
    const cached = structuredClone(first);
    cached.sampleId = "renamed-cache";
    cached.observedAtMono = f.clock.now;
    expect(f.gate.acceptEvidence(scope.accountId, cached).allowed).toBe(false);
    f.clock.advance(5_000);
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence({ sampleId: first.sampleId })).allowed).toBe(
      false,
    );
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(true);
    f.gate.dispose();
  });

  it("measures the warm-up gap on actual target observations rather than batch publication time", () => {
    const f = fixture();
    f.refresh();
    f.gate.acceptEvidence(scope.accountId, f.evidence());
    f.clock.advance(10_000);
    f.refresh();
    const tooClose = f.evidence();
    f.clock.advance(5_000);
    f.refresh();
    tooClose.observedAtMono = f.clock.now;
    expect(f.gate.acceptEvidence(scope.accountId, tooClose).allowed).toBe(false);
    f.clock.advance(5_000);
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(true);
    f.gate.dispose();
  });

  it("resets warm-up on failure and rejects previous network generations", () => {
    const f = fixture();
    f.refresh();
    const old = f.evidence();
    f.gate.acceptEvidence(scope.accountId, old);
    f.clock.advance(10_000);
    f.refresh();
    const failed = f.evidence();
    (failed.targets[0].route as CorrelatedConnectionEvidence).ruleDecision = "unknown";
    expect(f.gate.acceptEvidence(scope.accountId, failed).reason).toBe("RULE_UNVERIFIABLE");
    f.clock.advance(5_000);
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(false);
    f.gate.invalidate();
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, { ...old, observedAtMono: f.clock.now }).reason).toBe(
      "NETWORK_CHANGED",
    );
    f.gate.dispose();
  });

  it("cannot carry a warm-up sample across context or reviewed target-set changes", () => {
    const f = fixture();
    f.refresh();
    f.gate.acceptEvidence(scope.accountId, f.evidence());
    f.clock.advance(10_000);
    f.refresh();
    f.gate.registerAccount({ ...scope, catalogVersion: "reviewed-catalog-two" });
    f.clock.advance(5_000);
    f.refresh();
    expect(
      f.gate.acceptEvidence(scope.accountId, f.evidence({ catalogVersion: "reviewed-catalog-two" })).allowed,
    ).toBe(false);
    expect(f.gate.checkAction(scope.accountId, "other-process-context").reason).toBe("CONTEXT_UNVERIFIED");
    f.gate.dispose();
  });

  it("does not use a late pre-revocation success as the first recovery round", () => {
    const f = fixture();
    f.refresh();
    f.gate.acceptEvidence(scope.accountId, f.evidence());
    f.clock.advance(5_000);
    const lateSuccess = f.evidence();
    f.clock.advance(5_000);
    f.refresh();
    f.gate.revoke(scope.accountId);
    expect(f.gate.acceptEvidence(scope.accountId, lateSuccess)).toEqual(
      expect.objectContaining({ allowed: false, reason: "GATE_REVOKED" }),
    );
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(false);
    f.clock.advance(10_000);
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(false);
    f.clock.advance(5_000);
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(true);
    f.gate.dispose();
  });

  it("retains sample deduplication across account-local revocation", () => {
    const f = fixture();
    f.refresh();
    const first = f.evidence();
    f.gate.acceptEvidence(scope.accountId, first);
    f.clock.advance(10_000);
    f.refresh();
    f.gate.revoke(scope.accountId);
    // Even fresh-looking timestamps cannot reuse a round ID that already completed.
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence({ sampleId: first.sampleId })).reason).toBe(
      "GATE_REVOKED",
    );
    f.clock.advance(10_000);
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(false);
    f.gate.dispose();
  });

  it.each([
    { host: "passport.bilibili.com" },
    { host: "member.bilibili.com.attacker.test" },
    { port: 8443 },
    { protocol: "wss:" as const },
    { addressFamily: "ipv6" as const },
  ])("refuses an unproved request variant %j and revokes the account", (changed) => {
    const f = fixture();
    expect(f.activate().allowed).toBe(true);
    const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
    expect(
      f.gate.checkRequest({
        accountId: scope.accountId,
        contextId: scope.contextId,
        target: { ...target, ...changed },
      }),
    ).toEqual(expect.objectContaining({ allowed: false, cancel: true, reason: "UNKNOWN_TARGET" }));
    expect(lease.signal.aborted).toBe(true);
    expect(f.check().allowed).toBe(false);
    f.gate.dispose();
  });

  it("never borrows another account/context proof and permits canonical spelling only", () => {
    const f = fixture();
    f.activate();
    expect(
      f.gate.checkRequest({
        accountId: scope.accountId,
        contextId: scope.contextId,
        target: { ...target, host: "MEMBER.BILIBILI.COM." },
      }).allowed,
    ).toBe(true);
    expect(f.gate.checkRequest({ accountId: scope.accountId, contextId: "node-probe", target }).allowed).toBe(
      false,
    );
    expect(
      f.gate.checkRequest({ accountId: "other-account", contextId: scope.contextId, target }).allowed,
    ).toBe(false);
    f.gate.dispose();
  });

  it("proactively closes expired permits and aborts active tasks without a new request", () => {
    const f = fixture();
    f.activate();
    const revoked = vi.fn<(value: GateRevocation) => void>();
    f.gate.on("revoked", revoked);
    const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
    let wasClosedDuringAbort = false;
    lease.signal.addEventListener("abort", () => {
      wasClosedDuringAbort = !f.check().allowed;
    });
    f.clock.advance(10_000);
    f.refresh(); // Fresh controller data alone must not renew target proof.
    f.clock.advance(5_000);
    expect(lease.signal.aborted).toBe(true);
    expect(wasClosedDuringAbort).toBe(true);
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ reason: "PROOF_EXPIRED", enforce: true }));
    expect(lease.isCurrent()).toBe(false);
    expect(f.gate.snapshot()[0].state).toBe("dormant");
    f.gate.dispose();
  });

  it("renews before expiry without interrupting leases or repeating warm-up", () => {
    const f = fixture();
    const first = f.activate();
    const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
    f.clock.advance(10_000);
    f.refresh();
    const renewed = f.gate.acceptEvidence(scope.accountId, f.evidence());
    expect(renewed.allowed).toBe(true);
    expect(renewed.proofId).not.toBe(first.proofId);
    f.clock.advance(6_000);
    expect(lease.isCurrent()).toBe(true);
    expect(lease.signal.aborted).toBe(false);
    lease.release();
    expect(lease.isCurrent()).toBe(false);
    f.gate.dispose();
  });

  it.each(["global", "controller loss", "configuration change", "explicit invalidation"])(
    "revokes in-flight work on %s",
    (change) => {
      const f = fixture();
      f.activate();
      const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
      const oldGeneration = f.gate.generation;
      if (change === "global") f.gate.setNetworkState({ ...network, mode: "global" });
      else if (change === "controller loss")
        f.gate.setNetworkState({ ...network, controllerReadable: false });
      else if (change === "configuration change")
        f.gate.setNetworkState({ ...network, rulesVersion: "live-rules-b" });
      else f.gate.invalidate();
      expect(f.gate.generation).toBeGreaterThan(oldGeneration);
      expect(lease.signal.aborted).toBe(true);
      expect(lease.isCurrent()).toBe(false);
      expect(f.check().allowed).toBe(false);
      f.gate.dispose();
    },
  );

  it("expires a lost controller proactively and preserves refusal after restarting with the same rules", () => {
    const f = fixture();
    f.activate();
    const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
    f.clock.advance(15_000);
    expect(lease.signal.aborted).toBe(true);
    expect(f.check().reason).toBe("CONTROLLER_UNAVAILABLE");
    f.refresh();
    expect(f.gate.acceptEvidence(scope.accountId, f.evidence()).allowed).toBe(false);
    f.gate.dispose();
  });

  it("uses monotonic time for authority when the wall clock jumps backward or forward", () => {
    const f = fixture();
    f.activate();
    f.clock.wallOffset -= 86_400_000;
    expect(f.check().allowed).toBe(true);
    f.clock.wallOffset += 365 * 86_400_000;
    expect(f.check().allowed).toBe(true);
    f.clock.advance(15_000);
    expect(f.check().allowed).toBe(false);
    f.gate.dispose();
  });

  it("subtracts controller read age rather than refreshing a cached observation's lifetime", () => {
    const f = fixture();
    f.gate.setNetworkState(network, 10_000);
    const events = vi.fn();
    f.gate.on("revoked", events);
    f.clock.advance(5_000);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ reason: "CONTROLLER_UNAVAILABLE" }));
    f.gate.setNetworkState(network, -1);
    expect(f.check().allowed).toBe(false);
    f.gate.dispose();
  });

  it("continues notifying Session owners even when another revocation subscriber throws", () => {
    const f = fixture();
    f.activate();
    const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
    f.gate.on("revoked", () => {
      throw new Error("failed UI/audit subscriber");
    });
    const sessionOwner = vi.fn();
    f.gate.once("revoked", sessionOwner);
    expect(() => f.gate.invalidate()).not.toThrow();
    expect(lease.signal.aborted).toBe(true);
    expect(sessionOwner).toHaveBeenCalledOnce();
    f.gate.invalidate();
    expect(sessionOwner).toHaveBeenCalledOnce();
    f.gate.dispose();
  });

  it("keeps observation decisions incapable of cancellation or task authorization", () => {
    const f = fixture("observe");
    const event = vi.fn();
    f.gate.on("revoked", event);
    expect(f.check()).toEqual(expect.objectContaining({ allowed: false, enforce: false, cancel: false }));
    expect(f.activate()).toEqual(expect.objectContaining({ allowed: true, enforce: false, cancel: false }));
    expect(f.gate.acquireLease(scope.accountId, scope.contextId).lease).toBeNull();
    f.gate.invalidate();
    expect(event).toHaveBeenLastCalledWith(expect.objectContaining({ enforce: false }));
    f.gate.dispose();
  });

  it("deletion, re-registration and shutdown cannot revive an old task", () => {
    const f = fixture();
    f.activate();
    const lease = f.gate.acquireLease(scope.accountId, scope.contextId).lease!;
    f.gate.unregisterAccount(scope.accountId);
    expect(lease.signal.aborted).toBe(true);
    f.gate.registerAccount(scope);
    expect(lease.isCurrent()).toBe(false);
    expect(f.gate.snapshot()[0].state).toBe("checking");
    f.gate.dispose();
    expect(f.clock.timers.size).toBe(0);
    expect(f.check().allowed).toBe(false);
  });

  it("does not accept international accounts or mutate registration objects", () => {
    const f = fixture();
    expect(() =>
      f.gate.registerAccount({ ...scope, platformId: "youtube" } as unknown as AccountProofScope),
    ).toThrow("Invalid domestic");
    const externalScope = structuredClone(scope);
    f.gate.registerAccount(externalScope);
    externalScope.targets = [{ ...target, host: "attacker.test" }];
    expect(f.activate().allowed).toBe(true);
    f.gate.dispose();
  });
});
