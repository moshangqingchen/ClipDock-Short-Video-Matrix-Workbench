import { createHash } from "node:crypto";
import { mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  associateCurrentConfiguration,
  validateConfigurationAssociation,
  validateConfigurationAssociationForFreshDns,
  CONFIGURATION_ASSOCIATION_ASSUMPTIONS,
  type ConfigurationAssociationInput,
  type KnownSelectedLoaderContract,
} from "./configuration-association";
import { EffectiveConfigSource, type EffectiveConfigCandidate } from "./effective-config-source";
import type { CurrentPathInputs } from "./path-input-reader";
import type { KernelDnsCandidates } from "./kernel-dns";
import type { WindowsControllerOwnerSnapshot } from "./windows-controller-owner";
import type { WindowsSystemHostsObservation } from "./windows-system-hosts";

const V = "a".repeat(64),
  H = "b".repeat(64),
  K = "c".repeat(64),
  CHANGED = "d".repeat(64);
const missing = { present: false } as const;
const destination = {
  protocol: "https:",
  host: "creator.example.com",
  port: 443,
  addressFamily: "ipv4",
} as const;
function candidate(at: number): EffectiveConfigCandidate {
  return {
    kind: "local-config-candidate",
    runtimeConfigurationProven: false,
    sourceGeneration: 2,
    sourcePathIdentity: H,
    fileFingerprint: H,
    decoderIdentity: "known-client-decoder-v1",
    startedAtMono: at,
    completedAtMono: at + 4,
    expiresAtMono: at + 15004,
    controllerFingerprint: V,
    controllerStartedAtMono: at + 1,
    controllerCompletedAtMono: at + 3,
    comparedConfigFields: ["/mode", "/tun/enable"],
    comparedRuleCount: 1,
    orderedRulesFingerprint: H,
    sourceRuleOptionsFingerprint: H,
    rules: [{ type: "domain", payload: destination.host, proxy: "DIRECT" }],
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
  const answer = {
    queryType: "A",
    name: destination.host,
    type: 1,
    ttl: 15,
    data: "203.0.113.8",
    observedAtMono: at,
    expiresAtMono: at + 15000,
  } as const;
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
    hosts: [
      {
        host: destination.host,
        status: "unverified",
        reasons: ["FAMILY_MISSING"],
        ipv4: [answer.data],
        ipv6: [],
        addresses: [{ address: answer.data, addressFamily: "ipv4", addressClass: "real" }],
        answers: [answer],
        queries: [
          {
            type: "A",
            startedAtMono: at,
            completedAtMono: at + 1,
            error: null,
            response: {
              host: destination.host,
              queryType: "A",
              status: 0,
              truncated: false,
              question: { name: destination.host, type: 1 },
              answers: [answer],
              startedAtMono: at,
              completedAtMono: at + 1,
            },
          },
        ],
        startedAtMono: at,
        completedAtMono: at + 1,
        expiresAtMono: at + 15000,
      },
    ],
  };
}
function setup(): ConfigurationAssociationInput {
  const inputs: CurrentPathInputs = {
    state: "observed",
    kind: "current-path-inputs",
    sampleId: "current-real-read-shape",
    generation: 4,
    rulesVersion: V,
    targets: [structuredClone(destination)],
    startedAtMono: 100,
    completedAtMono: 124,
    expiresAtMono: 15100,
    configurationBefore: candidate(100),
    configurationAfter: candidate(118),
    ownerBefore: owner(100),
    ownerAfter: owner(120),
    networkBefore: { hash: H, startedAtMono: 100, completedAtMono: 104 },
    networkAfter: { hash: H, startedAtMono: 120, completedAtMono: 124 },
    dnsBefore: dns(105),
    dnsAfter: dns(112),
    routeBatches: [
      {
        available: true,
        basis: "windows-best-route-query",
        socketObserved: false,
        startedAtMono: 108,
        completedAtMono: 110,
        scopeHash: H,
        selectionHash: H,
        selections: [
          {
            targetAddress: "203.0.113.8",
            sourceAddress: "192.0.2.2",
            addressFamily: "ipv4",
            sourceState: "Preferred",
            skipAsSource: false,
            interfaceIndex: 12,
            interfaceGuid: "00000001-0002-0003-0004-000000000005",
            interfaceIdentity: H,
            hardwareInterface: true,
            adapterStatus: "Up",
            adapterUp: true,
            interfaceConnection: "Connected",
            interfaceMetric: 20,
            destinationPrefix: "0.0.0.0/0",
            nextHop: "192.0.2.1",
            routeMetric: 0,
            routeState: "Alive",
          },
        ],
      },
    ],
  };
  const loader: KnownSelectedLoaderContract = {
    source: "main-process-selected-loader-contract",
    selectionId: "current-app-source-selection",
    loaderProfileId: "explicit-known-client-path-contract",
    sourcePathIdentity: H,
    decoderIdentity: "known-client-decoder-v1",
    qualificationEvidenceIds: ["retained-client-loader-path-record", "retained-decoder-protocol-record"],
    selectedAtMono: 10,
  };
  return { inputs, loader };
}
const result = (input: ConfigurationAssociationInput, now = 130) => associateCurrentConfiguration(input, now);

describe("configuration association", () => {
  const hostsObservation = (at: number): WindowsSystemHostsObservation => ({
    available: true,
    kind: "windows-system-hosts-targets",
    source: "windows-system-hosts-file",
    resolutionProven: false,
    parserProfile: "windows-hosts-ascii-aliases-v1",
    scopeHash: createHash("sha256")
      .update(JSON.stringify([destination.host]))
      .digest("hex"),
    fileHash: H,
    fileIdentity: H,
    startedAtMono: at,
    completedAtMono: at + 1,
    hosts: [{ host: destination.host, ipv4: [], ipv6: [] }],
  });
  const withHosts = (): ConfigurationAssociationInput => {
    const fixture = setup();
    return {
      ...fixture,
      inputs: {
        ...fixture.inputs,
        systemHostsBefore: hostsObservation(100),
        systemHostsAfter: hostsObservation(120),
      },
    };
  };

  it("keeps configuration association available for separately checked fresh DNS after initial DNS expires", () => {
    const fixture = withHosts();
    const inputs = { ...fixture.inputs, expiresAtMono: 1100 };
    const found = result({ ...fixture, inputs });
    if (!found.valid) throw new Error(found.reason);
    const original = structuredClone({ inputs, association: found.association });
    expect(validateConfigurationAssociation(found.association, inputs, fixture.loader, 1100)).toBe(false);
    expect(validateConfigurationAssociationForFreshDns(found.association, inputs, fixture.loader, 1200)).toBe(
      true,
    );
    expect({ inputs, association: found.association }).toEqual(original);
    expect(found.association.expiresAtMono).toBe(1100);
    expect(
      validateConfigurationAssociationForFreshDns(found.association, inputs, fixture.loader, 15100),
    ).toBe(false);
  });

  it.each(["configuration", "owner", "OS", "hosts"] as const)(
    "rejects the original %s observation exactly at its real 15-second deadline",
    (kind) => {
      const fixture = withHosts();
      const inputs: CurrentPathInputs = {
        ...fixture.inputs,
        expiresAtMono: 1100,
        configurationBefore: candidate(kind === "configuration" ? 100 : 101),
        ownerBefore: owner(kind === "owner" ? 100 : 101),
        networkBefore: { hash: H, startedAtMono: kind === "OS" ? 100 : 101, completedAtMono: 105 },
        systemHostsBefore: hostsObservation(kind === "hosts" ? 100 : 101),
      };
      const found = result({ ...fixture, inputs });
      if (!found.valid) throw new Error(found.reason);
      expect(
        validateConfigurationAssociationForFreshDns(found.association, inputs, fixture.loader, 15099),
      ).toBe(true);
      expect(
        validateConfigurationAssociationForFreshDns(found.association, inputs, fixture.loader, 15100),
      ).toBe(false);
    },
  );

  it("retains a genuinely shorter configuration deadline even if caller-owned candidate dates are later extended", () => {
    const fixture = withHosts();
    const inputs = {
      ...fixture.inputs,
      expiresAtMono: 1100,
      configurationBefore: { ...fixture.inputs.configurationBefore, expiresAtMono: 1200 },
    };
    const found = result({ ...fixture, inputs });
    if (!found.valid) throw new Error(found.reason);
    expect(validateConfigurationAssociationForFreshDns(found.association, inputs, fixture.loader, 1199)).toBe(
      true,
    );
    inputs.configurationBefore.expiresAtMono = 15100;
    // The original full-input deadline still equals 1100. It cannot reveal this inner extension.
    expect(validateConfigurationAssociation(found.association, inputs, fixture.loader, 131)).toBe(true);
    expect(validateConfigurationAssociationForFreshDns(found.association, inputs, fixture.loader, 1200)).toBe(
      false,
    );
  });

  it.each([
    "copied association",
    "no association",
    "changed controller",
    "changed owner",
    "changed OS",
    "changed hosts",
    "unselected loader",
  ])("does not accept %s through the fresh-DNS configuration prerequisite", (kind) => {
    const fixture = withHosts();
    const inputs = structuredClone({ ...fixture.inputs, expiresAtMono: 1100 });
    const found = result({ ...fixture, inputs });
    if (!found.valid) throw new Error(found.reason);
    const changed = structuredClone(inputs);
    if (kind === "changed controller") Object.assign(changed, { rulesVersion: CHANGED });
    if (kind === "changed owner") Object.assign(changed.ownerAfter, { kernelEpoch: CHANGED });
    if (kind === "changed OS") Object.assign(changed.networkAfter, { hash: CHANGED });
    if (kind === "changed hosts") Object.assign(changed.systemHostsAfter!, { fileIdentity: CHANGED });
    expect(
      validateConfigurationAssociationForFreshDns(
        kind === "no association"
          ? null
          : kind === "copied association"
            ? structuredClone(found.association)
            : found.association,
        changed,
        kind === "unselected loader" ? null : fixture.loader,
        1200,
      ),
    ).toBe(false);
  });

  it.each([NaN, Infinity, -1, 129])("rejects non-current fresh-DNS configuration time %s", (at) => {
    const fixture = withHosts(),
      found = result(fixture);
    if (!found.valid) throw new Error(found.reason);
    expect(
      validateConfigurationAssociationForFreshDns(found.association, fixture.inputs, fixture.loader, at),
    ).toBe(false);
  });

  it("binds the system hosts file and target projection without claiming resolver equivalence", () => {
    const fixture = withHosts();
    const found = result(fixture);
    expect(found.valid).toBe(true);
    if (!found.valid) return;
    expect(found.association.systemHostsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(validateConfigurationAssociation(found.association, fixture.inputs, fixture.loader, 131)).toBe(
      true,
    );
    const replacement = { ...fixture.inputs.systemHostsAfter!, fileHash: CHANGED };
    const changed = {
      ...fixture.inputs,
      systemHostsBefore: { ...replacement, startedAtMono: 100, completedAtMono: 101 },
      systemHostsAfter: replacement,
    };
    expect(validateConfigurationAssociation(found.association, changed, fixture.loader, 131)).toBe(false);
    const { systemHostsBefore: _before, systemHostsAfter: _after, ...legacy } = fixture.inputs;
    expect(validateConfigurationAssociation(found.association, legacy, fixture.loader, 131)).toBe(false);
  });

  it.each([
    "missing half",
    "test source",
    "wrong scope",
    "old window",
    "changed identity",
    "changed contents",
    "changed projection",
  ] as const)("rejects %s hosts records in current associations", (kind) => {
    const fixture = withHosts();
    let after = fixture.inputs.systemHostsAfter!;
    if (kind === "test source") after = { ...after, source: "explicit-test-hosts-file" };
    if (kind === "wrong scope") after = { ...after, scopeHash: CHANGED };
    if (kind === "old window") after = { ...after, startedAtMono: 90, completedAtMono: 91 };
    if (kind === "changed identity") after = { ...after, fileIdentity: CHANGED };
    if (kind === "changed contents") after = { ...after, fileHash: CHANGED };
    if (kind === "changed projection")
      after = { ...after, hosts: [{ host: destination.host, ipv4: ["192.0.2.2"], ipv6: [] }] };
    expect(
      result({
        ...fixture,
        inputs: { ...fixture.inputs, systemHostsAfter: kind === "missing half" ? undefined : after },
      }),
    ).toEqual({
      valid: false,
      reason:
        kind === "old window"
          ? "INPUT_EXPIRED"
          : kind.startsWith("changed")
            ? "NETWORK_CHANGED"
            : "INPUT_INVALID",
    });
  });

  it("accepts generation 0 from real EffectiveConfigSource initial file reads without changing Gate generation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "clipdock-association-source-zero-"));
    const file = path.join(directory, "selected-fixture.yaml");
    let source: EffectiveConfigSource | null = null;
    try {
      await writeFile(file, `mode: rule\nrules:\n  - DOMAIN,${destination.host},DIRECT\n`, { flag: "wx" });
      const resolved = await realpath(file),
        fixture = setup();
      const loader: KnownSelectedLoaderContract = {
        ...fixture.loader!,
        selectedAtMono: performance.now(),
        decoderIdentity: "plaintext-yaml-v1",
        sourcePathIdentity: createHash("sha256")
          .update(process.platform === "win32" ? resolved.toLowerCase() : resolved)
          .digest("hex"),
      };
      const modeHash = createHash("sha256").update(JSON.stringify("rule")).digest("hex");
      source = new EffectiveConfigSource({
        path: file,
        format: "yaml",
        readController: async () => {
          const at = performance.now();
          return {
            mode: "rule",
            tun: true,
            mixedPort: 10090,
            version: "synthetic-controller",
            fingerprint: V,
            rules: [{ type: "Domain", payload: destination.host, proxy: "DIRECT" }],
            configFieldHashes: { mode: modeHash },
            configPathHashes: { "/mode": modeHash },
            startedAtMono: at,
            completedAtMono: at,
            directPolicy: {
              kind: "direct",
              interfaceName: null,
              dialer: "none",
              ipVersion: null,
              policyFingerprint: H,
              startedAtMono: at,
              completedAtMono: at,
            },
          };
        },
      });
      const first = await source.read(),
        second = await source.read();
      expect(first.state).toBe("candidate");
      expect(second.state).toBe("candidate");
      if (first.state !== "candidate" || second.state !== "candidate") return;
      expect(first.candidate.sourceGeneration).toBe(0);
      expect(second.candidate.sourceGeneration).toBe(0);
      const start = first.candidate.startedAtMono,
        end = second.candidate.completedAtMono;
      const inputs: CurrentPathInputs = {
        ...fixture.inputs,
        startedAtMono: start,
        completedAtMono: end,
        expiresAtMono: Math.min(first.candidate.expiresAtMono, second.candidate.expiresAtMono),
        configurationBefore: first.candidate,
        configurationAfter: second.candidate,
        ownerBefore: { ...fixture.inputs.ownerBefore, startedAtMono: start, completedAtMono: start },
        ownerAfter: { ...fixture.inputs.ownerAfter, startedAtMono: end, completedAtMono: end },
        networkBefore: { hash: H, startedAtMono: start, completedAtMono: start },
        networkAfter: { hash: H, startedAtMono: end, completedAtMono: end },
      };
      const found = associateCurrentConfiguration({ inputs, loader }, performance.now());
      expect(found.valid).toBe(true);
      if (!found.valid) return;
      expect(found.association.sourceGeneration).toBe(0);
      expect(found.association.generation).toBe(4);
      expect(found.association.runtimeConfigurationProven).toBe(false);
      expect(validateConfigurationAssociation(found.association, inputs, loader, performance.now())).toBe(
        true,
      );
    } finally {
      source?.dispose();
      // Only the exact new fixture file and its empty directory; never recursive cleanup.
      await unlink(file);
      await rmdir(directory);
    }
  });

  it.each([-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid source generation %s",
    (sourceGeneration) => {
      const fixture = setup();
      const inputs = {
        ...fixture.inputs,
        configurationBefore: { ...fixture.inputs.configurationBefore, sourceGeneration },
        configurationAfter: { ...fixture.inputs.configurationAfter, sourceGeneration },
      };
      expect(result({ ...fixture, inputs })).toEqual({ valid: false, reason: "INPUT_INVALID" });
    },
  );

  it("still rejects Gate generation zero even though source generation zero is valid", () => {
    const fixture = setup();
    expect(
      result({
        ...fixture,
        inputs: {
          ...fixture.inputs,
          generation: 0,
          configurationBefore: { ...fixture.inputs.configurationBefore, sourceGeneration: 0 },
          configurationAfter: { ...fixture.inputs.configurationAfter, sourceGeneration: 0 },
        },
      }),
    ).toEqual({ valid: false, reason: "INPUT_INVALID" });
  });

  it("associates actual current records only under the selected loader model, without proving runtime configuration", () => {
    const fixture = setup(),
      before = structuredClone(fixture),
      found = result(fixture);
    expect(found.valid).toBe(true);
    if (!found.valid) return;
    expect(found.association).toMatchObject({
      source: "current-configuration-association",
      model: "known-selected-loader-observation",
      runtimeConfigurationProven: false,
      inputSampleId: fixture.inputs.sampleId,
      loaderSelectionId: fixture.loader!.selectionId,
      sourceGeneration: 2,
      generation: 4,
      sourcePathIdentity: H,
      fileFingerprint: H,
      decoderIdentity: fixture.loader!.decoderIdentity,
      controllerFingerprint: V,
      kernelEpoch: K,
      osNetworkHash: H,
      startedAtMono: 100,
      completedAtMono: 124,
      checkedAtMono: 130,
      expiresAtMono: 15100,
    });
    expect(found.association.supportAssumptions).toEqual(CONFIGURATION_ASSOCIATION_ASSUMPTIONS);
    expect(found.association).not.toHaveProperty("permit");
    expect(found.association).not.toHaveProperty("countryCode");
    expect(found.association).not.toHaveProperty("sourceAddress");
    expect(fixture).toEqual(before);
    expect(fixture.inputs.configurationAfter.runtimeConfigurationProven).toBe(false);
    expect(Object.isFrozen(found.association)).toBe(true);
    expect(Object.isFrozen(found.association.qualificationEvidenceIds)).toBe(true);
    expect(Object.isFrozen(found.association.comparedConfigFields)).toBe(true);
    expect(Object.isFrozen(found.association.supportAssumptions)).toBe(true);
  });

  it("never infers a loader selection from identical visible rules", () => {
    expect(result({ ...setup(), loader: null })).toEqual({ valid: false, reason: "LOADER_UNSELECTED" });
    const fixture = setup();
    expect(result({ ...fixture, loader: { ...fixture.loader!, sourcePathIdentity: CHANGED } })).toEqual({
      valid: false,
      reason: "LOADER_SOURCE_MISMATCH",
    });
  });

  it("requires the explicitly selected decoder as well as the selected source path", () => {
    const fixture = setup();
    expect(
      result({ ...fixture, loader: { ...fixture.loader!, decoderIdentity: "another-client-decoder" } }),
    ).toEqual({ valid: false, reason: "LOADER_SOURCE_MISMATCH" });
  });

  it.each(["selectionId", "loaderProfileId", "sourcePathIdentity", "decoderIdentity"] as const)(
    "rejects a missing loader %s",
    (field) => {
      const fixture = setup();
      expect(result({ ...fixture, loader: { ...fixture.loader!, [field]: "" } })).toEqual({
        valid: false,
        reason: "LOADER_CONTRACT_INVALID",
      });
    },
  );

  it("rejects absent or duplicated retained qualification references", () => {
    const fixture = setup();
    for (const qualificationEvidenceIds of [[], ["same", "same"]])
      expect(result({ ...fixture, loader: { ...fixture.loader!, qualificationEvidenceIds } }).valid).toBe(
        false,
      );
  });

  it("does not relabel a source selected after the input round as a preselected loader", () => {
    const fixture = setup();
    expect(result({ ...fixture, loader: { ...fixture.loader!, selectedAtMono: 101 } })).toEqual({
      valid: false,
      reason: "INPUT_EXPIRED",
    });
  });

  it("does not restore associations from JSON, copies or older rounds", () => {
    const fixture = setup(),
      found = result(fixture);
    expect(found.valid).toBe(true);
    if (!found.valid) return;
    expect(validateConfigurationAssociation(found.association, fixture.inputs, fixture.loader, 131)).toBe(
      true,
    );
    expect(
      validateConfigurationAssociation({ ...found.association }, fixture.inputs, fixture.loader, 131),
    ).toBe(false);
    expect(
      validateConfigurationAssociation(
        JSON.parse(JSON.stringify(found.association)),
        fixture.inputs,
        fixture.loader,
        131,
      ),
    ).toBe(false);
    expect(
      validateConfigurationAssociation(
        found.association,
        { ...fixture.inputs, sampleId: "a-new-round" },
        fixture.loader,
        131,
      ),
    ).toBe(false);
    expect(
      validateConfigurationAssociation(
        found.association,
        fixture.inputs,
        { ...fixture.loader!, selectionId: "another-selection" },
        131,
      ),
    ).toBe(false);
    expect(validateConfigurationAssociation(found.association, fixture.inputs, fixture.loader, 15100)).toBe(
      false,
    );
    expect(validateConfigurationAssociation(found.association, fixture.inputs, fixture.loader, 129)).toBe(
      false,
    );
    expect(found.association.checkedAtMono).toBe(130);
    expect(found.association.expiresAtMono).toBe(15100);
  });

  it("copies mutable loader references and current input projections into the association", () => {
    const fixture = setup(),
      found = result(fixture);
    if (!found.valid) throw new Error(found.reason);
    Object.assign(fixture.loader!, { qualificationEvidenceIds: ["later-mutated-reference"] });
    Object.assign(fixture.inputs.configurationAfter, { comparedConfigFields: ["/later-change"] });
    expect(found.association.qualificationEvidenceIds).toEqual([
      "retained-client-loader-path-record",
      "retained-decoder-protocol-record",
    ]);
    expect(found.association.comparedConfigFields).toEqual(["/mode", "/tun/enable"]);
    expect(validateConfigurationAssociation(found.association, fixture.inputs, fixture.loader, 131)).toBe(
      false,
    );
  });

  it.each([
    "fileFingerprint",
    "sourceGeneration",
    "orderedRulesFingerprint",
    "sourceRuleOptionsFingerprint",
  ] as const)("rejects changed before/after source %s", (field) => {
    const fixture = setup();
    const changed = {
      ...fixture.inputs.configurationAfter,
      [field]: field === "sourceGeneration" ? 3 : CHANGED,
    };
    expect(result({ ...fixture, inputs: { ...fixture.inputs, configurationAfter: changed } })).toEqual({
      valid: false,
      reason: "SOURCE_CHANGED",
    });
  });

  it("checks actual policy projections and preserves missing fields instead of filling defaults", () => {
    const fixture = setup(),
      after = fixture.inputs.configurationAfter;
    expect(after.policy.dnsFlags["use-system-hosts"]).toEqual({ present: false });
    expect(result(fixture).valid).toBe(true);
    const changed = {
      ...after,
      policy: {
        ...after.policy,
        dnsFlags: { ...after.policy.dnsFlags, "use-system-hosts": { present: true as const, value: false } },
      },
    };
    // A stale policy digest does not excuse an internally contradictory projection.
    expect(result({ ...fixture, inputs: { ...fixture.inputs, configurationAfter: changed } })).toEqual({
      valid: false,
      reason: "SOURCE_CHANGED",
    });
  });

  it.each(["visible controller", "actual Direct policy", "Direct interface", "Direct dialer"])(
    "rejects changed %s",
    (kind) => {
      const fixture = setup(),
        after = fixture.inputs.configurationAfter;
      let changed = after;
      if (kind === "visible controller") changed = { ...after, controllerFingerprint: CHANGED };
      if (kind === "actual Direct policy")
        changed = {
          ...after,
          currentDirectPolicy: { ...after.currentDirectPolicy, policyFingerprint: CHANGED },
        };
      if (kind === "Direct interface")
        changed = {
          ...after,
          currentDirectPolicy: { ...after.currentDirectPolicy, interfaceName: "different-interface" },
        };
      if (kind === "Direct dialer")
        changed = { ...after, currentDirectPolicy: { ...after.currentDirectPolicy, dialer: "configured" } };
      expect(result({ ...fixture, inputs: { ...fixture.inputs, configurationAfter: changed } })).toEqual({
        valid: false,
        reason: "CONTROLLER_CHANGED",
      });
    },
  );

  it.each(["PID", "birth", "epoch", "listener", "scope", "path identity"])(
    "rejects changed kernel %s",
    (kind) => {
      const fixture = setup(),
        after = fixture.inputs.ownerAfter;
      let changed = after;
      if (kind === "PID") changed = { ...after, owner: { ...after.owner, pid: 402 } };
      if (kind === "birth")
        changed = { ...after, owner: { ...after.owner, createdAtTicks: "639244035457234679" } };
      if (kind === "epoch") changed = { ...after, kernelEpoch: CHANGED };
      if (kind === "listener") changed = { ...after, listeners: [{ ...after.listeners[0], port: 9791 }] };
      if (kind === "scope") changed = { ...after, scopeHash: CHANGED };
      if (kind === "path identity")
        changed = { ...after, owner: { ...after.owner, executablePathIdentity: H } };
      expect(result({ ...fixture, inputs: { ...fixture.inputs, ownerAfter: changed } })).toEqual({
        valid: false,
        reason: "KERNEL_CHANGED",
      });
    },
  );

  it("does not require an otherwise unused executable path to be readable", () => {
    const fixture = setup();
    expect(fixture.inputs.ownerAfter.owner.executablePathIdentity).toBeNull();
    expect(result(fixture).valid).toBe(true);
  });

  it("rejects OS network change even when the selected file and live rules are unchanged", () => {
    const fixture = setup();
    expect(
      result({
        ...fixture,
        inputs: { ...fixture.inputs, networkAfter: { ...fixture.inputs.networkAfter, hash: CHANGED } },
      }),
    ).toEqual({ valid: false, reason: "NETWORK_CHANGED" });
  });

  it.each([
    "configurationBefore",
    "configurationAfter",
    "ownerBefore",
    "ownerAfter",
    "networkBefore",
    "networkAfter",
  ] as const)(
    "rejects an old shared %s sample whose timestamp predates the actual current round",
    (field) => {
      const fixture = setup();
      expect(
        result({
          ...fixture,
          inputs: { ...fixture.inputs, [field]: { ...fixture.inputs[field], startedAtMono: 99 } },
        }),
      ).toEqual({ valid: false, reason: "INPUT_EXPIRED" });
    },
  );

  it.each([
    "configurationBefore",
    "configurationAfter",
    "ownerBefore",
    "ownerAfter",
    "networkBefore",
    "networkAfter",
  ] as const)("rejects a %s sample outside the closed input window", (field) => {
    const fixture = setup();
    expect(
      result({
        ...fixture,
        inputs: { ...fixture.inputs, [field]: { ...fixture.inputs[field], completedAtMono: 125 } },
      }),
    ).toEqual({ valid: false, reason: "INPUT_EXPIRED" });
  });

  it.each([
    "controller outside source window",
    "Direct outside controller window",
    "NaN time",
    "expired candidate",
    "expired inputs",
    "old providers",
  ])("rejects %s without relabeling the sample time", (kind) => {
    const fixture = setup();
    let inputs = fixture.inputs;
    if (kind === "controller outside source window")
      inputs = {
        ...inputs,
        configurationAfter: { ...inputs.configurationAfter, controllerStartedAtMono: 117 },
      };
    if (kind === "Direct outside controller window")
      inputs = {
        ...inputs,
        configurationAfter: {
          ...inputs.configurationAfter,
          currentDirectPolicy: { ...inputs.configurationAfter.currentDirectPolicy, completedAtMono: 122 },
        },
      };
    if (kind === "NaN time") inputs = { ...inputs, completedAtMono: NaN };
    if (kind === "expired candidate")
      inputs = { ...inputs, configurationBefore: { ...inputs.configurationBefore, expiresAtMono: 130 } };
    if (kind === "expired inputs") inputs = { ...inputs, expiresAtMono: 130 };
    if (kind === "old providers")
      inputs = {
        ...inputs,
        expiresAtMono: 99999,
        configurationBefore: { ...inputs.configurationBefore, expiresAtMono: 99999 },
        configurationAfter: { ...inputs.configurationAfter, expiresAtMono: 99999 },
      };
    expect(result({ ...fixture, inputs }, kind === "old providers" ? 15100 : 130)).toEqual({
      valid: false,
      reason: "INPUT_EXPIRED",
    });
  });

  it("limits expiry to the earliest real current dependency instead of adding a fresh TTL at checking", () => {
    const fixture = setup(),
      found = result({ ...fixture, inputs: { ...fixture.inputs, expiresAtMono: 140 } });
    expect(found.valid && found.association.expiresAtMono).toBe(140);
    if (found.valid)
      expect(
        validateConfigurationAssociation(
          found.association,
          { ...fixture.inputs, expiresAtMono: 140 },
          fixture.loader,
          139,
        ),
      ).toBe(true);
  });

  it("does not turn global or proxy configuration association into a routing permission", () => {
    const fixture = setup();
    const change = (value: EffectiveConfigCandidate) => ({
      ...value,
      currentDirectPolicy: { ...value.currentDirectPolicy, kind: "other" as const },
    });
    const found = result({
      ...fixture,
      inputs: {
        ...fixture.inputs,
        configurationBefore: change(fixture.inputs.configurationBefore),
        configurationAfter: change(fixture.inputs.configurationAfter),
      },
    });
    expect(found.valid).toBe(true);
    if (found.valid) expect(found.association.runtimeConfigurationProven).toBe(false);
  });

  it("rejects a candidate that claims a proven runtime configuration instead of accepting the false marker as permission", () => {
    const fixture = setup();
    const changed = {
      ...fixture.inputs.configurationAfter,
      runtimeConfigurationProven: true,
    } as unknown as EffectiveConfigCandidate;
    expect(result({ ...fixture, inputs: { ...fixture.inputs, configurationAfter: changed } })).toEqual({
      valid: false,
      reason: "INPUT_INVALID",
    });
  });
});
