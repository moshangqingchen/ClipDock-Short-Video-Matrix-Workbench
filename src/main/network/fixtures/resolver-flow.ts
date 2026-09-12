import { createHash } from "node:crypto";
import type { ResolverFlowMappingInput } from "../resolver-flow-mapping";
import {
  associateCurrentConfiguration,
  type KnownSelectedLoaderContract,
} from "../configuration-association";
import { parseAnonymousRequestSocket } from "../anonymous-request-socket";
import { projectSourcePolicyDetails } from "../source-policy-details";
import type { CurrentPathInputs } from "../path-input-reader";
import type { EffectiveConfigCandidate } from "../effective-config-source";
import type { KernelDnsCandidates } from "../kernel-dns";

export const H = "b".repeat(64),
  V = "a".repeat(64),
  K = "c".repeat(64);
export const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };
export const mutable = <T>(v: T) => v as Mutable<T>;
export const target = {
  protocol: "https:" as const,
  host: "api.bilibili.com",
  port: 443,
  addressFamily: "ipv4" as const,
};
const missing = { present: false } as const;
export function candidate(at: number): EffectiveConfigCandidate {
  return {
    kind: "local-config-candidate",
    runtimeConfigurationProven: false,
    sourceGeneration: 0,
    sourcePathIdentity: H,
    fileFingerprint: H,
    decoderIdentity: "synthetic-yaml",
    controllerFingerprint: V,
    orderedRulesFingerprint: H,
    sourceRuleOptionsFingerprint: H,
    comparedConfigFields: ["mode"],
    comparedRuleCount: 1,
    rules: [{ type: "Domain", payload: target.host, proxy: "DIRECT" }],
    startedAtMono: at,
    completedAtMono: at,
    expiresAtMono: 15100,
    controllerStartedAtMono: at,
    controllerCompletedAtMono: at,
    policy: {
      fingerprint: H,
      dns: { present: true, kind: "object", fingerprint: H },
      hosts: missing,
      sniffer: missing,
      tun: missing,
      ipv6: missing,
      dnsFlags: {
        enable: { present: true, value: true },
        ipv6: missing,
        "use-hosts": missing,
        "use-system-hosts": missing,
        "respect-rules": missing,
      },
      dnsMode: { present: true, value: "fake-ip" },
      snifferFlags: {
        enable: missing,
        "force-dns-mapping": missing,
        "override-destination": missing,
        "parse-pure-ip": missing,
      },
      tunEnabled: missing,
      directOutbounds: { count: 0, fingerprint: H, builtinNameConfigured: false, entries: [] },
      details: projectSourcePolicyDetails({ dns: { "fake-ip-range": "198.18.0.1/16" } }),
    },
    currentDirectPolicy: {
      kind: "direct",
      dialer: "none",
      interfaceName: null,
      ipVersion: null,
      policyFingerprint: H,
      startedAtMono: at,
      completedAtMono: at,
    },
  };
}
export function dns(at: number): KernelDnsCandidates {
  const addresses = ["223.5.5.5", "223.6.6.6"];
  const answers = addresses.map((data) => ({
    queryType: "A" as const,
    name: target.host,
    type: 1 as const,
    ttl: 1,
    data,
    observedAtMono: at,
    expiresAtMono: at + 1000,
  }));
  const response = {
    host: target.host,
    queryType: "A" as const,
    status: 0,
    truncated: false,
    question: { name: target.host, type: 1 },
    answers: answers.map(({ name, type, ttl, data }) => ({ name, type, ttl, data })),
    startedAtMono: at,
    completedAtMono: at + 2,
  };
  return {
    available: true,
    kind: "kernel-dns-candidates",
    chromiumResolutionProven: false,
    status: "unverified",
    controllerVersionBefore: { controllerVersion: V, startedAtMono: at, completedAtMono: at },
    controllerVersionAfter: { controllerVersion: V, startedAtMono: at + 3, completedAtMono: at + 3 },
    startedAtMono: at,
    completedAtMono: at + 3,
    expiresAtMono: at + 1000,
    ttlCapAtMono: at + 15000,
    hosts: [
      {
        host: target.host,
        status: "unverified",
        reasons: ["FAMILY_MISSING"],
        ipv4: addresses,
        ipv6: [],
        addresses: addresses.map((address) => ({ address, addressFamily: "ipv4", addressClass: "real" })),
        queries: [{ type: "A", startedAtMono: at, completedAtMono: at + 2, response, error: null }],
        answers,
        startedAtMono: at,
        completedAtMono: at + 2,
        expiresAtMono: at + 1000,
      },
    ],
  };
}
export function socketNetLog(): string {
  return JSON.stringify({
    constants: {
      logEventTypes: { URL_REQUEST_START_JOB: 1, HTTP_STREAM_JOB_BOUND_TO_REQUEST: 2, TCP_CONNECT: 3 },
      logSourceType: { URL_REQUEST: 1, HTTP_STREAM_JOB: 2, SOCKET: 3 },
    },
    events: [
      {
        source: { id: 10, type: 1 },
        type: 1,
        time: "1000",
        params: { url: `https://${target.host}/robots.txt` },
      },
      { source: { id: 10, type: 1 }, type: 2, time: "1001", params: { source_dependency: { id: 20 } } },
      {
        source: { id: 20, type: 3 },
        type: 3,
        time: "1002",
        params: { source_address: "10.0.0.2:50000", address: "198.18.0.2:443" },
      },
    ],
  });
}

export function fixture(): ResolverFlowMappingInput {
  const loader: KnownSelectedLoaderContract = {
    source: "main-process-selected-loader-contract",
    selectionId: "selected",
    loaderProfileId: "known-client",
    sourcePathIdentity: H,
    decoderIdentity: "synthetic-yaml",
    qualificationEvidenceIds: ["retained-loader-review"],
    selectedAtMono: 0,
  };
  const kernelOwner = (at: number) => ({
    available: true as const,
    basis: "windows-controller-listener" as const,
    kernelEpoch: K,
    scopeHash: H,
    owner: { pid: 901, createdAtTicks: "639244035457234678", executablePathIdentity: H },
    listeners: [
      { address: "127.0.0.1", addressFamily: "ipv4" as const, port: 9790, coverage: "exact" as const },
    ],
    startedAtMono: at,
    completedAtMono: at,
  });
  const hosts = (at: number) => ({
    available: true as const,
    kind: "windows-system-hosts-targets" as const,
    source: "windows-system-hosts-file" as const,
    resolutionProven: false as const,
    parserProfile: "windows-hosts-ascii-aliases-v1" as const,
    fileHash: H,
    fileIdentity: K,
    scopeHash: hash([target.host]),
    hosts: [{ host: target.host, ipv4: [], ipv6: [] }],
    startedAtMono: at,
    completedAtMono: at,
  });
  const inputs: CurrentPathInputs = {
    state: "observed",
    kind: "current-path-inputs",
    sampleId: "original-round",
    generation: 1,
    rulesVersion: V,
    targets: [structuredClone(target)],
    startedAtMono: 100,
    completedAtMono: 130,
    expiresAtMono: 1100,
    configurationBefore: candidate(100),
    configurationAfter: candidate(130),
    ownerBefore: kernelOwner(100),
    ownerAfter: kernelOwner(130),
    networkBefore: { hash: H, startedAtMono: 100, completedAtMono: 100 },
    networkAfter: { hash: H, startedAtMono: 130, completedAtMono: 130 },
    systemHostsBefore: hosts(100),
    systemHostsAfter: hosts(130),
    dnsBefore: dns(110),
    dnsAfter: dns(126),
    routeBatches: [],
  };
  const associated = associateCurrentConfiguration({ inputs, loader }, 131);
  if (!associated.valid) throw new Error(associated.reason);
  const parsed = parseAnonymousRequestSocket(socketNetLog(), target);
  if (!parsed.available) throw new Error(parsed.reason);
  const appOwner = { pid: 902, createdAtTicks: "639244035457234679", executablePathIdentity: K };
  return {
    target: structuredClone(target),
    transportProfileId: "anonymous-tls",
    factoryId: "clipdock-anonymous-tls-v1",
    transportContextId: "actual-private-session-context",
    inputs,
    loader,
    configuration: associated.association,
    requestSocket: parsed.observation,
    appOwner,
    appTcp: {
      available: true,
      startedAtMono: 170,
      completedAtMono: 180,
      scopeHash: H,
      owners: [structuredClone(appOwner)],
      sockets: [{ ...parsed.observation.tuple, ownerPid: appOwner.pid, state: "Established" }],
    },
    incomingBefore: { startedAtMono: 132, completedAtMono: 135, connections: [] },
    incomingAfter: {
      startedAtMono: 170,
      completedAtMono: 180,
      connections: [
        {
          id: "own-new-connection",
          host: target.host,
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
    kernelDns: dns(136),
    window: { sendAtMono: 140, headersAtMono: 160, sendAtWallMs: 1000, headersAtWallMs: 1020 },
  };
}
