import { describe, expect, it, vi } from "vitest";
import {
  createLiveRuleEvidence,
  validateLiveRuleEvidence,
  type CurrentOrderedRuleEvidence,
  type LiveRuleEvidenceInput,
} from "./live-rule-evidence";
import {
  validateDirectEvidence,
  type AccountProofScope,
  type DirectEvidenceBatch,
  type ProofEnvironment,
  type ProofTarget,
} from "./direct-proof";
import { EgressGate, type GateClock } from "./egress-gate";

const target: ProofTarget = {
  protocol: "https:",
  host: "member.bilibili.com",
  port: 443,
  addressFamily: "ipv4",
};
const scope: AccountProofScope = {
  accountId: "synthetic-account",
  platformId: "bilibili",
  contextId: "synthetic-chromium-context",
  catalogVersion: "synthetic-reviewed-catalog",
  catalogReviewed: true,
  targets: [target],
};
const environment: ProofEnvironment = {
  controllerReadable: true,
  mode: "rule",
  tun: true,
  rulesVersion: "current-rules",
  generation: 2,
  expiresAtMono: 100_000,
};
const timing = { proofTtlMs: 15_000, egressTtlMs: 120_000 };

function input(at = 1_000, generation = 2): LiveRuleEvidenceInput {
  return {
    target: { ...target },
    contextId: scope.contextId,
    snapshot: {
      mode: "rule",
      generation,
      rulesVersion: "current-rules",
      kernelEpoch: "kernel-instance",
      rules: [{ type: "DOMAIN", payload: target.host, proxy: "DIRECT" }],
      observedAtMono: at,
    },
    outbound: {
      name: "DIRECT",
      id: "actual-direct-instance",
      kind: "direct",
      dialer: "none",
      policyVersion: "visible-outbound-policy",
      kernelEpoch: "kernel-instance",
      generation,
      rulesVersion: "current-rules",
      observedAtMono: at,
    },
    // All references are synthetic test records, not observations about a production network.
    path: {
      source: "validated-path-profile",
      evidenceId: "synthetic-path-record",
      target: { ...target },
      contextId: scope.contextId,
      kernelEpoch: "kernel-instance",
      generation,
      rulesVersion: "current-rules",
      outboundId: "actual-direct-instance",
      outboundPolicyVersion: "visible-outbound-policy",
      effectivePathPolicyVersion: "synthetic-effective-dns-route-policy",
      physicalRouteClass: "synthetic-physical-route",
      transportCompatibilityEvidenceId: "synthetic-chromium-conformance",
      dnsPolicyEvidenceId: "synthetic-dns-policy",
      network: "tcp",
      possibleAddressFamilies: ["ipv4"],
      familyConstraintEvidenceId: "synthetic-ipv4-only-constraint",
      observedAtMono: at,
      expiresAtMono: at + 15_000,
    },
  };
}

function create(value = input(), now = value.snapshot.observedAtMono): CurrentOrderedRuleEvidence {
  const result = createLiveRuleEvidence(value, now);
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error(result.reason);
  return result.evidence;
}

function batch(route: CurrentOrderedRuleEvidence): DirectEvidenceBatch {
  return {
    sampleId: `round-${route.observedAtMono}`,
    generation: route.generation,
    rulesVersion: route.rulesVersion,
    contextId: scope.contextId,
    catalogVersion: scope.catalogVersion,
    observedAtMono: route.observedAtMono,
    targets: [
      {
        target: { ...target },
        route,
        egress: {
          target: { ...target },
          contextId: scope.contextId,
          ip: "192.0.2.1",
          countryCode: "CN",
          asn: 64512,
          source: "synthetic-receiver",
          applicabilityVerified: true,
          observedAtMono: route.observedAtMono,
        },
        tls: { verified: true, observedAtMono: route.observedAtMono },
        dns: { status: "resolved", addressFamily: "ipv4", observedAtMono: route.observedAtMono },
      },
    ],
  };
}

describe("current ordered rule evidence construction", () => {
  it("computes an early DOMAIN without requiring an irrelevant later PROCESS or GEO branch", () => {
    const value = input();
    value.snapshot.rules = [
      ...value.snapshot.rules,
      { type: "PROCESS-NAME", payload: "other.exe", proxy: "Overseas" },
      { type: "GEOIP", payload: "CN", proxy: "DIRECT" },
    ];
    expect(create(value)).toMatchObject({
      source: "current-ordered-rules",
      ruleIndex: 0,
      ruleType: "DOMAIN",
    });
    expect(validateDirectEvidence(scope, batch(create(value)), environment, 1_001, timing).valid).toBe(true);
  });

  it("accepts a named actual Direct endpoint, without weakening connection-chain validation", () => {
    const value = input();
    value.snapshot.rules = [{ type: "DOMAIN", payload: target.host, proxy: "CN-outbound" }];
    value.outbound.name = "CN-outbound";
    expect(create(value).effectiveOutboundId).toBe("actual-direct-instance");
    value.outbound.kind = "other";
    expect(createLiveRuleEvidence(value, 1_000)).toEqual({ valid: false, reason: "NOT_DIRECT" });
  });

  it.each([
    [
      "unsupported earlier rule",
      (v: LiveRuleEvidenceInput) => {
        v.snapshot.rules = [
          { type: "RULE-SET", payload: "not-readable", proxy: "DIRECT" },
          ...v.snapshot.rules,
        ];
      },
      "RULE_UNVERIFIABLE",
    ],
    [
      "unresolved earlier process",
      (v: LiveRuleEvidenceInput) => {
        v.snapshot.rules = [
          { type: "PROCESS-NAME", payload: "electron.exe", proxy: "DIRECT" },
          ...v.snapshot.rules,
        ];
      },
      "RULE_UNVERIFIABLE",
    ],
    [
      "matched different outbound",
      (v: LiveRuleEvidenceInput) => {
        v.snapshot.rules = [{ type: "MATCH", payload: "", proxy: "DIRECT-but-proxy" }];
      },
      "NOT_DIRECT",
    ],
    [
      "port branch selects proxy",
      (v: LiveRuleEvidenceInput) => {
        v.snapshot.rules = [{ type: "DST-PORT", payload: "443", proxy: "Overseas" }, ...v.snapshot.rules];
      },
      "NOT_DIRECT",
    ],
    [
      "global",
      (v: LiveRuleEvidenceInput) => {
        v.snapshot.mode = "global";
      },
      "GLOBAL_MODE",
    ],
    [
      "missing path record",
      (v: LiveRuleEvidenceInput) => {
        v.path = null;
      },
      "CONTEXT_UNVERIFIED",
    ],
    [
      "other target",
      (v: LiveRuleEvidenceInput) => {
        v.path!.target.host = "passport.bilibili.com";
      },
      "UNKNOWN_TARGET",
    ],
    [
      "other port",
      (v: LiveRuleEvidenceInput) => {
        v.path!.target.port = 8443;
      },
      "UNKNOWN_TARGET",
    ],
    [
      "other context",
      (v: LiveRuleEvidenceInput) => {
        v.path!.contextId = "node-probe";
      },
      "CONTEXT_UNVERIFIED",
    ],
    [
      "missing compatibility record",
      (v: LiveRuleEvidenceInput) => {
        v.path!.transportCompatibilityEvidenceId = "";
      },
      "CONTEXT_UNVERIFIED",
    ],
    [
      "missing effective DNS policy",
      (v: LiveRuleEvidenceInput) => {
        v.path!.dnsPolicyEvidenceId = "";
      },
      "CONTEXT_UNVERIFIED",
    ],
    [
      "missing physical route class",
      (v: LiveRuleEvidenceInput) => {
        v.path!.physicalRouteClass = "";
      },
      "CONTEXT_UNVERIFIED",
    ],
    [
      "single family without constraint",
      (v: LiveRuleEvidenceInput) => {
        v.path!.familyConstraintEvidenceId = null;
      },
      "EGRESS_UNVERIFIED",
    ],
    [
      "wrong family",
      (v: LiveRuleEvidenceInput) => {
        v.path!.possibleAddressFamilies = ["ipv6"];
      },
      "EGRESS_UNVERIFIED",
    ],
    [
      "duplicate family",
      (v: LiveRuleEvidenceInput) => {
        v.path!.possibleAddressFamilies = ["ipv4", "ipv4"];
      },
      "EGRESS_UNVERIFIED",
    ],
    [
      "stale generation",
      (v: LiveRuleEvidenceInput) => {
        v.path!.generation--;
      },
      "NETWORK_CHANGED",
    ],
    [
      "stale rules",
      (v: LiveRuleEvidenceInput) => {
        v.outbound.rulesVersion = "old-rules";
      },
      "NETWORK_CHANGED",
    ],
    [
      "other kernel",
      (v: LiveRuleEvidenceInput) => {
        v.path!.kernelEpoch = "restarted-kernel";
      },
      "NETWORK_CHANGED",
    ],
    [
      "changed outbound policy",
      (v: LiveRuleEvidenceInput) => {
        v.outbound.policyVersion = "new-policy";
      },
      "NETWORK_CHANGED",
    ],
    [
      "unexposed dialer",
      (v: LiveRuleEvidenceInput) => {
        v.outbound.dialer = "unknown";
      },
      "RULE_UNVERIFIABLE",
    ],
    [
      "configured proxy dialer",
      (v: LiveRuleEvidenceInput) => {
        v.outbound.dialer = "configured";
      },
      "NOT_DIRECT",
    ],
    [
      "expired path",
      (v: LiveRuleEvidenceInput) => {
        v.path!.expiresAtMono = 1_000;
      },
      "PROOF_EXPIRED",
    ],
    [
      "future observation",
      (v: LiveRuleEvidenceInput) => {
        v.snapshot.observedAtMono = 1_001;
      },
      "PROOF_EXPIRED",
    ],
  ] as const)("rejects %s", (_label, change, reason) => {
    const value = input();
    change(value);
    expect(createLiveRuleEvidence(value, 1_000)).toEqual({ valid: false, reason });
  });

  it("uses supplied process context for an actually effective process branch", () => {
    const value = input();
    value.snapshot.rules = [
      { type: "PROCESS-NAME", payload: "other.exe", proxy: "Overseas" },
      ...value.snapshot.rules,
    ];
    value.path!.processName = "electron.exe";
    expect(create(value).ruleIndex).toBe(1);
    value.path!.processName = "other.exe";
    expect(createLiveRuleEvidence(value, 1_000)).toEqual({ valid: false, reason: "NOT_DIRECT" });
  });

  it("binds validity to the earliest live input and does not mutate its inputs", () => {
    const value = input();
    value.outbound.observedAtMono = 900;
    value.path!.expiresAtMono = 4_000;
    const route = create(value);
    expect(route.observedAtMono).toBe(900);
    expect(route.expiresAtMono).toBe(4_000);
    value.target.host = "changed.example";
    value.path!.possibleAddressFamilies = ["ipv6"];
    expect(route.target).toEqual(target);
    expect(route.possibleAddressFamilies).toEqual(["ipv4"]);
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.target)).toBe(true);
  });
});

describe("rule source authority boundary", () => {
  it("rejects copied/forged rule objects and mixed connection fields", () => {
    const real = create();
    for (const forged of [
      structuredClone(real),
      { ...real, connectionId: "other-request" },
      { ...real, correlationVerified: true, chains: ["DIRECT"], ruleDecision: "direct" },
    ]) {
      expect(validateDirectEvidence(scope, batch(forged), environment, 1_001, timing)).toEqual({
        valid: false,
        reason: "RULE_UNVERIFIABLE",
      });
    }
    const relabelled = {
      ...real,
      source: "correlated-connection",
      connectionId: "invented",
      correlationVerified: true,
      chains: ["DIRECT"],
      ruleDecision: "direct",
    };
    const forgedBatch = batch(real);
    forgedBatch.targets[0].route = relabelled as unknown as DirectEvidenceBatch["targets"][number]["route"];
    expect(validateDirectEvidence(scope, forgedBatch, environment, 1_001, timing)).toEqual({
      valid: false,
      reason: "RULE_UNVERIFIABLE",
    });
  });

  it("does not let valid rules manufacture exit applicability or waive TLS/DNS", () => {
    const exit = batch(create());
    exit.targets[0].egress.applicabilityVerified = false;
    expect(validateDirectEvidence(scope, exit, environment, 1_001, timing)).toEqual({
      valid: false,
      reason: "EGRESS_UNVERIFIED",
    });
    const tls = batch(create());
    tls.targets[0].tls.verified = false;
    expect(validateDirectEvidence(scope, tls, environment, 1_001, timing).valid).toBe(false);
    const dns = batch(create());
    dns.targets[0].dns.status = "unverified";
    expect(validateDirectEvidence(scope, dns, environment, 1_001, timing).valid).toBe(false);
  });

  it("checks route target, context and generation independently from the batch labels", () => {
    const route = create();
    const expected = {
      target,
      contextId: scope.contextId,
      generation: 2,
      rulesVersion: "current-rules",
      nowMono: 1_001,
    };
    expect(validateLiveRuleEvidence(route, { ...expected, target: { ...target, port: 8443 } })).toEqual({
      valid: false,
      reason: "UNKNOWN_TARGET",
    });
    expect(validateLiveRuleEvidence(route, { ...expected, contextId: "node" })).toEqual({
      valid: false,
      reason: "CONTEXT_UNVERIFIED",
    });
    const old = batch(create(input(1_000, 1)));
    old.generation = 2;
    expect(validateDirectEvidence(scope, old, environment, 1_001, timing)).toEqual({
      valid: false,
      reason: "NETWORK_CHANGED",
    });
  });

  it("requires every possible family in the batch scope instead of choosing the green one", () => {
    const ipv4 = input();
    ipv4.path!.possibleAddressFamilies = ["ipv4", "ipv6"];
    ipv4.path!.familyConstraintEvidenceId = null;
    const first = batch(create(ipv4));
    expect(validateDirectEvidence(scope, first, environment, 1_001, timing)).toEqual({
      valid: false,
      reason: "EGRESS_UNVERIFIED",
    });
    const ipv6 = input();
    ipv6.target.addressFamily = "ipv6";
    ipv6.path!.target.addressFamily = "ipv6";
    ipv6.path!.possibleAddressFamilies = ["ipv4", "ipv6"];
    ipv6.path!.familyConstraintEvidenceId = null;
    const second = batch(create(ipv6)).targets[0];
    second.target = { ...target, addressFamily: "ipv6" };
    second.egress.target = { ...second.target };
    second.egress.ip = "2001:db8::1";
    second.dns.addressFamily = "ipv6";
    first.targets = [...first.targets, second];
    expect(
      validateDirectEvidence(
        { ...scope, targets: [target, second.target] },
        first,
        environment,
        1_001,
        timing,
      ).valid,
    ).toBe(true);
  });

  it("activates only after two new rounds, rejects cached rule relabelling and revokes on expiry", () => {
    let now = 0;
    const callbacks = new Map<number, () => void>();
    let timerId = 0;
    const clock: GateClock = {
      monotonicMs: () => now,
      wallTimeMs: () => now,
      setTimeout: (cb) => {
        callbacks.set(++timerId, cb);
        return timerId;
      },
      clearTimeout: (id) => {
        callbacks.delete(id as number);
      },
    };
    const gate = new EgressGate({ clock });
    gate.registerAccount(scope);
    const refresh = () =>
      gate.setNetworkState({
        controllerReadable: true,
        mode: "rule",
        tun: true,
        rulesVersion: "current-rules",
      });
    refresh();
    const first = batch(create(input(now, gate.generation)));
    expect(gate.acceptEvidence(scope.accountId, first).allowed).toBe(false);
    now = 10_000;
    refresh();
    const cached = batch(first.targets[0].route as CurrentOrderedRuleEvidence);
    cached.sampleId = "renamed-cache";
    cached.observedAtMono = now;
    cached.targets[0].tls.observedAtMono = now;
    cached.targets[0].dns.observedAtMono = now;
    expect(gate.acceptEvidence(scope.accountId, cached).allowed).toBe(false);
    now = 15_000;
    refresh();
    expect(gate.acceptEvidence(scope.accountId, batch(create(input(now, gate.generation)))).allowed).toBe(
      true,
    );
    const lease = gate.acquireLease(scope.accountId, scope.contextId).lease!;
    const aborted = vi.fn();
    lease.signal.addEventListener("abort", aborted);
    now = 29_000;
    refresh();
    now = 30_000;
    for (const cb of [...callbacks.values()]) cb();
    expect(aborted).toHaveBeenCalledOnce();
    expect(lease.isCurrent()).toBe(false);
    expect(gate.checkAction(scope.accountId, scope.contextId).reason).toBe("PROOF_EXPIRED");
    gate.dispose();
  });
});
