import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { executablePathIdentity } from "@main/network/connection-evidence";
import type {
  WindowsControllerOwnerSnapshot,
  WindowsControllerProcessIdentity,
} from "@main/network/windows-controller-owner";
import type { WindowsTcpSocketSnapshot } from "@main/network/windows-tcp-sockets";
import type { ProxyTunnelContext } from "./proxy-transport";
import { isOfficialProxyHost } from "./proxy-target-policy";
import { isGlobalWebHost } from "@main/network/global-web-target-policy";
import { isDomesticWebHost } from "@main/network/domestic-web-target-policy";

type Endpoint = Readonly<{ host: string; port: number }>;
interface Timed {
  readonly startedAtMono: number;
  readonly completedAtMono: number;
}

/** The accepted server socket, not an inferred IPv4 capability of a `::` listener. */
export interface WindowsProxyAcceptedSnapshot extends Timed {
  readonly available: true;
  readonly basis: "windows-proxy-accepted";
  readonly scopeHash: string;
  readonly owner: WindowsControllerProcessIdentity;
  readonly socketSnapshot: WindowsTcpSocketSnapshot;
}

export interface ProxyTunnelReadResult extends Timed {
  readonly contextId: string;
  readonly generation: number;
  readonly revision: string;
  readonly controllerBefore: Timed & {
    readonly fingerprint: string;
    readonly mixedPort: number;
    readonly mode: string;
  };
  readonly controllerAfter: Timed & {
    readonly fingerprint: string;
    readonly mixedPort: number;
    readonly mode: string;
  };
  readonly controllerOwner: WindowsControllerOwnerSnapshot;
  readonly proxyOwner: WindowsControllerOwnerSnapshot | WindowsProxyAcceptedSnapshot;
  /** Bounded controller responses only; never persist/log these objects (proxy names may be private). */
  readonly connections: Timed & { readonly value: unknown };
  readonly proxies: Timed & { readonly value: unknown };
}
/** Fixed main-only diagnostic context. Never accepted by business ProxyTransport. */
export type AnonymousProxyTunnelContext = Omit<ProxyTunnelContext, "platformId" | "target"> & {
  readonly platformId: "anonymous-egress";
  readonly target: Readonly<{ host: "www.cloudflare.com" | "myip.ipip.net"; port: 443 }>;
};
export type VerifiableProxyTunnelContext = ProxyTunnelContext | AnonymousProxyTunnelContext;
export interface VerifiedProxyTunnelEvidence {
  readonly contextId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly revision: string;
  readonly target: Readonly<{ host: string; port: 443 }>;
  readonly chainFingerprint: string;
  readonly kernelOwner: WindowsControllerProcessIdentity;
  readonly controllerFingerprint: string;
  readonly evidenceExpiresAtMono: number;
}
export interface ProxyTunnelEvidenceInput {
  readonly context: VerifiableProxyTunnelContext;
  readonly evidence: ProxyTunnelReadResult;
  readonly controller: Endpoint;
  readonly proxy: Endpoint;
  readonly generation: number;
  readonly revision: string;
  readonly nowMono: number;
  readonly readStartedAtMono: number;
  readonly evidenceTtlMs?: number;
  /** Main-owned live lease continuation only. This pure verifier never grants a lease itself. */
  readonly expectedConnectionId?: string;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const specialV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  specialV4.addSubnet(address, prefix, "ipv4");
export function isPublicIpv4(value: unknown): value is string {
  return typeof value === "string" && isIP(value) === 4 && !specialV4.check(value, "ipv4");
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const token = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const integer = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function ip(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("%")) return null;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  // Windows can expose IPv4-mapped addresses while the kernel reports plain IPv4.
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/i.exec(canonical);
  if (!mapped) return canonical;
  const bits = Number.parseInt(mapped[1], 16) * 65536 + Number.parseInt(mapped[2], 16);
  return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join(".");
}
function port(value: unknown): number | null {
  const number = typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : value;
  return typeof number === "number" && integer(number, 1, 65535) ? number : null;
}
function host(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 253 || !/^[a-z0-9.-]+$/i.test(value)) return null;
  return value.toLowerCase();
}
function sameOwner(a: WindowsControllerProcessIdentity, b: WindowsControllerProcessIdentity): boolean {
  return (
    integer(a.pid, 1, 0xffffffff) &&
    /^[1-9]\d{15,18}$/.test(a.createdAtTicks) &&
    hash(a.executablePathIdentity) &&
    a.pid === b.pid &&
    a.createdAtTicks === b.createdAtTicks &&
    a.executablePathIdentity === b.executablePathIdentity
  );
}
function localEndpoint(endpoint: Endpoint): boolean {
  const address = ip(endpoint.host);
  return !!address && (address === "::1" || address.startsWith("127.")) && port(endpoint.port) !== null;
}
// First release supports these known remote adapters, not arbitrary names or unknown future types.
const remoteTypes = new Set([
  "Http",
  "Socks5",
  "Shadowsocks",
  "ShadowsocksR",
  "Snell",
  "Vmess",
  "Vless",
  "Trojan",
  "Hysteria",
  "Hysteria2",
  "WireGuard",
  "Tuic",
  "Ssh",
  "AnyTLS",
]);
const groupTypes = new Set(["Selector", "Fallback", "URLTest", "LoadBalance", "Relay"]);
const reserved = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "DNS"]);

function visiblePolicy(value: unknown, depth = 0): unknown {
  if (depth > 6) throw new Error();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 16_384) return value;
  if (Array.isArray(value) && value.length <= 512) return value.map((item) => visiblePolicy(item, depth + 1));
  const item = record(value);
  if (!item || Object.keys(item).length > 256) throw new Error();
  // Remove live health telemetry, not the API-visible policy/identity or current group selection.
  return Object.fromEntries(
    Object.keys(item)
      .filter((key) => depth !== 0 || !["alive", "history"].includes(key))
      .sort()
      .map((key) => {
        if (key.length > 256) throw new Error();
        return [key, visiblePolicy(item[key], depth + 1)];
      }),
  );
}

/** Shared main-only digest algorithm for a sample producer. No truth from a bare `route=non-direct`.
 * Actual chain is leaf first in mihomo; aliases with type Direct/Reject are refused as well.
 */
export function proxyTunnelChainFingerprint(chains: unknown, response: unknown): string | null {
  if (
    !Array.isArray(chains) ||
    !chains.length ||
    chains.length > 32 ||
    new Set(chains).size !== chains.length
  )
    return null;
  const proxies = record(record(response)?.proxies);
  if (!proxies || Object.keys(proxies).length > 10_000) return null;
  const entries: [string, unknown][] = [];
  for (const [index, name] of chains.entries()) {
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 1024 ||
      /[\r\n\0]/.test(name) ||
      reserved.has(name.toUpperCase())
    )
      return null;
    if (!Object.hasOwn(proxies, name)) return null;
    const type = record(proxies[name])?.type;
    if (typeof type !== "string" || (!remoteTypes.has(type) && !(index > 0 && groupTypes.has(type))))
      return null;
    try {
      const policy = visiblePolicy(proxies[name]);
      if (JSON.stringify(policy).length > 65_536) return null;
      entries.push([name, policy]);
    } catch {
      return null;
    }
  }
  return digest(JSON.stringify(entries));
}

/** Pure accepted-socket ownership check; this alone is neither a route nor an egress grant.
 * The source query is scoped by the controller's independently read PID and this client tuple.
 */
export function proxyAcceptedOwnerMatches(
  context: VerifiableProxyTunnelContext,
  controllerOwner: WindowsControllerProcessIdentity,
  sample: WindowsProxyAcceptedSnapshot,
  readStartedAtMono: number,
  nowMono: number,
  evidenceTtlMs = 15_000,
): boolean {
  try {
    const sockets = sample.socketSnapshot;
    const clientAddress = context.socket.localAddress;
    const scopeAddress =
      isIP(clientAddress) === 6 ? new URL(`http://[${clientAddress}]`).hostname.slice(1, -1) : clientAddress;
    if (
      sample.available !== true ||
      sample.basis !== "windows-proxy-accepted" ||
      !sockets.available ||
      !Number.isFinite(readStartedAtMono) ||
      readStartedAtMono < 0 ||
      !Number.isFinite(nowMono) ||
      nowMono < readStartedAtMono ||
      !integer(evidenceTtlMs, 1, 15_000) ||
      !ip(clientAddress) ||
      port(context.socket.localPort) === null ||
      !ip(context.socket.remoteAddress) ||
      port(context.socket.remotePort) === null ||
      !Number.isFinite(sockets.startedAtMono) ||
      !Number.isFinite(sockets.completedAtMono) ||
      sockets.startedAtMono < readStartedAtMono ||
      sockets.completedAtMono < sockets.startedAtMono ||
      sockets.completedAtMono > nowMono ||
      nowMono >= sockets.startedAtMono + evidenceTtlMs ||
      sample.startedAtMono !== sockets.startedAtMono ||
      sample.completedAtMono !== sockets.completedAtMono ||
      sample.scopeHash !== sockets.scopeHash ||
      sockets.scopeHash !==
        digest(
          JSON.stringify({
            ownerPids: [controllerOwner.pid],
            remotes: [{ address: scopeAddress, port: context.socket.localPort }],
          }),
        ) ||
      !sameOwner(sample.owner, controllerOwner) ||
      !Array.isArray(sockets.owners) ||
      sockets.owners.length !== 1 ||
      !sameOwner(sockets.owners[0], controllerOwner) ||
      !Array.isArray(sockets.sockets) ||
      sockets.sockets.length > 1024
    )
      return false;
    // Preserve all matching rows until uniqueness is checked, including a non-Established duplicate.
    const matches = sockets.sockets.filter(
      (row) =>
        ip(row.sourceAddress) === ip(context.socket.remoteAddress) &&
        row.sourcePort === context.socket.remotePort &&
        ip(row.remoteAddress) === ip(clientAddress) &&
        row.remotePort === context.socket.localPort,
    );
    return (
      matches.length === 1 &&
      matches[0].ownerPid === controllerOwner.pid &&
      matches[0].state === "Established" &&
      sockets.sockets.every(
        (row) =>
          row.ownerPid === controllerOwner.pid &&
          ip(row.remoteAddress) === ip(clientAddress) &&
          row.remotePort === context.socket.localPort,
      )
    );
  } catch {
    return false;
  }
}

/** Checks observed tunnel facts only. It does not attest exit country, grant a lease,
 * or expand the business allowlist. Caller must still enforce its current epoch/signal. */
export function verifyProxyTunnelEvidence(
  input: ProxyTunnelEvidenceInput,
): VerifiedProxyTunnelEvidence | null {
  try {
    return verify(structuredClone(input), isOfficialProxyHost);
  } catch {
    return null;
  }
}
/** Explicit main-only website entry point. The default API verifier stays API-scoped. */
export function verifyWebProxyTunnelEvidence(
  input: ProxyTunnelEvidenceInput,
): VerifiedProxyTunnelEvidence | null {
  try {
    if (input.context.platformId === "anonymous-egress") return null;
    return verify(structuredClone(input), isGlobalWebHost);
  } catch {
    return null;
  }
}
/** DIRECT is a distinct transport; it can never authorize an overseas request. */
export function verifyDomesticTunnelEvidence(
  input: ProxyTunnelEvidenceInput,
): VerifiedProxyTunnelEvidence | null {
  try {
    return verify(structuredClone(input), isDomesticWebHost, true);
  } catch {
    return null;
  }
}
export function directTunnelChainFingerprint(chains: unknown, response: unknown): string | null {
  const proxies = record(record(response)?.proxies);
  if (
    !Array.isArray(chains) ||
    !chains.length ||
    chains.length > 32 ||
    new Set(chains).size !== chains.length ||
    chains[0] !== "DIRECT" ||
    !proxies ||
    record(proxies.DIRECT)?.type !== "Direct" ||
    record(proxies.DIRECT)?.["dialer-proxy"] !== ""
  )
    return null;
  // Different selectors may lead to the same actual DIRECT adapter. Relay chains are not equivalent.
  for (const name of chains.slice(1)) {
    if (
      typeof name !== "string" ||
      !Object.hasOwn(proxies, name) ||
      !["Selector", "Fallback", "URLTest", "LoadBalance"].includes(String(record(proxies[name])?.type))
    )
      return null;
  }
  try {
    return digest(JSON.stringify([["DIRECT", visiblePolicy(proxies.DIRECT)]]));
  } catch {
    return null;
  }
}
function verify(
  input: ProxyTunnelEvidenceInput,
  allowHost: typeof isOfficialProxyHost,
  domesticDirect = false,
): VerifiedProxyTunnelEvidence | null {
  const {
    context,
    evidence: value,
    controller,
    proxy,
    generation,
    revision,
    nowMono: now,
    readStartedAtMono,
  } = input;
  const ttl = input.evidenceTtlMs ?? 15_000;
  if (
    !integer(ttl, 1, 15_000) ||
    !integer(generation, 0, Number.MAX_SAFE_INTEGER) ||
    !token(revision) ||
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isFinite(readStartedAtMono) ||
    readStartedAtMono < 0 ||
    readStartedAtMono > now ||
    !localEndpoint(controller) ||
    !localEndpoint(proxy) ||
    !token(context.id) ||
    context.target.port !== 443 ||
    !(context.platformId === "anonymous-egress"
      ? context.target.host === (domesticDirect ? "myip.ipip.net" : "www.cloudflare.com")
      : allowHost(context.platformId, context.target.host)) ||
    context.proxy.host !== proxy.host ||
    context.proxy.port !== proxy.port ||
    ip(context.socket.remoteAddress) !== ip(proxy.host) ||
    context.socket.remotePort !== proxy.port ||
    !ip(context.socket.localAddress) ||
    port(context.socket.localPort) === null ||
    !Number.isFinite(context.connectedAtMono) ||
    context.connectedAtMono < 0 ||
    context.connectedAtMono > readStartedAtMono ||
    (input.expectedConnectionId === undefined
      ? now >= context.connectedAtMono + ttl
      : !token(input.expectedConnectionId) || context.platformId === "anonymous-egress")
  )
    return null;
  const timed = (item: Timed) =>
    Number.isFinite(item?.startedAtMono) &&
    Number.isFinite(item.completedAtMono) &&
    item.startedAtMono >= context.connectedAtMono &&
    item.completedAtMono >= item.startedAtMono &&
    item.completedAtMono <= now &&
    now < item.startedAtMono + ttl;
  if (
    value.contextId !== context.id ||
    value.generation !== generation ||
    value.revision !== revision ||
    !timed(value) ||
    value.startedAtMono < readStartedAtMono ||
    !timed(value.controllerBefore) ||
    !timed(value.controllerAfter) ||
    !timed(value.connections) ||
    !timed(value.proxies) ||
    value.controllerBefore.startedAtMono < value.startedAtMono ||
    value.controllerAfter.completedAtMono > value.completedAtMono ||
    value.controllerBefore.completedAtMono >
      Math.min(value.connections.startedAtMono, value.proxies.startedAtMono) ||
    value.controllerAfter.startedAtMono <
      Math.max(value.connections.completedAtMono, value.proxies.completedAtMono)
  )
    return null;
  for (const config of [value.controllerBefore, value.controllerAfter])
    if (
      !hash(config.fingerprint) ||
      config.fingerprint !== value.controllerBefore.fingerprint ||
      config.mixedPort !== proxy.port ||
      !["rule", "global"].includes(config.mode) ||
      (domesticDirect && config.mode !== "rule") ||
      config.mode !== value.controllerBefore.mode
    )
      return null;
  const owner = (sample: WindowsControllerOwnerSnapshot, endpoint: Endpoint): boolean => {
    if (
      !sample.available ||
      sample.basis !== "windows-controller-listener" ||
      sample.scopeHash !== digest(JSON.stringify({ address: endpoint.host, port: endpoint.port })) ||
      !hash(sample.kernelEpoch) ||
      !Number.isFinite(sample.startedAtMono) ||
      !Number.isFinite(sample.completedAtMono) ||
      sample.startedAtMono < 0 ||
      sample.startedAtMono > sample.completedAtMono ||
      sample.completedAtMono > now ||
      now >= sample.startedAtMono + ttl ||
      !sameOwner(sample.owner, sample.owner)
    )
      return false;
    return sample.listeners.some(
      (listener) =>
        listener.port === endpoint.port &&
        ((listener.coverage === "exact" && ip(listener.address) === ip(endpoint.host)) ||
          (listener.coverage === "same-family-wildcard" &&
            (isIP(ip(endpoint.host)!) === 4 ? listener.address === "0.0.0.0" : listener.address === "::"))),
    );
  };
  if (
    !owner(value.controllerOwner, controller) ||
    !value.controllerOwner.available ||
    !value.proxyOwner.available
  )
    return null;
  if (value.proxyOwner.basis === "windows-proxy-accepted") {
    if (
      !proxyAcceptedOwnerMatches(
        context,
        value.controllerOwner.owner,
        value.proxyOwner,
        value.startedAtMono,
        now,
        ttl,
      )
    )
      return null;
  } else if (
    !owner(value.proxyOwner, proxy) ||
    !sameOwner(value.controllerOwner.owner, value.proxyOwner.owner)
  )
    return null;
  const rows = record(value.connections.value)?.connections;
  if (!Array.isArray(rows) || rows.length > 20_000) return null;
  const matches = rows.filter((row) => {
    const meta = record(record(row)?.metadata);
    return (
      meta &&
      ip(meta.sourceIP) === ip(context.socket.localAddress) &&
      port(meta.sourcePort) === context.socket.localPort &&
      ip(meta.inboundIP) === ip(context.socket.remoteAddress) &&
      port(meta.inboundPort) === context.socket.remotePort
    );
  });
  if (matches.length !== 1) return null;
  const row = record(matches[0])!,
    meta = record(row.metadata)!;
  if (
    !token(row.id) ||
    (input.expectedConnectionId !== undefined && row.id !== input.expectedConnectionId) ||
    host(meta.host) !== context.target.host ||
    port(meta.destinationPort) !== context.target.port ||
    meta.type !== "HTTPS" ||
    meta.network !== "tcp" ||
    (meta.sniffHost !== undefined &&
      meta.sniffHost !== null &&
      meta.sniffHost !== "" &&
      host(meta.sniffHost) !== context.target.host)
  )
    return null;
  if (
    meta.processPath !== undefined &&
    meta.processPath !== null &&
    meta.processPath !== "" &&
    (typeof meta.processPath !== "string" ||
      executablePathIdentity(meta.processPath) !== executablePathIdentity(process.execPath))
  )
    return null;
  // Reject unobserved/IPv6 destinations: a successful IPv4 country probe cannot qualify IPv6.
  if (domesticDirect && !isPublicIpv4(meta.remoteDestination || meta.destinationIP)) return null;
  const chainFingerprint = (domesticDirect ? directTunnelChainFingerprint : proxyTunnelChainFingerprint)(
    row.chains,
    value.proxies.value,
  );
  if (!chainFingerprint) return null;
  const evidenceExpiresAtMono =
    Math.min(
      value.startedAtMono,
      value.controllerBefore.startedAtMono,
      value.connections.startedAtMono,
      value.proxies.startedAtMono,
      value.controllerAfter.startedAtMono,
      value.controllerOwner.startedAtMono,
      value.proxyOwner.startedAtMono,
    ) + ttl;
  return Object.freeze({
    contextId: context.id,
    connectionId: row.id,
    generation,
    revision,
    target: Object.freeze({ ...context.target }),
    chainFingerprint,
    kernelOwner: Object.freeze({ ...value.controllerOwner.owner }),
    controllerFingerprint: value.controllerBefore.fingerprint,
    evidenceExpiresAtMono,
  });
}
