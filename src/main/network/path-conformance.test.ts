import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PathConformanceAdapter,
  validatePathDiagnosticMetadata,
  type PathConformanceOptions,
  type RetainedPathQualification,
} from "./path-conformance";
import {
  ProductionProofSource,
  currentDirectOutbound,
  type ProductionProofSourceOptions,
  type ScopePathConformance,
} from "./production-proof-source";
import {
  routeApplicabilityBinding,
  verifyRouteApplicability,
  type RouteConformanceRecord,
} from "./route-applicability";
import { validateDirectEvidence, type AccountProofScope, type ProofTarget } from "./direct-proof";
import type { ProofCollectionRequest, ProofScopeVersion } from "./proof-issuer";
import type { CurrentPathInputs } from "./path-input-reader";
import type { ClashReadResult } from "./clash-reader";
import type { EffectiveConfigCandidate } from "./effective-config-source";
import type { KernelDnsCandidates, KernelDnsHostCandidate } from "./kernel-dns";
import type { WindowsRouteSelection, WindowsRouteSelectionSnapshot } from "./windows-route-selection";
import { ANONYMOUS_TLS_FACTORY_ID, type AnonymousTlsObservation } from "./anonymous-proof-probe";
import {
  ANONYMOUS_EGRESS_FACTORY_ID,
  type AnonymousEgressObservation,
  type AnonymousEgressProvider,
} from "./anonymous-egress-probe";
import { associateCurrentConfiguration, type KnownSelectedLoaderContract } from "./configuration-association";
import { CHROMIUM_TRANSPORT_PROFILE_ID } from "./chromium-transport";
import { NETWORK_TIMING } from "@shared/network";
import { normalizeKernelRule, type KernelRule } from "./rules";
import type { CurrentRuleContext } from "./current-rule-context";
import { createResolverFlowMapping, type ResolverFlowMappingObservation } from "./resolver-flow-mapping";
import { parseAnonymousRequestSocket } from "./anonymous-request-socket";
import { projectSourcePolicyDetails } from "./source-policy-details";
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
  const ruleParameters = live.rules.map((r) => (r.type === "IPCIDR" ? ["no-resolve"] : []));
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
    orderedRulesFingerprint: hash(live.rules.map(normalizeKernelRule)),
    sourceRuleOptionsFingerprint: hash(ruleParameters),
    rules: live.rules,
    ruleParameters,
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
    currentDirectPolicy: { ...live.directPolicy!, startedAtMono: at, completedAtMono: at },
  };
}
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

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const mutable = <T>(value: T) => value as Mutable<T>;
const adapters: PathConformanceAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(
  destinations: readonly ProofTarget[] = [target()],
  leadingRules: readonly KernelRule[] = [],
  amendInputs?: (inputs: CurrentPathInputs) => void,
) {
  let now = 1000,
    sequence = 0;
  const version: ProofScopeVersion = { generation: 3, rulesVersion: V };
  const required = [
    ...destinations,
    ...[...new Set(destinations.map((t) => t.addressFamily))].map(echoTarget),
  ];
  const scope: AccountProofScope = {
    accountId: "fixture-account",
    platformId: "bilibili",
    contextId: "runtime-account-context",
    catalogVersion: "reviewed-operation",
    catalogReviewed: true,
    targets: destinations,
  };
  const currentController = (at: number) => {
    const value = controller(at, required);
    return { ...value, rules: [...leadingRules, ...value.rules] };
  };
  const originalLive = currentController(500),
    original = pathInputs(500, required, version, originalLive, "qualification-inputs");
  amendInputs?.(original);
  const loader: KnownSelectedLoaderContract = {
    source: "main-process-selected-loader-contract",
    selectionId: "current-selected-loader",
    loaderProfileId: "selected-client-loader",
    sourcePathIdentity: H,
    decoderIdentity: "synthetic-yaml",
    qualificationEvidenceIds: ["actual-loader-path-reference"],
    selectedAtMono: 10,
  };
  const associated = associateCurrentConfiguration({ inputs: original, loader }, 510);
  if (!associated.valid) throw new Error(`fixture association ${associated.reason}`);
  const originalConformance = scopeConformance(
    {
      generation: 3,
      rulesVersion: V,
      scope,
      requestId: "original-request",
      startedAtMono: 500,
      signal: new AbortController().signal,
    },
    original,
    originalLive,
    510,
  );
  const origins = [...new Set(required.map((v) => v.host))].map((host) => {
    const values = required.filter((t) => t.host === host),
      possibleAddressFamilies = values.map((v) => v.addressFamily);
    return {
      origin: { protocol: "https:" as const, host, port: 443 },
      possibleAddressFamilies,
      familyConstraint:
        possibleAddressFamilies.length === 1
          ? {
              evidenceId: `reviewed-family-${host}`,
              sourceEvidenceIds: ["retained-positive-and-negative-family-trials"],
            }
          : null,
    };
  });
  const qualification: RetainedPathQualification = {
    source: "main-process-retained-path-qualification",
    evidenceId: "selected-original-path-qualification",
    inputs: original,
    loader,
    configuration: associated.association,
    qualifiedAtMono: 520,
    expiresAtMono: 100000,
    electronVersion: "43.3.0",
    transport: originalConformance.transport,
    tcpQualification: {
      evidenceId: "original-tcp-startup-trial",
      switch: "disable-quic",
      startupProfileId: CHROMIUM_TRANSPORT_PROFILE_ID,
      sourceEvidenceIds: ["controlled-positive-and-negative-quic-results"],
    },
    origins,
    routes: structuredClone(originalConformance.routes),
    resolver: {
      source: "reviewed-real-kernel-query-equivalence",
      evidenceId: "original-resolver-equivalence",
      sourceEvidenceIds: ["original-kernel-and-chromium-resolver-records"],
      transportProfileIds: ["account-chromium", "anonymous-tls", "anonymous-egress"],
      observations: required.map((t) => {
        const addresses = original.dnsAfter.hosts
          .find((h) => h.host === t.host)!
          .addresses.filter((a) => a.addressFamily === t.addressFamily)
          .map((a) => a.address);
        return {
          evidenceId: `original-resolver-${t.host}-${t.addressFamily}`,
          target: t,
          transportProfileId: "anonymous-egress",
          kernelAddresses: addresses,
          transportAddresses: addresses,
          startedAtMono: 500,
          completedAtMono: 501,
        };
      }),
    },
    diagnosticPaths: [
      ...origins
        .filter((o) => destinations.some((t) => t.host === o.origin.host))
        .map((o) => ({
          kind: "tls" as const,
          origin: o.origin,
          possibleAddressFamilies: o.possibleAddressFamilies,
          basis: "reviewed-path-equivalence" as const,
          evidenceId: `tls-profile-${o.origin.host}`,
          sourceEvidenceIds: ["retained-factory-resolver-route-review"],
        })),
      ...[...new Set(destinations.map((t) => t.addressFamily))].map((family) => ({
        kind: "egress" as const,
        origin: echoTarget(family),
        possibleAddressFamilies: [family],
        basis: "validated-path-constraint" as const,
        evidenceId: `echo-profile-${family}`,
        sourceEvidenceIds: ["retained-echo-origin-family-constraint"],
      })),
    ],
  };
  mutable(qualification).resolver.profileEquivalences = ["account-chromium", "anonymous-tls"].map(
    (profile) => ({
      evidenceId: `reviewed-resolver-equivalence:${profile}`,
      fromProfileId: "anonymous-egress",
      toProfileId: profile,
      addressFamilies: [...new Set(required.map((t) => t.addressFamily))],
      sourceObservationIds: qualification.resolver.observations.map((o) => o.evidenceId),
      sourceEvidenceIds: ["reviewed-factories-use-same-resolver-policy-and-current-mode"],
    }),
  );
  let latest = currentController(now);
  const runtime = {
    electronVersion: "43.3.0",
    profileId: CHROMIUM_TRANSPORT_PROFILE_ID,
    configuredBeforeReady: true,
    disableQuicSwitchPresent: true,
  };
  const createRouteReader = vi.fn<NonNullable<PathConformanceOptions["createRouteReader"]>>((routeScope) => ({
    read: vi.fn(
      async () =>
        ({
          available: true,
          basis: "windows-source-route-query",
          localAddress: routeScope.localAddress!,
          socketObserved: false,
          startedAtMono: now,
          completedAtMono: now,
          scopeHash: H,
          selectionHash: H,
          selections: routeScope.addresses.map((address) => route(address)),
        }) as const,
    ),
    dispose: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }));
  const options: PathConformanceOptions = {
    loader,
    qualification,
    readVersion: () => version,
    getController: () => latest,
    createRouteReader,
    now: () => now,
    readChromiumRuntime: () => runtime,
  };
  const create = (overrides: Partial<PathConformanceOptions> = {}) => {
    const value = new PathConformanceAdapter({ ...options, ...overrides });
    adapters.push(value);
    return value;
  };
  const request = (): ProofCollectionRequest => ({
    requestId: `request-${++sequence}`,
    scope: structuredClone(scope),
    generation: version.generation,
    rulesVersion: version.rulesVersion,
    startedAtMono: now,
    signal: new AbortController().signal,
  });
  const currentInputs = (virtual = false) => {
    const inputs = pathInputs(now, required, version, latest, `input-${++sequence}`);
    amendInputs?.(inputs);
    if (virtual)
      for (const batch of mutable(inputs).routeBatches)
        for (const r of batch.selections)
          Object.assign(r, {
            hardwareInterface: false,
            interfaceIndex: 59,
            sourceAddress: r.addressFamily === "ipv4" ? "198.18.0.1" : "fd00::1",
          });
    return inputs;
  };
  const inputs = {
    read: vi.fn<ProductionProofSourceOptions["inputs"]["read"]>(async () => currentInputs(true)),
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
  const buildSource = (adapter: PathConformanceAdapter) => {
    const source = new ProductionProofSource({
      inputs,
      conformance: adapter,
      readVersion: () => version,
      now: () => now,
      readController: async () =>
        (latest = {
          ...latest,
          startedAtMono: now,
          completedAtMono: now,
          directPolicy: latest.directPolicy && {
            ...latest.directPolicy,
            startedAtMono: now,
            completedAtMono: now,
          },
        }),
      tls,
      egress,
    });
    sources.push(source);
    return source;
  };
  const bindInput = (
    r: ProofCollectionRequest,
    inputs: CurrentPathInputs,
    conformance: ScopePathConformance,
  ) => {
    const outbound = currentDirectOutbound(inputs, latest);
    const routes = r.scope.targets.map((t) => {
      const result = verifyRouteApplicability(
        {
          inputs,
          target: t,
          echo: echoTarget(t.addressFamily),
          outbound,
          snapshot: {
            mode: latest.mode,
            rules: latest.rules,
            generation: version.generation,
            rulesVersion: version.rulesVersion,
            kernelEpoch: K,
            observedAtMono: now,
          },
          conformance: conformance.routes.find((v) => v.binding.addressFamily === t.addressFamily)!,
          targetTransportProfileId: "account-chromium",
          echoTransportProfileId: "anonymous-egress",
          physicalRouteProjections: conformance.physicalRouteProjections,
        },
        now,
      );
      if (!result.valid) throw new Error(result.reason);
      return result.evidence;
    });
    return {
      request: r,
      inputs: structuredClone(inputs),
      conformance: structuredClone(conformance),
      routes,
      samples: [
        ...[...new Set(r.scope.targets.map((v) => v.host))].map((host) => ({
          kind: "tls" as const,
          observation: tlsObservation({ host, port: 443 }, now),
          previousBinding: null,
        })),
        ...[...new Set(r.scope.targets.map((v) => v.addressFamily))].map((f) => ({
          kind: "egress" as const,
          observation: egressObservation(f === "ipv4" ? "ipip" : "ipify-ipv6", now),
          previousBinding: null,
        })),
      ],
    };
  };
  return {
    create,
    request,
    currentInputs,
    qualification,
    loader,
    createRouteReader,
    options,
    runtime,
    version,
    scope,
    inputs,
    tls,
    egress,
    buildSource,
    bindInput,
    currentController: () => latest,
    setController: (patch: Partial<ClashReadResult>) => {
      latest = { ...latest, ...patch };
    },
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Synthetic reader observations: original qualification and current round retain their own times. */
function attachSystemHosts(inputs: CurrentPathInputs, fileHash = H, fileIdentity = K): void {
  const hosts = [...new Set(inputs.targets.map((value) => value.host))].sort();
  const observation = {
    available: true as const,
    kind: "windows-system-hosts-targets" as const,
    source: "windows-system-hosts-file" as const,
    resolutionProven: false as const,
    parserProfile: "windows-hosts-ascii-aliases-v1" as const,
    scopeHash: hash(hosts),
    fileHash,
    fileIdentity,
    startedAtMono: inputs.startedAtMono,
    completedAtMono: inputs.completedAtMono,
    hosts: hosts.map((host) => ({ host, ipv4: [], ipv6: [] })),
  };
  mutable(inputs).systemHostsBefore = structuredClone(observation);
  mutable(inputs).systemHostsAfter = structuredClone(observation);
}
function qualifySystemHosts(f: ReturnType<typeof setup>): void {
  attachSystemHosts(f.qualification.inputs);
  // Reconstruct the branded association over the actual synthetic qualification inputs, instead
  // of changing a retained association or filling a successful validation boolean by hand.
  const associated = associateCurrentConfiguration(
    { inputs: f.qualification.inputs, loader: f.loader },
    f.qualification.configuration.checkedAtMono,
  );
  if (!associated.valid) throw new Error(`system hosts fixture association ${associated.reason}`);
  mutable(f.qualification).configuration = associated.association;
}

function attachFakePolicy(inputs: CurrentPathInputs): void {
  attachSystemHosts(inputs);
  for (const candidate of [inputs.configurationBefore, inputs.configurationAfter]) {
    const policy = mutable(candidate.policy);
    policy.dns = { present: true, kind: "object", fingerprint: H };
    policy.dnsMode = { present: true, value: "fake-ip" };
    policy.dnsFlags.enable = { present: true, value: true };
    policy.details = projectSourcePolicyDetails({ dns: { "fake-ip-range": "198.18.0.1/16" } });
  }
}
/** A synthetic mapping flow is deliberately different from the retained physical route sample. */
function withFakeResolver(latePostflight = false) {
  const f = setup(),
    q = f.qualification,
    t = f.scope.targets[0];
  if (latePostflight) {
    mutable(q).inputs = pathInputs(
      100,
      q.inputs.targets,
      f.version,
      controller(100, q.inputs.targets),
      "original-short-dns",
    );
  }
  attachFakePolicy(q.inputs);
  if (latePostflight) mutable(q.inputs).expiresAtMono = 1100;
  qualifySystemHosts(f);
  const parsed = parseAnonymousRequestSocket(
    JSON.stringify({
      constants: {
        logEventTypes: { URL_REQUEST_START_JOB: 1, HTTP_STREAM_JOB_BOUND_TO_REQUEST: 2, TCP_CONNECT: 3 },
        logSourceType: { URL_REQUEST: 1, HTTP_STREAM_JOB: 2, SOCKET: 3 },
      },
      events: [
        {
          source: { id: 10, type: 1 },
          type: 1,
          time: "1000",
          params: { url: `https://${t.host}/robots.txt` },
        },
        { source: { id: 10, type: 1 }, type: 2, time: "1001", params: { source_dependency: { id: 20 } } },
        {
          source: { id: 20, type: 3 },
          type: 3,
          time: "1002",
          params: { source_address: "10.0.0.2:50000", address: "198.18.0.2:443" },
        },
      ],
    }),
    t,
  );
  if (!parsed.available) throw new Error(parsed.reason);
  const dns = structuredClone(q.inputs.dnsAfter),
    host = mutable(dns.hosts.find((h) => h.host === t.host)!);
  host.ipv4 = ["223.5.5.5"];
  host.addresses = [{ address: "223.5.5.5", addressFamily: "ipv4", addressClass: "real" }];
  for (const answer of host.answers) answer.data = "223.5.5.5";
  for (const query of host.queries)
    for (const answer of mutable(query.response!).answers) answer.data = "223.5.5.5";
  if (latePostflight) {
    // A one-second DNS sample that is still valid during the request but expired by review.
    for (const answer of host.answers) {
      answer.ttl = 1;
      answer.expiresAtMono = answer.observedAtMono + 1000;
    }
    for (const query of host.queries) for (const answer of mutable(query.response!).answers) answer.ttl = 1;
    mutable(dns).expiresAtMono = host.expiresAtMono = 1100;
  }
  const owner = { pid: 902, createdAtTicks: "639244035457234679", executablePathIdentity: K };
  const mapping = createResolverFlowMapping(
    {
      target: t,
      factoryId: ANONYMOUS_TLS_FACTORY_ID,
      transportProfileId: q.transport.tlsProfileId,
      transportContextId: "actual-mapping-context",
      inputs: q.inputs,
      loader: q.loader,
      configuration: q.configuration,
      requestSocket: parsed.observation,
      appOwner: owner,
      appTcp: {
        available: true,
        startedAtMono: 515,
        completedAtMono: latePostflight ? 1200 : 516,
        scopeHash: H,
        owners: [owner],
        sockets: [{ ...parsed.observation.tuple, ownerPid: owner.pid, state: "Established" }],
      },
      incomingBefore: { startedAtMono: 501, completedAtMono: 509, connections: [] },
      incomingAfter: {
        startedAtMono: 515,
        completedAtMono: latePostflight ? 1200 : 516,
        connections: [
          {
            id: "original-mapping-flow",
            host: t.host,
            sniffHost: null,
            sourceAddress: "10.0.0.2",
            sourcePort: 50000,
            destinationPort: 443,
            destinationIp: "198.18.0.2",
            remoteDestinationIp: "223.5.5.5",
            network: "tcp",
            inboundType: "Tun",
            processIdentity: null,
            route: "direct",
            startedAtMs: 1002,
          },
        ],
      },
      kernelDns: dns,
      window: { sendAtMono: 511, headersAtMono: 514, sendAtWallMs: 1000, headersAtWallMs: 1003 },
    },
    latePostflight ? 1201 : 517,
  );
  if (!mapping.valid) throw new Error(mapping.reason);
  mutable(q.resolver).source = "reviewed-kernel-query-path-conformance";
  // Keep the actual constructor object; the adapter must not accept its JSON replacement.
  Object.assign(q.resolver, { observations: [mapping.observation] });
  mutable(q.resolver).profileEquivalences = [q.transport.accountProfileId, q.transport.egressProfileId].map(
    (toProfileId) => ({
      evidenceId: `reviewed-fake-profile:${toProfileId}`,
      fromProfileId: q.transport.tlsProfileId,
      toProfileId,
      addressFamilies: ["ipv4"],
      sourceObservationIds: [mapping.observation.evidenceId],
      sourceEvidenceIds: ["retained-profile-resolver-policy-review"],
    }),
  );
  const current = () => {
    const inputs = f.currentInputs(true);
    attachFakePolicy(inputs);
    return inputs;
  };
  f.inputs.read.mockImplementation(async () => current());
  if (latePostflight) {
    mutable(q).qualifiedAtMono = 1202;
    f.advance(2000 - f.now());
  }
  return { ...f, current, mapping: mapping.observation };
}

function withIndependentResolverContext() {
  const f = withFakeResolver(),
    q = f.qualification;
  const context = {
    observationEvidenceIds: [f.mapping.evidenceId],
    inputs: q.inputs,
    loader: q.loader,
    configuration: q.configuration,
  };
  // A genuinely separate qualification anchor, not the original mapping's input with its dates edited.
  const anchor = pathInputs(
    550,
    q.inputs.targets,
    f.version,
    controller(550, q.inputs.targets),
    "later-preparation-anchor",
  );
  attachFakePolicy(anchor);
  const associated = associateCurrentConfiguration({ inputs: anchor, loader: f.loader }, 560);
  if (!associated.valid) throw new Error(associated.reason);
  Object.assign(q, { inputs: anchor, configuration: associated.association, qualifiedAtMono: 570 });
  Object.assign(q.resolver, { observationContexts: [context] });
  return { ...f, context };
}

type RuleContextReaderInput = Parameters<NonNullable<PathConformanceOptions["readRuleContexts"]>>[0];
/** Synthetic reviewed rule-entry alternatives, never inferred from the fixture DNS addresses. */
function ruleContexts(input: RuleContextReaderInput, at: number): CurrentRuleContext[] {
  return input.inputs.targets.flatMap((target) => {
    const profiles = new Set<string>();
    if (
      input.request.scope.targets.some(
        (t) => t.host === target.host && t.addressFamily === target.addressFamily,
      )
    ) {
      profiles.add(input.transport.accountProfileId);
      profiles.add(input.transport.tlsProfileId);
    }
    if (target.host === echoTarget(target.addressFamily).host) profiles.add(input.transport.egressProfileId);
    return [...profiles].map((transportProfileId) => ({
      source: "main-process-current-rule-context",
      target,
      scopeContextId: input.request.scope.contextId,
      transportProfileId,
      inputSampleId: input.inputs.sampleId,
      configurationEvidenceId: input.configuration.association!.evidenceId,
      generation: input.request.generation,
      rulesVersion: input.request.rulesVersion,
      kernelEpoch: input.inputs.ownerAfter.kernelEpoch,
      network: "tcp",
      destinations: [{ stage: "unresolved" }, { stage: "resolved", address: "192.0.2.7" }],
      sourceEvidenceIds: ["synthetic-reviewed-entry-alternatives"],
      checkedAtMono: at,
      expiresAtMono: Math.min(at + 15000, input.configuration.association!.expiresAtMono),
    }));
  });
}
const leadingCidrRules: KernelRule[] = [
  { type: "IPCIDR", payload: "198.51.100.0/24", proxy: "overseas" },
  { type: "IPCIDR", payload: "192.0.2.0/24", proxy: "DIRECT" },
];

describe("same-round rule context through the production proof source", () => {
  it("carries branded configuration and source parameters through all layers and retains different DIRECT indices", async () => {
    const f = setup([target()], leadingCidrRules);
    const adapter = f.create({ readRuleContexts: (input) => ruleContexts(input, f.now()) });
    const result = await f.buildSource(adapter).collect(f.request());
    expect(result, adapter.lastFailure() ?? "").toHaveProperty("kind", "evidence");
    if (result.kind !== "evidence") return;
    const route = result.batch.targets[0].route;
    expect(route.source).toBe("current-ordered-rules");
    if (route.source !== "current-ordered-rules") return;
    expect(route.ruleBranches?.map((b) => b.decision.ruleIndex)).toEqual([2, 1]);
    expect(route.ruleBranches?.map((b) => b.matchedPolicy)).toEqual(["DIRECT", "DIRECT"]);
    expect(
      validateDirectEvidence(
        f.scope,
        result.batch,
        {
          controllerReadable: true,
          mode: "rule",
          tun: true,
          generation: 3,
          rulesVersion: V,
          expiresAtMono: f.now() + 15000,
        },
        f.now(),
        NETWORK_TIMING,
      ).valid,
    ).toBe(true);
    expect(f.inputs.read).toHaveBeenCalledTimes(1);
    expect(f.tls.probeTls).toHaveBeenCalledTimes(1);
    expect(f.egress.probe).toHaveBeenCalledTimes(1);
  });

  it.each(["account-chromium", "anonymous-tls", "anonymous-egress"])(
    "uses the shortest %s context lifetime in the resulting permit evidence",
    async (profile) => {
      const f = setup([target()], leadingCidrRules),
        deadline = f.now() + 50;
      const adapter = f.create({
        readRuleContexts: (input) =>
          ruleContexts(input, f.now()).map((c) =>
            c.transportProfileId === profile ? { ...c, expiresAtMono: deadline } : c,
          ),
      });
      const result = await f.buildSource(adapter).collect(f.request());
      expect(result, adapter.lastFailure() ?? "").toHaveProperty("kind", "evidence");
      if (result.kind !== "evidence") return;
      const route = result.batch.targets[0].route;
      expect(route.source).toBe("current-ordered-rules");
      if (route.source === "current-ordered-rules") expect(route.expiresAtMono).toBe(deadline);
    },
  );

  it.each(["anonymous-tls", "anonymous-egress"])(
    "rechecks the original %s lifetime after awaiting sample bindings",
    async (profile) => {
      const f = setup([target()], leadingCidrRules),
        deadline = f.now() + 50;
      const adapter = f.create({
        readRuleContexts: (input) =>
          ruleContexts(input, f.now()).map((c) =>
            c.transportProfileId === profile ? { ...c, expiresAtMono: deadline } : c,
          ),
      });
      const bind = adapter.bindSamples.bind(adapter);
      vi.spyOn(adapter, "bindSamples").mockImplementation(async (input) => {
        const result = await bind(input);
        expect(result).not.toBeNull();
        f.advance(51);
        return result;
      });
      const result = await f.buildSource(adapter).collect(f.request());
      expect(result.kind).toBe("unavailable");
      expect(adapter.bindSamples).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["account-chromium", "anonymous-tls", "anonymous-egress"])(
    "does not let an unproved %s branch reach any HTTP diagnostic",
    async (profile) => {
      const f = setup([target()], leadingCidrRules);
      const adapter = f.create({
        readRuleContexts: (input) =>
          ruleContexts(input, f.now()).map((c) =>
            c.transportProfileId === profile
              ? { ...c, destinations: [...c.destinations, { stage: "unknown" as const }] }
              : c,
          ),
      });
      expect((await f.buildSource(adapter).collect(f.request())).kind).toBe("unavailable");
      expect(f.tls.probeTls).not.toHaveBeenCalled();
      expect(f.egress.probe).not.toHaveBeenCalled();
    },
  );

  it.each(["proxy alternative", "missing tls", "duplicate egress", "wrong sample", "wrong scope", "udp"])(
    "rejects %s without falling back to the simple DOMAIN interpreter",
    async (kind) => {
      const f = setup([target()], leadingCidrRules);
      const adapter = f.create({
        readRuleContexts: (input) => {
          let contexts = ruleContexts(input, f.now());
          if (kind === "proxy alternative")
            contexts[0] = {
              ...contexts[0],
              destinations: [...contexts[0].destinations, { stage: "resolved", address: "198.51.100.7" }],
            };
          if (kind === "missing tls")
            contexts = contexts.filter((c) => c.transportProfileId !== "anonymous-tls");
          if (kind === "duplicate egress")
            contexts.push(contexts.find((c) => c.transportProfileId === "anonymous-egress")!);
          if (kind === "wrong sample") contexts[0] = { ...contexts[0], inputSampleId: "another-round" };
          if (kind === "wrong scope")
            contexts[0] = { ...contexts[0], scopeContextId: "another-account-context" };
          if (kind === "udp") contexts[0] = { ...contexts[0], network: "udp" };
          return contexts;
        },
      });
      expect((await f.buildSource(adapter).collect(f.request())).kind).toBe("unavailable");
      expect(f.tls.probeTls).not.toHaveBeenCalled();
      expect(f.egress.probe).not.toHaveBeenCalled();
    },
  );

  it("rejects a copied association at the Source boundary before HTTP diagnostics", async () => {
    const f = setup([target()], leadingCidrRules);
    const adapter = f.create({ readRuleContexts: (input) => ruleContexts(input, f.now()) });
    const read = adapter.read.bind(adapter);
    vi.spyOn(adapter, "read").mockImplementation(async (...args) => {
      const result = await read(...args);
      expect(result).not.toBeNull();
      return structuredClone(result);
    });
    expect((await f.buildSource(adapter).collect(f.request())).kind).toBe("unavailable");
    expect(f.tls.probeTls).not.toHaveBeenCalled();
    expect(f.egress.probe).not.toHaveBeenCalled();
  });

  it("treats an explicitly unavailable provider as unavailable even for early DOMAIN rules", async () => {
    const f = setup(),
      adapter = f.create({ readRuleContexts: () => null });
    expect((await f.buildSource(adapter).collect(f.request())).kind).toBe("unavailable");
    expect(f.tls.probeTls).not.toHaveBeenCalled();
    expect(f.egress.probe).not.toHaveBeenCalled();
  });
});

describe("fake-IP resolver conformance", () => {
  it("accepts different app/kernel addresses while retaining the independently qualified physical path", async () => {
    const f = withFakeResolver(),
      originalRoutes = structuredClone(f.qualification.routes);
    expect(f.mapping.transportAddresses).not.toEqual(f.mapping.kernelAddresses);
    expect(f.mapping.incoming.remoteDestinationIp).not.toBe(
      originalRoutes[0].samples[0].socket.remoteAddress,
    );
    const result = await f.create().read(f.request(), f.current());
    expect(result).not.toBeNull();
    expect(result!.routes[0].samples).toEqual(originalRoutes[0].samples);
    expect(
      result!.dns.every((d) => d.candidateAddresses.every((address) => !address.startsWith("198.18."))),
    ).toBe(true);
    expect(f.createRouteReader).toHaveBeenCalled();
  });

  it("allows a complete synthetic ProductionProofSource round through the mapping branch", async () => {
    const f = withFakeResolver(),
      adapter = f.create(),
      source = f.buildSource(adapter);
    const result = await source.collect(f.request());
    expect(result.kind).toBe("evidence");
    expect(f.tls.probeTls).toHaveBeenCalled();
    expect(f.egress.probe).toHaveBeenCalled();
  });

  it("cannot replace physical conformance with a valid resolver mapping", async () => {
    const f = withFakeResolver();
    mutable(f.qualification).routes = [];
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.current())).toBeNull();
    expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
    expect(f.createRouteReader).not.toHaveBeenCalled();
  });

  it("cannot turn one observed app address family into a business family constraint", async () => {
    const f = withFakeResolver();
    for (const origin of mutable(f.qualification).origins) origin.familyConstraint = null;
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.current())).toBeNull();
    expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
    expect(f.createRouteReader).not.toHaveBeenCalled();
  });

  it.each([
    "copied mapping",
    "changed context",
    "old real label",
    "wrong profile",
    "duplicate mapping",
  ] as const)("rejects %s instead of treating a raw record as a mapping qualification", async (kind) => {
    const f = withFakeResolver(),
      copied = structuredClone(f.mapping);
    if (kind === "old real label")
      mutable(f.qualification.resolver).source = "reviewed-real-kernel-query-equivalence";
    else if (kind === "duplicate mapping")
      Object.assign(f.qualification.resolver, { observations: [f.mapping, f.mapping] });
    else {
      if (kind === "changed context") mutable(copied).transportContextId = "another-context";
      if (kind === "wrong profile")
        mutable(copied).transportProfileId = f.qualification.transport.accountProfileId;
      Object.assign(f.qualification.resolver, { observations: [copied] });
    }
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.current())).toBeNull();
    expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
    expect(f.createRouteReader).not.toHaveBeenCalled();
  });

  it("checks current policy dependencies without refreshing or mutating the retained mapping", async () => {
    const f = withFakeResolver(),
      adapter = f.create(),
      before = structuredClone(f.mapping);
    expect(await adapter.read(f.request(), f.current())).not.toBeNull();
    await adapter.whenIdle();
    const changed = f.current();
    mutable(changed.configurationBefore.policy).fingerprint = K;
    mutable(changed.configurationAfter.policy).fingerprint = K;
    expect(await adapter.read(f.request(), changed)).toBeNull();
    expect(adapter.lastFailure()).toBe("QUALIFICATION_CHANGED");
    expect(f.mapping).toEqual(before);
  });

  it("reviews completed postflight after the original DNS window and uses fresh current inputs for Source", async () => {
    const f = withFakeResolver(true),
      original = structuredClone(f.mapping),
      adapter = f.create();
    expect(f.qualification.configuration.expiresAtMono).toBe(1100);
    expect(f.mapping.kernelDnsExpiresAtMono).toBe(1100);
    expect(f.mapping.completedAtMono).toBe(1200);
    expect(f.mapping.checkedAtMono).toBe(1201);
    expect(f.qualification.qualifiedAtMono).toBe(1202);
    expect(f.mapping.window.headersAtMono).toBeLessThan(1100);
    const result = await f.buildSource(adapter).collect(f.request());
    expect(result, adapter.lastFailure() ?? "").toHaveProperty("kind", "evidence");
    expect(f.mapping).toEqual(original);
    expect(f.qualification.configuration.expiresAtMono).toBe(1100);
  });

  it("cannot use late historical review to revive expired current DNS", async () => {
    const f = withFakeResolver(true),
      adapter = f.create();
    f.inputs.read.mockImplementation(async () => {
      const inputs = f.current();
      for (const host of mutable(inputs.dnsAfter).hosts) {
        host.expiresAtMono = f.now();
        for (const answer of host.answers) answer.expiresAtMono = f.now();
      }
      return inputs;
    });
    expect((await f.buildSource(adapter).collect(f.request())).kind).toBe("unavailable");
    expect(f.tls.probeTls).not.toHaveBeenCalled();
    expect(f.egress.probe).not.toHaveBeenCalled();
  });

  it.each([1199, 1200])(
    "rejects a qualification backdated to %s before all postflight/checks completed",
    async (at) => {
      const f = withFakeResolver(true);
      mutable(f.qualification).qualifiedAtMono = at;
      const adapter = f.create();
      expect(await adapter.read(f.request(), f.current())).toBeNull();
      expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
      expect(f.createRouteReader).not.toHaveBeenCalled();
    },
  );

  it("does not reuse original expired inputs after a late review", async () => {
    const f = withFakeResolver(true),
      adapter = f.create();
    expect(await adapter.read(f.request(), f.qualification.inputs)).toBeNull();
    expect(adapter.lastFailure()).toBe("CONFIGURATION_UNAVAILABLE");
    expect(f.createRouteReader).not.toHaveBeenCalled();
  });

  it("does not inherit constructor provenance after mutating the input qualification between construction and read", async () => {
    const f = withFakeResolver(),
      adapter = f.create();
    Object.assign(f.qualification.resolver, {
      observations: [structuredClone(f.mapping) as ResolverFlowMappingObservation],
    });
    // The adapter owns its captured original and copied content, so caller replacement cannot
    // change or revive the already retained round.
    expect(await adapter.read(f.request(), f.current())).not.toBeNull();
  });
});

describe("independent original resolver contexts", () => {
  it("composes a genuine earlier mapping with a later preparation anchor without rewriting either window", async () => {
    const f = withIndependentResolverContext();
    const before = structuredClone(f.context);
    const result = await f.buildSource(f.create()).collect(f.request());
    expect(result.kind).toBe("evidence");
    expect(f.context).toEqual(before);
    expect(f.context.inputs.sampleId).not.toBe(f.qualification.inputs.sampleId);
    expect(f.context.configuration.checkedAtMono).toBe(510);
    expect(f.qualification.configuration.checkedAtMono).toBe(560);
  });
  it("does not borrow the later anchor when an explicit original context is absent", async () => {
    const f = withIndependentResolverContext();
    delete mutable(f.qualification.resolver).observationContexts;
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.current())).toBeNull();
    expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
  });
  it.each(["empty", "wrong-id", "overlap", "extra", "restored-association"])(
    "rejects %s context coverage",
    async (kind) => {
      const f = withIndependentResolverContext();
      if (kind === "empty") Object.assign(f.qualification.resolver, { observationContexts: [] });
      if (kind === "wrong-id") f.context.observationEvidenceIds = ["another-mapping"];
      if (kind === "overlap")
        Object.assign(f.qualification.resolver, { observationContexts: [f.context, f.context] });
      if (kind === "extra") f.context.observationEvidenceIds.push("unused-fact");
      if (kind === "restored-association") f.context.configuration = structuredClone(f.context.configuration);
      const adapter = f.create();
      expect(await adapter.read(f.request(), f.current())).toBeNull();
      expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
      expect(f.createRouteReader).not.toHaveBeenCalled();
    },
  );
  it("a caller's replacement cannot rewrite contexts retained by an existing adapter", async () => {
    const f = withIndependentResolverContext(),
      adapter = f.create();
    f.context.observationEvidenceIds[0] = "late-replacement";
    f.context.configuration = structuredClone(f.context.configuration);
    expect(await adapter.read(f.request(), f.current())).not.toBeNull();
  });
  it.each(["generation", "rules", "file", "selection", "os"])(
    "cannot combine independently valid contexts across changed %s",
    async (kind) => {
      const f = withIndependentResolverContext();
      // Change the anchor (not the original mapping), preserving its own association provenance.
      const anchor = mutable(f.qualification.inputs),
        loader = structuredClone(f.loader);
      if (kind === "generation") anchor.generation++;
      if (kind === "rules") anchor.rulesVersion = K;
      if (kind === "file") {
        anchor.configurationBefore.fileFingerprint = K;
        anchor.configurationAfter.fileFingerprint = K;
      }
      if (kind === "selection") Object.assign(loader, { selectionId: "another-selection" });
      if (kind === "os") {
        anchor.networkBefore.hash = K;
        anchor.networkAfter.hash = K;
      }
      const association = associateCurrentConfiguration({ inputs: anchor, loader }, 560);
      if (kind !== "rules") expect(association.valid).toBe(true);
      if (association.valid)
        Object.assign(f.qualification, { configuration: association.association, loader });
      const adapter = f.create();
      expect(await adapter.read(f.request(), f.current())).toBeNull();
      expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
    },
  );
});

describe("retained qualification address-family projection", () => {
  const expectNoPathIO = (f: ReturnType<typeof setup>) => {
    expect(f.createRouteReader).not.toHaveBeenCalled();
    expect(f.inputs.read).not.toHaveBeenCalled();
    expect(f.tls.probeTls).not.toHaveBeenCalled();
    expect(f.egress.probe).not.toHaveBeenCalled();
  };

  it.each([["ipv4"], ["ipv6"], ["ipv4", "ipv6"]] satisfies ProofTarget["addressFamily"][][])(
    "projects the reviewed family set %j without collecting a new path",
    (...families) => {
      const f = setup(families.map((family) => target("creator.example.com", family)));
      const adapter = f.create();
      const first = adapter.resolveAddressFamilies(target());
      const second = adapter.resolveAddressFamilies(target());
      expect(first).toEqual(families);
      expect(second).toEqual(families);
      expect(second).not.toBe(first);
      expect(Object.isFrozen(first)).toBe(true);
      expect(first).not.toBe(f.qualification.origins[0].possibleAddressFamilies);
      expectNoPathIO(f);
    },
  );

  it("matches each exact origin independently and does not discard known origins on a miss", () => {
    const f = setup([target(), target("creator.example.com", "ipv6")]);
    const adapter = f.create();
    expect(adapter.resolveAddressFamilies(echoTarget("ipv4"))).toEqual(["ipv4"]);
    expect(adapter.resolveAddressFamilies(echoTarget("ipv6"))).toEqual(["ipv6"]);
    expect(adapter.resolveAddressFamilies(target("not-reviewed.example.com"))).toBeNull();
    expect(adapter.resolveAddressFamilies({ ...target(), port: 8443 })).toBeNull();
    expect(adapter.resolveAddressFamilies({ ...target(), protocol: "wss:" })).toBeNull();
    expect(adapter.resolveAddressFamilies(target("CREATOR.EXAMPLE.COM."))).toBeNull();
    expect(adapter.resolveAddressFamilies(target())).toEqual(["ipv4", "ipv6"]);
    expectNoPathIO(f);
  });

  it.each(["missing", "copied", "expired"])(
    "does not project a %s qualification even when diagnostic metadata is complete",
    (kind) => {
      const f = setup();
      expect(validatePathDiagnosticMetadata(f.qualification)).toBe(true);
      const qualification =
        kind === "missing"
          ? null
          : kind === "copied"
            ? structuredClone(f.qualification)
            : { ...f.qualification, expiresAtMono: f.now() };
      expect(f.create({ qualification }).resolveAddressFamilies(target())).toBeNull();
      expectNoPathIO(f);
    },
  );

  it("does not treat reviewed family metadata as a substitute for original resolver facts", () => {
    const f = setup();
    mutable(f.qualification).resolver.observations = [];
    expect(validatePathDiagnosticMetadata(f.qualification)).toBe(true);
    expect(f.create().resolveAddressFamilies(target())).toBeNull();
    expectNoPathIO(f);
  });

  it("expires a previously projected qualification at its original deadline", () => {
    const f = setup();
    const adapter = f.create();
    expect(adapter.resolveAddressFamilies(target())).toEqual(["ipv4"]);
    f.advance(f.qualification.expiresAtMono - f.now());
    expect(adapter.resolveAddressFamilies(target())).toBeNull();
    expectNoPathIO(f);
  });

  it.each(["configuredBeforeReady", "disableQuicSwitchPresent"] as const)(
    "stops projecting when current Chromium %s ceases to hold",
    (field) => {
      const f = setup();
      const adapter = f.create();
      expect(adapter.resolveAddressFamilies(target())).toEqual(["ipv4"]);
      f.runtime[field] = false;
      expect(adapter.resolveAddressFamilies(target())).toBeNull();
      expectNoPathIO(f);
    },
  );

  it.each(["electronVersion", "profileId"] as const)(
    "does not reuse the previous projection after Chromium %s changes",
    (field) => {
      const f = setup();
      const adapter = f.create();
      expect(adapter.resolveAddressFamilies(target())).toEqual(["ipv4"]);
      f.runtime[field] = "unreviewed-runtime";
      expect(adapter.resolveAddressFamilies(target())).toBeNull();
      expectNoPathIO(f);
    },
  );

  it.each(["invalidate", "dispose"] as const)(
    "does not return the old family array when a synchronous runtime read calls %s",
    (action) => {
      const f = setup();
      let reenter = false;
      const runtimeRead = vi.fn(() => {
        if (reenter) adapter[action]();
        return f.runtime;
      });
      const adapter = f.create({ readChromiumRuntime: runtimeRead });
      expect(adapter.resolveAddressFamilies(target())).toEqual(["ipv4"]);
      reenter = true;
      expect(adapter.resolveAddressFamilies(target())).toBeNull();
      expect(runtimeRead).toHaveBeenCalledTimes(2);
      expectNoPathIO(f);
    },
  );

  it("rejects a runtime read failure and never falls back to the last projected families", () => {
    const f = setup();
    const runtimeRead = vi.fn(() => f.runtime);
    const adapter = f.create({ readChromiumRuntime: runtimeRead });
    expect(adapter.resolveAddressFamilies(target())).toEqual(["ipv4"]);
    runtimeRead.mockImplementationOnce(() => {
      throw new Error("current runtime unavailable");
    });
    expect(adapter.resolveAddressFamilies(target())).toBeNull();
    expectNoPathIO(f);
  });
});

describe("retained diagnostic metadata", () => {
  it("accepts a dual-family business path with the two fixed single-family echoes", () => {
    const f = setup([target(), target("creator.example.com", "ipv6")]);
    expect(validatePathDiagnosticMetadata(f.qualification)).toBe(true);
    expect(f.qualification.diagnosticPaths).toHaveLength(3);
    expect(f.qualification.diagnosticPaths.filter((p) => p.kind === "tls")).toHaveLength(1);
    expect(f.create().hasValidRetainedQualification()).toBe(true);
  });
  it("does not require an extra TLS or geo path for an echo-only reviewed directory", () => {
    const f = setup();
    const q = mutable(f.qualification);
    q.origins = q.origins.filter((o) => o.origin.host === "myip.ipip.net");
    q.diagnosticPaths = q.diagnosticPaths.filter((p) => p.kind === "egress");
    expect(validatePathDiagnosticMetadata(q)).toBe(true);
  });
  it.each([
    "empty",
    "too-many",
    "duplicate",
    "unknown-kind",
    "unknown-basis",
    "empty-reference",
    "duplicate-references",
    "oversize-reference",
    "foreign-origin",
    "noncanonical-origin",
    "wss-origin",
    "missing-tls",
    "missing-egress",
    "duplicate-family",
    "unknown-family",
    "family-mismatch",
    "two-family-egress",
    "wrong-echo-family",
    "missing-family-echo",
    "duplicate-origin",
    "empty-origins",
    "too-many-origins",
    "missing-constraint",
    "empty-constraint-references",
  ])("rejects %s before retaining the qualification", (kind) => {
    const f = setup(),
      q = mutable(f.qualification);
    const tls = q.diagnosticPaths.find((p) => p.kind === "tls")!;
    const egress = q.diagnosticPaths.find((p) => p.kind === "egress")!;
    const business = q.origins.find((o) => o.origin.host === tls.origin.host)!;
    const echo = q.origins.find((o) => o.origin.host === egress.origin.host)!;
    if (kind === "empty") q.diagnosticPaths = [];
    if (kind === "too-many") q.diagnosticPaths = Array.from({ length: 257 }, () => tls);
    if (kind === "duplicate") q.diagnosticPaths.push(structuredClone(tls));
    if (kind === "unknown-kind") tls.kind = "geo" as never;
    if (kind === "unknown-basis") tls.basis = "guessed" as never;
    if (kind === "empty-reference") tls.evidenceId = "";
    if (kind === "duplicate-references") tls.sourceEvidenceIds = ["same", "same"];
    if (kind === "oversize-reference") tls.sourceEvidenceIds = ["x".repeat(4097)];
    if (kind === "foreign-origin") tls.origin = { ...tls.origin, host: "not-reviewed.example.com" };
    if (kind === "noncanonical-origin") tls.origin.host = "CREATOR.EXAMPLE.COM.";
    if (kind === "wss-origin") tls.origin.protocol = "wss:";
    if (kind === "missing-tls") q.diagnosticPaths = [egress];
    if (kind === "missing-egress") q.diagnosticPaths = [tls];
    if (kind === "duplicate-family") tls.possibleAddressFamilies = ["ipv4", "ipv4"];
    if (kind === "unknown-family") tls.possibleAddressFamilies = ["unknown" as never];
    if (kind === "family-mismatch") tls.possibleAddressFamilies = ["ipv6"];
    if (kind === "two-family-egress") {
      egress.possibleAddressFamilies = ["ipv4", "ipv6"];
      echo.possibleAddressFamilies = ["ipv4", "ipv6"];
    }
    if (kind === "wrong-echo-family") {
      egress.possibleAddressFamilies = ["ipv6"];
      echo.possibleAddressFamilies = ["ipv6"];
    }
    if (kind === "missing-family-echo") {
      business.possibleAddressFamilies = ["ipv4", "ipv6"];
      tls.possibleAddressFamilies = ["ipv4", "ipv6"];
    }
    if (kind === "duplicate-origin") q.origins.push(structuredClone(business));
    if (kind === "empty-origins") q.origins = [];
    if (kind === "too-many-origins") q.origins = Array.from({ length: 129 }, () => business);
    if (kind === "missing-constraint") business.familyConstraint = null;
    if (kind === "empty-constraint-references") business.familyConstraint!.sourceEvidenceIds = [];
    expect(validatePathDiagnosticMetadata(q)).toBe(false);
    const adapter = f.create();
    expect(adapter.hasValidRetainedQualification()).toBe(false);
    expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
    expect(f.createRouteReader).not.toHaveBeenCalled();
  });
});

describe("path conformance adapter", () => {
  it("also retains reviewed real-address facts after their original source window without renewing them", async () => {
    const f = setup(),
      original = structuredClone(f.qualification.resolver);
    mutable(f.qualification).qualifiedAtMono = f.qualification.configuration.expiresAtMono + 1;
    f.advance(f.qualification.qualifiedAtMono - f.now() + 1);
    const adapter = f.create();
    expect(await f.buildSource(adapter).collect(f.request()), adapter.lastFailure() ?? "").toHaveProperty(
      "kind",
      "evidence",
    );
    expect(f.qualification.resolver).toEqual(original);
  });

  it("constructs without observing routes or sending diagnostics", () => {
    const f = setup();
    f.create();
    expect(f.createRouteReader).not.toHaveBeenCalled();
    expect(f.tls.probeTls).not.toHaveBeenCalled();
  });
  it("connects real ProductionProofSource clones through association and route verifiers", async () => {
    const f = setup(),
      adapter = f.create(),
      result = await f.buildSource(adapter).collect(f.request());
    expect(result, adapter.lastFailure() ?? "").toHaveProperty("kind", "evidence");
    if (result.kind !== "evidence") return;
    expect(
      validateDirectEvidence(
        f.scope,
        result.batch,
        {
          controllerReadable: true,
          mode: "rule",
          tun: true,
          generation: 3,
          rulesVersion: V,
          expiresAtMono: f.now() + 15000,
        },
        f.now(),
        NETWORK_TIMING,
      ).valid,
    ).toBe(true);
    expect(f.inputs.read).toHaveBeenCalledTimes(1);
    expect(f.createRouteReader).toHaveBeenCalledWith({
      addresses: ["203.0.113.10", "203.0.113.11"],
      localAddress: "192.0.2.2",
    });
    expect(f.qualification.inputs.configurationAfter.runtimeConfigurationProven).toBe(false);
  });
  it("uses both qualified families without requiring account and diagnostics to share a PID", async () => {
    const f = setup([target(), target("creator.example.com", "ipv6")]),
      adapter = f.create(),
      result = await f.buildSource(adapter).collect(f.request());
    expect(result, adapter.lastFailure() ?? "").toHaveProperty("kind", "evidence");
    expect(f.createRouteReader).toHaveBeenCalledTimes(2);
  });
  it.each(["missing", "copied", "expired"])(
    "rejects %s original qualification before route reads",
    async (kind) => {
      const f = setup();
      const q =
        kind === "missing"
          ? null
          : kind === "copied"
            ? structuredClone(f.qualification)
            : { ...f.qualification, expiresAtMono: 999 };
      const adapter = f.create({ qualification: q });
      expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
      expect(f.createRouteReader).not.toHaveBeenCalled();
    },
  );
  it.each(["configuredBeforeReady", "disableQuicSwitchPresent"] as const)(
    "rejects missing actual Chromium startup fact %s",
    async (field) => {
      const f = setup();
      f.runtime[field] = false;
      const adapter = f.create();
      expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
      expect(adapter.lastFailure()).toBe("PROTOCOL_UNQUALIFIED");
    },
  );
  it.each(["electron", "profile"])("rejects changed Chromium %s", async (field) => {
    const f = setup();
    const adapter = f.create({
      readChromiumRuntime: () => ({
        ...f.runtime,
        ...(field === "electron"
          ? { electronVersion: "44.0.0" }
          : { profileId: "unknown" as typeof CHROMIUM_TRANSPORT_PROFILE_ID }),
      }),
    });
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
  });
  it("accepts a still-current controller first read that precedes the input round", async () => {
    const f = setup();
    f.advance(20);
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.currentInputs())).not.toBeNull();
  });
  it.each(["mode", "rules", "version", "expired"])("rejects controller %s mismatch", async (field) => {
    const f = setup(),
      observed = f.currentInputs();
    if (field === "mode") f.setController({ mode: "global" });
    if (field === "rules") f.setController({ rules: [{ type: "MATCH", payload: "", proxy: "proxy" }] });
    if (field === "version") f.setController({ fingerprint: "d".repeat(64) });
    if (field === "expired") f.setController({ startedAtMono: -15000 });
    const adapter = f.create();
    expect(await adapter.read(f.request(), observed)).toBeNull();
    expect(f.createRouteReader).not.toHaveBeenCalled();
  });
  it.each(["policy", "kernel", "network", "decoder"])(
    "rejects qualification dependency change: %s",
    async (field) => {
      const f = setup(),
        i = mutable(f.currentInputs());
      if (field === "policy") {
        i.configurationBefore.policy.fingerprint = "d".repeat(64);
        i.configurationAfter.policy.fingerprint = "d".repeat(64);
      }
      if (field === "kernel") {
        i.ownerBefore.kernelEpoch = "d".repeat(64);
        i.ownerAfter.kernelEpoch = "d".repeat(64);
      }
      if (field === "network") {
        i.networkBefore.hash = "d".repeat(64);
        i.networkAfter.hash = "d".repeat(64);
      }
      if (field === "decoder") {
        i.configurationBefore.decoderIdentity = "other";
        i.configurationAfter.decoderIdentity = "other";
      }
      const adapter = f.create();
      expect(await adapter.read(f.request(), i)).toBeNull();
      expect(f.createRouteReader).not.toHaveBeenCalled();
    },
  );
  it.each(["content", "identity"] as const)(
    "does not reuse retained qualification after system hosts %s changes",
    async (field) => {
      const f = setup();
      qualifySystemHosts(f);
      const adapter = f.create(),
        initial = f.currentInputs();
      attachSystemHosts(initial);
      expect(await adapter.read(f.request(), initial), adapter.lastFailure() ?? "").not.toBeNull();
      await adapter.whenIdle();
      f.createRouteReader.mockClear();
      f.advance(20);
      const changed = f.currentInputs();
      attachSystemHosts(
        changed,
        field === "content" ? "d".repeat(64) : H,
        field === "identity" ? "e".repeat(64) : K,
      );
      if (field === "identity") {
        expect(changed.systemHostsAfter!.fileHash).toBe(f.qualification.inputs.systemHostsAfter!.fileHash);
        expect(changed.systemHostsAfter!.fileIdentity).not.toBe(
          f.qualification.inputs.systemHostsAfter!.fileIdentity,
        );
      }
      expect(await adapter.read(f.request(), changed)).toBeNull();
      expect(adapter.lastFailure()).toBe("QUALIFICATION_CHANGED");
      expect(f.createRouteReader).not.toHaveBeenCalled();
    },
  );
  it.each(["missing-to-present", "present-to-missing"] as const)(
    "does not reuse retained qualification across system hosts availability: %s",
    async (direction) => {
      const f = setup();
      if (direction === "present-to-missing") qualifySystemHosts(f);
      const current = f.currentInputs();
      if (direction === "missing-to-present") attachSystemHosts(current);
      const adapter = f.create();
      expect(await adapter.read(f.request(), current)).toBeNull();
      expect(adapter.lastFailure()).toBe("QUALIFICATION_CHANGED");
      expect(f.createRouteReader).not.toHaveBeenCalled();
    },
  );
  it("reuses the same system hosts file across scoped projections without comparing scopeHash as a dependency", async () => {
    const extra = target("second-creator.example.com"),
      f = setup([target(), extra]);
    qualifySystemHosts(f);
    const originalHosts = structuredClone(f.qualification.inputs.systemHostsAfter);
    const adapter = f.create(),
      full = f.currentInputs();
    attachSystemHosts(full);
    expect(await adapter.read(f.request(), full), adapter.lastFailure() ?? "").not.toBeNull();
    await adapter.whenIdle();
    f.createRouteReader.mockClear();
    f.advance(20);
    const request = f.request(),
      current = mutable(f.currentInputs());
    request.scope = {
      ...request.scope,
      accountId: "another-fixture-account",
      contextId: "another-runtime-account-context",
      targets: [target()],
    };
    current.targets = current.targets.filter((value) => value.host !== extra.host);
    current.dnsBefore.hosts = current.dnsBefore.hosts.filter((value) => value.host !== extra.host);
    current.dnsAfter.hosts = current.dnsAfter.hosts.filter((value) => value.host !== extra.host);
    const currentAddresses = new Set(
      current.dnsAfter.hosts.flatMap((value) => value.addresses.map((address) => address.address)),
    );
    for (const batch of current.routeBatches)
      batch.selections = batch.selections.filter((value) => currentAddresses.has(value.targetAddress));
    attachSystemHosts(current);
    expect(current.systemHostsAfter!.fileHash).toBe(originalHosts!.fileHash);
    expect(current.systemHostsAfter!.fileIdentity).toBe(originalHosts!.fileIdentity);
    expect(current.systemHostsAfter!.scopeHash).not.toBe(originalHosts!.scopeHash);
    expect(await adapter.read(request, current), adapter.lastFailure() ?? "").not.toBeNull();
    expect(f.createRouteReader).toHaveBeenCalledTimes(1);
    expect(f.qualification.inputs.systemHostsAfter).toEqual(originalHosts);
  });
  it("rechecks changed rules/file/generation without rewriting original route samples or acquiring sockets", async () => {
    const f = setup(),
      original = structuredClone(f.qualification.routes),
      adapter = f.create();
    f.version.generation++;
    f.version.rulesVersion = "d".repeat(64);
    f.setController({
      fingerprint: f.version.rulesVersion,
      rules: [...f.currentController().rules, { type: "MATCH", payload: "", proxy: "other" }],
    });
    const i = mutable(f.currentInputs());
    for (const c of [i.configurationBefore, i.configurationAfter]) {
      c.controllerFingerprint = f.version.rulesVersion;
      c.fileFingerprint = "e".repeat(64);
      c.sourceGeneration++;
    }
    i.dnsBefore.controllerVersionBefore.controllerVersion = f.version.rulesVersion;
    i.dnsBefore.controllerVersionAfter.controllerVersion = f.version.rulesVersion;
    i.dnsAfter.controllerVersionBefore.controllerVersion = f.version.rulesVersion;
    i.dnsAfter.controllerVersionAfter.controllerVersion = f.version.rulesVersion;
    const result = await adapter.read(f.request(), i);
    expect(result, adapter.lastFailure() ?? "").not.toBeNull();
    expect(result!.routes[0].binding.generation).toBe(4);
    expect(result!.routes[0].samples).toEqual(original[0].samples);
    expect(result!.routes[0].observedAtMono).toBe(original[0].observedAtMono);
    expect(f.qualification.routes).toEqual(original);
  });
  it.each(["unknown", "fake-ip"] as const)("does not invent current %s DNS mapping", async (addressClass) => {
    const f = setup(),
      i = mutable(f.currentInputs());
    i.dnsAfter.hosts[0].addresses[0].addressClass = addressClass;
    const adapter = f.create();
    expect(await adapter.read(f.request(), i)).toBeNull();
    expect(adapter.lastFailure()).toBe("DNS_UNVERIFIED");
  });
  it("ignores an unrelated missing family only with retained single-family qualification", async () => {
    const f = setup(),
      i = f.currentInputs();
    expect(i.dnsAfter.hosts[0].status).toBe("unverified");
    expect(await f.create().read(f.request(), i)).not.toBeNull();
  });
  it("rejects single-family scope with missing constraint sources", async () => {
    const f = setup();
    mutable(f.qualification).origins[0].familyConstraint = null;
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
  });
  it("rejects a route lookup returning TUN as the physical projection", async () => {
    const f = setup();
    f.createRouteReader.mockImplementation((scope) => ({
      read: async () => ({
        available: true,
        basis: "windows-source-route-query",
        localAddress: scope.localAddress!,
        socketObserved: false,
        startedAtMono: f.now(),
        completedAtMono: f.now(),
        scopeHash: H,
        selectionHash: H,
        selections: scope.addresses.map((a) => ({
          ...route(a),
          hardwareInterface: false,
          interfaceIndex: 59,
        })),
      }),
      dispose() {},
      async whenIdle() {},
    }));
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.currentInputs(true))).toBeNull();
    expect(adapter.lastFailure()).toBe("ROUTE_CLASS_MISMATCH");
  });
  it("rejects a specific target route selecting a different next hop", async () => {
    const f = setup();
    f.createRouteReader.mockImplementation((scope) => ({
      read: async () => ({
        available: true,
        basis: "windows-source-route-query",
        localAddress: scope.localAddress!,
        socketObserved: false,
        startedAtMono: f.now(),
        completedAtMono: f.now(),
        scopeHash: H,
        selectionHash: H,
        selections: scope.addresses.map((a, n) => ({
          ...route(a),
          nextHop: n === 0 ? "192.0.2.99" : route(a).nextHop,
        })),
      }),
      dispose() {},
      async whenIdle() {},
    }));
    expect(await f.create().read(f.request(), f.currentInputs(true))).toBeNull();
  });
  it("keeps source and Session DNS observations distinct; resolver mismatch is rejected", async () => {
    const f = setup();
    mutable(f.qualification).resolver.observations[0].transportAddresses = ["203.0.113.99"];
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
    expect(f.createRouteReader).not.toHaveBeenCalled();
  });
  const setupResolverSubset = () => {
    const extraAddress = "203.0.113.99";
    const f = setup([target()], [], (inputs) => {
      for (const dns of [mutable(inputs).dnsBefore, mutable(inputs).dnsAfter]) {
        const host = dns.hosts.find((value) => value.host === target().host)!;
        host.ipv4.push(extraAddress);
        host.addresses.push({ address: extraAddress, addressFamily: "ipv4", addressClass: "real" });
        host.answers.push({ ...host.answers[0], data: extraAddress });
        const answer = host.queries[0].response!.answers[0];
        host.queries[0].response!.answers.push({ ...answer, data: extraAddress });
      }
      mutable(inputs).routeBatches[0].selections.push(route(extraAddress));
    });
    const observation = mutable(f.qualification).resolver.observations[0];
    observation.transportAddresses = [observation.kernelAddresses[0]];
    return { ...f, extraAddress, observation };
  };
  it("accepts an observed real transport subset while checking every current kernel candidate", async () => {
    const f = setupResolverSubset(),
      adapter = f.create(),
      result = await f.buildSource(adapter).collect(f.request());
    expect(f.observation.kernelAddresses).toEqual(["203.0.113.10", f.extraAddress]);
    expect(f.observation.transportAddresses).toEqual(["203.0.113.10"]);
    expect(result, adapter.lastFailure() ?? "").toHaveProperty("kind", "evidence");
    expect(f.createRouteReader).toHaveBeenCalledWith({
      addresses: ["203.0.113.10", "203.0.113.11", f.extraAddress],
      localAddress: "192.0.2.2",
    });
  });
  it("rejects an unselected kernel candidate whose physical route is outside the reviewed class", async () => {
    const f = setupResolverSubset(),
      original = f.createRouteReader.getMockImplementation()!;
    f.createRouteReader.mockImplementation((scope) => {
      const reader = original(scope),
        read = reader.read;
      return {
        ...reader,
        read: async (signal) => {
          const result = mutable(await read(signal));
          if (result.available)
            result.selections.find((value) => value.targetAddress === f.extraAddress)!.nextHop = "192.0.2.99";
          return result;
        },
      };
    });
    const adapter = f.create(),
      result = await f.buildSource(adapter).collect(f.request());
    expect(result.kind).toBe("unavailable");
    expect(f.createRouteReader).toHaveBeenCalledWith(
      expect.objectContaining({ addresses: expect.arrayContaining([f.extraAddress]) }),
    );
    expect(adapter.lastFailure()).toBe("ROUTE_CLASS_MISMATCH");
    expect(f.tls.probeTls).not.toHaveBeenCalled();
    expect(f.egress.probe).not.toHaveBeenCalled();
  });
  it.each([
    ["empty transport", ["203.0.113.10"], []],
    ["uncovered transport", ["203.0.113.10"], ["203.0.113.99"]],
    ["wrong transport family", ["203.0.113.10"], ["2001:db8::10"]],
    ["duplicate transport", ["203.0.113.10"], ["203.0.113.10", "203.0.113.10"]],
    ["empty kernel", [], ["203.0.113.10"]],
    ["wrong kernel family", ["203.0.113.10", "2001:db8::10"], ["203.0.113.10"]],
    ["invalid kernel address", ["203.0.113.10", "not-an-address"], ["203.0.113.10"]],
    ["duplicate kernel", ["203.0.113.10", "203.0.113.10"], ["203.0.113.10"]],
  ] as const)("rejects real resolver %s before sampling", async (_, kernelAddresses, transportAddresses) => {
    const f = setup();
    Object.assign(mutable(f.qualification).resolver.observations[0], {
      kernelAddresses: [...kernelAddresses],
      transportAddresses: [...transportAddresses],
    });
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
    expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
    expect(f.createRouteReader).not.toHaveBeenCalled();
  });
  it("binds full copied records and rejects modified conformance metadata", async () => {
    const f = setup(),
      adapter = f.create(),
      r = f.request(),
      i = f.currentInputs(true),
      conformance = await adapter.read(r, i);
    expect(conformance).not.toBeNull();
    const binding = f.bindInput(r, i, conformance!);
    expect(await adapter.bindSamples(binding)).not.toBeNull();
    binding.conformance.transport.evidenceId = "rewritten";
    expect(await adapter.bindSamples(binding)).toBeNull();
  });
  it("rejects a copied route brand even when all fields match", async () => {
    const f = setup(),
      adapter = f.create(),
      r = f.request(),
      i = f.currentInputs(),
      c = await adapter.read(r, i),
      b = f.bindInput(r, i, c!);
    b.routes = structuredClone(b.routes);
    expect(await adapter.bindSamples(b)).toBeNull();
  });
  it("rejects changed request context and target on bind", async () => {
    const f = setup(),
      adapter = f.create(),
      r = f.request(),
      i = f.currentInputs(),
      c = await adapter.read(r, i),
      b = f.bindInput(r, i, c!);
    b.request = { ...b.request, scope: { ...b.request.scope, contextId: "different-runtime-context" } };
    expect(await adapter.bindSamples(b)).toBeNull();
  });
  it("rejects an unconstrained echo family before sending diagnostics, rather than inferring it from response text", async () => {
    const f = setup();
    mutable(f.qualification).diagnosticPaths.find((v) => v.kind === "egress")!.possibleAddressFamilies = [
      "ipv4",
      "ipv6",
    ];
    const adapter = f.create(),
      result = await f.buildSource(adapter).collect(f.request());
    expect(result).toHaveProperty("kind", "unavailable");
    // The same fixed echo contract is now checked before sampling and qualification publication.
    expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
    expect(f.tls.probeTls).not.toHaveBeenCalled();
    expect(f.egress.probe).not.toHaveBeenCalled();
  });
  it("preserves cached egress observation original path and sample dates across fresh rounds", async () => {
    const f = setup(),
      adapter = f.create(),
      binder = vi.spyOn(adapter, "bindSamples"),
      source = f.buildSource(adapter);
    expect(await source.collect(f.request())).toHaveProperty("kind", "evidence");
    await flush();
    f.advance(1000);
    expect(await source.collect(f.request())).toHaveProperty("kind", "evidence");
    expect(f.egress.probe).toHaveBeenCalledTimes(1);
    const first = await binder.mock.results[0].value,
      second = await binder.mock.results[1].value;
    expect(first![0].inputSampleId).not.toBe(second![0].inputSampleId);
    const firstEcho = first!.find((v) => v.factoryId === ANONYMOUS_EGRESS_FACTORY_ID)!,
      secondEcho = second!.find((v) => v.factoryId === ANONYMOUS_EGRESS_FACTORY_ID)!;
    expect(secondEcho.originalPath).toEqual(firstEcho.originalPath);
    expect(secondEcho.originalStartedAtMono).toBe(firstEcho.originalStartedAtMono);
    expect(secondEcho.checkedAtMono).toBeGreaterThan(firstEcho.checkedAtMono);
  });
  it("snapshot-isolates caller inputs/scope and the selected qualification during awaits", async () => {
    const f = setup(),
      wait = deferred<WindowsRouteSelectionSnapshot>();
    f.createRouteReader.mockImplementation(() => ({
      read: () => wait.promise,
      dispose() {},
      async whenIdle() {},
    }));
    const adapter = f.create(),
      r = f.request(),
      i = mutable(f.currentInputs()),
      original = structuredClone(i);
    const pending = adapter.read(r, i);
    mutable(r.scope).targets[0].host = "rewritten.example.com";
    i.configurationAfter.policy.fingerprint = "e".repeat(64);
    mutable(f.qualification).transport.accountProfileId = "changed-after-selection";
    wait.resolve({
      available: true,
      basis: "windows-source-route-query",
      localAddress: "192.0.2.2",
      socketObserved: false,
      startedAtMono: f.now(),
      completedAtMono: f.now(),
      scopeHash: H,
      selectionHash: H,
      selections: original.routeBatches[0].selections,
    });
    const result = await pending;
    expect(result).not.toBeNull();
    expect(result!.families[0].origin.host).toBe("creator.example.com");
    expect(result!.transport.accountProfileId).toBe("account-chromium");
  });
  it("retains the real reader slot after public cancellation until whenIdle settles", async () => {
    const f = setup(),
      idle = deferred<void>();
    f.createRouteReader.mockImplementation((scope) => ({
      read: async () => ({
        available: true,
        basis: "windows-source-route-query",
        localAddress: scope.localAddress!,
        socketObserved: false,
        startedAtMono: f.now(),
        completedAtMono: f.now(),
        scopeHash: H,
        selectionHash: H,
        selections: scope.addresses.map(route),
      }),
      dispose() {},
      whenIdle: () => idle.promise,
    }));
    const adapter = f.create(),
      abort = new AbortController(),
      r = { ...f.request(), signal: abort.signal },
      i = f.currentInputs();
    const first = adapter.read(r, i);
    await flush();
    abort.abort();
    expect(await first).toBeNull();
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
    expect(adapter.lastFailure()).toBe("READ_BUSY");
    expect(f.createRouteReader).toHaveBeenCalledTimes(1);
    const settled = vi.fn();
    const drained = adapter.whenIdle().then(settled);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    idle.resolve();
    await drained;
    expect(settled).toHaveBeenCalledOnce();
    expect(await adapter.read(f.request(), f.currentInputs())).not.toBeNull();
  });
  it("coalesces same-key reads and cancellation from a joined caller cancels the batch", async () => {
    const f = setup(),
      wait = deferred<WindowsRouteSelectionSnapshot>();
    f.createRouteReader.mockImplementation(() => ({
      read: () => wait.promise,
      dispose() {},
      async whenIdle() {},
    }));
    const adapter = f.create(),
      r = f.request(),
      i = f.currentInputs(),
      abort = new AbortController();
    const first = adapter.read(r, i),
      second = adapter.read({ ...r, signal: abort.signal }, structuredClone(i));
    expect(first).toBe(second);
    abort.abort();
    expect(await first).toBeNull();
    expect(f.createRouteReader).toHaveBeenCalledTimes(1);
    wait.resolve({
      available: false,
      reason: "READ_CANCELLED",
      startedAtMono: f.now(),
      completedAtMono: f.now(),
    });
    await flush();
  });
  it("rejects a late route result after version change", async () => {
    const f = setup(),
      wait = deferred<WindowsRouteSelectionSnapshot>();
    f.createRouteReader.mockImplementation(() => ({
      read: () => wait.promise,
      dispose() {},
      async whenIdle() {},
    }));
    const adapter = f.create(),
      pending = adapter.read(f.request(), f.currentInputs());
    f.version.generation++;
    wait.resolve({
      available: true,
      basis: "windows-source-route-query",
      localAddress: "192.0.2.2",
      socketObserved: false,
      startedAtMono: f.now(),
      completedAtMono: f.now(),
      scopeHash: H,
      selectionHash: H,
      selections: [route("203.0.113.10"), route("203.0.113.11")],
    });
    expect(await pending).toBeNull();
    expect(adapter.lastFailure()).toBe("NETWORK_CHANGED");
  });
  it.each(["osNetworkHash", "fileFingerprint", "rulesVersion", "generation", "sourceGeneration"] as const)(
    "rejects mismatched original route binding %s before replacing it",
    async (key) => {
      const f = setup(),
        binding = mutable(f.qualification).routes[0].binding;
      if (key === "generation" || key === "sourceGeneration") binding[key]++;
      else binding[key] = "e".repeat(64);
      const adapter = f.create();
      expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
      expect(adapter.lastFailure()).toBe("QUALIFICATION_INVALID");
      expect(f.createRouteReader).not.toHaveBeenCalled();
    },
  );
  it("accepts real sourceGeneration zero without mutating the original producer value", async () => {
    const f = setup(),
      q = mutable(f.qualification);
    for (const c of [q.inputs.configurationBefore, q.inputs.configurationAfter]) c.sourceGeneration = 0;
    for (const route of q.routes) route.binding.sourceGeneration = 0;
    const associated = associateCurrentConfiguration({ inputs: q.inputs, loader: q.loader }, 510);
    if (!associated.valid) throw new Error(associated.reason);
    q.configuration = associated.association;
    const adapter = f.create(),
      inputs = mutable(f.currentInputs());
    for (const c of [inputs.configurationBefore, inputs.configurationAfter]) c.sourceGeneration = 0;
    const result = await adapter.read(f.request(), inputs);
    expect(result).not.toBeNull();
    expect(result!.routes[0].binding.sourceGeneration).toBe(0);
  });
  it("does not extend an expired original route artifact", async () => {
    const f = setup();
    mutable(f.qualification).routes[0].expiresAtMono = 999;
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
  });
  it("rejects resolver profile names without observation or explicit equivalence coverage", async () => {
    const f = setup();
    mutable(f.qualification).resolver.profileEquivalences = [];
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
    expect(f.createRouteReader).not.toHaveBeenCalled();
  });
  it("rejects resolver equivalence referencing another profile's observation", async () => {
    const f = setup();
    mutable(f.qualification).resolver.profileEquivalences![0].fromProfileId = "anonymous-tls";
    expect(await f.create().read(f.request(), f.currentInputs())).toBeNull();
  });
  it("rejects resolver equivalence that omits a possible address family", async () => {
    const f = setup([target(), target("creator.example.com", "ipv6")]);
    mutable(f.qualification).resolver.profileEquivalences![0].addressFamilies = ["ipv4"];
    expect(await f.create().read(f.request(), f.currentInputs())).toBeNull();
  });
  it("accepts direct original resolver observations for each profile without equivalence declarations", async () => {
    const f = setup(),
      resolver = mutable(f.qualification).resolver;
    const original = structuredClone(resolver.observations);
    resolver.profileEquivalences = [];
    for (const profile of ["account-chromium", "anonymous-tls"])
      for (const observed of original)
        resolver.observations.push({
          ...observed,
          evidenceId: `${profile}:${observed.evidenceId}`,
          transportProfileId: profile,
        });
    expect(await f.create().read(f.request(), f.currentInputs())).not.toBeNull();
  });
  it("batches source-conditioned queries at sixteen destinations without repeating PathInputReader", async () => {
    const f = setup(Array.from({ length: 18 }, (_, index) => target(`creator${index}.example.com`))),
      adapter = f.create();
    expect(await adapter.read(f.request(), f.currentInputs(true))).not.toBeNull();
    expect(f.createRouteReader.mock.calls.map(([scope]) => scope.addresses.length)).toEqual([16, 3]);
    expect(f.inputs.read).not.toHaveBeenCalled();
  });
  it("snapshots a returned route result before awaiting reader drain", async () => {
    const f = setup(),
      idle = deferred<void>(),
      selections = [route("203.0.113.10"), route("203.0.113.11")];
    f.createRouteReader.mockImplementation(() => ({
      read: async () => ({
        available: true,
        basis: "windows-source-route-query",
        localAddress: "192.0.2.2",
        socketObserved: false,
        startedAtMono: f.now(),
        completedAtMono: f.now(),
        scopeHash: H,
        selectionHash: H,
        selections,
      }),
      dispose() {},
      whenIdle: () => idle.promise,
    }));
    const adapter = f.create(),
      pending = adapter.read(f.request(), f.currentInputs(true));
    await flush();
    mutable(selections)[0].hardwareInterface = false;
    idle.resolve();
    expect(await pending).not.toBeNull();
  });
  it("does not allow a second real read after a timeout until the ignored-abort work drains", async () => {
    const f = setup(),
      wait = deferred<WindowsRouteSelectionSnapshot>();
    f.createRouteReader.mockImplementation(() => ({
      read: () => wait.promise,
      dispose() {},
      async whenIdle() {},
    }));
    const adapter = f.create({ timeoutMs: 5 });
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
    expect(adapter.lastFailure()).toBe("READ_BUSY");
    wait.resolve({
      available: false,
      reason: "READ_TIMEOUT",
      startedAtMono: f.now(),
      completedAtMono: f.now(),
    });
    await flush();
    expect(f.createRouteReader).toHaveBeenCalledTimes(1);
  });
  it("rejects reentrant invalidation inside the final readVersion getter without restoring cleared paths", async () => {
    const f = setup();
    let trigger = false,
      reads = 0;
    const adapter = f.create({
      readVersion: () => {
        if (trigger && ++reads === 2) adapter.invalidate();
        return f.version;
      },
    });
    const r = f.request(),
      i = f.currentInputs(),
      c = await adapter.read(r, i),
      b = f.bindInput(r, i, c!);
    trigger = true;
    expect(await adapter.bindSamples(b)).toBeNull();
    expect(adapter.lastFailure()).toBe("CANCELLED");
    trigger = false;
    expect(await adapter.bindSamples(b)).toBeNull();
  });
  it("rejects a route snapshot sampled before its actual invocation", async () => {
    const f = setup();
    f.createRouteReader.mockImplementation((scope) => ({
      read: async () => ({
        available: true,
        basis: "windows-source-route-query",
        localAddress: scope.localAddress!,
        socketObserved: false,
        startedAtMono: f.now() - 1,
        completedAtMono: f.now(),
        scopeHash: H,
        selectionHash: H,
        selections: scope.addresses.map(route),
      }),
      dispose() {},
      async whenIdle() {},
    }));
    const adapter = f.create();
    expect(await adapter.read(f.request(), f.currentInputs())).toBeNull();
    expect(adapter.lastFailure()).toBe("ROUTE_UNAVAILABLE");
  });
  it("stays unavailable when the current inputs expire during route reads", async () => {
    const f = setup(),
      wait = deferred<WindowsRouteSelectionSnapshot>();
    f.createRouteReader.mockImplementation(() => ({
      read: () => wait.promise,
      dispose() {},
      async whenIdle() {},
    }));
    const adapter = f.create(),
      pending = adapter.read(f.request(), f.currentInputs());
    f.advance(15001);
    wait.resolve({
      available: true,
      basis: "windows-source-route-query",
      localAddress: "192.0.2.2",
      socketObserved: false,
      startedAtMono: 1000,
      completedAtMono: 1001,
      scopeHash: H,
      selectionHash: H,
      selections: [route("203.0.113.10"), route("203.0.113.11")],
    });
    expect(await pending).toBeNull();
  });
});
