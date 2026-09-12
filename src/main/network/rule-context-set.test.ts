import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { associateCurrentConfiguration, type KnownSelectedLoaderContract } from "./configuration-association";
import { type CurrentRuleContext, type CurrentRuleContextInput } from "./current-rule-context";
import type { EffectiveConfigCandidate } from "./effective-config-source";
import type { KernelDnsCandidates } from "./kernel-dns";
import type { CurrentPathInputs } from "./path-input-reader";
import { normalizeKernelRule, type KernelRule } from "./rules";
import type { WindowsControllerOwnerSnapshot } from "./windows-controller-owner";
import { cloneRuleContextSet, evaluateRuleContextSet, type CurrentRuleContextSet } from "./rule-context-set";

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
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function contextSet(input: CurrentRuleContextInput): Mutable<CurrentRuleContextSet> {
  if (!input.configuration?.association || !input.context) throw new Error("complete fixture required");
  return {
    configuration: { association: input.configuration.association, loader: input.configuration.loader },
    contexts: [input.context],
  } as Mutable<CurrentRuleContextSet>;
}
function decide(
  input: CurrentRuleContextInput,
  set: CurrentRuleContextSet,
  expectedNetwork: "tcp" | "udp" = "tcp",
  nowMono = 131,
) {
  return evaluateRuleContextSet(
    set,
    input.configuration!.inputs,
    input.snapshot,
    input.target,
    input.scopeContextId,
    input.transportProfileId,
    expectedNetwork,
    nowMono,
  );
}

describe("current rule context set boundaries", () => {
  it("preserves the actual constructed association while copying mutable contents", () => {
    const input = fixture();
    const original = contextSet(input);
    const copied = cloneRuleContextSet(original);
    expect(copied).not.toBe(original);
    expect(copied.configuration).not.toBe(original.configuration);
    expect(copied.configuration.association).toBe(original.configuration.association);
    expect(copied.configuration.loader).not.toBe(original.configuration.loader);
    expect(copied.contexts).not.toBe(original.contexts);
    expect(copied.contexts[0]).not.toBe(original.contexts[0]);
    expect(copied.contexts[0].target).not.toBe(original.contexts[0].target);
    expect(copied.contexts[0].destinations).not.toBe(original.contexts[0].destinations);
    expect(copied.contexts[0].sourceEvidenceIds).not.toBe(original.contexts[0].sourceEvidenceIds);
    expect(decide(input, copied)).toMatchObject({
      route: "direct",
      matchedPolicy: "DIRECT",
      expiresAtMono: 15000,
    });
    original.contexts[0].target.host = "unrelated.example.test";
    original.contexts[0].destinations[0] = { stage: "resolved", address: "10.1.2.3" };
    original.contexts[0].sourceEvidenceIds[0] = "replaced-artifact";
    original.configuration.loader!.qualificationEvidenceIds[0] = "replaced-loader";
    expect(copied.contexts[0].target.host).toBe(target.host);
    expect(copied.contexts[0].destinations).toEqual([{ stage: "unknown" }]);
    expect(copied.contexts[0].sourceEvidenceIds).toEqual(["retained-real-factory-behavior"]);
    expect(copied.configuration.loader!.qualificationEvidenceIds).toEqual([
      "retained-loader-and-decoder-record",
    ]);
    expect(decide(input, copied).route).toBe("direct");
  });

  it("cannot restore a serialized association by passing it through the preserving clone helper", () => {
    const input = fixture();
    const original = contextSet(input);
    const serializedCopy = structuredClone(original);
    expect(serializedCopy.configuration.association).toEqual(original.configuration.association);
    expect(decide(input, cloneRuleContextSet(serializedCopy))).toMatchObject({
      route: "unknown",
      reason: "RULE_UNVERIFIABLE",
    });
    expect(decide(input, cloneRuleContextSet(cloneRuleContextSet(original))).route).toBe("direct");
  });

  it("does not refresh context expiry while copying a valid branded association", () => {
    const input = fixture();
    const copied = cloneRuleContextSet(contextSet(input));
    expect(copied.contexts[0].checkedAtMono).toBe(130);
    expect(copied.contexts[0].expiresAtMono).toBe(15000);
    expect(decide(input, copied, "tcp", 14999).expiresAtMono).toBe(15000);
    expect(decide(input, copied, "tcp", 15000)).toMatchObject({ route: "unknown", reason: "PROOF_EXPIRED" });
  });

  it.each(["missing", "empty", "oversized"] as const)(
    "rejects a %s set without falling back to an early DOMAIN DIRECT rule",
    (kind) => {
      const input = fixture();
      const set = contextSet(input);
      if (kind === "missing") {
        expect(decide(input, null as unknown as CurrentRuleContextSet)).toMatchObject({
          route: "unknown",
          reason: "CONTEXT_UNVERIFIED",
        });
        return;
      }
      set.contexts =
        kind === "empty" ? [] : Array.from({ length: 769 }, () => structuredClone(set.contexts[0]));
      expect(decide(input, set)).toMatchObject({ route: "unknown", reason: "CONTEXT_UNVERIFIED" });
    },
  );

  it("rejects duplicate matching contexts instead of selecting the first or the unexpired one", () => {
    const input = fixture();
    const set = contextSet(input);
    set.contexts.push({ ...structuredClone(set.contexts[0]), expiresAtMono: 100 });
    expect(decide(input, set)).toMatchObject({
      route: "unknown",
      reason: "CONTEXT_UNVERIFIED",
      branches: [],
    });
  });

  it.each([
    ["scheme", { protocol: "http:" }],
    ["hostname", { host: "other.example.test" }],
    ["port", { port: 8443 }],
    ["address family", { addressFamily: "ipv6" }],
  ] as const)("does not borrow a target whose %s differs", (_name, change) => {
    const input = fixture();
    const set = contextSet(input);
    Object.assign(set.contexts[0].target, change);
    expect(decide(input, set)).toMatchObject({ route: "unknown", reason: "CONTEXT_UNVERIFIED" });
  });

  it.each(["scopeContextId", "transportProfileId"] as const)(
    "does not borrow a context with another %s",
    (key) => {
      const input = fixture();
      const set = contextSet(input);
      set.contexts[0][key] = "another-real-context";
      expect(decide(input, set)).toMatchObject({ route: "unknown", reason: "CONTEXT_UNVERIFIED" });
    },
  );

  it("selects exactly one matching scope/profile while ignoring unrelated evidence", () => {
    const input = fixture();
    const set = contextSet(input);
    set.contexts.unshift({ ...structuredClone(set.contexts[0]), scopeContextId: "unrelated-scope" });
    set.contexts.push({ ...structuredClone(set.contexts[1]), transportProfileId: "unrelated-profile" });
    expect(decide(input, set)).toMatchObject({ route: "direct", matchedPolicy: "DIRECT" });
  });

  it.each(["inputSampleId", "configurationEvidenceId", "rulesVersion", "kernelEpoch"] as const)(
    "does not use a selected context from another %s",
    (key) => {
      const input = fixture();
      const set = contextSet(input);
      set.contexts[0][key] = OTHER;
      expect(decide(input, set)).toMatchObject({ route: "unknown", reason: "CONTEXT_UNVERIFIED" });
    },
  );

  it("does not accept a selected context from an older generation", () => {
    const input = fixture();
    const set = contextSet(input);
    set.contexts[0].generation--;
    expect(decide(input, set)).toMatchObject({ route: "unknown", reason: "CONTEXT_UNVERIFIED" });
  });

  it("cannot give an actual TCP request the DIRECT branch belonging to UDP", () => {
    const input = fixture([
      { type: "Network", payload: "udp", proxy: "DIRECT" },
      { type: "Match", payload: "", proxy: "REJECT" },
    ]);
    const set = contextSet(input);
    set.contexts[0].network = "udp";
    expect(decide(input, set, "udp")).toMatchObject({ route: "direct", matchedPolicy: "DIRECT" });
    expect(decide(input, set, "tcp")).toMatchObject({
      route: "unknown",
      reason: "CONTEXT_UNVERIFIED",
      branches: [],
    });
    set.contexts[0].network = "tcp";
    expect(decide(input, set, "tcp")).toMatchObject({
      route: "proxy",
      reason: "NOT_DIRECT",
      matchedPolicy: "REJECT",
    });
  });

  it("also requires the expected UDP request to have a UDP context", () => {
    const input = fixture();
    expect(decide(input, contextSet(input), "udp")).toMatchObject({
      route: "unknown",
      reason: "CONTEXT_UNVERIFIED",
    });
  });

  it("does not resolve duplicate scope/profile contexts by choosing the desired transport", () => {
    const input = fixture();
    const set = contextSet(input);
    set.contexts.push({ ...structuredClone(set.contexts[0]), network: "udp" });
    expect(decide(input, set, "tcp")).toMatchObject({ route: "unknown", reason: "CONTEXT_UNVERIFIED" });
    expect(decide(input, set, "udp")).toMatchObject({ route: "unknown", reason: "CONTEXT_UNVERIFIED" });
  });
});
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
