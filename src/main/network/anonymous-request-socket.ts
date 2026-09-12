import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { normalizeProofTarget } from "./direct-proof";

export interface AnonymousSocketEndpoint {
  readonly address: string;
  readonly port: number;
}
export interface AnonymousRequestSocketObservation {
  readonly kind: "anonymous-netlog-request-socket";
  readonly evidenceId: string;
  readonly origin: { readonly protocol: "https:"; readonly host: string; readonly port: number };
  readonly rootId: number;
  readonly socketSourceId: number;
  readonly relatedSourceIds: readonly number[];
  readonly tuple: {
    readonly sourceAddress: string;
    readonly sourcePort: number;
    readonly remoteAddress: string;
    readonly remotePort: number;
  };
  /** Original NetLog clock strings; never relabel these as performance.now() timestamps. */
  readonly eventEvidence: readonly {
    readonly sourceId: number;
    readonly eventType: string;
    readonly timeTicks: string | null;
    readonly phase: number | null;
    readonly dependentSourceIds: readonly number[];
    readonly local: AnonymousSocketEndpoint | null;
    readonly remote: AnonymousSocketEndpoint | null;
  }[];
}
export type AnonymousRequestSocketResult =
  | { readonly available: true; readonly observation: AnonymousRequestSocketObservation }
  | {
      readonly available: false;
      readonly reason: "INPUT_INVALID" | "LOG_LIMIT" | "REQUEST_AMBIGUOUS" | "SOCKET_AMBIGUOUS";
    };

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 50_000;
const MAX_RELATED = 128;
const shared = /HOST_RESOLVER|DNS_|PROXY_|CERT_VERIFIER/;
const sharedSource = /HOST_RESOLVER|HOST_CACHE|DNS|CERT_VERIF|PROXY|PAC_FILE/;
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
function fail(reason: Extract<AnonymousRequestSocketResult, { available: false }>["reason"]): never {
  throw new ParseFailure(reason);
}
class ParseFailure extends Error {
  constructor(readonly reason: Extract<AnonymousRequestSocketResult, { available: false }>["reason"]) {
    super(reason);
  }
}
function endpoint(value: unknown): AnonymousSocketEndpoint | null {
  if (typeof value !== "string" || value.length > 80 || value.includes("%")) return null;
  const match = /^\[([^\]]+)\]:([1-9]\d{0,4})$/.exec(value) ?? /^([^:]+):([1-9]\d{0,4})$/.exec(value);
  if (!match || !isIP(match[1]) || Number(match[2]) > 65535) return null;
  const address = isIP(match[1]) === 4 ? match[1] : new URL(`http://[${match[1]}]`).hostname.slice(1, -1);
  return { address, port: Number(match[2]) };
}
function dependencies(value: unknown): number[] {
  const output = new Set<number>();
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++count > 2048 || next.depth > 16) fail("LOG_LIMIT");
    if (!next.value || typeof next.value !== "object") continue;
    for (const [key, item] of Object.entries(next.value)) {
      if (key === "source_dependency") {
        const source = record(item);
        if (!source || !integer(source.id)) fail("INPUT_INVALID");
        output.add(source.id);
      } else if (item && typeof item === "object") pending.push({ value: item, depth: next.depth + 1 });
    }
  }
  return [...output].sort((a, b) => a - b);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Pure, bounded parser for a fresh anonymous factory's fixed robots.txt request.
 * Logging must be isolated by the caller. This does not start NetLog, identify a
 * Windows process, infer DNS equivalence, or grant a route/egress permission.
 */
export function parseAnonymousRequestSocket(
  text: string,
  expected: { host: string; port: number },
): AnonymousRequestSocketResult {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BYTES) fail("LOG_LIMIT");
    const target = normalizeProofTarget({ ...expected, protocol: "https:", addressFamily: "ipv4" });
    if (!target) fail("INPUT_INVALID");
    const exactUrl = `https://${target.host}${target.port === 443 ? "" : `:${target.port}`}/robots.txt`;
    const document = record(JSON.parse(text));
    const constants = record(document?.constants);
    const namedTypes = record(constants?.logEventTypes);
    const namedSourceTypes = record(constants?.logSourceType);
    if (!namedTypes || !namedSourceTypes || !Array.isArray(document?.events)) fail("INPUT_INVALID");
    if (
      document.events.length > MAX_EVENTS ||
      Object.keys(namedTypes).length > 4096 ||
      Object.keys(namedSourceTypes).length > 512
    )
      fail("LOG_LIMIT");
    const types = new Map<number, string>();
    for (const [name, id] of Object.entries(namedTypes)) {
      if (!integer(id) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || types.has(id)) fail("INPUT_INVALID");
      types.set(id, name);
    }
    const sourceTypes = new Map<number, string>();
    for (const [name, id] of Object.entries(namedSourceTypes)) {
      if (!integer(id) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || sourceTypes.has(id)) fail("INPUT_INVALID");
      sourceTypes.set(id, name);
    }
    const sourceIdentities = new Map<number, number>();
    const rows = document.events.map((raw) => {
      const event = record(raw),
        source = record(event?.source),
        params = record(event?.params) ?? {};
      if (
        !event ||
        !source ||
        !integer(source.id) ||
        !integer(source.type) ||
        !sourceTypes.has(source.type) ||
        !integer(event.type) ||
        !types.has(event.type)
      )
        fail("INPUT_INVALID");
      if (sourceIdentities.has(source.id) && sourceIdentities.get(source.id) !== source.type)
        fail("INPUT_INVALID");
      sourceIdentities.set(source.id, source.type);
      const name = types.get(event.type)!;
      return {
        sourceId: source.id,
        sourceType: sourceTypes.get(source.type)!,
        eventType: name,
        timeTicks: typeof event.time === "string" && /^\d+(?:\.\d+)?$/.test(event.time) ? event.time : null,
        phase: integer(event.phase) ? event.phase : null,
        dependentSourceIds: dependencies(params),
        local: endpoint(params.source_address ?? params.local_address ?? params.localAddress),
        remote: endpoint(params.address ?? params.remote_address ?? params.remoteAddress),
        peers: Array.isArray(params.address_list)
          ? params.address_list.map(endpoint).filter((v) => v !== null)
          : [],
        url: typeof params.url === "string" ? params.url : null,
      };
    });
    // A socket/controller can emit certificate or proxy-resolution events itself. Those events
    // must not erase its request-local socket edges. Identify shared nodes by their actual type,
    // then omit only the resolver/proxy/certificate edges on the remaining local nodes.
    const excluded = new Set(
      rows
        .filter((row) => row.sourceType === "NONE" || sharedSource.test(row.sourceType))
        .map((row) => row.sourceId),
    );
    const roots = new Set(
      rows
        .filter(
          (row) =>
            row.sourceType === "URL_REQUEST" && row.url === exactUrl && /URL_REQUEST/.test(row.eventType),
        )
        .map((row) => row.sourceId),
    );
    if (roots.size !== 1) fail("REQUEST_AMBIGUOUS");
    const rootId = [...roots][0];
    if (excluded.has(rootId)) fail("REQUEST_AMBIGUOUS");
    const edges = new Map<number, Set<number>>();
    const link = (a: number, b: number) => {
      if (!edges.has(a)) edges.set(a, new Set());
      edges.get(a)!.add(b);
    };
    for (const row of rows) {
      if (excluded.has(row.sourceId) || shared.test(row.eventType)) continue;
      for (const other of row.dependentSourceIds) {
        // A missing source may be a shared service outside this capture. It cannot bridge
        // two otherwise unrelated local nodes without an observed source identity.
        if (!sourceIdentities.has(other) || excluded.has(other)) continue;
        link(row.sourceId, other);
        link(other, row.sourceId);
      }
    }
    const reached = new Set([rootId]),
      queue = [rootId];
    for (let i = 0; i < queue.length; i++) {
      for (const neighbor of edges.get(queue[i]) ?? []) {
        if (reached.has(neighbor)) continue;
        reached.add(neighbor);
        if (reached.size > MAX_RELATED) fail("LOG_LIMIT");
        queue.push(neighbor);
      }
    }
    const related = rows.filter((row) => reached.has(row.sourceId));
    if (
      related.some(
        (row) =>
          row.url !== null &&
          /URL_REQUEST/.test(row.eventType) &&
          (row.url !== exactUrl || row.sourceId !== rootId),
      )
    )
      fail("REQUEST_AMBIGUOUS");
    const sockets = new Map<
      string,
      { sourceId: number; local: AnonymousSocketEndpoint; remote: AnonymousSocketEndpoint }
    >();
    for (const row of related) {
      if (!row.local || !/TCP_CONNECT|SOCKET/.test(row.eventType)) continue;
      const sourceEvents = related.filter((r) => r.sourceId === row.sourceId);
      if (
        row.sourceType !== "SOCKET" ||
        sourceEvents.some((r) => /UDP|QUIC/.test(r.eventType)) ||
        !sourceEvents.some((r) => /TCP_CONNECT/.test(r.eventType))
      )
        fail("SOCKET_AMBIGUOUS");
      const peers = new Map<string, AnonymousSocketEndpoint>();
      for (const sibling of sourceEvents) {
        for (const peer of [sibling.remote, ...sibling.peers])
          if (peer) peers.set(JSON.stringify(peer), peer);
      }
      const remote = row.remote ?? (peers.size === 1 ? [...peers.values()][0] : null);
      if (!remote) fail("SOCKET_AMBIGUOUS");
      const socket = { sourceId: row.sourceId, local: row.local, remote };
      sockets.set(JSON.stringify(socket), socket);
    }
    if (sockets.size !== 1) fail("SOCKET_AMBIGUOUS");
    const socket = [...sockets.values()][0];
    if (socket.remote.port !== target.port) fail("SOCKET_AMBIGUOUS");
    const eventEvidence = related
      .filter((row) => row.dependentSourceIds.length > 0 || row.local !== null || row.remote !== null)
      .map(({ sourceId, eventType, timeTicks, phase, dependentSourceIds, local, remote }) => ({
        sourceId,
        eventType,
        timeTicks,
        phase,
        dependentSourceIds: shared.test(eventType) ? [] : dependentSourceIds.filter((id) => reached.has(id)),
        local,
        remote,
      }));
    if (!eventEvidence.length || eventEvidence.length > 512) fail("LOG_LIMIT");
    const body = {
      kind: "anonymous-netlog-request-socket" as const,
      origin: { protocol: "https:" as const, host: target.host, port: target.port },
      rootId,
      socketSourceId: socket.sourceId,
      relatedSourceIds: [...reached].sort((a, b) => a - b),
      tuple: {
        sourceAddress: socket.local.address,
        sourcePort: socket.local.port,
        remoteAddress: socket.remote.address,
        remotePort: socket.remote.port,
      },
      eventEvidence,
    };
    return freeze({
      available: true,
      observation: { ...body, evidenceId: createHash("sha256").update(JSON.stringify(body)).digest("hex") },
    });
  } catch (error) {
    return { available: false, reason: error instanceof ParseFailure ? error.reason : "INPUT_INVALID" };
  }
}
