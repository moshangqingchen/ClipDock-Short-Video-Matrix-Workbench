import { isIP } from "node:net";
import {
  normalizeKernelDnsHost,
  type ClashReader,
  type KernelDnsQueryResponse,
  type KernelDnsQueryType,
} from "./clash-reader";

export interface KernelDnsControllerVersion {
  readonly controllerVersion: string;
  readonly startedAtMono: number;
  readonly completedAtMono: number;
}
export type KernelDnsAddressClass = "real" | "fake-ip" | "unknown";
export interface KernelDnsAddress {
  readonly address: string;
  readonly addressFamily: "ipv4" | "ipv6";
  /** Candidate grouping from explicit current policy only; never final Chromium DNS evidence. */
  readonly addressClass: KernelDnsAddressClass;
}
export interface KernelDnsAnswer {
  readonly queryType: KernelDnsQueryType;
  readonly name: string;
  readonly type: 1 | 5 | 28;
  readonly ttl: number;
  readonly data: string;
  /** Conservatively starts before the lookup, never after the response arrives. */
  readonly observedAtMono: number;
  /** Original TTL deadline. maxTtlMs does not rewrite this timestamp or ttl. */
  readonly expiresAtMono: number;
}
export type KernelDnsHostReason =
  | "QUERY_FAILED"
  | "DNS_STATUS"
  | "TRUNCATED"
  | "QUESTION_MISMATCH"
  | "ANSWER_INVALID"
  | "CNAME_INVALID"
  | "FAMILY_MISSING"
  | "FAKE_IP_UNVERIFIED"
  | "ADDRESS_CLASS_UNKNOWN"
  | "EXPIRED"
  | "CONTROLLER_CHANGED";
export interface KernelDnsQueryObservation {
  readonly type: KernelDnsQueryType;
  readonly startedAtMono: number;
  readonly completedAtMono: number;
  readonly response: KernelDnsQueryResponse | null;
  readonly error: "QUERY_FAILED" | null;
}
export interface KernelDnsHostCandidate {
  readonly host: string;
  readonly status: "candidate" | "unverified";
  readonly reasons: readonly KernelDnsHostReason[];
  /** Observed addresses for bounded route inspection, not permission to dial them. */
  readonly ipv4: readonly string[];
  readonly ipv6: readonly string[];
  readonly addresses: readonly KernelDnsAddress[];
  readonly queries: readonly KernelDnsQueryObservation[];
  readonly answers: readonly KernelDnsAnswer[];
  readonly startedAtMono: number;
  readonly completedAtMono: number;
  readonly expiresAtMono: number;
}
export interface KernelDnsCandidates {
  readonly available: true;
  readonly kind: "kernel-dns-candidates";
  readonly chromiumResolutionProven: false;
  readonly status: "candidate" | "unverified";
  readonly controllerVersionBefore: KernelDnsControllerVersion;
  readonly controllerVersionAfter: KernelDnsControllerVersion;
  readonly startedAtMono: number;
  readonly completedAtMono: number;
  /** Actual reader policy cap (round start + configured maxTtlMs), separate from every answer TTL.
   * Older providers may omit it; consumers must then retain the conservative overall deadline. */
  readonly ttlCapAtMono?: number;
  readonly expiresAtMono: number;
  readonly hosts: readonly KernelDnsHostCandidate[];
}
export type KernelDnsSnapshot =
  | KernelDnsCandidates
  | Readonly<{
      available: false;
      reason: KernelDnsErrorCode;
      startedAtMono: number;
      completedAtMono: number;
    }>;
export interface KernelDnsReaderOptions {
  reader: Pick<ClashReader, "readDnsQuery">;
  /** Must perform a current read within this round; historical snapshots are rejected. */
  readControllerVersion: (signal: AbortSignal) => Promise<KernelDnsControllerVersion>;
  /** Does not establish final resolver/path identity, even when this explicitly returns real. */
  classifyAddress?: (address: string, controllerVersion: string) => KernelDnsAddressClass;
  now?: () => number;
  maxHosts?: number;
  /** Maximum A/AAAA HTTP requests together, not host count. */
  concurrency?: number;
  timeoutMs?: number;
  maxTtlMs?: number;
}
export type KernelDnsErrorCode =
  | "INPUT_INVALID"
  | "READ_BUSY"
  | "READ_TIMEOUT"
  | "CANCELLED"
  | "INVALIDATED"
  | "DISPOSED"
  | "CONTROLLER_UNAVAILABLE"
  | "CONTROLLER_VERSION_INVALID";
export class KernelDnsError extends Error {
  constructor(readonly code: KernelDnsErrorCode) {
    super(code);
    this.name = "KernelDnsError";
  }
}
function fail(code: KernelDnsErrorCode): never {
  throw new KernelDnsError(code);
}
const QUERY_TYPES = ["A", "AAAA"] as const;

/** Main-only, one bounded round at a time. No address substitution, dial, Session or persisted cache. */
export class KernelDnsReader {
  private readonly now: () => number;
  private readonly maxHosts: number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly maxTtlMs: number;
  private active: AbortController | null = null;
  private disposed = false;

  constructor(private readonly options: KernelDnsReaderOptions) {
    this.now = options.now ?? (() => performance.now());
    this.maxHosts = bounded(options.maxHosts ?? 64, 1, 64);
    this.concurrency = bounded(options.concurrency ?? 4, 1, 8);
    this.timeoutMs = bounded(options.timeoutMs ?? 10_000, 1, 30_000);
    this.maxTtlMs = bounded(options.maxTtlMs ?? 15_000, 1, 60_000);
  }

  invalidate(): void {
    this.active?.abort(new KernelDnsError("INVALIDATED"));
  }
  dispose(): void {
    this.disposed = true;
    this.active?.abort(new KernelDnsError("DISPOSED"));
  }

  async read(hosts: readonly string[], signal?: AbortSignal): Promise<KernelDnsSnapshot> {
    const startedAtMono = this.now();
    try {
      return await this.readOnce(hosts, startedAtMono, signal);
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: error instanceof KernelDnsError ? error.code : "CONTROLLER_UNAVAILABLE",
        startedAtMono,
        completedAtMono: this.now(),
      });
    }
  }

  private async readOnce(
    hosts: readonly string[],
    startedAtMono: number,
    signal?: AbortSignal,
  ): Promise<KernelDnsCandidates> {
    if (this.disposed) fail("DISPOSED");
    if (this.active) fail("READ_BUSY");
    if (signal?.aborted) fail("CANCELLED");
    // Bound the original input before normalization/deduplication, including repeated entries.
    if (!Array.isArray(hosts) || !hosts.length || hosts.length > this.maxHosts) fail("INPUT_INVALID");
    let targets: string[];
    try {
      targets = [...new Set(hosts.map(normalizeKernelDnsHost))];
    } catch {
      fail("INPUT_INVALID");
    }
    const controller = new AbortController();
    this.active = controller;
    const cancel = () => controller.abort(new KernelDnsError("CANCELLED"));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new KernelDnsError("READ_TIMEOUT")), this.timeoutMs);
    const guard = (): void => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.disposed) fail("DISPOSED");
    };
    const version = async (): Promise<KernelDnsControllerVersion> => {
      guard();
      const floor = this.now();
      let result: KernelDnsControllerVersion;
      try {
        result = await abortable(
          Promise.resolve().then(() => this.options.readControllerVersion(controller.signal)),
          controller.signal,
        );
      } catch {
        guard();
        fail("CONTROLLER_UNAVAILABLE");
      }
      guard();
      if (
        !result ||
        !/^[a-f0-9]{64}$/.test(result.controllerVersion) ||
        !validWindow(result.startedAtMono, result.completedAtMono, floor, this.now())
      )
        fail("CONTROLLER_VERSION_INVALID");
      return Object.freeze({
        controllerVersion: result.controllerVersion,
        startedAtMono: result.startedAtMono,
        completedAtMono: result.completedAtMono,
      });
    };
    try {
      const before = await version();
      const observations = new Map<string, KernelDnsQueryObservation[]>();
      const jobs = targets.flatMap((host) => QUERY_TYPES.map((type) => ({ host, type })));
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          guard();
          const { host, type } = jobs[next++];
          const floor = this.now();
          let observation: KernelDnsQueryObservation;
          try {
            const response = await abortable(
              Promise.resolve().then(() => this.options.reader.readDnsQuery(host, type, controller.signal)),
              controller.signal,
            );
            guard();
            if (!validWindow(response.startedAtMono, response.completedAtMono, floor, this.now()))
              throw new Error();
            observation = { type, response, error: null, startedAtMono: floor, completedAtMono: this.now() };
          } catch {
            guard();
            observation = {
              type,
              response: null,
              error: "QUERY_FAILED",
              startedAtMono: floor,
              completedAtMono: this.now(),
            };
          }
          const rows = observations.get(host) ?? [];
          rows.push(observation);
          observations.set(host, rows);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, jobs.length) }, worker));
      guard();
      const after = await version();
      guard();
      const completedAtMono = this.now();
      const stable = before.controllerVersion === after.controllerVersion;
      const candidates = targets.map((host) =>
        projectHost(
          host,
          observations.get(host)!,
          before.controllerVersion,
          stable,
          completedAtMono,
          startedAtMono + this.maxTtlMs,
          this.options.classifyAddress,
        ),
      );
      return Object.freeze({
        available: true,
        kind: "kernel-dns-candidates",
        chromiumResolutionProven: false,
        status: candidates.every((entry) => entry.status === "candidate") ? "candidate" : "unverified",
        controllerVersionBefore: before,
        controllerVersionAfter: after,
        startedAtMono,
        completedAtMono,
        ttlCapAtMono: startedAtMono + this.maxTtlMs,
        expiresAtMono: Math.min(...candidates.map((entry) => entry.expiresAtMono)),
        hosts: Object.freeze(candidates),
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.abort();
      if (this.active === controller) this.active = null;
    }
  }
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) fail("INPUT_INVALID");
  return value;
}
function validWindow(start: number, end: number, floor: number, ceiling: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && start >= floor && end >= start && end <= ceiling;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

function projectHost(
  host: string,
  observations: KernelDnsQueryObservation[],
  version: string,
  stable: boolean,
  now: number,
  cap: number,
  classify?: KernelDnsReaderOptions["classifyAddress"],
): KernelDnsHostCandidate {
  const reasons = new Set<KernelDnsHostReason>();
  const answers: KernelDnsAnswer[] = [];
  const addresses = new Map<string, KernelDnsAddress>();
  let expiresAtMono = cap;
  if (!stable) reasons.add("CONTROLLER_CHANGED");
  const queries = QUERY_TYPES.map((type) => observations.find((entry) => entry.type === type)!);
  for (const query of queries) {
    const response = query.response;
    if (!response) {
      reasons.add("QUERY_FAILED");
      continue;
    }
    if (
      response.host !== host ||
      response.queryType !== query.type ||
      response.question?.name !== host ||
      response.question.type !== (query.type === "A" ? 1 : 28)
    ) {
      reasons.add("QUESTION_MISMATCH");
      continue;
    }
    if (response.status !== 0) {
      reasons.add("DNS_STATUS");
      continue;
    }
    if (response.truncated !== false) {
      reasons.add("TRUNCATED");
      continue;
    }
    const parsed = parseAnswers(host, query.type, response.answers);
    if (typeof parsed === "string") {
      reasons.add(parsed);
      continue;
    }
    for (const rr of response.answers) {
      const expiry = response.startedAtMono + rr.ttl * 1000;
      answers.push(
        Object.freeze({
          queryType: query.type,
          ...rr,
          observedAtMono: response.startedAtMono,
          expiresAtMono: expiry,
        }),
      );
      expiresAtMono = Math.min(expiresAtMono, expiry);
    }
    if (!parsed.length) reasons.add("FAMILY_MISSING");
    for (const raw of parsed) {
      const address = isIP(raw) === 6 ? new URL(`http://[${raw}]/`).hostname.slice(1, -1) : raw;
      let addressClass: KernelDnsAddressClass = "unknown";
      try {
        const value = classify?.(address, version);
        if (value === "real" || value === "fake-ip") addressClass = value;
      } catch {
        /* Unknown policy cannot establish real addresses. */
      }
      // Never reinterpret the conventional fake-IP/benchmark range as a remote origin.
      if (/^198\.(18|19)\./.test(address)) addressClass = "fake-ip";
      if (addressClass === "fake-ip") reasons.add("FAKE_IP_UNVERIFIED");
      if (addressClass === "unknown") reasons.add("ADDRESS_CLASS_UNKNOWN");
      addresses.set(
        address,
        Object.freeze({ address, addressFamily: isIP(address) === 4 ? "ipv4" : "ipv6", addressClass }),
      );
    }
  }
  if (expiresAtMono <= now) reasons.add("EXPIRED");
  const entries = [...addresses.values()];
  return Object.freeze({
    host,
    status: reasons.size ? "unverified" : "candidate",
    reasons: Object.freeze([...reasons]),
    ipv4: Object.freeze(
      entries.filter((entry) => entry.addressFamily === "ipv4").map((entry) => entry.address),
    ),
    ipv6: Object.freeze(
      entries.filter((entry) => entry.addressFamily === "ipv6").map((entry) => entry.address),
    ),
    addresses: Object.freeze(entries),
    queries: Object.freeze(queries.map((entry) => Object.freeze(entry))),
    answers: Object.freeze(answers),
    startedAtMono: Math.min(...queries.map((entry) => entry.startedAtMono)),
    completedAtMono: Math.max(...queries.map((entry) => entry.completedAtMono)),
    expiresAtMono,
  });
}

function parseAnswers(
  host: string,
  type: KernelDnsQueryType,
  records: KernelDnsQueryResponse["answers"],
): string[] | "ANSWER_INVALID" | "CNAME_INVALID" {
  if (!Array.isArray(records) || records.length > 128) return "ANSWER_INVALID";
  const cnames = new Map<string, string>();
  try {
    for (const rr of records) {
      if (
        !rr ||
        normalizeKernelDnsHost(rr.name) !== rr.name ||
        !Number.isInteger(rr.ttl) ||
        rr.ttl < 0 ||
        rr.ttl > 2_147_483_647
      )
        return "ANSWER_INVALID";
      if (rr.type === 5) {
        if (
          normalizeKernelDnsHost(rr.data) !== rr.data ||
          (cnames.has(rr.name) && cnames.get(rr.name) !== rr.data)
        )
          return "CNAME_INVALID";
        cnames.set(rr.name, rr.data);
      } else if (
        rr.type !== (type === "A" ? 1 : 28) ||
        rr.data.includes("%") ||
        isIP(rr.data) !== (type === "A" ? 4 : 6)
      )
        return "ANSWER_INVALID";
    }
  } catch {
    return "ANSWER_INVALID";
  }
  const seen = new Set<string>();
  let leaf = host;
  while (cnames.has(leaf)) {
    if (seen.has(leaf) || seen.size >= 16) return "CNAME_INVALID";
    seen.add(leaf);
    leaf = cnames.get(leaf)!;
  }
  if (
    seen.has(leaf) ||
    [...cnames.keys()].some((name) => !seen.has(name)) ||
    records.some((rr) => rr.type !== 5 && rr.name !== leaf)
  )
    return "CNAME_INVALID";
  return [...new Set(records.filter((rr) => rr.type !== 5).map((rr) => rr.data))];
}
