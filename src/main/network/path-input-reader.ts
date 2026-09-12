import { createHash } from "node:crypto";
import { NETWORK_TIMING } from "@shared/network";
import { normalizeProofTarget, proofTargetKey, type ProofTarget } from "./direct-proof";
import type { EffectiveConfigCandidate, EffectiveConfigSource } from "./effective-config-source";
import type { KernelDnsCandidates, KernelDnsReader } from "./kernel-dns";
import type { ProofScopeVersion } from "./proof-issuer";
import type {
  WindowsControllerOwnerReader,
  WindowsControllerOwnerSnapshot,
} from "./windows-controller-owner";
import type { WindowsNetworkFingerprintReader } from "./windows-network-fingerprint";
import { WindowsRouteSelectionReader, type WindowsRouteSelectionSnapshot } from "./windows-route-selection";
import type { WindowsSystemHostsReader, WindowsSystemHostsSnapshot } from "./windows-system-hosts";

type Owner = Extract<WindowsControllerOwnerSnapshot, { available: true }>;
type Routes = Extract<WindowsRouteSelectionSnapshot, { available: true }>;
type SystemHosts = Extract<WindowsSystemHostsSnapshot, { available: true }>;
interface NetworkRead {
  hash: string;
  startedAtMono: number;
  completedAtMono: number;
}
export interface PathInputRequest extends ProofScopeVersion {
  targets: readonly ProofTarget[];
}
export interface CurrentPathInputs extends ProofScopeVersion {
  readonly state: "observed";
  /** Actual input observations, never a ValidatedRulePath or an account permit. */
  readonly kind: "current-path-inputs";
  readonly sampleId: string;
  readonly targets: readonly ProofTarget[];
  readonly startedAtMono: number;
  readonly completedAtMono: number;
  readonly expiresAtMono: number;
  readonly configurationBefore: EffectiveConfigCandidate;
  readonly configurationAfter: EffectiveConfigCandidate;
  readonly ownerBefore: Owner;
  readonly ownerAfter: Owner;
  readonly networkBefore: NetworkRead;
  readonly networkAfter: NetworkRead;
  /** Production always supplies both. Absent legacy inputs do not mean an empty hosts file. */
  readonly systemHostsBefore?: SystemHosts;
  readonly systemHostsAfter?: SystemHosts;
  readonly dnsBefore: KernelDnsCandidates;
  readonly dnsAfter: KernelDnsCandidates;
  readonly routeBatches: readonly Routes[];
}
export type PathInputFailure =
  | "INPUT_INVALID"
  | "READ_BUSY"
  | "READ_TIMEOUT"
  | "READ_CANCELLED"
  | "DISPOSED"
  | "SOURCE_UNAVAILABLE"
  | "KERNEL_UNAVAILABLE"
  | "NETWORK_UNAVAILABLE"
  | "DNS_UNAVAILABLE"
  | "SYSTEM_HOSTS_UNAVAILABLE"
  | "ROUTES_UNAVAILABLE"
  | "NETWORK_CHANGED"
  | "INPUT_EXPIRED";
export type PathInputResult =
  | CurrentPathInputs
  | Readonly<{
      state: "unavailable";
      reason: PathInputFailure;
      startedAtMono: number;
      completedAtMono: number;
    }>;
export interface PathInputReaderOptions {
  configuration: Pick<EffectiveConfigSource, "read">;
  owner: Pick<WindowsControllerOwnerReader, "read">;
  network: Pick<WindowsNetworkFingerprintReader, "readObservation">;
  dns: Pick<KernelDnsReader, "read">;
  systemHosts?: Pick<WindowsSystemHostsReader, "read">;
  /** Current Gate version in production; an absent/unreadable environment is not reconstructed. */
  readVersion(): ProofScopeVersion | null;
  createRouteReader?: (
    addresses: readonly string[],
  ) => Pick<WindowsRouteSelectionReader, "read" | "dispose"> &
    Partial<Pick<WindowsRouteSelectionReader, "whenIdle">>;
  now?: () => number;
  timeoutMs?: number;
  maxAddresses?: number;
}
class InputError extends Error {
  constructor(readonly reason: PathInputFailure) {
    super(reason);
  }
}
function fail(reason: PathInputFailure): never {
  throw new InputError(reason);
}
/** Retain all real provider work even if another provider fails first. */
async function settledTuple<T extends readonly unknown[]>(values: {
  [K in keyof T]: Promise<T[K]>;
}): Promise<T> {
  const results = await Promise.allSettled(values);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  }) as unknown as T;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function configIdentity(value: EffectiveConfigCandidate): string {
  return digest([
    value.sourceGeneration,
    value.sourcePathIdentity,
    value.fileFingerprint,
    value.decoderIdentity,
    value.controllerFingerprint,
    value.orderedRulesFingerprint,
    value.sourceRuleOptionsFingerprint,
    value.policy.fingerprint,
    value.currentDirectPolicy.policyFingerprint,
  ]);
}
function requestedQuery(families: ReadonlySet<string>, host: string, type: "A" | "AAAA"): boolean {
  return families.has(`${host}|${type === "A" ? "ipv4" : "ipv6"}`);
}
/** Compare only the declared host/AF scope; retain the full DNS observations in the returned record. */
function dnsIdentity(value: KernelDnsCandidates, families: ReadonlySet<string>): string {
  return digest(
    value.hosts
      .map((host) => [
        host.host,
        host.queries
          .filter((query) => requestedQuery(families, host.host, query.type))
          .map((query) => [
            query.type,
            query.error,
            query.response?.host ?? null,
            query.response?.queryType ?? null,
            query.response?.status ?? null,
            query.response?.truncated ?? null,
            query.response?.question ?? null,
          ])
          .sort(),
        host.addresses
          .filter((address) => families.has(`${host.host}|${address.addressFamily}`))
          .map((address) => [address.address, address.addressFamily, address.addressClass])
          .sort(),
        host.answers
          .filter((answer) => requestedQuery(families, host.host, answer.queryType))
          .map((answer) => [answer.queryType, answer.name, answer.type, answer.data])
          .sort(),
      ])
      .sort(),
  );
}

/** No default TTL is invented when the provider did not publish its actual cap. */
function dnsDeadline(value: KernelDnsCandidates, families: ReadonlySet<string>): number {
  if (value.ttlCapAtMono === undefined) return value.expiresAtMono;
  if (!Number.isFinite(value.ttlCapAtMono) || value.ttlCapAtMono < value.startedAtMono) return NaN;
  return Math.min(
    value.ttlCapAtMono,
    ...value.hosts.flatMap((host) =>
      host.answers
        .filter((answer) => requestedQuery(families, host.host, answer.queryType))
        .map((answer) => answer.expiresAtMono),
    ),
  );
}

/**
 * Collect real configuration/DNS/owner/OS/route records in one bounded window. A stable window
 * is not an atomic routing lock, physical DIRECT conformance, final Chromium DNS or CN exit proof.
 * The path verifier must still supply those independently supported facts.
 */
export class PathInputReader {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxAddresses: number;
  private active: AbortController | null = null;
  private pendingKey: string | null = null;
  private pending: Promise<PathInputResult> | null = null;
  private readonly draining = new Set<Promise<void>>();
  private disposed = false;
  private sequence = 0;

  constructor(private readonly options: PathInputReaderOptions) {
    this.now = options.now ?? (() => performance.now());
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAddresses = options.maxAddresses ?? 128;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000 ||
      !Number.isInteger(this.maxAddresses) ||
      this.maxAddresses < 1 ||
      this.maxAddresses > 256
    )
      throw new Error("PATH_INPUT_OPTIONS_INVALID");
  }

  read(request: PathInputRequest, signal?: AbortSignal): Promise<PathInputResult> {
    const start = this.now();
    const rejected = (reason: PathInputFailure): PathInputResult =>
      Object.freeze({
        state: "unavailable",
        reason,
        startedAtMono: start,
        completedAtMono: this.now(),
      });
    if (this.disposed) return Promise.resolve(rejected("DISPOSED"));
    if (signal?.aborted) return Promise.resolve(rejected("READ_CANCELLED"));
    const keys = Array.isArray(request?.targets) ? request.targets.map(proofTargetKey) : [];
    if (
      !keys.length ||
      keys.length > 128 ||
      keys.some((key) => !key) ||
      new Set(keys).size !== keys.length ||
      !Number.isSafeInteger(request.generation) ||
      request.generation < 1 ||
      typeof request.rulesVersion !== "string" ||
      !request.rulesVersion ||
      request.rulesVersion.length > 256
    )
      return Promise.resolve(rejected("INPUT_INVALID"));
    const key = digest([request.generation, request.rulesVersion, [...keys].sort()]);
    if (this.pending && key !== this.pendingKey) return Promise.resolve(rejected("READ_BUSY"));
    if (this.pending) {
      this.joinSignal(signal, this.active!, this.pending);
      return this.pending;
    }
    const captured = structuredClone(request);
    const abort = new AbortController();
    this.active = abort;
    this.pendingKey = key;
    const timer = setTimeout(() => abort.abort(new InputError("READ_TIMEOUT")), this.timeoutMs);
    const work = this.collect(captured, start, ++this.sequence, abort.signal);
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    const result = Promise.race([work, cancelled]).catch((error: unknown) =>
      rejected(error instanceof InputError ? error.reason : "SOURCE_UNAVAILABLE"),
    );
    this.pending = result;
    this.joinSignal(signal, abort, result);
    // A source that ignores cancellation retains its real slot until it settles.
    const draining = Promise.allSettled([work, result]).then(() => {
      clearTimeout(timer);
      if (this.pending === result) {
        this.pending = null;
        this.pendingKey = null;
        this.active = null;
      }
    });
    this.draining.add(draining);
    void draining.then(() => this.draining.delete(draining));
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.active?.abort(new InputError("DISPOSED"));
  }

  /** Includes the original collection and its owned route readers, not only the cancellation race. */
  whenIdle(): Promise<void> {
    return Promise.allSettled([...this.draining]).then(() => undefined);
  }

  private joinSignal(
    signal: AbortSignal | undefined,
    abort: AbortController,
    result: Promise<unknown>,
  ): void {
    if (!signal) return;
    const cancel = () => abort.abort(new InputError("READ_CANCELLED"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void result.finally(() => signal.removeEventListener("abort", cancel));
  }

  private async collect(
    request: PathInputRequest,
    start: number,
    sequence: number,
    signal: AbortSignal,
  ): Promise<CurrentPathInputs> {
    const check = () => {
      if (signal.aborted) throw signal.reason;
      const version = this.options.readVersion();
      if (
        !version ||
        version.generation !== request.generation ||
        version.rulesVersion !== request.rulesVersion
      )
        fail("NETWORK_CHANGED");
    };
    const requireWindow = (value: { startedAtMono: number; completedAtMono: number }, floor: number) => {
      if (
        !Number.isFinite(value.startedAtMono) ||
        !Number.isFinite(value.completedAtMono) ||
        value.startedAtMono < floor ||
        value.completedAtMono < value.startedAtMono ||
        value.completedAtMono > this.now()
      )
        fail("INPUT_EXPIRED");
    };
    const readConfig = async () => {
      check();
      const floor = this.now();
      const result = await this.options.configuration.read();
      check();
      if (result.state !== "candidate") return fail("SOURCE_UNAVAILABLE");
      requireWindow(result.candidate, floor);
      if (result.candidate.controllerFingerprint !== request.rulesVersion) return fail("NETWORK_CHANGED");
      return structuredClone(result.candidate);
    };
    const readOwner = async () => {
      check();
      const floor = this.now();
      const result = await this.options.owner.read(signal);
      check();
      requireWindow(result, floor);
      return result.available ? structuredClone(result) : fail("KERNEL_UNAVAILABLE");
    };
    const readNetwork = async (): Promise<NetworkRead> => {
      check();
      const floor = this.now(),
        result = await this.options.network.readObservation();
      check();
      requireWindow(result, floor);
      return result.available
        ? { hash: result.hash, startedAtMono: result.startedAtMono, completedAtMono: result.completedAtMono }
        : fail("NETWORK_UNAVAILABLE");
    };
    const hosts = [...new Set(request.targets.map((target) => normalizeProofTarget(target)!.host))].sort();
    const readSystemHosts = async () => {
      if (!this.options.systemHosts) return undefined;
      check();
      const floor = this.now();
      const result = await this.options.systemHosts.read(hosts, signal);
      check();
      requireWindow(result, floor);
      if (
        !result.available ||
        result.kind !== "windows-system-hosts-targets" ||
        result.source !== "windows-system-hosts-file" ||
        result.resolutionProven !== false ||
        result.parserProfile !== "windows-hosts-ascii-aliases-v1" ||
        ![result.scopeHash, result.fileHash, result.fileIdentity].every((value) =>
          /^[a-f0-9]{64}$/.test(value),
        ) ||
        result.scopeHash !== digest(hosts) ||
        JSON.stringify(result.hosts.map((value) => value.host).sort()) !== JSON.stringify(hosts)
      )
        return fail("SYSTEM_HOSTS_UNAVAILABLE");
      return structuredClone(result);
    };
    const readDns = async () => {
      check();
      const floor = this.now();
      const result = await this.options.dns.read(hosts, signal);
      check();
      requireWindow(result, floor);
      if (!result.available) return fail("DNS_UNAVAILABLE");
      if (
        result.controllerVersionBefore.controllerVersion !== request.rulesVersion ||
        result.controllerVersionAfter.controllerVersion !== request.rulesVersion
      )
        return fail("NETWORK_CHANGED");
      if (JSON.stringify(result.hosts.map((host) => host.host).sort()) !== JSON.stringify(hosts))
        return fail("DNS_UNAVAILABLE");
      return structuredClone(result);
    };
    const [configurationBefore, ownerBefore, networkBefore, systemHostsBefore] = await settledTuple([
      readConfig(),
      readOwner(),
      readNetwork(),
      readSystemHosts(),
    ] as const);
    const dnsBefore = await readDns();
    // This reader observes the caller's declared host/AF scope; it does not choose possible
    // business families. The issuer must declare both unless an independent constraint exists.
    const requestedFamilies = new Set(
      request.targets.map((target) => `${normalizeProofTarget(target)!.host}|${target.addressFamily}`),
    );
    const addresses = [
      ...new Set(
        dnsBefore.hosts.flatMap((host) =>
          host.addresses
            .filter((value) => requestedFamilies.has(`${host.host}|${value.addressFamily}`))
            .map((value) => value.address),
        ),
      ),
    ].sort();
    if (addresses.length > this.maxAddresses) fail("ROUTES_UNAVAILABLE");
    const routeBatches: Routes[] = [];
    for (let offset = 0; offset < addresses.length; offset += 16) {
      check();
      const selected = addresses.slice(offset, offset + 16);
      const reader =
        this.options.createRouteReader?.(selected) ??
        new WindowsRouteSelectionReader({ addresses: selected });
      try {
        const floor = this.now();
        const result = await reader.read(signal);
        check();
        requireWindow(result, floor);
        if (
          !result.available ||
          result.basis !== "windows-best-route-query" ||
          result.localAddress !== undefined ||
          JSON.stringify(result.selections.map((row) => row.targetAddress).sort()) !==
            JSON.stringify(selected)
        )
          fail("ROUTES_UNAVAILABLE");
        routeBatches.push(structuredClone(result));
      } finally {
        reader.dispose();
        await reader.whenIdle?.();
      }
    }
    const [configurationAfter, ownerAfter, networkAfter, systemHostsAfter] = await settledTuple([
      readConfig(),
      readOwner(),
      readNetwork(),
      readSystemHosts(),
    ] as const);
    // Finish the slower OS/source postflight before refreshing short-lived DNS. Each DNS read
    // also reads the actual controller version before/after its queries. Keep all original
    // sampling times and reject changed answers; this bounded window is not an atomic lock.
    const dnsAfter = await readDns();
    check();
    if (
      configIdentity(configurationBefore) !== configIdentity(configurationAfter) ||
      ownerBefore.kernelEpoch !== ownerAfter.kernelEpoch ||
      ownerBefore.scopeHash !== ownerAfter.scopeHash ||
      networkBefore.hash !== networkAfter.hash ||
      JSON.stringify(
        systemHostsBefore && [
          systemHostsBefore.fileHash,
          systemHostsBefore.fileIdentity,
          systemHostsBefore.scopeHash,
          systemHostsBefore.hosts,
        ],
      ) !==
        JSON.stringify(
          systemHostsAfter && [
            systemHostsAfter.fileHash,
            systemHostsAfter.fileIdentity,
            systemHostsAfter.scopeHash,
            systemHostsAfter.hosts,
          ],
        ) ||
      dnsIdentity(dnsBefore, requestedFamilies) !== dnsIdentity(dnsAfter, requestedFamilies)
    )
      fail("NETWORK_CHANGED");
    const completedAtMono = this.now();
    const expiresAtMono = Math.min(
      configurationBefore.expiresAtMono,
      configurationAfter.expiresAtMono,
      dnsDeadline(dnsAfter, requestedFamilies),
      ...[systemHostsBefore, systemHostsAfter].flatMap((value) =>
        value ? [value.startedAtMono + NETWORK_TIMING.proofTtlMs] : [],
      ),
    );
    if (!Number.isFinite(expiresAtMono) || completedAtMono >= expiresAtMono) fail("INPUT_EXPIRED");
    return freeze({
      state: "observed",
      kind: "current-path-inputs",
      sampleId: digest([start, sequence, ownerAfter.kernelEpoch]),
      generation: request.generation,
      rulesVersion: request.rulesVersion,
      targets: request.targets.map((target) => normalizeProofTarget(target)!),
      startedAtMono: start,
      completedAtMono,
      expiresAtMono,
      configurationBefore,
      configurationAfter,
      ownerBefore,
      ownerAfter,
      networkBefore,
      networkAfter,
      ...(systemHostsBefore && systemHostsAfter ? { systemHostsBefore, systemHostsAfter } : {}),
      dnsBefore,
      dnsAfter,
      routeBatches,
    });
  }
}
