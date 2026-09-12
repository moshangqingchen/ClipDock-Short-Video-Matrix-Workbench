import { describe, expect, it } from "vitest";
import {
  normalizeProofTarget,
  proofScopeKey,
  validateDirectEvidence,
  type AccountProofScope,
  type CorrelatedConnectionEvidence,
  type DirectEvidenceBatch,
  type ProofEnvironment,
  type ProofTarget,
} from "./direct-proof";

const target: ProofTarget = {
  protocol: "https:",
  host: "member.bilibili.com",
  port: 443,
  addressFamily: "ipv4",
};
const scope: AccountProofScope = {
  accountId: "account-one",
  platformId: "bilibili",
  contextId: "verified-chromium-context",
  catalogVersion: "reviewed-login-v1",
  catalogReviewed: true,
  targets: [target],
};
const environment: ProofEnvironment = {
  controllerReadable: true,
  mode: "rule",
  tun: true,
  rulesVersion: "live-rules-a",
  generation: 3,
  expiresAtMono: 25_000,
};
const timing = { proofTtlMs: 15_000, egressTtlMs: 120_000 };

function batch(): DirectEvidenceBatch {
  return {
    sampleId: "new-round-1",
    generation: 3,
    rulesVersion: "live-rules-a",
    contextId: scope.contextId,
    catalogVersion: scope.catalogVersion,
    observedAtMono: 10_000,
    targets: [
      {
        target: { ...target },
        route: {
          source: "correlated-connection",
          contextId: scope.contextId,
          rulesVersion: "live-rules-a",
          ruleDecision: "direct",
          connectionId: "synthetic-correlated-connection",
          correlationVerified: true,
          chains: ["DIRECT"],
          observedAtMono: 10_000,
        },
        // Synthetic observations exercise the authority boundary; these are not internet/IP facts.
        egress: {
          target: { ...target },
          contextId: scope.contextId,
          ip: "192.0.2.1",
          countryCode: "CN",
          asn: 64512,
          source: "synthetic-controlled-receiver",
          applicabilityVerified: true,
          observedAtMono: 10_000,
        },
        tls: { verified: true, observedAtMono: 10_000 },
        dns: { status: "resolved", addressFamily: "ipv4", observedAtMono: 10_000 },
      },
    ],
  };
}

describe("direct target proof validation", () => {
  it("allows rule + TUN when the exact target and transport observations are valid", () => {
    expect(validateDirectEvidence(scope, batch(), environment, 10_001, timing)).toEqual({
      valid: true,
      scopeKey: proofScopeKey(scope),
      expiresAtMono: 25_000,
      targets: [target],
    });
  });

  it.each([
    ["global policy", (b: DirectEvidenceBatch) => b, { ...environment, mode: "global" }, "GLOBAL_MODE"],
    [
      "unsupported direct mode",
      (b: DirectEvidenceBatch) => b,
      { ...environment, mode: "direct" },
      "RULE_UNVERIFIABLE",
    ],
    [
      "lost controller",
      (b: DirectEvidenceBatch) => b,
      { ...environment, controllerReadable: false },
      "CONTROLLER_UNAVAILABLE",
    ],
    [
      "stale generation",
      (b: DirectEvidenceBatch) => ({ ...b, generation: 2 }),
      environment,
      "NETWORK_CHANGED",
    ],
    [
      "other rules",
      (b: DirectEvidenceBatch) => ({ ...b, rulesVersion: "old-rules" }),
      environment,
      "NETWORK_CHANGED",
    ],
    [
      "other Chromium context",
      (b: DirectEvidenceBatch) => ({ ...b, contextId: "node-probe" }),
      environment,
      "CONTEXT_UNVERIFIED",
    ],
    [
      "other catalog",
      (b: DirectEvidenceBatch) => ({ ...b, catalogVersion: "other-catalog" }),
      environment,
      "CATALOG_UNVERIFIED",
    ],
    [
      "infinite validity",
      (b: DirectEvidenceBatch) => b,
      { ...environment, expiresAtMono: Infinity },
      "PROOF_EXPIRED",
    ],
  ] as const)("rejects %s", (_label, change, env, reason) => {
    expect(validateDirectEvidence(scope, change(batch()), env, 10_001, timing)).toEqual({
      valid: false,
      reason,
    });
  });

  it.each([
    [
      "uninterpretable earlier rule",
      (b: DirectEvidenceBatch) => {
        (b.targets[0].route as CorrelatedConnectionEvidence).ruleDecision = "unknown";
      },
      "RULE_UNVERIFIABLE",
    ],
    [
      "proxy endpoint despite direct label",
      (b: DirectEvidenceBatch) => {
        (b.targets[0].route as CorrelatedConnectionEvidence).chains = ["DIRECT", "Tokyo"];
      },
      "NOT_DIRECT",
    ],
    [
      "alias chain is not a verified correlated DIRECT connection",
      (b: DirectEvidenceBatch) => {
        (b.targets[0].route as CorrelatedConnectionEvidence).chains = ["CN-outbound"];
      },
      "NOT_DIRECT",
    ],
    [
      "legacy connection object without an explicit source",
      (b: DirectEvidenceBatch) => {
        Reflect.deleteProperty(b.targets[0].route, "source");
      },
      "RULE_UNVERIFIABLE",
    ],
    [
      "unrelated kernel connection",
      (b: DirectEvidenceBatch) => {
        (b.targets[0].route as CorrelatedConnectionEvidence).correlationVerified = false;
      },
      "CONTEXT_UNVERIFIED",
    ],
    [
      "connection from another context",
      (b: DirectEvidenceBatch) => {
        (b.targets[0].route as CorrelatedConnectionEvidence).contextId = "node-probe";
      },
      "CONTEXT_UNVERIFIED",
    ],
    [
      "connection from older rules",
      (b: DirectEvidenceBatch) => {
        (b.targets[0].route as CorrelatedConnectionEvidence).rulesVersion = "old";
      },
      "NETWORK_CHANGED",
    ],
    [
      "echo target substituted for business target",
      (b: DirectEvidenceBatch) => {
        b.targets[0].egress.target.host = "myip.example.com";
      },
      "EGRESS_UNVERIFIED",
    ],
    [
      "unsupported exit applicability",
      (b: DirectEvidenceBatch) => {
        b.targets[0].egress.applicabilityVerified = false;
      },
      "EGRESS_UNVERIFIED",
    ],
    [
      "CN ASN with a Japanese exit",
      (b: DirectEvidenceBatch) => {
        b.targets[0].egress.countryCode = "JP";
      },
      "EGRESS_OUTSIDE_CN",
    ],
    [
      "IPv6 exit used for an IPv4 permit",
      (b: DirectEvidenceBatch) => {
        b.targets[0].egress.ip = "2001:db8::1";
      },
      "EGRESS_UNVERIFIED",
    ],
    [
      "unresolved fake IP",
      (b: DirectEvidenceBatch) => {
        b.targets[0].dns.status = "unverified";
      },
      "EGRESS_UNVERIFIED",
    ],
    [
      "unverified possible address family",
      (b: DirectEvidenceBatch) => {
        b.targets[0].dns.addressFamily = "ipv6";
      },
      "EGRESS_UNVERIFIED",
    ],
    [
      "disabled TLS verification",
      (b: DirectEvidenceBatch) => {
        b.targets[0].tls.verified = false;
      },
      "EGRESS_UNVERIFIED",
    ],
    [
      "future route observation",
      (b: DirectEvidenceBatch) => {
        (b.targets[0].route as CorrelatedConnectionEvidence).observedAtMono = 30_000;
      },
      "PROOF_EXPIRED",
    ],
    [
      "unknown upload host",
      (b: DirectEvidenceBatch) => {
        b.targets[0].target.host = "upload.example.com";
      },
      "UNKNOWN_TARGET",
    ],
    [
      "extra target",
      (b: DirectEvidenceBatch) => {
        b.targets = [...b.targets, b.targets[0]];
      },
      "UNKNOWN_TARGET",
    ],
  ] as const)("rejects %s", (_label, change, reason) => {
    const input = batch();
    change(input);
    expect(validateDirectEvidence(scope, input, environment, 10_001, timing)).toEqual({
      valid: false,
      reason,
    });
  });

  it("does not let long-lived exit geolocation extend short route evidence", () => {
    const input = batch();
    input.targets[0].egress.observedAtMono = 0;
    (input.targets[0].route as CorrelatedConnectionEvidence).observedAtMono = 9_000;
    expect(validateDirectEvidence(scope, input, environment, 10_001, timing)).toEqual(
      expect.objectContaining({ valid: true, expiresAtMono: 24_000 }),
    );
    expect(
      validateDirectEvidence(scope, input, { ...environment, expiresAtMono: 99_000 }, 24_000, timing),
    ).toEqual({ valid: false, reason: "PROOF_EXPIRED" });
  });

  it("requires an explicitly reviewed catalog and every distinct target", () => {
    expect(
      validateDirectEvidence({ ...scope, catalogReviewed: false }, batch(), environment, 10_001, timing),
    ).toEqual({ valid: false, reason: "CATALOG_UNVERIFIED" });
    const two = { ...scope, targets: [target, { ...target, host: "passport.bilibili.com" }] };
    const duplicate = batch();
    duplicate.targets = [duplicate.targets[0], duplicate.targets[0]];
    expect(validateDirectEvidence(two, duplicate, environment, 10_001, timing)).toEqual({
      valid: false,
      reason: "UNKNOWN_TARGET",
    });
  });
});

describe("exact target normalization", () => {
  it("normalizes case, final dot and IDN without broadening scope", () => {
    expect(normalizeProofTarget({ ...target, host: "MEMBER.BILIBILI.COM." })).toEqual(target);
    expect(normalizeProofTarget({ ...target, host: "例子.中国" })?.host).toBe("xn--fsqu00a.xn--fiqs8s");
    expect(proofScopeKey({ ...scope, targets: [{ ...target, host: "MEMBER.BILIBILI.COM." }] })).toBe(
      proofScopeKey(scope),
    );
    expect(proofScopeKey({ ...scope, targets: [{ ...target, port: 8443 }] })).not.toBe(proofScopeKey(scope));
  });
  it.each([
    "127.0.0.1",
    "127.1",
    "0x7f000001",
    "2130706433",
    "[::1]",
    "host/path",
    "user@host",
    "*.bilibili.com",
    "host?secret",
    "host%2ecom",
    "bad..host",
    " leading.com",
    "host\\path",
  ])("rejects %s", (host) => {
    expect(normalizeProofTarget({ ...target, host })).toBeNull();
  });
  it("rejects unknown ports, plaintext schemes and unknown families", () => {
    for (const changed of [{ port: 0 }, { port: 65536 }, { protocol: "http:" }, { addressFamily: "unknown" }])
      expect(normalizeProofTarget({ ...target, ...changed } as ProofTarget)).toBeNull();
  });
});
