import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { associateCurrentConfiguration, type KnownSelectedLoaderContract } from "./configuration-association";
import { type CurrentRuleContext, type CurrentRuleContextInput } from "./current-rule-context";
import type { EffectiveConfigCandidate } from "./effective-config-source";
import type { KernelDnsCandidates } from "./kernel-dns";
import type { CurrentPathInputs } from "./path-input-reader";
import { normalizeKernelRule, type KernelRule } from "./rules";
import type { WindowsControllerOwnerSnapshot } from "./windows-controller-owner";
import {
  createConservativeRuleContexts,
  UNCONFIRMED_MATCH_STAGE_POLICY,
  type ConservativeRuleContextInput,
} from "./current-rule-context-producer";
import { evaluateRuleContextSet } from "./rule-context-set";
import { proofTargetKey, type ProofTarget } from "./direct-proof";

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
function baseFixture(
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

const echoTarget = (addressFamily: ProofTarget["addressFamily"]): ProofTarget => ({
  protocol: "https:",
  host: addressFamily === "ipv4" ? "myip.ipip.net" : "api6.ipify.org",
  port: 443,
  addressFamily,
});
function fixture(business: readonly ProofTarget[] = [target]) {
  const original = baseFixture(
    [direct, cidr(), { type: "Domain", payload: "myip.ipip.net", proxy: "DIRECT" }],
    [[], ["no-resolve"], []],
  );
  const inputs = original.configuration!.inputs;
  inputs.targets = [
    ...new Map(
      [...business, ...business.map((t) => echoTarget(t.addressFamily))].map((t) => [
        proofTargetKey(t),
        structuredClone(t),
      ]),
    ).values(),
  ];
  const loader = original.configuration!.loader!;
  const associated = associateCurrentConfiguration({ inputs, loader }, 130);
  if (!associated.valid) throw new Error("current association fixture failed");
  const abort = new AbortController();
  const data = {
    request: {
      requestId: "current-collection-request",
      generation: inputs.generation,
      rulesVersion: inputs.rulesVersion,
      startedAtMono: 99,
      signal: abort.signal,
      scope: {
        accountId: "account-id",
        platformId: "bilibili",
        contextId: "actual-operation-context",
        catalogVersion: "reviewed-catalog-v1",
        catalogReviewed: true,
        targets: structuredClone(business),
      },
    },
    inputs,
    configuration: { inputs: structuredClone(inputs), loader, association: associated.association },
    transport: {
      evidenceId: "retained-transport-qualification",
      accountProfileId: "actual-account-profile",
      tlsFactoryId: "clipdock-anonymous-tls-v1",
      tlsProfileId: "actual-tls-profile",
      egressFactoryId: "clipdock-anonymous-egress-v1",
      egressProfileId: "actual-egress-profile",
    },
  } as Mutable<ConservativeRuleContextInput>;
  return { data, abort, snapshot: original.snapshot };
}

describe("conservative current rule context producer", () => {
  it("creates current account/TLS/egress profile inputs with explicit unknown stage and real source references", () => {
    const { data } = fixture();
    const found = createConservativeRuleContexts(data, 131)!;
    expect(found).toHaveLength(3);
    expect(found.map((c) => [c.target.host, c.transportProfileId])).toEqual([
      [target.host, data.transport.accountProfileId],
      [target.host, data.transport.tlsProfileId],
      ["myip.ipip.net", data.transport.egressProfileId],
    ]);
    for (const context of found) {
      expect(context).toMatchObject({
        source: "main-process-current-rule-context",
        network: "tcp",
        destinations: [{ stage: "unknown" }],
        scopeContextId: data.request.scope.contextId,
        generation: data.request.generation,
        rulesVersion: V,
        inputSampleId: data.inputs.sampleId,
        configurationEvidenceId: data.configuration.association!.evidenceId,
        kernelEpoch: K,
        checkedAtMono: 131,
        expiresAtMono: 15100,
      });
      expect(context.sourceEvidenceIds).toEqual([
        data.configuration.association!.evidenceId,
        data.inputs.sampleId,
        data.transport.evidenceId,
        UNCONFIRMED_MATCH_STAGE_POLICY,
      ]);
      expect(context).not.toHaveProperty("processName");
      expect(context).not.toHaveProperty("processPath");
      expect(context).not.toHaveProperty("applicabilityVerified");
    }
  });

  it("lets an early DOMAIN decide but preserves unknown for IP-dependent echo matching", () => {
    const { data, snapshot } = fixture();
    const contexts = createConservativeRuleContexts(data, 131)!;
    const set = {
      configuration: { association: data.configuration.association, loader: data.configuration.loader },
      contexts,
    };
    const evaluate = (t: ProofTarget, profile: string) =>
      evaluateRuleContextSet(
        set,
        data.inputs,
        snapshot,
        t,
        data.request.scope.contextId,
        profile,
        "tcp",
        131,
      );
    expect(evaluate(target, data.transport.accountProfileId)).toMatchObject({
      route: "direct",
      matchedPolicy: "DIRECT",
      branches: [{ destination: { stage: "unknown" }, decision: { ruleIndex: 0 } }],
    });
    expect(evaluate(target, data.transport.tlsProfileId).route).toBe("direct");
    expect(evaluate(echoTarget("ipv4"), data.transport.egressProfileId)).toMatchObject({
      route: "unknown",
      matchedPolicy: null,
      branches: [{ destination: { stage: "unknown" }, decision: { ruleIndex: 1 } }],
    });
  });

  it("does not turn current kernel DNS addresses into a resolved or unresolved rule-stage destination", () => {
    const { data } = fixture();
    data.inputs.dnsAfter.hosts.push({
      host: "myip.ipip.net",
      status: "candidate",
      reasons: [],
      ipv4: ["203.0.113.9"],
      ipv6: [],
      addresses: [],
      queries: [],
      answers: [],
      startedAtMono: 112,
      completedAtMono: 113,
      expiresAtMono: 15100,
    });
    data.configuration.inputs.dnsAfter = structuredClone(data.inputs.dnsAfter);
    const contexts = createConservativeRuleContexts(data, 131)!;
    expect(contexts).not.toBeNull();
    expect(contexts.every((c) => JSON.stringify(c.destinations) === '[{"stage":"unknown"}]')).toBe(true);
  });

  it("covers each possible address family without defaulting a dual-family scope to IPv4", () => {
    const { data } = fixture([target, { ...target, addressFamily: "ipv6" }]);
    const found = createConservativeRuleContexts(data, 131)!;
    expect(found).toHaveLength(6);
    expect(
      found
        .filter((c) => c.transportProfileId === data.transport.egressProfileId)
        .map((c) => [c.target.host, c.target.addressFamily]),
    ).toEqual([
      ["myip.ipip.net", "ipv4"],
      ["api6.ipify.org", "ipv6"],
    ]);
  });

  it("unions overlapping business/echo targets and repeated profile IDs without duplicate contexts", () => {
    const { data } = fixture([target, echoTarget("ipv4")]);
    expect(createConservativeRuleContexts(data, 131)).toHaveLength(5);
    data.transport.tlsProfileId = data.transport.accountProfileId;
    data.transport.egressProfileId = data.transport.accountProfileId;
    const contexts = createConservativeRuleContexts(data, 131)!;
    expect(contexts).toHaveLength(2);
    expect(new Set(contexts.map((c) => `${proofTargetKey(c.target)}:${c.transportProfileId}`)).size).toBe(2);
  });

  it("normalizes exact targets and returns immutable contents independent of caller mutations", () => {
    const { data } = fixture();
    data.request.scope.targets[0].host = "CREATOR.EXAMPLE.TEST.";
    const contexts = createConservativeRuleContexts(data, 131)!;
    expect(contexts[0].target.host).toBe(target.host);
    expect(Object.isFrozen(contexts)).toBe(true);
    for (const context of contexts) {
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.target)).toBe(true);
      expect(Object.isFrozen(context.destinations[0])).toBe(true);
      expect(Object.isFrozen(context.sourceEvidenceIds)).toBe(true);
    }
    data.inputs.targets[0].host = "changed.example.test";
    data.transport.accountProfileId = "changed-profile";
    expect(contexts[0].target.host).toBe(target.host);
    expect(contexts[0].transportProfileId).toBe("actual-account-profile");
  });

  it.each(["association", "loader"] as const)("rejects absent %s instead of constructing it", (key) => {
    const { data } = fixture();
    data.configuration[key] = null;
    expect(createConservativeRuleContexts(data, 131)).toBeNull();
  });

  it("cannot restore a plain serialized association as a current source", () => {
    const { data } = fixture();
    data.configuration.association = structuredClone(data.configuration.association);
    expect(createConservativeRuleContexts(data, 131)).toBeNull();
  });

  it.each(["generation", "rulesVersion"] as const)("rejects a request from another %s", (field) => {
    const { data } = fixture();
    if (field === "generation") data.request.generation++;
    else data.request.rulesVersion = OTHER;
    expect(createConservativeRuleContexts(data, 131)).toBeNull();
  });

  it.each(["inputs", "configuration"] as const)(
    "requires the original brand to validate against %s contents",
    (which) => {
      const { data } = fixture();
      const input = which === "inputs" ? data.inputs : data.configuration.inputs;
      input.configurationAfter.fileFingerprint = OTHER;
      expect(createConservativeRuleContexts(data, 131)).toBeNull();
    },
  );

  it.each([
    "missing echo",
    "extra host",
    "duplicate target",
    "configuration target mismatch",
    "duplicate business",
  ] as const)("rejects %s instead of broadening coverage", (change) => {
    const { data } = fixture();
    if (change === "missing echo") {
      data.inputs.targets.pop();
      data.configuration.inputs.targets.pop();
    } else if (change === "extra host") {
      const extra = { ...target, host: "extra.example.test" };
      data.inputs.targets.push(extra);
      data.configuration.inputs.targets.push(extra);
    } else if (change === "duplicate target") data.inputs.targets.push({ ...target });
    else if (change === "configuration target mismatch") data.configuration.inputs.targets[0].port = 8443;
    else data.request.scope.targets.push({ ...target });
    expect(createConservativeRuleContexts(data, 131)).toBeNull();
  });

  it.each(["accountProfileId", "tlsProfileId", "egressProfileId", "evidenceId"] as const)(
    "rejects a missing transport %s",
    (key) => {
      const { data } = fixture();
      data.transport[key] = "";
      expect(createConservativeRuleContexts(data, 131)).toBeNull();
    },
  );

  it.each(["tlsFactoryId", "egressFactoryId"] as const)(
    "does not replace an unknown %s with a known factory",
    (key) => {
      const { data } = fixture();
      Object.assign(data.transport, { [key]: "unknown-factory" });
      expect(createConservativeRuleContexts(data, 131)).toBeNull();
    },
  );

  it("preserves the source deadline across repeated calls and rejects at expiry", () => {
    const { data } = fixture();
    expect(createConservativeRuleContexts(data, 131)![0].expiresAtMono).toBe(15100);
    expect(createConservativeRuleContexts(data, 14000)![0].expiresAtMono).toBe(15100);
    expect(createConservativeRuleContexts(data, 15100)).toBeNull();
  });

  it("rejects input data predating this collection round and aborted work", () => {
    const f = fixture();
    f.data.request.startedAtMono = 101;
    expect(createConservativeRuleContexts(f.data, 131)).toBeNull();
    f.data.request.startedAtMono = 99;
    f.abort.abort();
    expect(createConservativeRuleContexts(f.data, 131)).toBeNull();
  });

  it.each([NaN, Infinity, -1, 129])("rejects invalid or pre-association time %s", (now) => {
    expect(createConservativeRuleContexts(fixture().data, now)).toBeNull();
  });
});
