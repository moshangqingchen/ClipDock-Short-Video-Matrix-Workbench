import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NETWORK_TIMING } from "@shared/network";
import { associateCurrentConfiguration, type KnownSelectedLoaderContract } from "./configuration-association";
import {
  evaluateCurrentRuleContext,
  type CurrentRuleContext,
  type CurrentRuleContextInput,
} from "./current-rule-context";
import type { EffectiveConfigCandidate } from "./effective-config-source";
import type { KernelDnsCandidates } from "./kernel-dns";
import type { CurrentPathInputs } from "./path-input-reader";
import { normalizeKernelRule, type KernelRule } from "./rules";
import type { WindowsControllerOwnerSnapshot } from "./windows-controller-owner";

const V = "a".repeat(64),
  H = "b".repeat(64),
  K = "c".repeat(64),
  OTHER = "d".repeat(64);
const missing = { present: false } as const;
const target = {
  protocol: "https:",
  host: "creator.example.test",
  port: 443,
  addressFamily: "ipv4",
} as const;
const direct: KernelRule = { type: "Domain", payload: target.host, proxy: "DIRECT" };
const cidr = (payload = "10.0.0.0/8", proxy = "REJECT"): KernelRule => ({ type: "IPCIDR", payload, proxy });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

function candidate(
  at: number,
  rules: readonly KernelRule[],
  parameters: readonly (readonly string[])[],
): EffectiveConfigCandidate {
  return {
    kind: "local-config-candidate",
    runtimeConfigurationProven: false,
    sourceGeneration: 0,
    sourcePathIdentity: H,
    fileFingerprint: H,
    decoderIdentity: "known-test-decoder-v1",
    startedAtMono: at,
    completedAtMono: at + 4,
    expiresAtMono: at + 15004,
    controllerFingerprint: V,
    controllerStartedAtMono: at + 1,
    controllerCompletedAtMono: at + 3,
    comparedConfigFields: ["/mode", "/tun/enable"],
    comparedRuleCount: rules.length,
    orderedRulesFingerprint: hash(rules.map(normalizeKernelRule)),
    sourceRuleOptionsFingerprint: hash(parameters),
    rules: structuredClone(rules).map(normalizeKernelRule),
    ruleParameters: structuredClone(parameters),
    policy: {
      fingerprint: H,
      dns: missing,
      hosts: missing,
      sniffer: missing,
      tun: missing,
      ipv6: missing,
      dnsFlags: {
        enable: missing,
        ipv6: missing,
        "use-hosts": missing,
        "use-system-hosts": missing,
        "respect-rules": missing,
      },
      dnsMode: missing,
      snifferFlags: {
        enable: missing,
        "force-dns-mapping": missing,
        "override-destination": missing,
        "parse-pure-ip": missing,
      },
      tunEnabled: missing,
      directOutbounds: { count: 0, fingerprint: H, builtinNameConfigured: false, entries: [] },
    },
    currentDirectPolicy: {
      kind: "direct",
      interfaceName: null,
      dialer: "none",
      ipVersion: null,
      policyFingerprint: H,
      startedAtMono: at + 1,
      completedAtMono: at + 3,
    },
  };
}
function owner(at: number): Extract<WindowsControllerOwnerSnapshot, { available: true }> {
  return {
    available: true,
    basis: "windows-controller-listener",
    scopeHash: H,
    kernelEpoch: K,
    owner: { pid: 401, createdAtTicks: "639244035457234678", executablePathIdentity: null },
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4", port: 9790, coverage: "exact" }],
    startedAtMono: at,
    completedAtMono: at + 4,
  };
}
function dns(at: number): KernelDnsCandidates {
  // No DNS answer is converted into a rule-stage destination by this fixture or the evaluator.
  return {
    available: true,
    kind: "kernel-dns-candidates",
    chromiumResolutionProven: false,
    status: "unverified",
    controllerVersionBefore: { controllerVersion: V, startedAtMono: at, completedAtMono: at },
    controllerVersionAfter: { controllerVersion: V, startedAtMono: at + 1, completedAtMono: at + 1 },
    startedAtMono: at,
    completedAtMono: at + 1,
    expiresAtMono: at + 15000,
    hosts: [],
  };
}
function fixture(
  rules = [direct],
  parameters = rules.map((): string[] => []),
): Mutable<CurrentRuleContextInput> {
  const inputs: CurrentPathInputs = {
    state: "observed",
    kind: "current-path-inputs",
    sampleId: "actual-shape-current-inputs",
    generation: 4,
    rulesVersion: V,
    targets: [target],
    startedAtMono: 100,
    completedAtMono: 124,
    expiresAtMono: 15100,
    configurationBefore: candidate(100, rules, parameters),
    configurationAfter: candidate(118, rules, parameters),
    ownerBefore: owner(100),
    ownerAfter: owner(120),
    networkBefore: { hash: H, startedAtMono: 100, completedAtMono: 104 },
    networkAfter: { hash: H, startedAtMono: 120, completedAtMono: 124 },
    dnsBefore: dns(105),
    dnsAfter: dns(112),
    routeBatches: [],
  };
  const loader: KnownSelectedLoaderContract = {
    source: "main-process-selected-loader-contract",
    selectionId: "selected-current-client",
    loaderProfileId: "retained-loader-profile",
    sourcePathIdentity: H,
    decoderIdentity: "known-test-decoder-v1",
    qualificationEvidenceIds: ["retained-loader-and-decoder-record"],
    selectedAtMono: 10,
  };
  const associated = associateCurrentConfiguration({ inputs, loader }, 130);
  if (!associated.valid) throw new Error(`fixture association failed: ${associated.reason}`);
  const context: CurrentRuleContext = {
    source: "main-process-current-rule-context",
    target,
    scopeContextId: "account-operation-scope",
    transportProfileId: "account-chromium-profile",
    inputSampleId: inputs.sampleId,
    configurationEvidenceId: associated.association.evidenceId,
    generation: inputs.generation,
    rulesVersion: V,
    kernelEpoch: K,
    network: "tcp",
    destinations: [{ stage: "unknown" }],
    sourceEvidenceIds: ["retained-real-factory-behavior"],
    checkedAtMono: 130,
    expiresAtMono: 15000,
  };
  return {
    snapshot: {
      mode: "rule",
      generation: inputs.generation,
      rulesVersion: V,
      kernelEpoch: K,
      rules: structuredClone(rules),
      observedAtMono: 128,
    },
    target: structuredClone(target),
    scopeContextId: context.scopeContextId,
    transportProfileId: context.transportProfileId,
    configuration: { inputs, loader, association: associated.association },
    context: structuredClone(context),
  } as Mutable<CurrentRuleContextInput>;
}
const decide = (input: CurrentRuleContextInput, at = 131) => evaluateCurrentRuleContext(input, at);

describe("current rule context shared interpretation", () => {
  it.each(["global", "direct", "unknown"])(
    "rejects non-rule mode %s even with a complete matching context",
    (mode) => {
      const f = fixture();
      f.snapshot.mode = mode;
      expect(decide(f)).toMatchObject({
        route: "unknown",
        reason: mode === "global" ? "GLOBAL_MODE" : "RULE_UNVERIFIABLE",
      });
    },
  );

  it("uses the real association constructor and permits dependency-independent DOMAIN with an explicit unknown stage", () => {
    const f = fixture();
    expect(decide(f)).toMatchObject({
      route: "direct",
      reason: "READY",
      matchedPolicy: "DIRECT",
      branches: [{ destination: { stage: "unknown" }, decision: { ruleIndex: 0 } }],
      expiresAtMono: 15000,
    });
    expect(f.configuration!.inputs.configurationAfter.sourceGeneration).toBe(0);
    expect(f.configuration!.association!.runtimeConfigurationProven).toBe(false);
  });

  it("ANDs every actual address and records different matching indices for one common endpoint", () => {
    const f = fixture([cidr("192.0.2.0/24", "DIRECT"), direct], [["no-resolve"], []]);
    f.context!.destinations = [
      { stage: "resolved", address: "192.0.2.7" },
      { stage: "resolved", address: "203.0.113.7" },
    ];
    const result = decide(f);
    expect(result.route).toBe("direct");
    expect(result.matchedPolicy).toBe("DIRECT");
    expect(result.branches.map((branch) => branch.decision.ruleIndex)).toEqual([0, 1]);
  });

  it("does not select the DIRECT address when another possible address is rejected", () => {
    const f = fixture([cidr(), direct], [["no-resolve"], []]);
    f.context!.destinations = [
      { stage: "resolved", address: "203.0.113.8" },
      { stage: "resolved", address: "10.1.2.3" },
    ];
    expect(decide(f)).toMatchObject({ route: "proxy", reason: "NOT_DIRECT", matchedPolicy: null });
    expect(decide(f).branches.map((branch) => [branch.decision.ruleIndex, branch.matchedPolicy])).toEqual([
      [1, "DIRECT"],
      [0, "REJECT"],
    ]);
  });

  it("retains unknown and non-DIRECT branches instead of stopping after the first successful one", () => {
    const f = fixture([cidr(), direct], [["no-resolve"], []]);
    f.context!.destinations = [
      { stage: "resolved", address: "203.0.113.8" },
      { stage: "unknown" },
      { stage: "resolved", address: "10.1.2.3" },
    ];
    const result = decide(f);
    expect(result).toMatchObject({ route: "unknown", matchedPolicy: null, reason: "RULE_UNVERIFIABLE" });
    expect(result.branches.map((branch) => branch.decision.route)).toEqual(["direct", "unknown", "proxy"]);
    expect(result.branches[1].matchedPolicy).toBeNull();
  });

  it("does not remove a kernel-stage IPv6 branch based on the final target's IPv4 discriminator", () => {
    const f = fixture([cidr("::/0"), direct], [["no-resolve"], []]);
    f.context!.destinations = [
      { stage: "resolved", address: "192.0.2.8" },
      { stage: "resolved", address: "2001:0db8::8" },
    ];
    const result = decide(f);
    expect(result.route).toBe("proxy");
    expect(result.branches.map((branch) => branch.decision.route)).toEqual(["direct", "proxy"]);
    expect(result.branches[1].destination).toEqual({ stage: "resolved", address: "2001:db8::8" });
  });

  it("keeps resolving versus no-resolve unresolved branches distinct without invoking DNS", () => {
    const f = fixture([cidr(), direct], [["no-resolve"], []]);
    f.context!.destinations = [{ stage: "unresolved" }];
    expect(decide(f).route).toBe("direct");
    const resolving = fixture([cidr(), direct]);
    resolving.context!.destinations = [{ stage: "unresolved" }];
    expect(decide(resolving)).toMatchObject({ route: "unknown", branches: [{ decision: { ruleIndex: 0 } }] });
  });

  it.each(["src", "duplicate", "unknown", "missing"])(
    "keeps %s parameters unknown even with matching visible rules",
    (change) => {
      const parameters =
        change === "src"
          ? ["src"]
          : change === "duplicate"
            ? ["no-resolve", "no-resolve"]
            : ["future-option"];
      const f = fixture([cidr(), direct], [parameters, []]);
      f.context!.destinations = [{ stage: "unresolved" }];
      if (change === "missing") {
        delete f.configuration!.inputs.configurationBefore.ruleParameters;
        delete f.configuration!.inputs.configurationAfter.ruleParameters;
      }
      expect(decide(f).route).toBe("unknown");
    },
  );

  it.each(["context", "configuration", "loader", "association"])(
    "never falls back to old DOMAIN evaluation when supplied bundle lacks %s",
    (missing) => {
      const f = fixture();
      if (missing === "context") f.context = null;
      if (missing === "configuration") f.configuration = null;
      if (missing === "loader") f.configuration!.loader = null;
      if (missing === "association") f.configuration!.association = null;
      expect(decide(f).route).toBe("unknown");
    },
  );

  it("allows cloned data plus the original association reference, rejects restoring the association from JSON", () => {
    const f = fixture();
    const cloned = structuredClone(f);
    cloned.configuration!.association = f.configuration!.association;
    expect(decide(cloned).route).toBe("direct");
    const restored = JSON.parse(JSON.stringify(f)) as CurrentRuleContextInput;
    expect(decide(restored).route).toBe("unknown");
  });

  it.each([
    "scopeContextId",
    "transportProfileId",
    "inputSampleId",
    "configurationEvidenceId",
    "generation",
    "rulesVersion",
    "kernelEpoch",
  ] as const)("rejects mismatched current context %s", (field) => {
    const f = fixture();
    if (field === "generation") f.context!.generation++;
    else f.context![field] = "different-current-record";
    expect(decide(f).reason).toBe("CONTEXT_UNVERIFIED");
  });

  it.each(["host", "port", "protocol", "addressFamily"] as const)(
    "binds the context to the exact target %s",
    (field) => {
      const f = fixture();
      if (field === "host") f.context!.target.host = "other.example.test";
      if (field === "port") f.context!.target.port = 8443;
      if (field === "protocol") f.context!.target.protocol = "wss:";
      if (field === "addressFamily") f.context!.target.addressFamily = "ipv6";
      expect(decide(f).reason).toBe("CONTEXT_UNVERIFIED");
    },
  );

  it("does not confuse scope context with the three actual factory profiles", () => {
    const f = fixture();
    for (const profile of ["account-chromium-profile", "anonymous-tls-profile", "anonymous-egress-profile"]) {
      f.transportProfileId = profile;
      f.context!.transportProfileId = profile;
      expect(decide(f).route).toBe("direct");
    }
    f.context!.scopeContextId = "anonymous-session-id-is-not-the-operation-scope";
    expect(decide(f).reason).toBe("CONTEXT_UNVERIFIED");
  });

  it("rejects an unrequested target even if the supplied context was changed to agree with it", () => {
    const f = fixture();
    f.target.host = "unrequested.example.test";
    f.context!.target.host = f.target.host;
    expect(decide(f).reason).toBe("UNKNOWN_TARGET");
  });

  it.each(["generation", "rulesVersion", "kernelEpoch"] as const)("rejects changed snapshot %s", (field) => {
    const f = fixture();
    if (field === "generation") f.snapshot.generation++;
    else f.snapshot[field] = OTHER;
    expect(decide(f).reason).toBe("NETWORK_CHANGED");
  });

  it.each(["file", "decoder", "network", "owner", "loader"])(
    "rejects %s changes against the retained current association",
    (change) => {
      const f = fixture();
      if (change === "file") f.configuration!.inputs.configurationAfter.fileFingerprint = OTHER;
      if (change === "decoder")
        f.configuration!.inputs.configurationAfter.decoderIdentity = "different-decoder";
      if (change === "network") f.configuration!.inputs.networkAfter.hash = OTHER;
      if (change === "owner") f.configuration!.inputs.ownerAfter.owner.pid++;
      if (change === "loader") f.configuration!.loader!.selectionId = "different-selected-client";
      expect(decide(f).route).toBe("unknown");
    },
  );

  it.each(["rules", "parameters", "visible-rules"])(
    "rejects %s body changes while old digests remain unchanged",
    (change) => {
      const f = fixture([cidr(), direct], [["no-resolve"], []]);
      f.context!.destinations = [{ stage: "unresolved" }];
      if (change === "rules") {
        f.configuration!.inputs.configurationBefore.rules[0].proxy = "DIRECT";
        f.configuration!.inputs.configurationAfter.rules[0].proxy = "DIRECT";
        f.snapshot.rules[0].proxy = "DIRECT";
      }
      if (change === "parameters") {
        f.configuration!.inputs.configurationBefore.ruleParameters![0] = [];
        f.configuration!.inputs.configurationAfter.ruleParameters![0] = [];
      }
      if (change === "visible-rules") f.snapshot.rules.reverse();
      expect(decide(f).route).toBe("unknown");
    },
  );

  it.each([
    "snapshot-future",
    "snapshot-old",
    "context-future",
    "context-before-inputs",
    "context-expired",
    "association-expired",
    "invalid-now",
  ])("rejects %s timing without refreshing it", (change) => {
    const f = fixture();
    let now = 131;
    if (change === "snapshot-future") f.snapshot.observedAtMono = 132;
    if (change === "snapshot-old") now = f.snapshot.observedAtMono + NETWORK_TIMING.proofTtlMs;
    if (change === "context-future") f.context!.checkedAtMono = 132;
    if (change === "context-before-inputs") f.context!.checkedAtMono = 123;
    if (change === "context-expired") f.context!.expiresAtMono = 131;
    if (change === "association-expired") now = f.configuration!.association!.expiresAtMono;
    if (change === "invalid-now") now = Number.NaN;
    expect(decide(f, now).route).toBe("unknown");
  });

  it("caps result lifetime at the earliest current input, scope and snapshot deadline", () => {
    const f = fixture();
    f.context!.expiresAtMono = 50000;
    expect(decide(f).expiresAtMono).toBe(f.configuration!.association!.expiresAtMono);
    f.context!.expiresAtMono = 140;
    expect(decide(f).expiresAtMono).toBe(140);
  });

  it.each([
    "empty",
    "over-limit",
    "duplicate",
    "equivalent-v6",
    "invalid-address",
    "contradictory",
    "unknown-stage",
  ])("rejects %s stage collection instead of dropping offending branches", (change) => {
    const f = fixture();
    if (change === "empty") f.context!.destinations = [];
    if (change === "over-limit")
      f.context!.destinations = Array.from({ length: 33 }, (_, i) => ({
        stage: "resolved",
        address: `192.0.2.${i + 1}`,
      }));
    if (change === "duplicate") f.context!.destinations = [{ stage: "unknown" }, { stage: "unknown" }];
    if (change === "equivalent-v6")
      f.context!.destinations = [
        { stage: "resolved", address: "2001:db8::1" },
        { stage: "resolved", address: "2001:0db8:0:0:0:0:0:1" },
      ];
    if (change === "invalid-address")
      f.context!.destinations = [{ stage: "resolved", address: "host.example.test" }];
    if (change === "contradictory")
      f.context!.destinations = [{ stage: "unresolved", address: "192.0.2.8" } as never];
    if (change === "unknown-stage") f.context!.destinations = [{ stage: "dns-query-answer" } as never];
    expect(decide(f).reason).toBe("CONTEXT_UNVERIFIED");
  });

  it.each(["missing", "duplicate", "sparse", "blank"])("rejects %s source references", (change) => {
    const f = fixture();
    f.context!.sourceEvidenceIds =
      change === "missing"
        ? []
        : change === "duplicate"
          ? ["ref", "ref"]
          : change === "blank"
            ? ["  "]
            : new Array(1);
    expect(decide(f).reason).toBe("CONTEXT_UNVERIFIED");
  });

  it("requires process identity only when a reached rule uses it, without inventing one", () => {
    const f = fixture([{ type: "ProcessName", payload: "specific.exe", proxy: "OTHER" }, direct]);
    expect(decide(f).route).toBe("unknown");
    f.context!.processName = "reviewed-factory.exe";
    expect(decide(f).route).toBe("direct");
    f.context!.processName = "SPECIFIC.EXE";
    expect(decide(f)).toMatchObject({ route: "proxy", matchedPolicy: "OTHER" });
  });

  it("does not label different policy aliases a common direct endpoint", () => {
    const f = fixture(
      [cidr("192.0.2.0/24", "NAMED-A"), { type: "Match", payload: "", proxy: "NAMED-B" }],
      [["no-resolve"], []],
    );
    f.context!.destinations = [
      { stage: "resolved", address: "192.0.2.3" },
      { stage: "resolved", address: "203.0.113.3" },
    ];
    expect(decide(f)).toMatchObject({ route: "proxy", matchedPolicy: null });
  });

  it("returns an immutable detached interpretation without freezing caller records or granting permission", () => {
    const f = fixture();
    const result = decide(f);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.branches)).toBe(true);
    expect(Object.isFrozen(result.branches[0].decision)).toBe(true);
    expect(Object.isFrozen(result.branches[0].destination)).toBe(true);
    expect(Object.isFrozen(f.context)).toBe(false);
    f.context!.destinations = [{ stage: "resolved", address: "10.0.0.1" }];
    f.snapshot.rules[0].proxy = "REJECT";
    expect(result).toMatchObject({
      route: "direct",
      matchedPolicy: "DIRECT",
      branches: [{ destination: { stage: "unknown" } }],
    });
    expect(result).not.toHaveProperty("proofId");
    expect(result).not.toHaveProperty("allowed");
  });
});
