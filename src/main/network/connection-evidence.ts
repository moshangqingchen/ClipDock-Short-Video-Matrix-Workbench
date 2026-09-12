import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { normalizeProofTarget, type ProofTarget } from "./direct-proof";

/** Main-process only. No URLs, rule payloads, provider names or executable paths cross this DTO. */
export interface KernelConnectionObservation {
  id: string;
  host: string;
  sniffHost: string | null;
  sourceAddress: string;
  sourcePort: number;
  destinationPort: number;
  destinationIp: string | null;
  /** DIRECT TCP dialed destination observation. Never the server-observed public source/egress. */
  remoteDestinationIp: string | null;
  network: "tcp" | "udp";
  inboundType: string;
  processIdentity: string | null;
  route: "direct" | "non-direct" | "unknown";
  startedAtMs: number;
}

export interface KernelConnectionsSnapshot {
  startedAtMono: number;
  completedAtMono: number;
  connections: readonly KernelConnectionObservation[];
}

/** A normalized path identity only; this does not hash or attest the executable's contents. */
export function executablePathIdentity(executablePath: string): string | null {
  if (!executablePath || executablePath.length > 4096 || /[\r\n\0]/.test(executablePath)) return null;
  const windowsPath = /^[a-z]:[\\/]/i.test(executablePath);
  if (!windowsPath && !path.posix.isAbsolute(executablePath)) return null;
  const normalized = windowsPath
    ? path.win32.normalize(executablePath).toLowerCase()
    : path.posix.normalize(executablePath);
  return createHash("sha256").update(normalized).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function host(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return (
    normalizeProofTarget({ host: value, protocol: "https:", port: 443, addressFamily: "ipv4" })?.host ?? null
  );
}
function port(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

function ipAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("%")) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  return new URL(`http://[${value}]`).hostname.slice(1, -1);
}

// Conservative destination candidates, not a geo database or a routability guarantee.
// IANA special-purpose registries checked 2026-09-07; exclude special allocations even
// where their registry permits global use. IPv6 is limited to ordinary 2000::/3 unicast.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const specialDestinations = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  specialDestinations.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
] as const)
  specialDestinations.addSubnet(address, prefix, "ipv6");
const ordinaryIpv6 = new BlockList();
ordinaryIpv6.addSubnet("2000::", 3, "ipv6");

function remoteDestinationCandidate(value: unknown): string | null {
  const ip = ipAddress(value);
  if (!ip) return null;
  const family = isIP(ip) === 4 ? "ipv4" : "ipv6";
  if (family === "ipv6" && !ordinaryIpv6.check(ip, "ipv6")) return null;
  return specialDestinations.check(ip, family) ? null : ip;
}

export function connectionHostScope(hosts: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(hosts) || !hosts.length || hosts.length > 256)
    throw new Error("INVALID_CONNECTION_SCOPE");
  const normalized = hosts.map(host);
  if (normalized.some((value) => !value)) throw new Error("INVALID_CONNECTION_SCOPE");
  return new Set(normalized as string[]);
}

/** Exact-host minimization only; ownership still requires an independently measured socket. */
export function parseScopedConnections(
  value: unknown,
  scope: ReadonlySet<string>,
): KernelConnectionObservation[] {
  const rows = record(value)?.connections;
  if (!Array.isArray(rows) || rows.length > 20_000) throw new Error("INVALID_CONNECTION_RESPONSE");
  const observations: KernelConnectionObservation[] = [];
  for (const row of rows) {
    const entry = record(row);
    const metadata = record(entry?.metadata);
    if (!entry || !metadata) continue;
    const targetHost = host(metadata.host);
    const sniffHost = host(metadata.sniffHost);
    if ((!targetHost || !scope.has(targetHost)) && (!sniffHost || !scope.has(sniffHost))) continue;
    // A present conflicting/literal/invalid sniffed target is not equivalent to no sniffing.
    if (
      metadata.sniffHost !== undefined &&
      metadata.sniffHost !== null &&
      metadata.sniffHost !== "" &&
      !sniffHost
    )
      throw new Error("INVALID_CONNECTION_RESPONSE");
    const sourcePort = port(metadata.sourcePort);
    const sourceAddress = ipAddress(metadata.sourceIP);
    const destinationPort = port(metadata.destinationPort);
    const startedAtMs = typeof entry.start === "string" ? Date.parse(entry.start) : NaN;
    if (
      !sourcePort ||
      !sourceAddress ||
      !destinationPort ||
      !Number.isFinite(startedAtMs) ||
      typeof entry.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) ||
      !["tcp", "udp"].includes(String(metadata.network)) ||
      typeof metadata.type !== "string" ||
      !/^[a-zA-Z_-]{1,64}$/.test(metadata.type)
    )
      throw new Error("INVALID_CONNECTION_RESPONSE");
    const chains = entry.chains;
    const knownChain =
      Array.isArray(chains) &&
      chains.length > 0 &&
      chains.length < 64 &&
      chains.every((name) => typeof name === "string" && name.length > 0 && name.length < 1024);
    const route = !knownChain
      ? "unknown"
      : chains.length === 1 && chains[0] === "DIRECT"
        ? "direct"
        : "non-direct";
    observations.push({
      id: entry.id,
      host: targetHost ?? "",
      sniffHost,
      sourceAddress,
      sourcePort,
      destinationPort,
      destinationIp: ipAddress(metadata.destinationIP),
      remoteDestinationIp:
        route === "direct" && metadata.network === "tcp"
          ? remoteDestinationCandidate(metadata.remoteDestination)
          : null,
      network: metadata.network as "tcp" | "udp",
      inboundType: metadata.type,
      processIdentity:
        typeof metadata.processPath === "string" ? executablePathIdentity(metadata.processPath) : null,
      route,
      startedAtMs,
    });
  }
  return observations;
}

export interface ProbeSocketObservation {
  contextId: string;
  target: ProofTarget;
  /** Must be measured for this probe's actual socket, never guessed from a process/host search. */
  sourceAddress: string;
  sourcePort: number;
  processIdentity: string;
  inboundType: string;
  network: "tcp" | "udp";
  startedAtWallMs: number;
  completedAtWallMs: number;
  startedAtMono: number;
  completedAtMono: number;
}

export type ConnectionCorrelation =
  | {
      matched: false;
      reason:
        | "STALE_CONNECTION_SNAPSHOT"
        | "SOCKET_UNVERIFIED"
        | "NO_MATCH"
        | "AMBIGUOUS_MATCH"
        | "CONTEXT_MISMATCH"
        | "NOT_DIRECT";
    }
  | {
      matched: true;
      contextId: string;
      connectionId: string;
      observedAtMono: number;
      destinationIp: string | null;
      remoteDestinationIp: string | null;
    };

/**
 * Matches an independently owned socket to one observed route. It cannot establish Chromium
 * request-to-socket ownership from TCP-table uniqueness, nor attest AF, TLS, DNS or egress.
 * The issuer must separately bind both snapshots to an unchanged kernel/config generation.
 */
export function correlateProbeConnection(
  socket: ProbeSocketObservation,
  before: KernelConnectionsSnapshot,
  after: KernelConnectionsSnapshot,
  nowMono: number,
  ttlMs: number,
): ConnectionCorrelation {
  const target = normalizeProofTarget(socket.target);
  const sourceAddress = ipAddress(socket.sourceAddress);
  if (
    !target ||
    !socket.contextId ||
    !sourceAddress ||
    !port(socket.sourcePort) ||
    !["tcp", "udp"].includes(socket.network) ||
    !/^[a-zA-Z_-]{1,64}$/.test(socket.inboundType) ||
    !/^[a-f0-9]{64}$/.test(socket.processIdentity) ||
    !Number.isFinite(socket.startedAtWallMs) ||
    !Number.isFinite(socket.completedAtWallMs) ||
    socket.completedAtWallMs < socket.startedAtWallMs ||
    !Number.isFinite(socket.startedAtMono) ||
    !Number.isFinite(socket.completedAtMono)
  )
    return { matched: false, reason: "SOCKET_UNVERIFIED" };
  if (
    ![
      nowMono,
      ttlMs,
      before.startedAtMono,
      before.completedAtMono,
      after.startedAtMono,
      after.completedAtMono,
    ].every(Number.isFinite) ||
    ttlMs <= 0 ||
    before.startedAtMono < 0 ||
    before.completedAtMono < before.startedAtMono ||
    after.startedAtMono < before.completedAtMono ||
    after.completedAtMono < after.startedAtMono ||
    socket.startedAtMono < before.completedAtMono ||
    socket.completedAtMono < socket.startedAtMono ||
    socket.completedAtMono > after.completedAtMono ||
    // Date.now and the monotonic clock are sampled together. Do not let a wall-clock jump
    // widen the connection creation window; 50ms accommodates bounded capture skew only.
    Math.abs(
      socket.completedAtWallMs - socket.startedAtWallMs - (socket.completedAtMono - socket.startedAtMono),
    ) > 50 ||
    after.completedAtMono > nowMono ||
    nowMono - before.startedAtMono >= ttlMs
  )
    return { matched: false, reason: "STALE_CONNECTION_SNAPSHOT" };
  const oldIds = new Set(before.connections.map((connection) => connection.id));
  const candidates = after.connections.filter(
    (connection) =>
      !oldIds.has(connection.id) &&
      connection.sourceAddress === sourceAddress &&
      connection.sourcePort === socket.sourcePort &&
      connection.destinationPort === target.port &&
      connection.network === socket.network &&
      (connection.host === target.host || connection.sniffHost === target.host) &&
      connection.startedAtMs >= socket.startedAtWallMs &&
      connection.startedAtMs <= socket.completedAtWallMs,
  );
  if (!candidates.length) return { matched: false, reason: "NO_MATCH" };
  if (candidates.length !== 1) return { matched: false, reason: "AMBIGUOUS_MATCH" };
  const connection = candidates[0];
  if (
    connection.host !== target.host ||
    (connection.sniffHost !== null && connection.sniffHost !== target.host) ||
    connection.processIdentity !== socket.processIdentity ||
    connection.inboundType !== socket.inboundType
  )
    return { matched: false, reason: "CONTEXT_MISMATCH" };
  if (connection.route !== "direct") return { matched: false, reason: "NOT_DIRECT" };
  return {
    matched: true,
    contextId: socket.contextId,
    connectionId: connection.id,
    observedAtMono: after.startedAtMono,
    destinationIp: connection.destinationIp,
    remoteDestinationIp: connection.remoteDestinationIp,
  };
}
