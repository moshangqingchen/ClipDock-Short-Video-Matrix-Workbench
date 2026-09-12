import { describe, expect, it } from "vitest";
import {
  routeApplicabilityBinding,
  validateRouteApplicability,
  verifyRouteApplicability,
  type CurrentPhysicalRouteProjection,
  type RouteApplicabilityInput,
  type RouteConformanceRecord,
} from "./route-applicability";
import type { CurrentPathInputs } from "./path-input-reader";
import type { EffectiveConfigCandidate } from "./effective-config-source";
import type { ProofTarget } from "./direct-proof";
import type { KernelDnsCandidates, KernelDnsHostCandidate } from "./kernel-dns";
import type { WindowsRouteSelection } from "./windows-route-selection";

const V = "a".repeat(64),
  H = "b".repeat(64),
  K = "c".repeat(64);
const target = (host: string, addressFamily: ProofTarget["addressFamily"] = "ipv4"): ProofTarget => ({
  protocol: "https:",
  host,
  port: 443,
  addressFamily,
});
const TARGET = target("creator.example.com"),
  ECHO = target("echo.example.com");
const missing = { present: false } as const;
function config(): EffectiveConfigCandidate {
  return {
    kind: "local-config-candidate",
    runtimeConfigurationProven: false,
    sourceGeneration: 2,
    sourcePathIdentity: H,
    fileFingerprint: H,
    decoderIdentity: "fixture-yaml",
    startedAtMono: 1000,
    completedAtMono: 1000,
    expiresAtMono: 9000,
    controllerFingerprint: V,
    controllerStartedAtMono: 1000,
    controllerCompletedAtMono: 1000,
    comparedConfigFields: ["mode"],
    comparedRuleCount: 2,
    orderedRulesFingerprint: H,
    sourceRuleOptionsFingerprint: H,
    rules: [TARGET, ECHO].map(({ host }) => ({ type: "DOMAIN", payload: host, proxy: "DIRECT" })),
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
      startedAtMono: 1000,
      completedAtMono: 1000,
    },
  };
}
function route(address: string, updates: Partial<WindowsRouteSelection> = {}): WindowsRouteSelection {
  const ipv6 = address.includes(":");
  return {
    targetAddress: address,
    sourceAddress: ipv6 ? "2001:db8::2" : "192.0.2.2",
    addressFamily: ipv6 ? "ipv6" : "ipv4",
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
    destinationPrefix: ipv6 ? "::/0" : "0.0.0.0/0",
    nextHop: ipv6 ? "fe80::1" : "192.0.2.1",
    routeMetric: 0,
    routeState: "Alive",
    ...updates,
  };
}
function dnsHost(host: string, address: string): KernelDnsHostCandidate {
  const ipv6 = address.includes(":"),
    queryType = ipv6 ? "AAAA" : "A",
    type = ipv6 ? 28 : 1;
  const answer = {
    queryType,
    name: host,
    type,
    ttl: 10,
    data: address,
    observedAtMono: 1000,
    expiresAtMono: 11000,
  } as const;
  return {
    host,
    status: "unverified",
    reasons: ["FAMILY_MISSING"],
    ipv4: ipv6 ? [] : [address],
    ipv6: ipv6 ? [address] : [],
    addresses: [{ address, addressFamily: ipv6 ? "ipv6" : "ipv4", addressClass: "real" }],
    answers: [answer],
    queries: [
      {
        type: queryType,
        startedAtMono: 1000,
        completedAtMono: 1000,
        error: null,
        response: {
          host,
          queryType,
          status: 0,
          truncated: false,
          question: { name: host, type },
          answers: [{ name: host, type, ttl: 10, data: address }],
          startedAtMono: 1000,
          completedAtMono: 1000,
        },
      },
    ],
    startedAtMono: 1000,
    completedAtMono: 1000,
    expiresAtMono: 11000,
  };
}
function setup(family: ProofTarget["addressFamily"] = "ipv4"): RouteApplicabilityInput {
  const destinations = [target(TARGET.host, family), target(ECHO.host, family)];
  const addresses = family === "ipv4" ? ["203.0.113.8", "198.51.100.9"] : ["2001:db8:1::8", "2001:db8:2::9"];
  const configuration = config();
  const owner = {
    available: true,
    basis: "windows-controller-listener",
    startedAtMono: 1000,
    completedAtMono: 1000,
    scopeHash: H,
    kernelEpoch: K,
    owner: { pid: 401, createdAtTicks: "639244035457234678", executablePathIdentity: H },
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4", port: 9790, coverage: "exact" }],
  } as const;
  const dns: KernelDnsCandidates = {
    available: true,
    kind: "kernel-dns-candidates",
    chromiumResolutionProven: false,
    status: "unverified",
    controllerVersionBefore: { controllerVersion: V, startedAtMono: 1000, completedAtMono: 1000 },
    controllerVersionAfter: { controllerVersion: V, startedAtMono: 1000, completedAtMono: 1000 },
    startedAtMono: 1000,
    completedAtMono: 1000,
    expiresAtMono: 11000,
    hosts: destinations.map(({ host }, i) => dnsHost(host, addresses[i])),
  };
  const inputs: CurrentPathInputs = {
    state: "observed",
    kind: "current-path-inputs",
    sampleId: "current-round",
    generation: 3,
    rulesVersion: V,
    targets: destinations,
    startedAtMono: 1000,
    completedAtMono: 1000,
    expiresAtMono: 9000,
    configurationBefore: structuredClone(configuration),
    configurationAfter: configuration,
    ownerBefore: structuredClone(owner),
    ownerAfter: owner,
    networkBefore: { hash: H, startedAtMono: 1000, completedAtMono: 1000 },
    networkAfter: { hash: H, startedAtMono: 1000, completedAtMono: 1000 },
    dnsBefore: structuredClone(dns),
    dnsAfter: dns,
    routeBatches: [
      {
        available: true,
        basis: "windows-best-route-query",
        socketObserved: false,
        startedAtMono: 1000,
        completedAtMono: 1000,
        scopeHash: H,
        selectionHash: H,
        selections: addresses.map((address) => route(address)),
      },
    ],
  };
  const outbound = {
    name: "DIRECT",
    id: "actual-outbound",
    kind: "direct",
    dialer: "none",
    policyVersion: H,
    kernelEpoch: K,
    generation: 3,
    rulesVersion: V,
    observedAtMono: 1000,
  } as const;
  const binding = routeApplicabilityBinding(inputs, outbound, family);
  const conformance: RouteConformanceRecord = {
    source: "main-process-route-conformance",
    evidenceId: "original-conformance",
    binding,
    transportProfileIds: ["account-chromium", "anonymous-chromium"],
    sourceEvidenceIds: ["retained-profile-qualification"],
    observedAtMono: 100,
    expiresAtMono: 20000,
    samples: [
      {
        evidenceId: "original-sample",
        target: destinations[1],
        transportProfileId: "anonymous-chromium",
        correlationEvidenceId: "original-controlled-window",
        socketEvidenceId: "original-tcp-table",
        routeEvidenceId: "original-physical-query",
        ownerRole: "kernel-direct-outbound",
        owner: owner.owner,
        socket: {
          ownerPid: 401,
          sourceAddress: route(addresses[1]).sourceAddress,
          sourcePort: 53123,
          remoteAddress: addresses[1],
          remotePort: 443,
          state: "Established",
        },
        physicalRoute: route(addresses[1]),
        startedAtMono: 100,
        completedAtMono: 150,
      },
    ],
  };
  return {
    inputs,
    target: destinations[0],
    echo: destinations[1],
    outbound,
    conformance,
    snapshot: {
      mode: "rule",
      generation: 3,
      rulesVersion: V,
      kernelEpoch: K,
      rules: configuration.rules,
      observedAtMono: 1000,
    },
    targetTransportProfileId: "account-chromium",
    echoTransportProfileId: "anonymous-chromium",
  };
}
const result = (input: RouteApplicabilityInput, now = 1100) => verifyRouteApplicability(input, now);
function projected(input: RouteApplicabilityInput): RouteApplicabilityInput {
  const selections = input.inputs.routeBatches[0].selections.map((entry) => ({
    ...entry,
    hardwareInterface: false,
    interfaceIndex: 59,
    sourceAddress: entry.addressFamily === "ipv4" ? "198.18.0.1" : "fd00::1",
    interfaceMetric: null,
  }));
  const nextInputs = { ...input.inputs, routeBatches: [{ ...input.inputs.routeBatches[0], selections }] };
  const physicalRouteProjections: CurrentPhysicalRouteProjection[] = [input.target, input.echo].map(
    (destination, i) => ({
      source: "current-physical-route-projection",
      evidenceId: `physical-projection-${i}`,
      binding: routeApplicabilityBinding(nextInputs, input.outbound, destination.addressFamily),
      host: destination.host,
      candidateAddress: selections[i].targetAddress,
      resolvedAddress: selections[i].targetAddress,
      observedOsRoute: selections[i],
      physicalRoute: route(selections[i].targetAddress),
      sourceEvidenceIds: [`current-outbound-physical-query-${i}`],
      dnsMappingEvidenceId: null,
      startedAtMono: 1000,
      completedAtMono: 1050,
    }),
  );
  return { ...input, inputs: nextInputs, physicalRouteProjections };
}
function changeCurrentRoute(
  input: RouteApplicabilityInput,
  patch: Partial<WindowsRouteSelection>,
): RouteApplicabilityInput {
  const batch = input.inputs.routeBatches[0];
  return {
    ...input,
    inputs: {
      ...input.inputs,
      routeBatches: [{ ...batch, selections: [{ ...batch.selections[0], ...patch }, batch.selections[1]] }],
    },
  };
}

describe("route applicability", () => {
  it("accepts the real configuration source's initial zero generation without changing the Gate generation", () => {
    const input = setup();
    Object.assign(input.inputs.configurationBefore, { sourceGeneration: 0 });
    Object.assign(input.inputs.configurationAfter, { sourceGeneration: 0 });
    Object.assign(input.conformance!, {
      binding: routeApplicabilityBinding(input.inputs, input.outbound, input.target.addressFamily),
    });
    const found = result(input);
    expect(found.valid).toBe(true);
    if (!found.valid) throw Error(found.reason);
    expect(found.evidence.binding).toMatchObject({ sourceGeneration: 0, generation: 3 });
  });

  it.each([-1, 0.5, Number.NaN])("rejects an invalid source generation %s", (sourceGeneration) => {
    const input = setup();
    Object.assign(input.inputs.configurationBefore, { sourceGeneration });
    Object.assign(input.inputs.configurationAfter, { sourceGeneration });
    Object.assign(input.conformance!, {
      binding: routeApplicabilityBinding(input.inputs, input.outbound, input.target.addressFamily),
    });
    expect(result(input).valid).toBe(false);
  });

  it("qualifies a shared physical class without granting permission, DNS, TLS or country", () => {
    const input = setup(),
      found = result(input);
    expect(found.valid).toBe(true);
    if (!found.valid) throw new Error(found.reason);
    expect(found.evidence).toMatchObject({
      source: "validated-route-applicability",
      checkedAtMono: 1100,
      conformanceObservedAtMono: 100,
      expiresAtMono: 9000,
      binding: { kernelEpoch: K, network: "tcp", addressFamily: "ipv4" },
    });
    for (const key of ["permit", "countryCode", "tlsValid", "chromiumResolutionProven"])
      expect(found.evidence).not.toHaveProperty(key);
    expect(input.inputs.configurationAfter.runtimeConfigurationProven).toBe(false);
    expect(Object.isFrozen(found.evidence)).toBe(true);
    expect(Object.isFrozen(found.evidence.binding)).toBe(true);
    expect(Object.isFrozen(found.evidence.sourceEvidenceIds)).toBe(true);
    expect(
      validateRouteApplicability(found.evidence, found.evidence.binding, input.target, input.echo, 1101),
    ).toBe(true);
    expect(
      validateRouteApplicability(
        { ...found.evidence },
        found.evidence.binding,
        input.target,
        input.echo,
        1101,
      ),
    ).toBe(false);
    expect(
      validateRouteApplicability(
        found.evidence,
        { ...found.evidence.binding, generation: 99 },
        input.target,
        input.echo,
        1101,
      ),
    ).toBe(false);
    expect(
      validateRouteApplicability(found.evidence, found.evidence.binding, input.target, input.echo, 9000),
    ).toBe(false);
  });
  it("reuses an unexpired conformance artifact while preserving the original socket time", () => {
    const input = setup();
    const first = result(input),
      second = result(input, 5000);
    expect(first.valid && second.valid).toBe(true);
    if (!first.valid || !second.valid) return;
    expect(second.evidence.conformanceObservedAtMono).toBe(first.evidence.conformanceObservedAtMono);
    expect(input.conformance?.samples[0].startedAtMono).toBe(100);
    expect(second.evidence.checkedAtMono).toBe(5000);
  });
  it("does not require the unrelated address family or turn family absence into a route failure", () => {
    for (const family of ["ipv4", "ipv6"] as const) expect(result(setup(family)).valid).toBe(true);
  });
  it("accepts canonical-equivalent IPv6 addresses and the matching scoped link-local gateway", () => {
    const input = changeCurrentRoute(setup("ipv6"), {
      sourceAddress: "2001:0db8:0:0:0:0:0:2",
      nextHop: "fe80::1%12",
    });
    expect(result(input).valid).toBe(true);
  });
  it.each([
    "::ffff:c000:208",
    "::FFFF:C000:0208",
    "0:0:0:0:0:ffff:c000:208",
    "0000:0000:0000:0000:0000:FFFF:C000:0208",
    "::ffff:192.0.2.8",
    "0:0:0:0:0:FFFF:192.0.2.8",
  ])("rejects mapped IPv4 source %s even when retained and current routes agree", (sourceAddress) => {
    const input = setup("ipv6"),
      conformance = input.conformance!;
    const changed: RouteApplicabilityInput = {
      ...input,
      inputs: {
        ...input.inputs,
        routeBatches: input.inputs.routeBatches.map((batch) => ({
          ...batch,
          selections: batch.selections.map((entry) => ({ ...entry, sourceAddress })),
        })),
      },
      conformance: {
        ...conformance,
        samples: conformance.samples.map((sample) => ({
          ...sample,
          socket: { ...sample.socket, sourceAddress },
          physicalRoute: { ...sample.physicalRoute, sourceAddress },
        })),
      },
    };
    expect(result(changed)).toEqual({ valid: false, reason: "CONFORMANCE_INVALID" });
  });
  it("does not require equal Chromium and kernel process identities for a retained native profile", () => {
    const input = setup(),
      original = input.conformance!;
    const sample = original.samples[0];
    const conformance: RouteConformanceRecord = {
      ...original,
      samples: [
        {
          ...sample,
          ownerRole: "native-physical",
          owner: { pid: 987, createdAtTicks: "639244035457231234", executablePathIdentity: null },
          socket: { ...sample.socket, ownerPid: 987 },
        },
      ],
    };
    expect(result({ ...input, conformance }).valid).toBe(true);
  });
  it("does not call the TUN ingress a physical egress", () => {
    const input = projected(setup());
    expect(result({ ...input, physicalRouteProjections: [] })).toEqual({
      valid: false,
      reason: "PHYSICAL_ROUTE_UNVERIFIED",
    });
    expect(result(input).valid).toBe(true);
  });
  it.each([
    ["next-hop", { nextHop: "192.0.2.3" }],
    ["source", { sourceAddress: "192.0.2.3" }],
    ["specific subnet", { destinationPrefix: "203.0.113.0/24" }],
    ["host route", { destinationPrefix: "203.0.113.8/32" }],
    ["metric", { routeMetric: 5 }],
    ["interface metric", { interfaceMetric: null }],
    ["GUID", { interfaceGuid: "00000002-0002-0003-0004-000000000005" }],
    ["interface", { interfaceIndex: 13 }],
  ])("rejects a different %s even on the same physical adapter", (_name, patch) => {
    expect(result(changeCurrentRoute(setup(), patch as Partial<WindowsRouteSelection>))).toEqual({
      valid: false,
      reason: "ROUTE_CLASS_MISMATCH",
    });
  });
  it.each([
    ["down", { adapterUp: false }],
    ["virtual", { hardwareInterface: false }],
    ["deprecated source", { sourceState: "Deprecated" }],
    ["skip source", { skipAsSource: true }],
    ["dead", { routeState: "Dead" }],
    ["wrong prefix", { destinationPrefix: "198.51.100.0/24" }],
    ["noncanonical prefix", { destinationPrefix: "203.0.113.8/24" }],
    ["negative metric", { routeMetric: -1 }],
  ])("rejects unusable physical routes: %s", (_name, patch) => {
    expect(result(changeCurrentRoute(setup(), patch as Partial<WindowsRouteSelection>))).toEqual({
      valid: false,
      reason: "PHYSICAL_ROUTE_UNVERIFIED",
    });
  });
  it("does not treat an IPv6 gateway scope on a different interface as equivalent", () => {
    expect(result(changeCurrentRoute(setup("ipv6"), { nextHop: "fe80::1%59" })).valid).toBe(false);
  });
  it("refuses missing qualification and unqualified transport profiles", () => {
    expect(result({ ...setup(), conformance: null })).toEqual({
      valid: false,
      reason: "CONFORMANCE_UNAVAILABLE",
    });
    expect(result({ ...setup(), targetTransportProfileId: "another-node-process" })).toEqual({
      valid: false,
      reason: "TRANSPORT_UNQUALIFIED",
    });
  });
  it.each([
    "generation",
    "sourceGeneration",
    "rulesVersion",
    "kernelEpoch",
    "sourcePathIdentity",
    "fileFingerprint",
    "effectivePathPolicyVersion",
    "osNetworkHash",
    "outboundId",
    "outboundPolicyVersion",
    "addressFamily",
  ] as const)("invalidates an old conformance binding when %s changes", (field) => {
    const input = setup(),
      c = input.conformance!;
    const binding = { ...c.binding, [field]: typeof c.binding[field] === "number" ? 999 : "changed" };
    expect(result({ ...input, conformance: { ...c, binding } })).toEqual({
      valid: false,
      reason: "NETWORK_CHANGED",
    });
  });
  it("rejects owner PID reuse instead of rebinding an old outbound socket", () => {
    const input = setup(),
      c = input.conformance!,
      s = c.samples[0];
    expect(
      result({
        ...input,
        conformance: {
          ...c,
          samples: [{ ...s, owner: { ...s.owner, createdAtTicks: "639244035457234679" } }],
        },
      }),
    ).toEqual({ valid: false, reason: "NETWORK_CHANGED" });
  });
  it.each(["sourceAddress", "remoteAddress", "remotePort", "ownerPid", "state"] as const)(
    "checks original TCP %s against the physical route",
    (field) => {
      const input = setup(),
        c = input.conformance!,
        s = c.samples[0];
      const value =
        field === "remotePort" || field === "ownerPid" ? 999 : field === "state" ? "Listen" : "192.0.2.99";
      expect(
        result({
          ...input,
          conformance: { ...c, samples: [{ ...s, socket: { ...s.socket, [field]: value } }] },
        }).valid,
      ).toBe(false);
    },
  );
  it("retains a missing executable path as unknown rather than hashing an empty path", () => {
    const input = setup(),
      c = input.conformance!,
      sample = c.samples[0];
    expect(
      result({
        ...input,
        conformance: {
          ...c,
          samples: [{ ...sample, owner: { ...sample.owner, executablePathIdentity: null } }],
        },
      }).valid,
    ).toBe(true);
    expect(
      result({
        ...input,
        conformance: {
          ...c,
          samples: [{ ...sample, owner: { ...sample.owner, executablePathIdentity: "" } }],
        },
      }).valid,
    ).toBe(false);
  });
  it.each(["expired artifact", "future artifact", "expired input", "future controller", "old outbound"])(
    "rejects %s",
    (kind) => {
      let input = setup();
      if (kind === "expired artifact")
        input = { ...input, conformance: { ...input.conformance!, expiresAtMono: 1100 } };
      if (kind === "future artifact")
        input = { ...input, conformance: { ...input.conformance!, observedAtMono: 1200 } };
      if (kind === "expired input") input = { ...input, inputs: { ...input.inputs, expiresAtMono: 1100 } };
      if (kind === "future controller")
        input = { ...input, snapshot: { ...input.snapshot, observedAtMono: 1200 } };
      if (kind === "old outbound") input = { ...input, outbound: { ...input.outbound, observedAtMono: 0 } };
      expect(result(input, kind === "old outbound" ? 16000 : 1100)).toEqual({
        valid: false,
        reason: "INPUT_EXPIRED",
      });
    },
  );
  it("accepts actual named Direct metadata but rejects name-only proxy claims", () => {
    const input = setup(),
      rules = input.snapshot.rules.map((rule) => ({ ...rule, proxy: "physical-uplink" }));
    const configured = {
      ...input,
      inputs: {
        ...input.inputs,
        configurationBefore: { ...input.inputs.configurationBefore, rules },
        configurationAfter: { ...input.inputs.configurationAfter, rules },
      },
      snapshot: { ...input.snapshot, rules },
      outbound: { ...input.outbound, name: "physical-uplink" },
    };
    expect(result(configured).valid).toBe(true);
    expect(result({ ...configured, outbound: { ...configured.outbound, kind: "other" } })).toEqual({
      valid: false,
      reason: "NOT_DIRECT",
    });
    expect(result({ ...configured, outbound: { ...configured.outbound, dialer: "configured" } })).toEqual({
      valid: false,
      reason: "NOT_DIRECT",
    });
  });
  it.each(["global", "direct", "unknown"])("rejects unsupported controller mode %s", (mode) => {
    const input = setup();
    expect(result({ ...input, snapshot: { ...input.snapshot, mode } })).toEqual({
      valid: false,
      reason: "RULE_UNVERIFIABLE",
    });
  });
  it("rejects unknown preceding rules but does not require inputs for branches after DOMAIN", () => {
    const input = setup(),
      unknown = { type: "GEOSITE", payload: "cn", proxy: "DIRECT" };
    for (const precedes of [true, false]) {
      const rules = precedes ? [unknown, ...input.snapshot.rules] : [...input.snapshot.rules, unknown];
      const changed = {
        ...input,
        inputs: { ...input.inputs, configurationAfter: { ...input.inputs.configurationAfter, rules } },
        snapshot: { ...input.snapshot, rules },
      };
      expect(result(changed).valid).toBe(!precedes);
    }
  });
  it("rejects an echo that does not select the same actual direct outbound", () => {
    const input = setup(),
      rules = [input.snapshot.rules[0], { ...input.snapshot.rules[1], proxy: "overseas" }];
    expect(
      result({
        ...input,
        inputs: { ...input.inputs, configurationAfter: { ...input.inputs.configurationAfter, rules } },
        snapshot: { ...input.snapshot, rules },
      }),
    ).toEqual({ valid: false, reason: "NOT_DIRECT" });
  });
  it.each([
    "stale",
    "wrong binding",
    "wrong observed route",
    "virtual projection",
    "duplicate",
    "unmapped destination",
  ])("rejects %s physical projection", (kind) => {
    let input = projected(setup()),
      projections = [...input.physicalRouteProjections!];
    const p = projections[0];
    if (kind === "stale") projections[0] = { ...p, startedAtMono: 999 };
    if (kind === "wrong binding")
      projections[0] = { ...p, binding: { ...p.binding, osNetworkHash: "changed" } };
    if (kind === "wrong observed route")
      projections[0] = { ...p, observedOsRoute: { ...p.observedOsRoute, nextHop: "192.0.2.99" } };
    if (kind === "virtual projection") projections[0] = { ...p, physicalRoute: p.observedOsRoute };
    if (kind === "duplicate") projections = [...projections, p];
    if (kind === "unmapped destination")
      projections[0] = { ...p, resolvedAddress: "203.0.113.99", physicalRoute: route("203.0.113.99") };
    input = { ...input, physicalRouteProjections: projections };
    expect(result(input)).toEqual({ valid: false, reason: "PHYSICAL_ROUTE_UNVERIFIED" });
  });
  it.each(["unknown", "fake-ip"] as const)(
    "requires an actual DNS mapping reference for %s candidates",
    (addressClass) => {
      const base = projected(setup()),
        dns = base.inputs.dnsAfter;
      const input = {
        ...base,
        inputs: {
          ...base.inputs,
          dnsAfter: {
            ...dns,
            hosts: dns.hosts.map((host) => ({
              ...host,
              addresses: host.addresses.map((address) => ({ ...address, addressClass })),
            })),
          },
        },
      };
      expect(result(input).valid).toBe(false);
      expect(
        result({
          ...input,
          physicalRouteProjections: input.physicalRouteProjections!.map((p) => ({
            ...p,
            dnsMappingEvidenceId: "actual-current-mapping",
          })),
        }).valid,
      ).toBe(true);
    },
  );
  it("checks every DNS candidate instead of selecting the convenient route", () => {
    const input = setup(),
      dns = input.inputs.dnsAfter;
    const extra = dnsHost(TARGET.host, "203.0.113.99"),
      original = dns.hosts[0];
    const host = {
      ...original,
      addresses: [...original.addresses, ...extra.addresses],
      answers: [...original.answers, ...extra.answers],
    };
    const changed = {
      ...input,
      inputs: { ...input.inputs, dnsAfter: { ...dns, hosts: [host, dns.hosts[1]] } },
    };
    expect(result(changed)).toEqual({ valid: false, reason: "ROUTE_UNAVAILABLE" });
    const batch = changed.inputs.routeBatches[0];
    expect(
      result({
        ...changed,
        inputs: {
          ...changed.inputs,
          routeBatches: [
            {
              ...batch,
              selections: [
                ...batch.selections,
                route("203.0.113.99", { destinationPrefix: "203.0.113.99/32" }),
              ],
            },
          ],
        },
      }),
    ).toEqual({ valid: false, reason: "ROUTE_CLASS_MISMATCH" });
  });
  it.each([
    "missing query",
    "failed query",
    "missing answer",
    "expired answer",
    "missing route",
    "duplicate route",
  ])("rejects %s without creating evidence", (kind) => {
    const input = setup(),
      dns = input.inputs.dnsAfter,
      host = dns.hosts[0],
      batch = input.inputs.routeBatches[0];
    let changedHost = host,
      routes = input.inputs.routeBatches;
    if (kind === "missing query") changedHost = { ...host, queries: [] };
    if (kind === "failed query")
      changedHost = { ...host, queries: [{ ...host.queries[0], error: "QUERY_FAILED" }] };
    if (kind === "missing answer") changedHost = { ...host, answers: [] };
    if (kind === "expired answer")
      changedHost = { ...host, answers: host.answers.map((answer) => ({ ...answer, expiresAtMono: 1100 })) };
    if (kind === "missing route") routes = [{ ...batch, selections: [batch.selections[1]] }];
    if (kind === "duplicate route") routes = [batch, batch];
    expect(
      result({
        ...input,
        inputs: {
          ...input.inputs,
          routeBatches: routes,
          dnsAfter: { ...dns, hosts: [changedHost, dns.hosts[1]] },
        },
      }).valid,
    ).toBe(false);
  });
  it("rejects incoherent before/after OS or kernel observations", () => {
    const input = setup();
    for (const patch of [
      { networkBefore: { ...input.inputs.networkBefore, hash: "changed" } },
      { ownerBefore: { ...input.inputs.ownerBefore, kernelEpoch: "changed" } },
      { configurationBefore: { ...input.inputs.configurationBefore, fileFingerprint: "changed" } },
    ]) {
      expect(result({ ...input, inputs: { ...input.inputs, ...patch } })).toEqual({
        valid: false,
        reason: "NETWORK_CHANGED",
      });
    }
  });
});
