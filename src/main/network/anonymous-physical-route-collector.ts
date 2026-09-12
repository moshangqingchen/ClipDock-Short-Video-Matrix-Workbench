import { app } from "electron";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  AnonymousProofProbe,
  ANONYMOUS_TLS_FACTORY_ID,
  type AnonymousTlsObserverContext,
  type AnonymousTlsObserverTiming,
  type AnonymousTlsObservation,
  type AnonymousProbeResult,
} from "./anonymous-proof-probe";
import { AnonymousNetLogCapture } from "./anonymous-netlog-capture";
import {
  parseAnonymousRequestSocket,
  type AnonymousRequestSocketObservation,
} from "./anonymous-request-socket";
import {
  associateCurrentConfiguration,
  validateConfigurationAssociationForFreshDns,
  type CurrentConfigurationAssociation,
  type KnownSelectedLoaderContract,
} from "./configuration-association";
import { normalizeProofTarget, type ProofTarget } from "./direct-proof";
import type { ClashReadResult } from "./clash-reader";
import type { KernelConnectionObservation, KernelConnectionsSnapshot } from "./connection-evidence";
import type { KernelDnsCandidates, KernelDnsReader } from "./kernel-dns";
import type { CurrentPathInputs, PathInputReader } from "./path-input-reader";
import type { ProofScopeVersion } from "./proof-issuer";
import { currentDirectOutbound } from "./production-proof-source";
import { createResolverFlowMapping, type ResolverFlowMappingObservation } from "./resolver-flow-mapping";
import {
  routeApplicabilityBinding,
  type RouteConformanceRecord,
  type RouteConformanceSample,
} from "./route-applicability";
import { evaluateRules } from "./rules";
import {
  WindowsTcpSocketReader,
  type WindowsTcpSocketScope,
  type WindowsTcpSocketSnapshot,
  type WindowsTcpSocketRow,
  type WindowsTcpOwnerIdentity,
} from "./windows-tcp-sockets";
import {
  WindowsRouteSelectionReader,
  type WindowsRouteSelectionScope,
  type WindowsRouteSelectionSnapshot,
} from "./windows-route-selection";

type Tcp = Extract<WindowsTcpSocketSnapshot, { available: true }>;
type Capture = Pick<AnonymousNetLogCapture, "start" | "finish" | "dispose" | "whenIdle">;
type Routes = Pick<WindowsRouteSelectionReader, "read" | "dispose" | "whenIdle">;
export interface OwnedConnectionClose {
  readonly status: number;
  readonly startedAtMono: number;
  readonly completedAtMono: number;
}
export interface AnonymousPhysicalRouteCollectorOptions {
  inputs: Pick<PathInputReader, "read" | "whenIdle">;
  dns: Pick<KernelDnsReader, "read">;
  readController(signal: AbortSignal): Promise<ClashReadResult>;
  readConnections(hosts: readonly string[], signal: AbortSignal): Promise<KernelConnectionsSnapshot>;
  /** Must target the selected controller's exact /connections/{id}, never bulk-close or retry. */
  closeConnection(id: string, signal: AbortSignal): Promise<OwnedConnectionClose>;
  readVersion(): ProofScopeVersion | null;
  isQuiescent(): boolean;
  readersWhenIdle(): Promise<void>;
  probe?: Pick<AnonymousProofProbe, "probeTls" | "whenIdle">;
  createCapture?: () => Capture;
  createTcpReader?: (scope: WindowsTcpSocketScope) => Pick<WindowsTcpSocketReader, "read">;
  createRouteReader?: (scope: WindowsRouteSelectionScope) => Routes;
  readNetworkServicePids?: () => readonly number[];
  now?: () => number;
  timeoutMs?: number;
}
export interface PhysicalRouteSnapshot {
  readonly phase: "baseline" | "both-held" | "after-a" | "after-b";
  readonly tcp: Tcp;
  readonly connections: KernelConnectionsSnapshot;
  readonly completedAtMono: number;
}
export interface AnonymousPhysicalFlow {
  readonly label: "A" | "B";
  readonly factoryId: typeof ANONYMOUS_TLS_FACTORY_ID;
  readonly transportContextId: string;
  readonly timing: AnonymousTlsObserverTiming;
  readonly tls: AnonymousTlsObservation;
  readonly kernelDns: KernelDnsCandidates;
  readonly requestSocket: AnonymousRequestSocketObservation;
  readonly appOwner: WindowsTcpOwnerIdentity;
  readonly appSocket: WindowsTcpSocketRow;
  readonly incoming: KernelConnectionObservation;
  readonly kernelSocket: WindowsTcpSocketRow;
  readonly resolverMapping: ResolverFlowMappingObservation;
  readonly intervention: OwnedConnectionClose & { readonly connectionId: string };
}
export interface AnonymousPhysicalRouteObservation {
  readonly kind: "anonymous-physical-route-observation";
  readonly target: ProofTarget;
  readonly factoryId: typeof ANONYMOUS_TLS_FACTORY_ID;
  readonly transportProfileId: string;
  readonly inputs: CurrentPathInputs;
  readonly postflightInputs: CurrentPathInputs;
  readonly configuration: CurrentConfigurationAssociation;
  readonly loader: KnownSelectedLoaderContract;
  readonly flows: readonly AnonymousPhysicalFlow[];
  readonly snapshots: readonly PhysicalRouteSnapshot[];
  /** Caller must choose a justified retention deadline; this collector grants no q/route TTL. */
  readonly routeFacts: Omit<RouteConformanceRecord, "expiresAtMono"> & { readonly completedAtMono: number };
  readonly completedAtMono: number;
  readonly qualificationGranted: false;
}
export type AnonymousPhysicalRouteResult =
  | { readonly available: true; readonly observation: AnonymousPhysicalRouteObservation }
  | {
      readonly available: false;
      readonly reason: "BUSY" | "CANCELLED" | "QUIET_WINDOW_REQUIRED" | "OBSERVATION_UNAVAILABLE";
    };

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const tuple = (r: WindowsTcpSocketRow) =>
  hash([r.ownerPid, r.sourceAddress, r.sourcePort, r.remoteAddress, r.remotePort]);
const ownerKey = (o: WindowsTcpOwnerIdentity) => hash([o.pid, o.createdAtTicks, o.executablePathIdentity]);
const environment = (i: CurrentPathInputs) =>
  hash([
    i.generation,
    i.rulesVersion,
    i.configurationAfter.sourceGeneration,
    i.configurationAfter.sourcePathIdentity,
    i.configurationAfter.decoderIdentity,
    i.configurationAfter.fileFingerprint,
    i.configurationAfter.policy.fingerprint,
    i.configurationAfter.currentDirectPolicy.policyFingerprint,
    i.ownerAfter.kernelEpoch,
    i.ownerAfter.owner,
    i.ownerAfter.scopeHash,
    i.networkAfter.hash,
    i.systemHostsAfter && [
      i.systemHostsAfter.kind,
      i.systemHostsAfter.source,
      i.systemHostsAfter.parserProfile,
      i.systemHostsAfter.scopeHash,
      i.systemHostsAfter.fileHash,
      i.systemHostsAfter.fileIdentity,
      i.systemHostsAfter.hosts,
    ],
  ]);
function fact(value: unknown): asserts value {
  if (!value) throw new Error("OBSERVATION_UNAVAILABLE");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("OBSERVATION_UNAVAILABLE"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function settle<T extends readonly unknown[]>(values: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(values);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
interface Phase {
  label: "A" | "B";
  startedAtMono: number;
  ready: ReturnType<typeof deferred>;
  release: ReturnType<typeof deferred>;
  held: boolean;
  settled: boolean;
  capture: Capture;
  context?: AnonymousTlsObserverContext;
  timing?: AnonymousTlsObserverTiming;
  dns?: KernelDnsCandidates;
  before?: KernelConnectionsSnapshot;
  socket?: AnonymousRequestSocketObservation;
  pending?: Promise<AnonymousProbeResult>;
  incoming?: KernelConnectionObservation;
  appOwner?: WindowsTcpOwnerIdentity;
  appSocket?: WindowsTcpSocketRow;
  kernelSocket?: WindowsTcpSocketRow;
  intervention?: OwnedConnectionClose & { connectionId: string };
}

/** Two bounded anonymous requests and exact owned-ID interventions in a genuine quiet window.
 * No Session fetch replacement, persisted evidence, profile equivalence, AF constraint or CN claim.
 */
export class AnonymousPhysicalRouteCollector {
  private readonly probe: NonNullable<AnonymousPhysicalRouteCollectorOptions["probe"]>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private pending: Promise<AnonymousPhysicalRouteResult> | null = null;
  private active: AbortController | null = null;
  private epoch = 0;
  private preparing = false;
  private disposed = false;
  private cleanupFailed = false;
  constructor(private readonly options: AnonymousPhysicalRouteCollectorOptions) {
    this.probe = options.probe ?? new AnonymousProofProbe({ concurrency: 2, timeoutMs: 10_000 });
    this.now = options.now ?? (() => performance.now());
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000)
      throw new Error("PHYSICAL_COLLECTOR_OPTIONS_INVALID");
  }
  collect(
    target: ProofTarget,
    loader: KnownSelectedLoaderContract,
    profile: string,
    signal: AbortSignal,
  ): Promise<AnonymousPhysicalRouteResult> {
    if (this.pending || this.preparing) return Promise.resolve({ available: false, reason: "BUSY" });
    if (this.disposed || this.cleanupFailed || signal.aborted)
      return Promise.resolve({ available: false, reason: "CANCELLED" });
    const epoch = this.epoch;
    this.preparing = true;
    let version: ProofScopeVersion | null,
      selected: KnownSelectedLoaderContract,
      normalized: ProofTarget,
      deadline: number;
    try {
      if (!this.options.isQuiescent())
        return Promise.resolve({ available: false, reason: "QUIET_WINDOW_REQUIRED" });
      version = structuredClone(this.options.readVersion());
      selected = structuredClone(loader);
      normalized = normalizeProofTarget(target)!;
      const now = this.now();
      deadline = now + this.timeoutMs;
      fact(
        Number.isFinite(now) &&
          now >= 0 &&
          version &&
          normalized &&
          normalized.protocol === "https:" &&
          /^[a-zA-Z0-9_.:-]{1,256}$/.test(profile),
      );
      fact(!this.disposed && !signal.aborted && epoch === this.epoch && !this.pending);
    } catch {
      return Promise.resolve({ available: false, reason: "OBSERVATION_UNAVAILABLE" });
    } finally {
      this.preparing = false;
    }
    const abort = new AbortController();
    this.active = abort;
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    const work = Promise.resolve()
      .then(() => this.run(normalized, selected, profile, version!, abort, epoch, deadline))
      .then((result) => {
        this.guard(version!, abort.signal, epoch, deadline);
        fact(!this.cleanupFailed);
        return result;
      })
      .catch((): AnonymousPhysicalRouteResult => ({
        available: false,
        reason: abort.signal.aborted ? "CANCELLED" : "OBSERVATION_UNAVAILABLE",
      }))
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (this.active === abort) this.active = null;
        if (this.pending === work) this.pending = null;
      });
    this.pending = work;
    if (signal.aborted) cancel();
    return work;
  }
  invalidate(): void {
    this.epoch++;
    this.active?.abort();
  }
  async whenIdle(): Promise<void> {
    while (this.pending) await this.pending;
    if (this.cleanupFailed) throw new Error("PHYSICAL_COLLECTOR_CLEANUP_FAILED");
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await this.whenIdle();
  }
  private guard(version: ProofScopeVersion, signal: AbortSignal, epoch: number, deadline: number): void {
    const current = this.options.readVersion();
    fact(
      !this.disposed &&
        !signal.aborted &&
        current &&
        current.generation === version.generation &&
        current.rulesVersion === version.rulesVersion &&
        this.options.isQuiescent(),
    );
    fact(!this.disposed && !signal.aborted && epoch === this.epoch && this.now() < deadline);
  }
  private async run(
    target: ProofTarget,
    loader: KnownSelectedLoaderContract,
    profile: string,
    version: ProofScopeVersion,
    abort: AbortController,
    epoch: number,
    deadline: number,
  ): Promise<AnonymousPhysicalRouteResult> {
    const signal = abort.signal,
      phases: Phase[] = [],
      routeReaders: Routes[] = [],
      snapshots: PhysicalRouteSnapshot[] = [];
    const guard = () => this.guard(version, signal, epoch, deadline);
    let completed = false;
    try {
      const readController = async () => {
        const c = structuredClone(await this.options.readController(signal));
        guard();
        fact(
          c.mode === "rule" &&
            c.fingerprint === version.rulesVersion &&
            c.directPolicy?.kind === "direct" &&
            c.directPolicy.dialer === "none",
        );
        fact(
          evaluateRules(c.mode, c.rules, { host: target.host, port: target.port, network: "tcp" }).route ===
            "direct",
        );
        return c;
      };
      guard();
      const controller = await readController();
      const request = { ...version, targets: [target] };
      const inputs = structuredClone(await this.options.inputs.read(request, signal));
      guard();
      fact(
        inputs.state === "observed" &&
          inputs.generation === version.generation &&
          inputs.rulesVersion === version.rulesVersion &&
          inputs.targets.length === 1 &&
          same(normalizeProofTarget(inputs.targets[0]), target),
      );
      const associated = associateCurrentConfiguration({ inputs, loader }, this.now());
      fact(associated.valid && inputs.systemHostsBefore && inputs.systemHostsAfter);
      const configuration = associated.association;
      const referenceOwner = inputs.ownerAfter.owner;
      fact(referenceOwner.executablePathIdentity);
      const family = target.addressFamily === "ipv4" ? 4 : 6;
      const candidates = [
        ...new Set(
          inputs.dnsAfter.hosts
            .filter((h) => h.host === target.host)
            .flatMap((h) => h.addresses)
            .filter((a) => a.addressFamily === target.addressFamily && a.addressClass === "real")
            .map((a) => a.address),
        ),
      ];
      fact(candidates.length > 0 && candidates.length <= 30 && candidates.every((a) => isIP(a) === family));
      const createTcp = (scope: WindowsTcpSocketScope) =>
        this.options.createTcpReader?.(scope) ?? new WindowsTcpSocketReader(scope);
      const readTcp = async (scope: WindowsTcpSocketScope) => {
        const floor = this.now(),
          value = structuredClone(await createTcp(scope).read());
        guard();
        fact(
          value.available &&
            value.startedAtMono >= floor &&
            value.completedAtMono >= value.startedAtMono &&
            value.completedAtMono <= this.now(),
        );
        const owner = value.owners.filter((o) => o.pid === referenceOwner.pid);
        fact(
          owner.length === 1 && ownerKey(owner[0]) === ownerKey(referenceOwner as WindowsTcpOwnerIdentity),
        );
        return value;
      };
      const readConnections = async () => {
        const floor = this.now();
        const value = structuredClone(await this.options.readConnections([target.host], signal));
        guard();
        fact(
          value.startedAtMono >= floor &&
            value.completedAtMono >= value.startedAtMono &&
            value.completedAtMono <= this.now(),
        );
        return value;
      };
      const baselineScope = {
        ownerPids: [referenceOwner.pid],
        remotes: candidates.map((address) => ({ address, port: target.port })),
      };
      const [baselineTcp, baselineConnections] = await settle([
        readTcp(baselineScope),
        readConnections(),
      ] as const);
      const baseline: PhysicalRouteSnapshot = {
        phase: "baseline",
        tcp: baselineTcp,
        connections: baselineConnections,
        completedAtMono: this.now(),
      };
      snapshots.push(baseline);
      const baselineIds = new Set(baselineConnections.connections.map((c) => c.id));
      const baselineTuples = new Set(baselineTcp.sockets.map(tuple));
      const held = () => {
        guard();
        fact(
          phases.length === 2 &&
            phases.every(
              (p) =>
                p.held &&
                !p.settled &&
                p.context &&
                p.timing &&
                !p.context.signal.aborted &&
                this.now() < Math.min(p.startedAtMono + 10_000, p.timing.headersAtMono + 8_000),
            ),
        );
      };
      for (const label of ["A", "B"] as const) {
        guard();
        const capture =
          this.options.createCapture?.() ??
          new AnonymousNetLogCapture({ isQuiescent: this.options.isQuiescent });
        const p: Phase = {
          label,
          startedAtMono: this.now(),
          ready: deferred(),
          release: deferred(),
          held: false,
          settled: false,
          capture,
        };
        phases.push(p);
        p.pending = this.probe
          .probeTls({ host: target.host, port: target.port }, signal, {
            beforeSend: async (context) => {
              guard();
              fact(
                context.factoryId === ANONYMOUS_TLS_FACTORY_ID &&
                  context.origin.host === target.host &&
                  context.origin.port === target.port &&
                  !context.signal.aborted,
              );
              p.context = context;
              await readController();
              await capture.start(context.trace.netLog, context.signal);
              guard();
              const [connections, dns] = await settle([
                readConnections(),
                this.options.dns.read([target.host], context.signal),
              ] as const);
              guard();
              fact(dns.available);
              p.before = connections;
              p.dns = structuredClone(dns);
              fact(validateConfigurationAssociationForFreshDns(configuration, inputs, loader, this.now()));
            },
            headers: async (context, timing) => {
              try {
                guard();
                fact(
                  context === p.context &&
                    !context.signal.aborted &&
                    timing.statusCode === 200 &&
                    timing.responseFromCache === false,
                );
                fact(
                  timing.sentAtMono >= p.startedAtMono &&
                    timing.headersAtMono >= timing.sentAtMono &&
                    timing.headersAtMono <= this.now(),
                );
                p.timing = structuredClone(timing);
                const parsed = parseAnonymousRequestSocket(await capture.finish(context.signal), {
                  host: target.host,
                  port: target.port,
                });
                guard();
                fact(parsed.available);
                p.socket = parsed.observation;
                p.held = true;
                p.ready.resolve();
                await withAbort(p.release.promise, context.signal);
              } catch (error) {
                p.ready.reject(error);
                throw error;
              } finally {
                p.held = false;
              }
            },
            cleanup: async () => {
              await capture.dispose();
            },
          })
          .then(
            (found) => {
              p.settled = true;
              if (!p.timing) p.ready.reject(new Error("OBSERVATION_UNAVAILABLE"));
              return found;
            },
            (error) => {
              p.settled = true;
              p.ready.reject(error);
              throw error;
            },
          );
        void p.pending.catch(() => undefined);
        await withAbort(
          Promise.race([
            p.ready.promise,
            p.pending.then(() => {
              throw new Error("OBSERVATION_UNAVAILABLE");
            }),
          ]),
          signal,
        );
      }
      held();
      fact(
        phases[0].context!.transportContextId !== phases[1].context!.transportContextId &&
          !same(phases[0].socket!.tuple, phases[1].socket!.tuple),
      );
      const incoming = await readConnections();
      held();
      for (const p of phases) {
        const wire = p.socket!.tuple;
        const matches = incoming.connections.filter(
          (c) =>
            !baselineIds.has(c.id) &&
            !p.before!.connections.some((old) => old.id === c.id) &&
            c.host === target.host &&
            (c.sniffHost === null || c.sniffHost === target.host) &&
            c.network === "tcp" &&
            c.route === "direct" &&
            c.destinationPort === target.port &&
            c.sourceAddress === wire.sourceAddress &&
            c.sourcePort === wire.sourcePort &&
            c.startedAtMs >= p.timing!.sentAtWall &&
            c.startedAtMs <= p.timing!.headersAtWall &&
            c.remoteDestinationIp &&
            candidates.includes(c.remoteDestinationIp) &&
            isIP(c.remoteDestinationIp) === family,
        );
        fact(matches.length === 1 && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(matches[0].id));
        p.incoming = matches[0];
      }
      fact(phases[0].incoming!.id !== phases[1].incoming!.id);
      const pids = [
        ...(this.options.readNetworkServicePids?.() ??
          app
            .getAppMetrics()
            .filter((m) => m.serviceName === "network.mojom.NetworkService")
            .map((m) => m.pid)),
      ];
      fact(
        pids.length > 0 &&
          pids.length < 32 &&
          pids.every((pid) => Number.isSafeInteger(pid) && pid > 0) &&
          new Set(pids).size === pids.length &&
          !pids.includes(referenceOwner.pid),
      );
      const remotes = [
        ...new Map(
          [
            ...baselineScope.remotes,
            ...phases.map((p) => ({ address: p.socket!.tuple.remoteAddress, port: target.port })),
          ].map((r) => [hash(r), r]),
        ).values(),
      ];
      fact(remotes.length <= 32);
      const scope = { ownerPids: [...pids, referenceOwner.pid], remotes };
      let ownerIdentities: string | null = null;
      const snapshot = async (phase: PhysicalRouteSnapshot["phase"]) => {
        held();
        const [tcp, connections] = await settle([
          readTcp(scope),
          readConnections(),
          readController(),
        ] as const);
        held();
        const identities = hash([...tcp.owners].sort((a, b) => a.pid - b.pid));
        if (ownerIdentities === null) ownerIdentities = identities;
        else fact(identities === ownerIdentities);
        const value = { phase, tcp, connections, completedAtMono: this.now() };
        snapshots.push(value);
        return value;
      };
      const first = await snapshot("both-held");
      for (const p of phases) {
        const wire = p.socket!.tuple;
        const rows = first.tcp.sockets.filter(
          (s) =>
            pids.includes(s.ownerPid) &&
            s.state === "Established" &&
            s.sourceAddress === wire.sourceAddress &&
            s.sourcePort === wire.sourcePort &&
            s.remoteAddress === wire.remoteAddress &&
            s.remotePort === wire.remotePort,
        );
        fact(rows.length === 1);
        p.appSocket = rows[0];
        const owners = first.tcp.owners.filter((o) => o.pid === rows[0].ownerPid);
        fact(owners.length === 1);
        p.appOwner = owners[0];
      }
      const kernel = (s: PhysicalRouteSnapshot) =>
        s.tcp.sockets.filter(
          (r) =>
            r.ownerPid === referenceOwner.pid &&
            r.state === "Established" &&
            phases.some((p) => p.incoming!.remoteDestinationIp === r.remoteAddress) &&
            r.remotePort === target.port,
        );
      const physicalCandidates = kernel(first);
      fact(
        physicalCandidates.length === 2 &&
          new Set(physicalCandidates.map(tuple)).size === 2 &&
          physicalCandidates.every((s) => !baselineTuples.has(tuple(s))),
      );
      const present = (s: KernelConnectionsSnapshot, p: Phase) =>
        s.connections.filter((c) => c.id === p.incoming!.id && same(c, p.incoming)).length === 1;
      fact(phases.every((p) => present(first.connections, p)));
      const close = async (p: Phase, latest: PhysicalRouteSnapshot, remaining: number) => {
        held();
        const [connections] = await settle([readConnections(), readController()] as const);
        held();
        fact(
          this.now() - latest.tcp.completedAtMono < 500 &&
            present(connections, p) &&
            !baselineIds.has(p.incoming!.id),
        );
        fact(
          phases.every(
            (v) =>
              Math.min(v.startedAtMono + 10_000, v.timing!.headersAtMono + 8_000) - this.now() >= remaining,
          ),
        );
        const floor = this.now();
        const response = structuredClone(await this.options.closeConnection(p.incoming!.id, signal));
        held();
        fact(
          response.status === 204 &&
            response.startedAtMono >= floor &&
            response.completedAtMono >= response.startedAtMono &&
            response.completedAtMono <= this.now(),
        );
        p.intervention = { ...response, connectionId: p.incoming!.id };
      };
      await close(phases[0], first, 4500);
      const afterA = await snapshot("after-a");
      fact(
        !afterA.connections.connections.some((c) => c.id === phases[0].incoming!.id) &&
          present(afterA.connections, phases[1]) &&
          afterA.tcp.sockets.some(
            (row) => row.state === "Established" && tuple(row) === tuple(phases[1].appSocket!),
          ),
      );
      const remaining = kernel(afterA),
        removed = physicalCandidates.filter((r) => !remaining.some((s) => tuple(s) === tuple(r)));
      fact(
        remaining.length === 1 &&
          removed.length === 1 &&
          physicalCandidates.some((r) => tuple(r) === tuple(remaining[0])) &&
          removed[0].remoteAddress === phases[0].incoming!.remoteDestinationIp &&
          remaining[0].remoteAddress === phases[1].incoming!.remoteDestinationIp,
      );
      phases[0].kernelSocket = removed[0];
      phases[1].kernelSocket = remaining[0];
      await close(phases[1], afterA, 2200);
      const afterB = await snapshot("after-b");
      fact(
        !afterB.connections.connections.some((c) => phases.some((p) => p.incoming!.id === c.id)) &&
          kernel(afterB).length === 0,
      );
      held();
      phases.forEach((p) => p.release.resolve());
      const found = await settle(phases.map((p) => p.pending!));
      guard();
      const flows: AnonymousPhysicalFlow[] = [];
      for (const [index, p] of phases.entries()) {
        const result = found[index];
        fact(result.available);
        const tls = result.observation;
        fact(
          tls.factoryId === ANONYMOUS_TLS_FACTORY_ID &&
            tls.transportContextId === p.context!.transportContextId &&
            tls.origin.host === target.host &&
            tls.origin.port === target.port &&
            tls.statusCode === 200 &&
            tls.responseFromCache === false &&
            tls.credentials === "omit" &&
            tls.certificateValidation === "chromium-default" &&
            tls.completedAtMono === p.timing!.headersAtMono,
        );
        const mapping = createResolverFlowMapping(
          {
            target,
            transportProfileId: profile,
            factoryId: ANONYMOUS_TLS_FACTORY_ID,
            transportContextId: p.context!.transportContextId,
            inputs,
            loader,
            configuration,
            requestSocket: p.socket!,
            appOwner: p.appOwner!,
            appTcp: first.tcp,
            incomingBefore: p.before!,
            incomingAfter: first.connections,
            kernelDns: p.dns!,
            window: {
              sendAtMono: p.timing!.sentAtMono,
              sendAtWallMs: p.timing!.sentAtWall,
              headersAtMono: p.timing!.headersAtMono,
              headersAtWallMs: p.timing!.headersAtWall,
            },
          },
          this.now(),
        );
        fact(mapping.valid);
        flows.push({
          label: p.label,
          factoryId: ANONYMOUS_TLS_FACTORY_ID,
          transportContextId: p.context!.transportContextId,
          timing: p.timing!,
          tls,
          kernelDns: p.dns!,
          requestSocket: p.socket!,
          appOwner: p.appOwner!,
          appSocket: p.appSocket!,
          incoming: p.incoming!,
          kernelSocket: p.kernelSocket!,
          resolverMapping: mapping.observation,
          intervention: p.intervention!,
        });
      }
      const samples: RouteConformanceSample[] = [];
      for (const p of phases) {
        const socket = p.kernelSocket!,
          scope = { addresses: [socket.remoteAddress], localAddress: socket.sourceAddress };
        const reader = this.options.createRouteReader?.(scope) ?? new WindowsRouteSelectionReader(scope);
        routeReaders.push(reader);
        const floor = this.now();
        let route: WindowsRouteSelectionSnapshot;
        try {
          route = structuredClone(await reader.read(signal));
        } finally {
          reader.dispose();
          await reader.whenIdle();
        }
        guard();
        fact(
          route.available &&
            route.basis === "windows-source-route-query" &&
            route.localAddress === socket.sourceAddress &&
            route.startedAtMono >= floor &&
            route.completedAtMono >= route.startedAtMono &&
            route.completedAtMono <= this.now() &&
            route.selections.length === 1,
        );
        const physical = route.selections[0];
        fact(
          physical.targetAddress === socket.remoteAddress &&
            physical.sourceAddress === socket.sourceAddress &&
            physical.addressFamily === target.addressFamily &&
            physical.hardwareInterface &&
            physical.sourceState === "Preferred" &&
            !physical.skipAsSource &&
            physical.adapterUp &&
            physical.interfaceConnection === "Connected" &&
            physical.routeState === "Alive",
        );
        samples.push({
          evidenceId: hash([p.context!.transportContextId, p.intervention, route.selectionHash]),
          target,
          transportProfileId: profile,
          correlationEvidenceId: hash([p.incoming, p.intervention, snapshots.slice(1)]),
          socketEvidenceId: hash([first.tcp, socket]),
          routeEvidenceId: route.selectionHash,
          ownerRole: "kernel-direct-outbound",
          owner: { ...referenceOwner },
          socket,
          physicalRoute: physical,
          startedAtMono: first.tcp.startedAtMono,
          completedAtMono: route.completedAtMono,
        });
      }
      const postflightFloor = this.now(),
        postflight = structuredClone(await this.options.inputs.read(request, signal));
      guard();
      fact(
        postflight.state === "observed" &&
          postflight.sampleId !== inputs.sampleId &&
          postflight.startedAtMono >= postflightFloor &&
          postflight.completedAtMono <= this.now(),
      );
      fact(
        environment(inputs) === environment(postflight) &&
          associateCurrentConfiguration({ inputs: postflight, loader }, this.now()).valid,
      );
      const completedAtMono = this.now();
      const routeFacts = {
        source: "main-process-route-conformance" as const,
        evidenceId: hash([configuration.evidenceId, samples]),
        binding: routeApplicabilityBinding(
          inputs,
          currentDirectOutbound(inputs, controller),
          target.addressFamily,
        ),
        transportProfileIds: [profile],
        sourceEvidenceIds: [
          configuration.evidenceId,
          ...flows.map((f) => f.resolverMapping.evidenceId),
          ...samples.map((s) => s.correlationEvidenceId),
        ],
        samples,
        observedAtMono: baseline.tcp.startedAtMono,
        completedAtMono,
      };
      completed = true;
      return {
        available: true,
        observation: freeze({
          kind: "anonymous-physical-route-observation",
          target,
          factoryId: ANONYMOUS_TLS_FACTORY_ID,
          transportProfileId: profile,
          inputs,
          postflightInputs: postflight,
          configuration,
          loader,
          flows,
          snapshots,
          routeFacts,
          completedAtMono,
          qualificationGranted: false,
        }),
      };
    } finally {
      // Release observer holds before waiting for native work. Cancellation never frees the slot early.
      if (!completed) abort.abort();
      phases.forEach((p) => p.release.resolve());
      // A synchronously throwing cleanup must not skip another capability's real drain.
      const cleanup = [
        () => this.probe.whenIdle(),
        () => this.options.inputs.whenIdle(),
        () => this.options.readersWhenIdle(),
        ...phases.map((p) => () => p.capture.dispose()),
        ...phases.map((p) => () => p.capture.whenIdle()),
        ...routeReaders.map((r) => () => r.dispose()),
        ...routeReaders.map((r) => () => r.whenIdle()),
      ];
      const settled = await Promise.allSettled([
        ...phases.map((p) => p.pending),
        ...cleanup.map((fn) => Promise.resolve().then(fn)),
      ]);
      if (settled.some((r) => r.status === "rejected")) this.cleanupFailed = true;
    }
  }
}
