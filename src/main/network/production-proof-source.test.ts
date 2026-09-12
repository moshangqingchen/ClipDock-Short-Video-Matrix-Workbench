import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_TIMING } from "@shared/network";
import {
  ProductionProofSource,
  currentDirectOutbound,
  diagnosticObservationDigest,
  type DiagnosticSamplePathBinding,
  type ProductionProofSourceOptions,
  type ScopePathConformance,
} from "./production-proof-source";
import { routeApplicabilityBinding, type RouteConformanceRecord } from "./route-applicability";
import { validateDirectEvidence, type AccountProofScope, type ProofTarget } from "./direct-proof";
import { EgressGate, type GateClock } from "./egress-gate";
import type { ProofCollectionRequest, ProofScopeVersion } from "./proof-issuer";
import type { CurrentPathInputs } from "./path-input-reader";
import type { ClashReadResult } from "./clash-reader";
import type { EffectiveConfigCandidate } from "./effective-config-source";
import type { KernelDnsCandidates, KernelDnsHostCandidate } from "./kernel-dns";
import type { WindowsRouteSelection } from "./windows-route-selection";
import { ANONYMOUS_TLS_FACTORY_ID, type AnonymousTlsObservation } from "./anonymous-proof-probe";
import {
  ANONYMOUS_EGRESS_FACTORY_ID,
  type AnonymousEgressObservation,
  type AnonymousEgressProvider,
} from "./anonymous-egress-probe";

// Only fixed observation producers below are substituted. No rule/path/Gate verifier is mocked.
vi.mock("electron", () => ({ app: {}, session: {} }));
const V = "a".repeat(64),
  H = "b".repeat(64),
  K = "c".repeat(64);
const target = (
  host = "creator.example.com",
  addressFamily: ProofTarget["addressFamily"] = "ipv4",
): ProofTarget => ({ protocol: "https:", host, port: 443, addressFamily });
const echoTarget = (family: ProofTarget["addressFamily"]) =>
  target(family === "ipv4" ? "myip.ipip.net" : "api6.ipify.org", family);
const missing = { present: false } as const;
const sources: ProductionProofSource[] = [];
afterEach(() => {
  for (const source of sources.splice(0)) source.dispose();
});

function controller(at: number, targets: readonly ProofTarget[]): ClashReadResult {
  return {
    mode: "rule",
    tun: true,
    mixedPort: 10090,
    version: "synthetic-kernel",
    fingerprint: V,
    rules: [...new Set(targets.map((value) => value.host))].map((host) => ({
      type: "DOMAIN",
      payload: host,
      proxy: "DIRECT",
    })),
    configFieldHashes: { mode: H },
    configPathHashes: { "/mode": H },
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
}
function config(at: number, live: ClashReadResult): EffectiveConfigCandidate {
  return {
    kind: "local-config-candidate",
    runtimeConfigurationProven: false,
    sourceGeneration: 2,
    sourcePathIdentity: H,
    fileFingerprint: H,
    decoderIdentity: "synthetic-yaml",
    startedAtMono: at,
    completedAtMono: at,
    expiresAtMono: at + 15000,
    controllerFingerprint: V,
    controllerStartedAtMono: at,
    controllerCompletedAtMono: at,
    comparedConfigFields: ["mode"],
    comparedRuleCount: live.rules.length,
    orderedRulesFingerprint: H,
    sourceRuleOptionsFingerprint: H,
    rules: live.rules,
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
    currentDirectPolicy: live.directPolicy!,
  };
}
function route(address: string): WindowsRouteSelection {
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
  };
}
function dnsHost(
  host: string,
  families: readonly ProofTarget["addressFamily"][],
  at: number,
  index: number,
): KernelDnsHostCandidate {
  const addresses = families.map((family) => ({
    address: family === "ipv4" ? `203.0.113.${index + 10}` : `2001:db8:1::${index + 10}`,
    addressFamily: family,
    addressClass: "real" as const,
  }));
  const answers = addresses.map(({ address, addressFamily }) => ({
    queryType: addressFamily === "ipv4" ? ("A" as const) : ("AAAA" as const),
    name: host,
    type: addressFamily === "ipv4" ? (1 as const) : (28 as const),
    ttl: 15,
    data: address,
    observedAtMono: at,
    expiresAtMono: at + 15000,
  }));
  return {
    host,
    status: families.length === 2 ? "candidate" : "unverified",
    reasons: families.length === 2 ? [] : ["FAMILY_MISSING"],
    ipv4: addresses.filter((v) => v.addressFamily === "ipv4").map((v) => v.address),
    ipv6: addresses.filter((v) => v.addressFamily === "ipv6").map((v) => v.address),
    addresses,
    answers,
    queries: families.map((family) => {
      const queryType = family === "ipv4" ? "A" : "AAAA",
        type = family === "ipv4" ? 1 : 28;
      return {
        type: queryType,
        startedAtMono: at,
        completedAtMono: at,
        error: null,
        response: {
          host,
          queryType,
          status: 0,
          truncated: false,
          question: { name: host, type },
          answers: answers
            .filter((answer) => answer.queryType === queryType)
            .map(({ name, type, ttl, data }) => ({ name, type, ttl, data })),
          startedAtMono: at,
          completedAtMono: at,
        },
      };
    }),
    startedAtMono: at,
    completedAtMono: at,
    expiresAtMono: at + 15000,
  };
}
function pathInputs(
  at: number,
  destinations: readonly ProofTarget[],
  version: ProofScopeVersion,
  live: ClashReadResult,
  sampleId: string,
): CurrentPathInputs {
  const cfg = config(at, live),
    hostNames = [...new Set(destinations.map((value) => value.host))];
  const dns: KernelDnsCandidates = {
    available: true,
    kind: "kernel-dns-candidates",
    chromiumResolutionProven: false,
    status: "unverified",
    controllerVersionBefore: { controllerVersion: V, startedAtMono: at, completedAtMono: at },
    controllerVersionAfter: { controllerVersion: V, startedAtMono: at, completedAtMono: at },
    startedAtMono: at,
    completedAtMono: at,
    expiresAtMono: at + 15000,
    hosts: hostNames.map((host, index) =>
      dnsHost(
        host,
        destinations.filter((item) => item.host === host).map((item) => item.addressFamily),
        at,
        index,
      ),
    ),
  };
  const owner = {
    available: true,
    basis: "windows-controller-listener",
    startedAtMono: at,
    completedAtMono: at,
    scopeHash: H,
    kernelEpoch: K,
    owner: { pid: 401, createdAtTicks: "639244035457234678", executablePathIdentity: H },
    listeners: [{ address: "127.0.0.1", addressFamily: "ipv4", port: 9790, coverage: "exact" }],
  } as const;
  return {
    state: "observed",
    kind: "current-path-inputs",
    sampleId,
    ...version,
    targets: destinations,
    startedAtMono: at,
    completedAtMono: at,
    expiresAtMono: at + 15000,
    configurationBefore: structuredClone(cfg),
    configurationAfter: cfg,
    ownerBefore: structuredClone(owner),
    ownerAfter: owner,
    networkBefore: { hash: H, startedAtMono: at, completedAtMono: at },
    networkAfter: { hash: H, startedAtMono: at, completedAtMono: at },
    dnsBefore: structuredClone(dns),
    dnsAfter: dns,
    routeBatches: [
      {
        available: true,
        basis: "windows-best-route-query",
        socketObserved: false,
        startedAtMono: at,
        completedAtMono: at,
        scopeHash: H,
        selectionHash: H,
        selections: dns.hosts.flatMap((host) => host.addresses.map((address) => route(address.address))),
      },
    ],
  };
}
function scopeConformance(
  request: ProofCollectionRequest,
  inputs: CurrentPathInputs,
  live: ClashReadResult,
  now: number,
): ScopePathConformance {
  const outbound = currentDirectOutbound(inputs, live);
  const routes: RouteConformanceRecord[] = [
    ...new Set(request.scope.targets.map((item) => item.addressFamily)),
  ].map((family) => {
    const echo = echoTarget(family),
      host = inputs.dnsAfter.hosts.find((item) => item.host === echo.host)!;
    const address = host.addresses.find((item) => item.addressFamily === family)!.address,
      physicalRoute = route(address);
    return {
      source: "main-process-route-conformance",
      evidenceId: `retained-route-${family}`,
      binding: routeApplicabilityBinding(inputs, outbound, family),
      transportProfileIds: ["account-chromium", "anonymous-egress", "anonymous-tls"],
      sourceEvidenceIds: [`retained-path-qualification-${family}`],
      observedAtMono: 100,
      expiresAtMono: 1000000,
      samples: [
        {
          evidenceId: `retained-socket-${family}`,
          target: echo,
          transportProfileId: "anonymous-egress",
          correlationEvidenceId: `retained-control-window-${family}`,
          socketEvidenceId: `retained-tcp-${family}`,
          routeEvidenceId: `retained-os-route-${family}`,
          ownerRole: "kernel-direct-outbound",
          owner: inputs.ownerAfter.owner,
          socket: {
            ownerPid: 401,
            sourceAddress: physicalRoute.sourceAddress,
            sourcePort: 53000,
            remoteAddress: address,
            remotePort: 443,
            state: "Established",
          },
          physicalRoute,
          startedAtMono: 100,
          completedAtMono: 150,
        },
      ],
    };
  });
  const origins = [
    ...new Set(request.scope.targets.map((item) => `${item.protocol}//${item.host}:${item.port}`)),
  ];
  return {
    source: "current-scope-path-conformance",
    evidenceId: `scope-conformance-${inputs.sampleId}`,
    inputSampleId: inputs.sampleId,
    accountContextId: request.scope.contextId,
    generation: request.generation,
    rulesVersion: request.rulesVersion,
    kernelEpoch: inputs.ownerAfter.kernelEpoch,
    fileFingerprint: inputs.configurationAfter.fileFingerprint,
    effectivePathPolicyVersion: inputs.configurationAfter.policy.fingerprint,
    osNetworkHash: inputs.networkAfter.hash,
    checkedAtMono: now,
    expiresAtMono: now + 15000,
    transport: {
      evidenceId: "retained-transport-compatibility",
      accountProfileId: "account-chromium",
      tlsFactoryId: ANONYMOUS_TLS_FACTORY_ID,
      tlsProfileId: "anonymous-tls",
      egressFactoryId: ANONYMOUS_EGRESS_FACTORY_ID,
      egressProfileId: "anonymous-egress",
    },
    families: origins.map((origin) => {
      const values = request.scope.targets.filter(
        (item) => `${item.protocol}//${item.host}:${item.port}` === origin,
      );
      return {
        origin: { protocol: values[0].protocol, host: values[0].host, port: values[0].port },
        possibleAddressFamilies: values.map((item) => item.addressFamily),
        constraintEvidenceId: values.length === 1 ? "retained-family-constraint" : null,
      };
    }),
    dns: inputs.targets.map((item) => {
      const host = inputs.dnsAfter.hosts.find((v) => v.host === item.host)!;
      const addresses = host.addresses
        .filter((v) => v.addressFamily === item.addressFamily)
        .map((v) => v.address);
      return {
        source: "current-dns-path-match",
        evidenceId: `dns:${item.host}:${item.addressFamily}:${inputs.sampleId}`,
        inputSampleId: inputs.sampleId,
        target: item,
        dnsPolicyEvidenceId: "retained-resolver-conformance",
        status: "resolved",
        candidateAddresses: addresses,
        resolvedAddresses: addresses,
        observedAtMono: now,
        expiresAtMono: now + 15000,
      };
    }),
    routes,
    physicalRouteProjections: [],
  };
}
function tlsObservation(origin: { host: string; port: number }, at: number): AnonymousTlsObservation {
  return {
    factoryId: ANONYMOUS_TLS_FACTORY_ID,
    origin,
    transportContextId: `tls-session:${origin.host}`,
    startedAtMono: at,
    completedAtMono: at,
    statusCode: 200,
    responseFromCache: false,
    certificateValidation: "chromium-default",
    credentials: "omit",
  };
}
function egressObservation(provider: AnonymousEgressProvider, at: number): AnonymousEgressObservation {
  const family = provider === "ipip" ? "ipv4" : "ipv6";
  const common = {
    startedAtMono: at,
    completedAtMono: at,
    statusCode: 200 as const,
    responseFromCache: false as const,
    certificateValidation: "chromium-default" as const,
    credentials: "omit" as const,
  };
  return {
    factoryId: ANONYMOUS_EGRESS_FACTORY_ID,
    source: provider,
    ip: family === "ipv4" ? "192.0.2.8" : "2001:db8::8",
    reportedAddressFamily: family,
    countryCode: "CN",
    asn: 64512,
    transportContextId: `egress-session:${provider}`,
    startedAtMono: at,
    observedAtMono: at,
    completedAtMono: at,
    echo: { ...common, origin: { host: echoTarget(family).host, port: 443 } },
    geo: { ...common, origin: { host: "ipwho.is", port: 443 }, provider: "ipwho.is" },
  };
}
type BindInput = Parameters<ProductionProofSourceOptions["conformance"]["bindSamples"]>[0];
function sampleBindings(input: BindInput, now: number): readonly DiagnosticSamplePathBinding[] {
  return input.samples.map((sample) => {
    const observation = sample.observation;
    const egress = sample.kind === "egress" ? (observation as AnonymousEgressObservation) : null;
    const tls = sample.kind === "tls" ? (observation as AnonymousTlsObservation) : null;
    const covered = input.routes.filter((route) =>
      egress
        ? route.target.addressFamily === egress.reportedAddressFamily
        : route.target.host === tls!.origin.host && route.target.port === tls!.origin.port,
    );
    const families = new Set(covered.map((route) => route.target.addressFamily));
    return {
      source: "current-diagnostic-path-binding",
      evidenceId: `binding:${sample.kind}:${input.inputs.sampleId}:${observation.transportContextId}`,
      observationDigest: diagnosticObservationDigest(observation),
      factoryId: observation.factoryId,
      diagnosticContextId: observation.transportContextId,
      origin: egress ? egress.echo.origin : tls!.origin,
      originalStartedAtMono: observation.startedAtMono,
      originalObservedAtMono: egress ? egress.observedAtMono : tls!.completedAtMono,
      originalPath: sample.previousBinding?.originalPath ?? {
        evidenceId: `retained-observation-path:${sample.kind}:${observation.startedAtMono}:${observation.transportContextId}`,
        sourceEvidenceIds: ["retained-path-source-record", "retained-qualification"],
        observedPhysicalFamily: families.size === 1 ? [...families][0] : null,
      },
      inputSampleId: input.inputs.sampleId,
      conformanceEvidenceId: input.conformance.evidenceId,
      checkedAtMono: now,
      expiresAtMono: now + 15000,
      coverage: covered.map((route) => ({
        target: route.target,
        physicalRouteClass: route.physicalRouteClass,
        routeApplicabilityEvidenceId: route.evidenceId,
        accountTransportProfileId: input.conformance.transport.accountProfileId,
        basis: families.size === 1 ? "observed-current-connection" : "reviewed-path-equivalence",
        sourceEvidenceIds: [
          "retained-path-qualification",
          `current-dependency-match:${input.inputs.sampleId}`,
        ],
      })),
    };
  });
}
function setup(destinations: readonly ProofTarget[] = [target()]) {
  let now = 1000,
    sequence = 0,
    version: ProofScopeVersion | null = { generation: 3, rulesVersion: V };
  const required = [
    ...destinations,
    ...[...new Set(destinations.map((item) => item.addressFamily))].map(echoTarget),
  ];
  let live = controller(now, required);
  const scope: AccountProofScope = {
    accountId: "synthetic-account",
    platformId: "bilibili",
    contextId: "reviewed-account-context",
    catalogReviewed: true,
    catalogVersion: "reviewed-fixture-catalog",
    targets: destinations,
  };
  const readController = vi.fn<ProductionProofSourceOptions["readController"]>(async () => ({
    ...live,
    startedAtMono: now,
    completedAtMono: now,
    directPolicy: live.directPolicy && { ...live.directPolicy, startedAtMono: now, completedAtMono: now },
  }));
  const inputs = {
    read: vi.fn<ProductionProofSourceOptions["inputs"]["read"]>(async (request) =>
      pathInputs(now, request.targets, request, live, `input-${++sequence}`),
    ),
  };
  const conformance = {
    read: vi.fn<ProductionProofSourceOptions["conformance"]["read"]>(async (request, value) =>
      scopeConformance(request, value, live, now),
    ),
    bindSamples: vi.fn<ProductionProofSourceOptions["conformance"]["bindSamples"]>(async (input) =>
      sampleBindings(input, now),
    ),
  };
  const tls = {
    probeTls: vi.fn<ProductionProofSourceOptions["tls"]["probeTls"]>(async (origin) => ({
      available: true,
      observation: tlsObservation(origin, now),
    })),
  };
  const egress = {
    probe: vi.fn<ProductionProofSourceOptions["egress"]["probe"]>(async (provider) => ({
      available: true,
      observation: egressObservation(provider, now),
    })),
  };
  const options: ProductionProofSourceOptions = {
    inputs,
    conformance,
    readController,
    readVersion: () => version,
    tls,
    egress,
    now: () => now,
  };
  const source = new ProductionProofSource(options);
  sources.push(source);
  const request = (overrides: Partial<ProofCollectionRequest> = {}): ProofCollectionRequest => ({
    requestId: `request-${++sequence}`,
    scope,
    generation: version?.generation ?? 3,
    rulesVersion: version?.rulesVersion ?? V,
    startedAtMono: now,
    signal: new AbortController().signal,
    ...overrides,
  });
  return {
    source,
    options,
    request,
    scope,
    inputs,
    conformance,
    readController,
    tls,
    egress,
    now: () => now,
    advance: (value: number) => {
      now += value;
    },
    setVersion: (value: ProofScopeVersion | null) => {
      version = value;
    },
    setController: (patch: Partial<ClashReadResult>) => {
      live = { ...live, ...patch };
    },
    currentController: () => live,
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("production proof source", () => {
  it("constructs without starting a controller read, account Session or anonymous probe", () => {
    const fixture = setup();
    expect(fixture.readController).not.toHaveBeenCalled();
    expect(fixture.inputs.read).not.toHaveBeenCalled();
    expect(fixture.tls.probeTls).not.toHaveBeenCalled();
    expect(fixture.egress.probe).not.toHaveBeenCalled();
  });
  it("combines actual-shaped records through the real rule and route verifiers", async () => {
    const fixture = setup(),
      request = fixture.request(),
      result = await fixture.source.collect(request);
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.requestId).toBe(request.requestId);
    expect(result.batch.sampleId).toBe(request.requestId);
    expect(result.batch.targets[0].route.source).toBe("current-ordered-rules");
    expect(
      validateDirectEvidence(
        request.scope,
        result.batch,
        {
          controllerReadable: true,
          mode: "rule",
          tun: true,
          generation: request.generation,
          rulesVersion: V,
          expiresAtMono: fixture.now() + 15000,
        },
        fixture.now(),
        NETWORK_TIMING,
      ).valid,
    ).toBe(true);
    expect(fixture.conformance.bindSamples).toHaveBeenCalledOnce();
    expect(fixture.egress.probe).toHaveBeenCalledOnce();
    expect(fixture.tls.probeTls).toHaveBeenCalledOnce();
  });

  it("requires two fresh rounds before the real strict Gate allows an account", async () => {
    const fixture = setup();
    const clock: GateClock = {
      monotonicMs: fixture.now,
      wallTimeMs: fixture.now,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    };
    const gate = new EgressGate({ clock, timing: { warmupGapMs: 10 } });
    try {
      gate.registerAccount(fixture.scope);
      gate.setNetworkState({ controllerReadable: true, mode: "rule", tun: true, rulesVersion: V });
      fixture.setVersion({ generation: gate.generation, rulesVersion: V });
      const first = await fixture.source.collect(fixture.request());
      expect(first.kind).toBe("evidence");
      if (first.kind !== "evidence") return;
      expect(gate.acceptEvidence(fixture.scope.accountId, first.batch).allowed).toBe(false);
      fixture.advance(10);
      const second = await fixture.source.collect(fixture.request());
      expect(second.kind).toBe("evidence");
      if (second.kind !== "evidence") return;
      expect(gate.acceptEvidence(fixture.scope.accountId, second.batch).allowed).toBe(true);
      expect(fixture.egress.probe).toHaveBeenCalledOnce();
      expect(second.batch.targets[0].egress.observedAtMono).toBe(
        first.batch.targets[0].egress.observedAtMono,
      );
      expect(second.batch.targets[0].tls.observedAtMono).toBeGreaterThan(
        first.batch.targets[0].tls.observedAtMono,
      );
      gate.setNetworkState({ controllerReadable: true, mode: "global", tun: true, rulesVersion: V });
      expect(gate.checkAction(fixture.scope.accountId, fixture.scope.contextId).allowed).toBe(false);
    } finally {
      gate.dispose();
    }
  });

  it("keeps both address families explicit while coalescing TLS per origin", async () => {
    const fixture = setup([target(), target(undefined, "ipv6")]);
    const request = fixture.request(),
      result = await fixture.source.collect(request);
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.batch.targets).toHaveLength(2);
    expect(fixture.tls.probeTls).toHaveBeenCalledOnce();
    expect(fixture.egress.probe).toHaveBeenCalledTimes(2);
    expect(
      validateDirectEvidence(
        request.scope,
        result.batch,
        {
          controllerReadable: true,
          mode: "rule",
          tun: true,
          generation: request.generation,
          rulesVersion: V,
          expiresAtMono: 16000,
        },
        fixture.now(),
        NETWORK_TIMING,
      ).valid,
    ).toBe(true);
  });

  it("shares one applicable anonymous exit across distinct exact targets, with separate TLS observations", async () => {
    const fixture = setup([target(), target("passport.example.com")]);
    const result = await fixture.source.collect(fixture.request());
    expect(result.kind).toBe("evidence");
    expect(fixture.egress.probe).toHaveBeenCalledOnce();
    expect(fixture.tls.probeTls).toHaveBeenCalledTimes(2);
  });

  it("rejects an unreviewed catalog before any observation", async () => {
    const fixture = setup();
    expect(
      await fixture.source.collect(fixture.request({ scope: { ...fixture.scope, catalogReviewed: false } })),
    ).toEqual({ kind: "unavailable", reason: "CATALOG_UNVERIFIED" });
    expect(fixture.readController).not.toHaveBeenCalled();
    expect(fixture.inputs.read).not.toHaveBeenCalled();
    expect(fixture.egress.probe).not.toHaveBeenCalled();
    expect(fixture.tls.probeTls).not.toHaveBeenCalled();
  });

  it.each(["global", "unknown", "direct"])("refuses mode %s before anonymous probes", async (mode) => {
    const fixture = setup();
    fixture.setController({ mode });
    const result = await fixture.source.collect(fixture.request());
    expect(result).toEqual({
      kind: "unavailable",
      reason: mode === "global" ? "GLOBAL_MODE" : "RULE_UNVERIFIABLE",
    });
    expect(fixture.inputs.read).not.toHaveBeenCalled();
    expect(fixture.egress.probe).not.toHaveBeenCalled();
  });

  it.each([
    "unknown first rule",
    "proxy target",
    "proxy echo",
    "missing Direct metadata",
    "Direct has dialer",
    "Direct name but proxy type",
  ])("refuses %s at ordered-rule preflight", async (kind) => {
    const fixture = setup(),
      live = fixture.currentController();
    if (kind === "unknown first rule")
      fixture.setController({ rules: [{ type: "GEOSITE", payload: "cn", proxy: "DIRECT" }, ...live.rules] });
    if (kind === "proxy target" || kind === "proxy echo")
      fixture.setController({
        rules: live.rules.map((rule, i) => ({
          ...rule,
          proxy: i === (kind === "proxy target" ? 0 : 1) ? "overseas" : rule.proxy,
        })),
      });
    if (kind === "missing Direct metadata") fixture.setController({ directPolicy: undefined });
    if (kind === "Direct has dialer")
      fixture.setController({ directPolicy: { ...live.directPolicy!, dialer: "configured" } });
    if (kind === "Direct name but proxy type")
      fixture.setController({ directPolicy: { ...live.directPolicy!, kind: "other" } });
    expect((await fixture.source.collect(fixture.request())).kind).toBe("unavailable");
    // Unknown rules need same-round source parameters before the definitive preflight.
    expect(fixture.inputs.read).toHaveBeenCalledTimes(kind === "unknown first rule" ? 1 : 0);
    expect(fixture.egress.probe).not.toHaveBeenCalled();
    expect(fixture.tls.probeTls).not.toHaveBeenCalled();
  });

  it("does not let unsupported WSS or an invalid target reach a probe", async () => {
    const fixture = setup();
    for (const changed of [
      { ...target(), protocol: "wss:" as const },
      { ...target(), host: "203.0.113.8" },
    ]) {
      expect(
        (await fixture.source.collect(fixture.request({ scope: { ...fixture.scope, targets: [changed] } })))
          .kind,
      ).toBe("unavailable");
    }
    expect(fixture.readController).not.toHaveBeenCalled();
    expect(fixture.egress.probe).not.toHaveBeenCalled();
  });

  it("does not elevate a local configuration candidate when independent conformance is absent", async () => {
    const fixture = setup();
    fixture.conformance.read.mockResolvedValue(null);
    expect(await fixture.source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "CONTEXT_UNVERIFIED",
    });
    expect(fixture.egress.probe).not.toHaveBeenCalled();
    expect(fixture.tls.probeTls).not.toHaveBeenCalled();
  });

  it.each([
    "accountContextId",
    "generation",
    "rulesVersion",
    "kernelEpoch",
    "fileFingerprint",
    "osNetworkHash",
    "effectivePathPolicyVersion",
    "inputSampleId",
  ] as const)("rejects conformance for another %s", async (field) => {
    const fixture = setup();
    fixture.conformance.read.mockImplementation(async (request, inputs) => {
      const value = scopeConformance(request, inputs, fixture.currentController(), fixture.now());
      return { ...value, [field]: field === "generation" ? 999 : "changed" };
    });
    expect(await fixture.source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "CONTEXT_UNVERIFIED",
    });
    expect(fixture.egress.probe).not.toHaveBeenCalled();
  });

  it.each([
    "missing family constraint",
    "missing actual route",
    "virtual OS route",
    "wrong transport profile",
    "expired record",
  ])("refuses %s before diagnostic probes", async (kind) => {
    const fixture = setup();
    fixture.conformance.read.mockImplementation(async (request, inputs) => {
      const value = scopeConformance(request, inputs, fixture.currentController(), fixture.now());
      if (kind === "missing family constraint")
        return {
          ...value,
          families: value.families.map((item) => ({ ...item, constraintEvidenceId: null })),
        };
      if (kind === "missing actual route") return { ...value, routes: [] };
      if (kind === "wrong transport profile")
        return { ...value, transport: { ...value.transport, accountProfileId: "unqualified-node-agent" } };
      if (kind === "expired record") return { ...value, expiresAtMono: fixture.now() };
      return value;
    });
    if (kind === "virtual OS route") {
      const impl = fixture.inputs.read.getMockImplementation()!;
      fixture.inputs.read.mockImplementation(async (...args) => {
        const value = await impl(...args);
        if (value.state !== "observed") return value;
        return {
          ...value,
          routeBatches: value.routeBatches.map((batch) => ({
            ...batch,
            selections: batch.selections.map((selection) => ({
              ...selection,
              hardwareInterface: false,
              interfaceIndex: 59,
            })),
          })),
        };
      });
    }
    expect((await fixture.source.collect(fixture.request())).kind).toBe("unavailable");
    expect(fixture.egress.probe).not.toHaveBeenCalled();
    expect(fixture.tls.probeTls).not.toHaveBeenCalled();
  });

  it("rejects a changed controller on the final read without caching the provisional exit", async () => {
    const fixture = setup(),
      impl = fixture.readController.getMockImplementation()!;
    fixture.readController
      .mockImplementationOnce(impl)
      .mockImplementationOnce(async (...args) => ({ ...(await impl(...args)), fingerprint: "changed" }));
    expect(await fixture.source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "NETWORK_CHANGED",
    });
    expect(fixture.conformance.bindSamples).not.toHaveBeenCalled();
    fixture.advance(10);
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    expect(fixture.egress.probe).toHaveBeenCalledTimes(2);
  });

  it.each([
    "missing",
    "duplicate",
    "digest",
    "factory",
    "context",
    "origin",
    "start",
    "observation time",
    "input",
    "conformance",
    "original path refs",
    "coverage target",
    "coverage family",
    "route ID",
    "physical class",
    "account profile",
    "coverage refs",
    "physical socket family",
    "overlong deadline",
    "expired",
    "old check",
  ])("rejects diagnostic binding with %s mismatch", async (kind) => {
    const fixture = setup();
    fixture.conformance.bindSamples.mockImplementation(async (input) => {
      let values = [...sampleBindings(input, fixture.now())];
      if (kind === "missing") return null;
      if (kind === "duplicate") return [values[0], values[0]];
      let value = values[0];
      if (kind === "digest") value = { ...value, observationDigest: "unrelated-observation" };
      if (kind === "factory") value = { ...value, factoryId: "node-agent" };
      if (kind === "context") value = { ...value, diagnosticContextId: "another-session" };
      if (kind === "origin") value = { ...value, origin: { host: "different.example.com", port: 443 } };
      if (kind === "start") value = { ...value, originalStartedAtMono: value.originalStartedAtMono - 1 };
      if (kind === "observation time")
        value = { ...value, originalObservedAtMono: value.originalObservedAtMono + 1 };
      if (kind === "input") value = { ...value, inputSampleId: "old-input" };
      if (kind === "conformance") value = { ...value, conformanceEvidenceId: "different-conformance" };
      if (kind === "original path refs")
        value = { ...value, originalPath: { ...value.originalPath, sourceEvidenceIds: [] } };
      if (kind === "physical socket family")
        value = { ...value, originalPath: { ...value.originalPath, observedPhysicalFamily: "ipv6" } };
      if (kind === "overlong deadline") value = { ...value, expiresAtMono: value.expiresAtMono + 1 };
      if (kind === "expired") value = { ...value, expiresAtMono: fixture.now() };
      if (kind === "old check") value = { ...value, checkedAtMono: fixture.now() - 1 };
      const coverage = value.coverage[0];
      if (kind === "coverage target")
        value = { ...value, coverage: [{ ...coverage, target: target("another.example.com") }] };
      if (kind === "coverage family")
        value = {
          ...value,
          coverage: [{ ...coverage, target: { ...coverage.target, addressFamily: "ipv6" } }],
        };
      if (kind === "route ID")
        value = { ...value, coverage: [{ ...coverage, routeApplicabilityEvidenceId: "old-route" }] };
      if (kind === "physical class")
        value = { ...value, coverage: [{ ...coverage, physicalRouteClass: "unrelated-interface-class" }] };
      if (kind === "account profile")
        value = {
          ...value,
          coverage: [{ ...coverage, accountTransportProfileId: "another-account-profile" }],
        };
      if (kind === "coverage refs") value = { ...value, coverage: [{ ...coverage, sourceEvidenceIds: [] }] };
      values = [value, ...values.slice(1)];
      return values;
    });
    const result = await fixture.source.collect(fixture.request());
    expect(result.kind).toBe("unavailable");
    if (kind === "physical socket family")
      expect(result).toEqual({ kind: "unavailable", reason: "EGRESS_UNVERIFIED" });
  });

  it("does not use an IPv4 response body as proof of an actual IPv4 socket", async () => {
    const fixture = setup();
    fixture.conformance.bindSamples.mockImplementation(async (input) =>
      sampleBindings(input, fixture.now()).map((binding) => ({
        ...binding,
        originalPath: { ...binding.originalPath, observedPhysicalFamily: null },
      })),
    );
    expect(await fixture.source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "EGRESS_UNVERIFIED",
    });
    // An independently retained path constraint may cover an unobserved family; not the body alone.
    fixture.conformance.bindSamples.mockImplementation(async (input) =>
      sampleBindings(input, fixture.now()).map((binding) => ({
        ...binding,
        originalPath: { ...binding.originalPath, observedPhysicalFamily: null },
        coverage: binding.coverage.map((entry) => ({ ...entry, basis: "validated-path-constraint" })),
      })),
    );
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
  });

  it("requires both AF coverage entries for one coalesced TLS observation", async () => {
    const fixture = setup([target(), target(undefined, "ipv6")]);
    fixture.conformance.bindSamples.mockImplementation(async (input) =>
      sampleBindings(input, fixture.now()).map((binding) =>
        binding.factoryId === ANONYMOUS_TLS_FACTORY_ID
          ? { ...binding, coverage: binding.coverage.slice(0, 1) }
          : binding,
      ),
    );
    expect(await fixture.source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "CONTEXT_UNVERIFIED",
    });
  });

  it("reuses an exit observation with the original path and dates, but requires current bindings", async () => {
    const fixture = setup();
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    const first = fixture.conformance.bindSamples.mock.calls[0][0].samples.find(
      (sample) => sample.kind === "egress",
    )!;
    expect(first.previousBinding).toBeNull();
    fixture.advance(500);
    const result = await fixture.source.collect(fixture.request());
    expect(result.kind).toBe("evidence");
    expect(fixture.egress.probe).toHaveBeenCalledOnce();
    expect(fixture.tls.probeTls).toHaveBeenCalledTimes(2);
    const secondInput = fixture.conformance.bindSamples.mock.calls[1][0];
    const second = secondInput.samples.find((sample) => sample.kind === "egress")!;
    expect(second.observation).toEqual(first.observation);
    expect(second.previousBinding).not.toBeNull();
    expect(second.previousBinding!.originalStartedAtMono).toBe(1000);
    expect(second.previousBinding!.inputSampleId).not.toBe(secondInput.inputs.sampleId);
    expect(result.kind === "evidence" && result.batch.targets[0].egress.observedAtMono).toBe(1000);
  });

  it("rejects relabeling a cached exit's original path even if all current coverage is plausible", async () => {
    const fixture = setup();
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    fixture.advance(10);
    fixture.conformance.bindSamples.mockImplementation(async (input) =>
      sampleBindings(input, fixture.now()).map((binding) => ({
        ...binding,
        originalPath: { ...binding.originalPath, evidenceId: "new-invented-original-path" },
      })),
    );
    expect(await fixture.source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "CONTEXT_UNVERIFIED",
    });
    expect(fixture.egress.probe).toHaveBeenCalledOnce();
  });

  it("does not cache provisional observations after missing binding evidence", async () => {
    const fixture = setup();
    fixture.conformance.bindSamples.mockResolvedValueOnce(null);
    expect((await fixture.source.collect(fixture.request())).kind).toBe("unavailable");
    fixture.advance(10);
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    expect(fixture.egress.probe).toHaveBeenCalledTimes(2);
    expect(
      fixture.conformance.bindSamples.mock.calls[1][0].samples.find((sample) => sample.kind === "egress")
        ?.previousBinding,
    ).toBeNull();
  });

  it("refreshes the exit after its diagnostic interval instead of rewriting the cached timestamp", async () => {
    const fixture = setup();
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    fixture.advance(NETWORK_TIMING.egressRefreshMs);
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    expect(fixture.egress.probe).toHaveBeenCalledTimes(2);
    expect(
      fixture.conformance.bindSamples.mock.calls[1][0].samples.find((sample) => sample.kind === "egress")
        ?.previousBinding,
    ).toBeNull();
  });

  it("invalidates retained exit observations with the source lifecycle", async () => {
    const fixture = setup();
    await fixture.source.collect(fixture.request());
    fixture.source.invalidate();
    fixture.advance(1);
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    expect(fixture.egress.probe).toHaveBeenCalledTimes(2);
  });

  it.each([
    "foreign country",
    "old fresh observation",
    "wrong response AF",
    "cached echo",
    "wrong echo host",
    "geo before echo",
    "NaN time",
  ])("rejects %s from the anonymous exit producer", async (kind) => {
    const fixture = setup();
    fixture.egress.probe.mockImplementation(async (provider) => {
      let observation = egressObservation(provider, fixture.now());
      if (kind === "foreign country") observation = { ...observation, countryCode: "JP" };
      if (kind === "old fresh observation") observation = egressObservation(provider, fixture.now() - 1);
      if (kind === "wrong response AF") observation = { ...observation, reportedAddressFamily: "ipv6" };
      if (kind === "cached echo")
        observation = { ...observation, echo: { ...observation.echo, responseFromCache: true as false } };
      if (kind === "wrong echo host")
        observation = {
          ...observation,
          echo: { ...observation.echo, origin: { host: "another.example.com", port: 443 } },
        };
      if (kind === "geo before echo")
        observation = { ...observation, geo: { ...observation.geo, startedAtMono: fixture.now() - 1 } };
      if (kind === "NaN time") observation = { ...observation, observedAtMono: NaN };
      return { available: true, observation };
    });
    const result = await fixture.source.collect(fixture.request());
    expect(result.kind).toBe("unavailable");
    if (kind === "foreign country")
      expect(result).toEqual({ kind: "unavailable", reason: "EGRESS_OUTSIDE_CN" });
    expect(fixture.tls.probeTls).not.toHaveBeenCalled();
  });

  it.each([
    "wrong host",
    "wrong port",
    "old shared observation",
    "NaN status",
    "redirect",
    "cached response",
    "future end",
  ])("rejects TLS producer %s", async (kind) => {
    const fixture = setup();
    fixture.tls.probeTls.mockImplementation(async (origin) => {
      let observation = tlsObservation(origin, fixture.now());
      if (kind === "wrong host")
        observation = { ...observation, origin: { ...origin, host: "another.example.com" } };
      if (kind === "wrong port") observation = { ...observation, origin: { ...origin, port: 8443 } };
      if (kind === "old shared observation") observation = tlsObservation(origin, fixture.now() - 1);
      if (kind === "NaN status") observation = { ...observation, statusCode: NaN };
      if (kind === "redirect") observation = { ...observation, statusCode: 302 };
      if (kind === "cached response") observation = { ...observation, responseFromCache: true };
      if (kind === "future end") observation = { ...observation, completedAtMono: fixture.now() + 1 };
      return { available: true, observation };
    });
    expect((await fixture.source.collect(fixture.request())).kind).toBe("unavailable");
    expect(fixture.conformance.bindSamples).not.toHaveBeenCalled();
  });

  it("rejects a changed gate version while an asynchronous sampler is in flight", async () => {
    const fixture = setup(),
      pending = deferred<Awaited<ReturnType<ProductionProofSourceOptions["egress"]["probe"]>>>();
    fixture.egress.probe.mockReturnValueOnce(pending.promise);
    const result = fixture.source.collect(fixture.request());
    await flush();
    fixture.setVersion({ generation: 4, rulesVersion: V });
    pending.resolve({ available: true, observation: egressObservation("ipip", fixture.now()) });
    expect(await result).toEqual({ kind: "unavailable", reason: "NETWORK_CHANGED" });
    expect(fixture.tls.probeTls).not.toHaveBeenCalled();
  });

  it("keeps a cancelled provider's real work in its concurrency slot until it settles", async () => {
    const fixture = setup(),
      source = new ProductionProofSource({ ...fixture.options, maxConcurrent: 1 });
    sources.push(source);
    const pending = deferred<ClashReadResult>();
    fixture.readController.mockReturnValueOnce(pending.promise);
    const abort = new AbortController(),
      first = source.collect(fixture.request({ signal: abort.signal }));
    await flush();
    abort.abort();
    expect(await source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "EGRESS_UNVERIFIED",
    });
    expect(fixture.readController).toHaveBeenCalledOnce();
    pending.resolve(controller(fixture.now(), [target(), echoTarget("ipv4")]));
    expect(await first).toEqual({ kind: "unavailable", reason: "GATE_REVOKED" });
    expect((await source.collect(fixture.request())).kind).toBe("evidence");
  });

  it("rejects pre-aborted requests and disposed sources without starting real work", async () => {
    const fixture = setup(),
      abort = new AbortController();
    abort.abort();
    expect(await fixture.source.collect(fixture.request({ signal: abort.signal }))).toEqual({
      kind: "unavailable",
      reason: "GATE_REVOKED",
    });
    fixture.source.dispose();
    expect(await fixture.source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "GATE_REVOKED",
    });
    expect(fixture.readController).not.toHaveBeenCalled();
  });

  it("sanitizes producer failures and never exposes their raw message", async () => {
    const fixture = setup();
    fixture.conformance.bindSamples.mockRejectedValue(new Error("synthetic-secret-do-not-output"));
    const result = await fixture.source.collect(fixture.request());
    expect(result).toEqual({ kind: "unavailable", reason: "EGRESS_UNVERIFIED" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });

  it.each([
    "candidate set",
    "resolved family",
    "input ID",
    "original lookup time",
    "deadline",
    "missing",
    "duplicate",
  ])("rejects mismatched current DNS %s before evidence can be committed", async (kind) => {
    const fixture = setup();
    fixture.conformance.read.mockImplementation(async (request, inputs) => {
      const value = scopeConformance(request, inputs, fixture.currentController(), fixture.now());
      let dns = [...value.dns],
        first = dns[0];
      if (kind === "candidate set") first = { ...first, candidateAddresses: ["192.0.2.99"] };
      if (kind === "resolved family") first = { ...first, resolvedAddresses: ["2001:db8::99"] };
      if (kind === "input ID") first = { ...first, inputSampleId: "prior-input" };
      if (kind === "original lookup time") first = { ...first, observedAtMono: fixture.now() - 1 };
      if (kind === "deadline") first = { ...first, expiresAtMono: first.expiresAtMono + 1 };
      dns = [first, ...dns.slice(1)];
      if (kind === "missing") dns = dns.slice(1);
      if (kind === "duplicate") dns = [...dns, first];
      return { ...value, dns };
    });
    expect((await fixture.source.collect(fixture.request())).kind).toBe("unavailable");
    fixture.conformance.read.mockImplementation(async (request, inputs) =>
      scopeConformance(request, inputs, fixture.currentController(), fixture.now()),
    );
    fixture.advance(10);
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    // Even a late DNS failure must not populate the reusable exit cache.
    expect(fixture.egress.probe).toHaveBeenCalledTimes(2);
  });

  it.each([
    "different targets",
    "different version",
    "different generation",
    "old input start",
    "unavailable input",
  ])("rejects %s from the current input reader before samplers", async (kind) => {
    const fixture = setup(),
      impl = fixture.inputs.read.getMockImplementation()!;
    fixture.inputs.read.mockImplementation(async (...args) => {
      const value = await impl(...args);
      if (value.state !== "observed") return value;
      if (kind === "different targets")
        return { ...value, targets: [target("other.example.com"), echoTarget("ipv4")] };
      if (kind === "different version") return { ...value, rulesVersion: "changed" };
      if (kind === "different generation") return { ...value, generation: 99 };
      if (kind === "old input start") return { ...value, startedAtMono: fixture.now() - 1 };
      return {
        state: "unavailable",
        reason: "SOURCE_UNAVAILABLE",
        startedAtMono: fixture.now(),
        completedAtMono: fixture.now(),
      };
    });
    expect((await fixture.source.collect(fixture.request())).kind).toBe("unavailable");
    expect(fixture.egress.probe).not.toHaveBeenCalled();
    expect(fixture.tls.probeTls).not.toHaveBeenCalled();
  });

  it("does not accept a prior shared controller read as this round's before observation", async () => {
    const fixture = setup();
    fixture.readController.mockResolvedValue(controller(fixture.now() - 1, [target(), echoTarget("ipv4")]));
    expect(await fixture.source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "PROOF_EXPIRED",
    });
    expect(fixture.inputs.read).not.toHaveBeenCalled();
  });

  it("honors cancellation while the original-path applicability binder is still running", async () => {
    const fixture = setup(),
      pending = deferred<readonly DiagnosticSamplePathBinding[] | null>(),
      abort = new AbortController();
    let captured: BindInput | null = null;
    fixture.conformance.bindSamples.mockImplementationOnce(async (input) => {
      captured = input;
      return pending.promise;
    });
    const result = fixture.source.collect(fixture.request({ signal: abort.signal }));
    await flush();
    expect(captured).not.toBeNull();
    abort.abort();
    pending.resolve(sampleBindings(captured!, fixture.now()));
    expect(await result).toEqual({ kind: "unavailable", reason: "GATE_REVOKED" });
    fixture.advance(1);
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    expect(fixture.egress.probe).toHaveBeenCalledTimes(2);
  });

  it("checks time again after binding and rejects inputs that expired during that await", async () => {
    const fixture = setup();
    fixture.conformance.bindSamples.mockImplementation(async (input) => {
      const bindings = sampleBindings(input, fixture.now());
      fixture.advance(15000);
      return bindings;
    });
    expect(await fixture.source.collect(fixture.request())).toEqual({
      kind: "unavailable",
      reason: "PROOF_EXPIRED",
    });
  });

  it("copies binder outputs and cached records so a provider cannot later relabel the stored original path", async () => {
    const fixture = setup();
    let external: readonly DiagnosticSamplePathBinding[] = [];
    fixture.conformance.bindSamples.mockImplementationOnce(async (input) => {
      external = sampleBindings(input, fixture.now());
      return external;
    });
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    external[0].originalPath.evidenceId = "post-return-mutation";
    fixture.advance(1);
    expect((await fixture.source.collect(fixture.request())).kind).toBe("evidence");
    const previous = fixture.conformance.bindSamples.mock.calls[1][0].samples.find(
      (sample) => sample.kind === "egress",
    )!.previousBinding!;
    expect(previous.originalPath.evidenceId).not.toBe("post-return-mutation");
  });

  it.each([0, -1, 5, NaN, 1.5])(
    "rejects an invalid concurrency limit %s without network work",
    (maxConcurrent) => {
      const fixture = setup();
      expect(() => new ProductionProofSource({ ...fixture.options, maxConcurrent })).toThrow(
        "PROOF_SOURCE_OPTIONS_INVALID",
      );
      expect(fixture.readController).not.toHaveBeenCalled();
    },
  );

  it("keeps the original scope when its caller changes it during the first controller await", async () => {
    const fixture = setup(),
      request = fixture.request(),
      original = structuredClone(request.scope);
    const pending = deferred<ClashReadResult>();
    fixture.readController.mockReturnValueOnce(pending.promise);
    const work = fixture.source.collect(request);
    await flush();
    Object.assign(request.scope, {
      contextId: "caller-replaced-context",
      catalogVersion: "caller-replaced-catalog",
    });
    Object.assign(request.scope.targets[0], { host: "caller-replaced.example.com", addressFamily: "ipv6" });
    pending.resolve(controller(fixture.now(), [target(), echoTarget("ipv4")]));
    const result = await work;
    expect(result).toMatchObject({
      kind: "evidence",
      batch: {
        contextId: original.contextId,
        catalogVersion: original.catalogVersion,
        targets: [{ target: original.targets[0] }],
      },
    });
    if (result.kind !== "evidence") return;
    expect(
      validateDirectEvidence(
        original,
        result.batch,
        {
          controllerReadable: true,
          mode: "rule",
          tun: true,
          generation: request.generation,
          rulesVersion: V,
          expiresAtMono: fixture.now() + 15000,
        },
        fixture.now(),
        NETWORK_TIMING,
      ).valid,
    ).toBe(true);
    expect(fixture.tls.probeTls.mock.calls.map(([origin]) => origin.host)).toEqual([
      original.targets[0].host,
    ]);
  });

  it("owns the observed snapshot even if its provider mutates the returned object during conformance await", async () => {
    const fixture = setup(),
      request = fixture.request(),
      original = structuredClone(request.scope);
    let providerOwned: CurrentPathInputs | null = null,
      goodRecord: ScopePathConformance | null = null;
    const pending = deferred<ScopePathConformance | null>(),
      impl = fixture.inputs.read.getMockImplementation()!;
    fixture.inputs.read.mockImplementation(async (...args) => {
      const value = await impl(...args);
      if (value.state === "observed") providerOwned = value;
      return value;
    });
    fixture.conformance.read.mockImplementation(async (inputRequest, inputs) => {
      goodRecord = structuredClone(
        scopeConformance(inputRequest, inputs, fixture.currentController(), fixture.now()),
      );
      return pending.promise;
    });
    const work = fixture.source.collect(request);
    await flush();
    expect(providerOwned).not.toBeNull();
    expect(goodRecord).not.toBeNull();
    const returned = providerOwned!;
    Object.assign(returned.targets[0], { host: "provider-replaced.example.com" });
    Object.assign(returned.configurationAfter, { fileFingerprint: "provider-mutated-file" });
    Object.assign(returned.ownerAfter, { kernelEpoch: "provider-mutated-kernel" });
    Object.assign(returned.networkAfter, { hash: "provider-mutated-os-network" });
    pending.resolve(goodRecord);
    const result = await work;
    expect(result).toMatchObject({
      kind: "evidence",
      batch: { contextId: original.contextId, targets: [{ target: original.targets[0] }] },
    });
    expect(fixture.conformance.bindSamples.mock.calls[0][0].inputs.configurationAfter.fileFingerprint).toBe(
      H,
    );
    expect(fixture.conformance.bindSamples.mock.calls[0][0].inputs.ownerAfter.kernelEpoch).toBe(K);
    expect(fixture.tls.probeTls.mock.calls.map(([origin]) => origin.host)).toEqual([
      original.targets[0].host,
    ]);
  });

  it("gives conformance.read private input and scope copies without changing the verified original batch", async () => {
    const fixture = setup(),
      request = fixture.request(),
      original = structuredClone(request.scope);
    fixture.conformance.read.mockImplementation(async (inputRequest, inputs) => {
      const result = structuredClone(
        scopeConformance(inputRequest, inputs, fixture.currentController(), fixture.now()),
      );
      Object.assign(inputRequest.scope, {
        contextId: "conformance-replaced-context",
        catalogVersion: "conformance-replaced-catalog",
      });
      Object.assign(inputRequest.scope.targets[0], { host: "conformance-replaced.example.com" });
      Object.assign(inputs.targets[0], { host: "conformance-input-replaced.example.com" });
      Object.assign(inputs.configurationAfter, { fileFingerprint: "conformance-replaced-file" });
      Object.assign(inputs.networkAfter, { hash: "conformance-replaced-os" });
      return result;
    });
    const result = await fixture.source.collect(request);
    expect(result).toMatchObject({
      kind: "evidence",
      batch: {
        contextId: original.contextId,
        catalogVersion: original.catalogVersion,
        targets: [{ target: original.targets[0] }],
      },
    });
    expect(request.scope).toEqual(original);
    expect(fixture.conformance.bindSamples.mock.calls[0][0].inputs.configurationAfter.fileFingerprint).toBe(
      H,
    );
    expect(fixture.tls.probeTls.mock.calls.map(([origin]) => origin.host)).toEqual([
      original.targets[0].host,
    ]);
  });

  it("gives bindSamples private input and scope copies while retaining genuine frozen route evidence", async () => {
    const fixture = setup(),
      request = fixture.request(),
      original = structuredClone(request.scope);
    fixture.conformance.bindSamples.mockImplementation(async (input) => {
      const bindings = sampleBindings(input, fixture.now());
      expect(input.routes).toHaveLength(1);
      expect(Object.isFrozen(input.routes[0])).toBe(true);
      expect(Object.isFrozen(input.routes[0].target)).toBe(true);
      Object.assign(input.request.scope, {
        contextId: "binder-replaced-context",
        catalogVersion: "binder-replaced-catalog",
      });
      Object.assign(input.request.scope.targets[0], { host: "binder-replaced.example.com" });
      Object.assign(input.inputs.targets[0], { host: "binder-input-replaced.example.com" });
      Object.assign(input.inputs.configurationAfter, { fileFingerprint: "binder-replaced-file" });
      Object.assign(input.inputs.networkAfter, { hash: "binder-replaced-os" });
      return bindings;
    });
    const result = await fixture.source.collect(request);
    expect(result).toMatchObject({
      kind: "evidence",
      batch: {
        contextId: original.contextId,
        catalogVersion: original.catalogVersion,
        targets: [{ target: original.targets[0] }],
      },
    });
    expect(request.scope).toEqual(original);
    if (result.kind !== "evidence") return;
    expect(
      validateDirectEvidence(
        original,
        result.batch,
        {
          controllerReadable: true,
          mode: "rule",
          tun: true,
          generation: request.generation,
          rulesVersion: V,
          expiresAtMono: fixture.now() + 15000,
        },
        fixture.now(),
        NETWORK_TIMING,
      ).valid,
    ).toBe(true);
  });

  it.each(["invalidate", "dispose", "version", "caller abort"])(
    "rechecks %s in the microtask between collectOnce completion and the public collect result",
    async (kind) => {
      const fixture = setup(),
        abort = new AbortController();
      fixture.conformance.bindSamples.mockImplementation(async (input) => {
        const result = sampleBindings(input, fixture.now());
        queueMicrotask(() =>
          queueMicrotask(() => {
            if (kind === "invalidate") fixture.source.invalidate();
            if (kind === "dispose") fixture.source.dispose();
            if (kind === "version") fixture.setVersion({ generation: 4, rulesVersion: V });
            if (kind === "caller abort") abort.abort();
          }),
        );
        return result;
      });
      expect(await fixture.source.collect(fixture.request({ signal: abort.signal }))).toEqual({
        kind: "unavailable",
        reason: kind === "version" ? "NETWORK_CHANGED" : "GATE_REVOKED",
      });
    },
  );
});
