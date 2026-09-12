import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { AnonymousRequestSocketObservation } from "./anonymous-request-socket";
import {
  validateConfigurationAssociation,
  validateConfigurationAssociationForFreshDns,
  type CurrentConfigurationAssociation,
  type KnownSelectedLoaderContract,
} from "./configuration-association";
import { normalizeProofTarget, proofTargetKey, type ProofTarget } from "./direct-proof";
import type { CurrentPathInputs } from "./path-input-reader";
import type { KernelDnsCandidates, KernelDnsHostCandidate } from "./kernel-dns";
import type { KernelConnectionObservation, KernelConnectionsSnapshot } from "./connection-evidence";
import type {
  WindowsTcpOwnerIdentity,
  WindowsTcpSocketRow,
  WindowsTcpSocketSnapshot,
} from "./windows-tcp-sockets";
import { classifyCurrentKernelDnsAddress } from "./kernel-dns-address-policy";

/** The actual factory clocks are separate from NetLog's unconverted clock strings. */
export interface ResolverRequestWindow {
  readonly sendAtMono: number;
  readonly headersAtMono: number;
  readonly sendAtWallMs: number;
  readonly headersAtWallMs: number;
}
export interface ResolverFlowMappingInput {
  readonly target: ProofTarget;
  readonly transportProfileId: string;
  readonly factoryId: string;
  readonly transportContextId: string;
  readonly inputs: CurrentPathInputs;
  readonly loader: KnownSelectedLoaderContract;
  /** Actual original association object, not one restored from JSON. */
  readonly configuration: CurrentConfigurationAssociation;
  readonly requestSocket: AnonymousRequestSocketObservation;
  /** Independently read identity of the isolated factory's Network Service process. */
  readonly appOwner: WindowsTcpOwnerIdentity;
  readonly appTcp: WindowsTcpSocketSnapshot;
  readonly incomingBefore: KernelConnectionsSnapshot;
  readonly incomingAfter: KernelConnectionsSnapshot;
  readonly kernelDns: KernelDnsCandidates;
  readonly window: ResolverRequestWindow;
}
export interface ResolverFlowMappingObservation {
  readonly kind: "fake-ip-kernel-destination";
  readonly evidenceId: string;
  readonly target: ProofTarget;
  readonly transportProfileId: string;
  readonly factoryId: string;
  readonly transportContextId: string;
  readonly inputSampleId: string;
  readonly configurationEvidenceId: string;
  readonly kernelAddresses: readonly string[];
  /** The actual app socket destination, not a separate resolveHost result. */
  readonly transportAddresses: readonly string[];
  readonly requestSocket: AnonymousRequestSocketObservation;
  readonly appOwner: WindowsTcpOwnerIdentity;
  readonly appSocket: WindowsTcpSocketRow;
  readonly incoming: KernelConnectionObservation;
  readonly kernelDnsEvidenceId: string;
  readonly kernelDnsExpiresAtMono: number;
  readonly window: ResolverRequestWindow;
  readonly startedAtMono: number;
  readonly observedAtMono: number;
  /** Postflight may finish after DNS expiry; this does not refresh the DNS observation. */
  readonly completedAtMono: number;
  readonly checkedAtMono: number;
  readonly physicalSocketProven: false;
}
export type ResolverFlowMappingFailure =
  | "INPUT_INVALID"
  | "CONFIGURATION_UNVERIFIED"
  | "CONTEXT_UNVERIFIED"
  | "SOCKET_UNVERIFIED"
  | "INCOMING_UNVERIFIED"
  | "DNS_UNVERIFIED"
  | "TIME_UNVERIFIED";
export type ResolverFlowMappingResult =
  | Readonly<{ valid: true; observation: ResolverFlowMappingObservation }>
  | Readonly<{ valid: false; reason: ResolverFlowMappingFailure }>;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\r\n\0]/.test(v);
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v > 0 && v <= max;
const windowValid = (start: number, end: number, floor: number, ceiling: number) =>
  [start, end, floor, ceiling].every(Number.isFinite) &&
  floor >= 0 &&
  floor <= start &&
  start <= end &&
  end <= ceiling;
const refs = (v: readonly unknown[], max: number) => Array.isArray(v) && v.length > 0 && v.length <= max;
const ownersMatch = (a: WindowsTcpOwnerIdentity, b: WindowsTcpOwnerIdentity) =>
  a.pid === b.pid &&
  a.createdAtTicks === b.createdAtTicks &&
  a.executablePathIdentity === b.executablePathIdentity;
const ownerValid = (v: WindowsTcpOwnerIdentity) =>
  integer(v.pid, 0xffff_ffff) && /^[1-9]\d{15,18}$/.test(v.createdAtTicks) && sha(v.executablePathIdentity);
function ip(value: string): string | null {
  if (typeof value !== "string" || value.length > 64 || value.includes("%")) return null;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  return canonical.startsWith("::ffff:") ? null : canonical;
}
function tupleMatches(
  a: AnonymousRequestSocketObservation["tuple"],
  b: AnonymousRequestSocketObservation["tuple"],
): boolean {
  return (
    ip(a.sourceAddress) !== null &&
    ip(a.remoteAddress) !== null &&
    integer(a.sourcePort, 65535) &&
    integer(a.remotePort, 65535) &&
    ip(a.sourceAddress) === ip(b.sourceAddress) &&
    a.sourcePort === b.sourcePort &&
    ip(a.remoteAddress) === ip(b.remoteAddress) &&
    a.remotePort === b.remotePort
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
class MappingError extends Error {
  constructor(readonly reason: ResolverFlowMappingFailure) {
    super(reason);
  }
}
function fail(reason: ResolverFlowMappingFailure): never {
  throw new MappingError(reason);
}
const constructed = new WeakMap<
  ResolverFlowMappingObservation,
  { original: CurrentConfigurationAssociation; inputsDigest: string; loaderDigest: string }
>();

/**
 * Pure main-process observation constructor. No sockets, DNS queries, filesystem, Session,
 * Gate or persistence. The caller supplies actual retained reader/parser outputs.
 * This maps an app fake destination to its own kernel dialed candidate, not a physical tuple.
 */
export function createResolverFlowMapping(
  input: ResolverFlowMappingInput,
  nowMono: number,
): ResolverFlowMappingResult {
  try {
    const original = input.configuration;
    const value = structuredClone(input);
    const { target, inputs, loader, requestSocket: socket, window: time } = value;
    if (
      !Number.isFinite(nowMono) ||
      !normalizeProofTarget(target) ||
      target.protocol !== "https:" ||
      !text(value.transportProfileId) ||
      !text(value.transportContextId) ||
      // The retained request parser currently admits only this factory's fixed robots.txt URL.
      // Its socket cannot be relabelled as an egress echo request.
      value.factoryId !== "clipdock-anonymous-tls-v1"
    )
      fail("INPUT_INVALID");
    if (
      !inputs.systemHostsBefore ||
      !inputs.systemHostsAfter ||
      !validateConfigurationAssociation(original, inputs, loader, original.checkedAtMono) ||
      !same(value.configuration, original) ||
      !inputs.targets.some((t) => proofTargetKey(t) === proofTargetKey(target)) ||
      inputs.configurationAfter.currentDirectPolicy.kind !== "direct" ||
      inputs.configurationAfter.currentDirectPolicy.dialer !== "none"
    )
      fail("CONFIGURATION_UNVERIFIED");
    if (
      !windowValid(time.sendAtMono, time.headersAtMono, inputs.startedAtMono, nowMono) ||
      !windowValid(time.sendAtWallMs, time.headersAtWallMs, 0, Number.MAX_SAFE_INTEGER) ||
      !validateConfigurationAssociationForFreshDns(original, inputs, loader, time.headersAtMono) ||
      original.checkedAtMono > nowMono
    )
      fail("TIME_UNVERIFIED");
    const { evidenceId: socketEvidenceId, ...socketBody } = socket;
    if (
      socket.kind !== "anonymous-netlog-request-socket" ||
      !sha(socketEvidenceId) ||
      hash(socketBody) !== socketEvidenceId ||
      socket.origin.protocol !== target.protocol ||
      socket.origin.host !== target.host ||
      socket.origin.port !== target.port ||
      !refs(socket.relatedSourceIds, 128) ||
      !socket.relatedSourceIds.includes(socket.rootId) ||
      !socket.relatedSourceIds.includes(socket.socketSourceId) ||
      !refs(socket.eventEvidence, 512)
    )
      fail("CONTEXT_UNVERIFIED");
    const family = target.addressFamily === "ipv4" ? 4 : 6;
    if (
      !tupleMatches(socket.tuple, socket.tuple) ||
      socket.tuple.remotePort !== target.port ||
      isIP(socket.tuple.sourceAddress) !== family ||
      isIP(socket.tuple.remoteAddress) !== family ||
      !ownerValid(value.appOwner) ||
      !value.appTcp.available ||
      !windowValid(value.appTcp.startedAtMono, value.appTcp.completedAtMono, time.sendAtMono, nowMono) ||
      !refs(value.appTcp.owners, 32) ||
      !refs(value.appTcp.sockets, 1024)
    )
      fail("SOCKET_UNVERIFIED");
    if (value.appTcp.owners.filter((o) => ownersMatch(o, value.appOwner)).length !== 1)
      fail("SOCKET_UNVERIFIED");
    const appMatches = value.appTcp.sockets.filter((row) => tupleMatches(socket.tuple, row));
    if (
      appMatches.length !== 1 ||
      appMatches[0].ownerPid !== value.appOwner.pid ||
      appMatches[0].state !== "Established"
    )
      fail("SOCKET_UNVERIFIED");
    const { incomingBefore: before, incomingAfter: after } = value;
    if (
      !windowValid(before.startedAtMono, before.completedAtMono, inputs.startedAtMono, time.sendAtMono) ||
      !windowValid(after.startedAtMono, after.completedAtMono, time.sendAtMono, nowMono) ||
      !Array.isArray(before.connections) ||
      before.connections.length > 20000 ||
      !refs(after.connections, 20000) ||
      new Set(before.connections.map((c) => c.id)).size !== before.connections.length ||
      new Set(after.connections.map((c) => c.id)).size !== after.connections.length
    )
      fail("INCOMING_UNVERIFIED");
    // Match the actual app source first so a conflicting sniffed host/route cannot be ignored.
    const incoming = after.connections.filter(
      (c) =>
        ip(c.sourceAddress) === ip(socket.tuple.sourceAddress) && c.sourcePort === socket.tuple.sourcePort,
    );
    if (incoming.length !== 1) fail("INCOMING_UNVERIFIED");
    const connection = incoming[0];
    if (
      !text(connection.id) ||
      before.connections.some((c) => c.id === connection.id) ||
      connection.host !== target.host ||
      (connection.sniffHost !== null && connection.sniffHost !== target.host) ||
      connection.destinationPort !== target.port ||
      connection.network !== "tcp" ||
      connection.inboundType !== "Tun" ||
      connection.route !== "direct" ||
      !windowValid(connection.startedAtMs, connection.startedAtMs, time.sendAtWallMs, time.headersAtWallMs) ||
      !connection.remoteDestinationIp ||
      isIP(connection.remoteDestinationIp) !== family ||
      (connection.processIdentity !== null &&
        connection.processIdentity !== value.appOwner.executablePathIdentity)
    )
      fail("INCOMING_UNVERIFIED");
    const policy = { candidate: inputs.configurationAfter, loader };
    if (
      classifyCurrentKernelDnsAddress(
        socket.tuple.remoteAddress,
        inputs.rulesVersion,
        policy,
        original.checkedAtMono,
      ) !== "fake-ip" ||
      classifyCurrentKernelDnsAddress(
        connection.remoteDestinationIp,
        inputs.rulesVersion,
        policy,
        original.checkedAtMono,
      ) !== "real"
    )
      fail("DNS_UNVERIFIED");
    const dns = value.kernelDns;
    if (
      dns.kind !== "kernel-dns-candidates" ||
      !dns.available ||
      dns.chromiumResolutionProven !== false ||
      !windowValid(dns.startedAtMono, dns.completedAtMono, inputs.startedAtMono, time.sendAtMono) ||
      dns.controllerVersionBefore.controllerVersion !== inputs.rulesVersion ||
      dns.controllerVersionAfter.controllerVersion !== inputs.rulesVersion ||
      !Array.isArray(dns.hosts)
    )
      fail("DNS_UNVERIFIED");
    const hosts: readonly KernelDnsHostCandidate[] = (dns.hosts as readonly KernelDnsHostCandidate[]).filter(
        (h) => h.host === target.host,
      ),
      type = family === 4 ? "A" : "AAAA",
      recordType = family === 4 ? 1 : 28;
    if (hosts.length !== 1) fail("DNS_UNVERIFIED");
    const host = hosts[0],
      queries = host.queries.filter((q) => q.type === type),
      answers = host.answers.filter((a) => a.queryType === type),
      addresses = host.addresses.filter((a) => a.addressFamily === target.addressFamily);
    if (
      queries.length !== 1 ||
      queries[0].error !== null ||
      !queries[0].response ||
      queries[0].response.status !== 0 ||
      queries[0].response.truncated ||
      queries[0].response.host !== target.host ||
      queries[0].response.queryType !== type ||
      queries[0].response.question.name !== target.host ||
      queries[0].response.question.type !== recordType ||
      !windowValid(
        queries[0].startedAtMono,
        queries[0].completedAtMono,
        dns.startedAtMono,
        time.sendAtMono,
      ) ||
      !windowValid(
        queries[0].response.startedAtMono,
        queries[0].response.completedAtMono,
        queries[0].startedAtMono,
        queries[0].completedAtMono,
      ) ||
      !refs(addresses, 128) ||
      new Set(addresses.map((a) => a.address)).size !== addresses.length ||
      !refs(answers, 256)
    )
      fail("DNS_UNVERIFIED");
    const kernelAddresses = addresses.map((a) => a.address).sort();
    if (
      !kernelAddresses.includes(connection.remoteDestinationIp) ||
      addresses.some(
        (a) =>
          a.addressClass !== "real" ||
          isIP(a.address) !== family ||
          classifyCurrentKernelDnsAddress(a.address, inputs.rulesVersion, policy, original.checkedAtMono) !==
            "real" ||
          !answers.some((answer) => answer.type === recordType && answer.data === a.address),
      ) ||
      answers.some(
        (a) =>
          !Number.isSafeInteger(a.ttl) ||
          a.ttl <= 0 ||
          a.observedAtMono !== queries[0].response!.startedAtMono ||
          a.expiresAtMono !== a.observedAtMono + a.ttl * 1000 ||
          a.expiresAtMono <= time.headersAtMono ||
          !queries[0].response!.answers.some(
            (raw) => raw.name === a.name && raw.type === a.type && raw.data === a.data && raw.ttl === a.ttl,
          ),
      )
    )
      fail("DNS_UNVERIFIED");
    const deadline = Math.min(dns.ttlCapAtMono ?? dns.expiresAtMono, ...answers.map((a) => a.expiresAtMono));
    if (!Number.isFinite(deadline) || deadline <= time.headersAtMono) fail("DNS_UNVERIFIED");
    const body = {
      kind: "fake-ip-kernel-destination" as const,
      target,
      transportProfileId: value.transportProfileId,
      factoryId: value.factoryId,
      transportContextId: value.transportContextId,
      inputSampleId: inputs.sampleId,
      configurationEvidenceId: original.evidenceId,
      kernelAddresses,
      transportAddresses: [socket.tuple.remoteAddress],
      requestSocket: socket,
      appOwner: value.appOwner,
      appSocket: appMatches[0],
      incoming: connection,
      kernelDnsEvidenceId: hash({
        query: queries[0],
        answers,
        addresses,
        controllerVersionBefore: dns.controllerVersionBefore,
        controllerVersionAfter: dns.controllerVersionAfter,
      }),
      kernelDnsExpiresAtMono: deadline,
      window: time,
      startedAtMono: time.sendAtMono,
      observedAtMono: time.headersAtMono,
      completedAtMono: Math.max(
        time.headersAtMono,
        after.completedAtMono,
        value.appTcp.completedAtMono,
        inputs.completedAtMono,
      ),
      checkedAtMono: nowMono,
      physicalSocketProven: false as const,
    };
    const observation = freeze({ ...body, evidenceId: hash(body) });
    constructed.set(observation, { original, inputsDigest: hash(inputs), loaderDigest: hash(loader) });
    return Object.freeze({ valid: true, observation });
  } catch (error) {
    return Object.freeze({
      valid: false,
      reason: error instanceof MappingError ? error.reason : "INPUT_INVALID",
    });
  }
}

/** Validate the retained original, not its copied DTO. Later current route checks remain separate. */
export function validateResolverFlowMapping(
  observation: ResolverFlowMappingObservation,
  inputs: CurrentPathInputs,
  loader: KnownSelectedLoaderContract,
  configuration: CurrentConfigurationAssociation,
  qualifiedAtMono: number,
): boolean {
  try {
    const retained = constructed.get(observation);
    return (
      !!retained &&
      retained.original === configuration &&
      retained.inputsDigest === hash(inputs) &&
      retained.loaderDigest === hash(loader) &&
      validateConfigurationAssociation(configuration, inputs, loader, configuration.checkedAtMono) &&
      Number.isFinite(qualifiedAtMono) &&
      observation.checkedAtMono <= qualifiedAtMono &&
      observation.configurationEvidenceId === configuration.evidenceId &&
      observation.inputSampleId === inputs.sampleId
    );
  } catch {
    return false;
  }
}
