import { app } from "electron";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  AnonymousProofProbe,
  ANONYMOUS_TLS_FACTORY_ID,
  type AnonymousTlsObservation,
  type AnonymousTlsObserverContext,
  type AnonymousTlsObserverTiming,
} from "./anonymous-proof-probe";
import { AnonymousNetLogCapture } from "./anonymous-netlog-capture";
import {
  parseAnonymousRequestSocket,
  type AnonymousRequestSocketObservation,
} from "./anonymous-request-socket";
import {
  associateCurrentConfiguration,
  validateConfigurationAssociation,
  type CurrentConfigurationAssociation,
  type KnownSelectedLoaderContract,
} from "./configuration-association";
import { normalizeProofTarget, proofTargetKey, type ProofTarget } from "./direct-proof";
import type { ClashReadResult } from "./clash-reader";
import type { KernelConnectionsSnapshot, KernelConnectionObservation } from "./connection-evidence";
import type { KernelDnsReader, KernelDnsCandidates } from "./kernel-dns";
import type { PathInputReader, CurrentPathInputs } from "./path-input-reader";
import type { ProofScopeVersion } from "./proof-issuer";
import { createResolverFlowMapping, type ResolverFlowMappingObservation } from "./resolver-flow-mapping";
import { evaluateRules } from "./rules";
import {
  WindowsTcpSocketReader,
  type WindowsTcpSocketScope,
  type WindowsTcpSocketSnapshot,
} from "./windows-tcp-sockets";

type Capture = Pick<AnonymousNetLogCapture, "start" | "finish" | "dispose" | "whenIdle">;
export interface AnonymousFlowCollectorOptions {
  inputs: Pick<PathInputReader, "read" | "whenIdle">;
  dns: Pick<KernelDnsReader, "read">;
  readController(signal: AbortSignal): Promise<ClashReadResult>;
  readConnections(hosts: readonly string[], signal: AbortSignal): Promise<KernelConnectionsSnapshot>;
  readVersion(): ProofScopeVersion | null;
  /** A real app-wide quiet window, not a declaration that one Session has no cookies. */
  isQuiescent(): boolean;
  /** Drain the underlying controller/DNS/file providers even if their public read was cancelled. */
  readersWhenIdle(): Promise<void>;
  probe?: Pick<AnonymousProofProbe, "probeTls" | "whenIdle">;
  createCapture?: () => Capture;
  createTcpReader?: (scope: WindowsTcpSocketScope) => Pick<WindowsTcpSocketReader, "read">;
  readNetworkServicePids?: () => readonly number[];
  now?: () => number;
  timeoutMs?: number;
}
export interface AnonymousFlowObservation {
  readonly kind: "anonymous-factory-flow-observation";
  readonly inputs: CurrentPathInputs;
  readonly postflightInputs: CurrentPathInputs;
  readonly configuration: CurrentConfigurationAssociation;
  readonly loader: KnownSelectedLoaderContract;
  readonly mapping: ResolverFlowMappingObservation;
  readonly tls: AnonymousTlsObservation;
  readonly completedAtMono: number;
  readonly qualificationGranted: false;
}
export type AnonymousFlowCollectionResult =
  | { readonly available: true; readonly observation: AnonymousFlowObservation }
  | {
      readonly available: false;
      readonly reason: "BUSY" | "CANCELLED" | "QUIET_WINDOW_REQUIRED" | "OBSERVATION_UNAVAILABLE";
    };

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sameVersion = (a: ProofScopeVersion | null, b: ProofScopeVersion | null) =>
  !!a && !!b && a.generation === b.generation && a.rulesVersion === b.rulesVersion;
const environment = (i: CurrentPathInputs) =>
  digest([
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
      i.systemHostsAfter.resolutionProven,
      i.systemHostsAfter.parserProfile,
      i.systemHostsAfter.scopeHash,
      i.systemHostsAfter.fileHash,
      i.systemHostsAfter.fileIdentity,
      i.systemHostsAfter.hosts,
    ],
  ]);
const connectionKey = (v: KernelConnectionObservation) => digest(v);
function requireFact(value: unknown): asserts value {
  if (!value) throw new Error("OBSERVATION_UNAVAILABLE");
}

/** Collects actual, current anonymous inputs. It neither writes q/permit flags nor uses report JSON.
 * The caller owns the quiet window and the readers; no account Session is accepted by this API.
 */
export class AnonymousFlowCollector {
  private readonly probe: Pick<AnonymousProofProbe, "probeTls" | "whenIdle">;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private active: AbortController | null = null;
  private pending: Promise<AnonymousFlowCollectionResult> | null = null;
  private disposed = false;
  private cleanupFailed = false;
  private epoch = 0;
  private preparing = false;

  constructor(private readonly options: AnonymousFlowCollectorOptions) {
    this.probe = options.probe ?? new AnonymousProofProbe({ concurrency: 1, timeoutMs: 10_000 });
    this.now = options.now ?? (() => performance.now());
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000)
      throw new Error("FLOW_COLLECTOR_OPTIONS_INVALID");
  }

  collect(
    target: ProofTarget,
    loader: KnownSelectedLoaderContract,
    transportProfileId: string,
    signal: AbortSignal,
  ): Promise<AnonymousFlowCollectionResult> {
    if (this.pending || this.preparing) return Promise.resolve({ available: false, reason: "BUSY" });
    if (this.disposed || this.cleanupFailed || signal.aborted)
      return Promise.resolve({ available: false, reason: "CANCELLED" });
    const epoch = this.epoch;
    let version: ProofScopeVersion | null;
    let capturedLoader: KnownSelectedLoaderContract;
    let capturedTarget: ProofTarget;
    let deadline: number;
    this.preparing = true;
    try {
      if (!this.options.isQuiescent())
        return Promise.resolve({ available: false, reason: "QUIET_WINDOW_REQUIRED" });
      version = structuredClone(this.options.readVersion());
      capturedLoader = structuredClone(loader);
      capturedTarget = normalizeProofTarget(target)!;
      const startedAt = this.now();
      requireFact(Number.isFinite(startedAt) && startedAt >= 0);
      deadline = startedAt + this.timeoutMs;
      requireFact(
        version &&
          capturedTarget &&
          target.protocol === "https:" &&
          /^[a-zA-Z0-9_.:-]{1,256}$/.test(transportProfileId),
      );
      requireFact(!this.pending && !this.disposed && !signal.aborted && epoch === this.epoch);
    } catch {
      return Promise.resolve({ available: false, reason: "OBSERVATION_UNAVAILABLE" });
    } finally {
      this.preparing = false;
    }
    const controller = new AbortController();
    this.active = controller;
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    // Reserve the slot before any provider can synchronously reenter or revoke this job.
    const work = Promise.resolve()
      .then(() =>
        this.run(
          capturedTarget,
          capturedLoader,
          transportProfileId,
          version,
          controller.signal,
          epoch,
          deadline,
        ),
      )
      .then((result) => {
        const current = this.options.readVersion();
        requireFact(
          !this.disposed &&
            !this.cleanupFailed &&
            epoch === this.epoch &&
            !controller.signal.aborted &&
            sameVersion(version, current) &&
            this.options.isQuiescent(),
        );
        requireFact(
          !this.disposed && !controller.signal.aborted && epoch === this.epoch && this.now() < deadline,
        );
        return result;
      })
      .catch((): AnonymousFlowCollectionResult => ({
        available: false,
        reason: controller.signal.aborted ? "CANCELLED" : "OBSERVATION_UNAVAILABLE",
      }))
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (this.active === controller) this.active = null;
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
    if (this.pending) await this.pending;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await this.whenIdle();
  }

  private async run(
    target: ProofTarget,
    loader: KnownSelectedLoaderContract,
    profile: string,
    version: ProofScopeVersion,
    signal: AbortSignal,
    epoch: number,
    deadline: number,
  ): Promise<AnonymousFlowCollectionResult> {
    let capture: Capture | null = null;
    const guard = () => {
      const current = this.options.readVersion();
      requireFact(
        !this.disposed && !signal.aborted && this.options.isQuiescent() && sameVersion(version, current),
      );
      requireFact(!this.disposed && !signal.aborted && epoch === this.epoch && this.now() < deadline);
    };
    try {
      guard();
      const controller = await this.options.readController(signal);
      guard();
      requireFact(
        controller.mode === "rule" &&
          controller.fingerprint === version.rulesVersion &&
          controller.directPolicy?.kind === "direct" &&
          controller.directPolicy.dialer === "none",
      );
      requireFact(
        evaluateRules(controller.mode, controller.rules, {
          host: target.host,
          port: target.port,
          network: "tcp",
        }).route === "direct",
      );
      const request = { ...version, targets: [target] };
      const inputs = structuredClone(await this.options.inputs.read(request, signal));
      guard();
      requireFact(inputs.state === "observed");
      const associated = associateCurrentConfiguration({ inputs, loader }, this.now());
      requireFact(associated.valid);
      requireFact(inputs.systemHostsBefore && inputs.systemHostsAfter);
      const configuration = associated.association;
      capture =
        this.options.createCapture?.() ??
        new AnonymousNetLogCapture({ isQuiescent: this.options.isQuiescent });
      let context: AnonymousTlsObserverContext | null = null;
      let timing: AnonymousTlsObserverTiming | null = null;
      let before: KernelConnectionsSnapshot | null = null;
      let after: KernelConnectionsSnapshot | null = null;
      let dns: KernelDnsCandidates | null = null;
      let socket: AnonymousRequestSocketObservation | null = null;
      let tcp: WindowsTcpSocketSnapshot | null = null;
      const found = await this.probe.probeTls({ host: target.host, port: target.port }, signal, {
        beforeSend: async (actual) => {
          guard();
          requireFact(
            actual.factoryId === ANONYMOUS_TLS_FACTORY_ID &&
              actual.origin.host === target.host &&
              actual.origin.port === target.port &&
              !actual.signal.aborted,
          );
          context = actual;
          await capture!.start(actual.trace.netLog, actual.signal);
          guard();
          const observations = await Promise.allSettled([
            this.options.readConnections([target.host], actual.signal),
            this.options.dns.read([target.host], actual.signal),
          ]);
          guard();
          requireFact(observations[0].status === "fulfilled" && observations[1].status === "fulfilled");
          before = structuredClone(observations[0].value);
          requireFact(observations[1].value.available);
          dns = structuredClone(observations[1].value);
          requireFact(validateConfigurationAssociation(configuration, inputs, loader, this.now()));
        },
        headers: async (actual, observed) => {
          guard();
          requireFact(actual === context && !actual.signal.aborted);
          timing = observed;
          after = structuredClone(await this.options.readConnections([target.host], actual.signal));
          guard();
          const parsed = parseAnonymousRequestSocket(await capture!.finish(actual.signal), {
            host: target.host,
            port: target.port,
          });
          guard();
          requireFact(parsed.available);
          socket = parsed.observation;
          const pids = [
            ...(this.options.readNetworkServicePids?.() ??
              app
                .getAppMetrics()
                .filter((r) => r.serviceName === "network.mojom.NetworkService")
                .map((r) => r.pid)),
          ];
          requireFact(pids.length > 0 && pids.length <= 32);
          const reader = (this.options.createTcpReader ?? ((scope) => new WindowsTcpSocketReader(scope)))({
            ownerPids: pids,
            remotes: [{ address: socket.tuple.remoteAddress, port: target.port }],
          });
          tcp = structuredClone(await reader.read());
          guard();
          requireFact(!actual.signal.aborted && tcp.available);
          const stillHeld = await this.options.readConnections([target.host], actual.signal);
          guard();
          const own = after.connections.filter(
            (r) =>
              r.sourceAddress === socket!.tuple.sourceAddress && r.sourcePort === socket!.tuple.sourcePort,
          );
          requireFact(
            own.length === 1 &&
              stillHeld.connections.filter((r) => connectionKey(r) === connectionKey(own[0])).length === 1,
          );
        },
        cleanup: async () => {
          await capture!.dispose();
        },
      });
      guard();
      requireFact(found.available && context && timing && before && after && dns && socket && tcp);
      // TypeScript cannot narrow assignments made by awaited observer callbacks.
      const actualContext = context as AnonymousTlsObserverContext;
      const actualTiming = timing as AnonymousTlsObserverTiming;
      const actualSocket = socket as AnonymousRequestSocketObservation;
      const actualTcp = tcp as WindowsTcpSocketSnapshot;
      requireFact(
        actualTcp.available &&
          found.observation.transportContextId === actualContext.transportContextId &&
          found.observation.factoryId === ANONYMOUS_TLS_FACTORY_ID &&
          found.observation.origin.host === target.host &&
          found.observation.origin.port === target.port &&
          found.observation.completedAtMono === actualTiming.headersAtMono &&
          found.observation.statusCode === actualTiming.statusCode &&
          found.observation.responseFromCache === false &&
          found.observation.certificateValidation === "chromium-default" &&
          found.observation.credentials === "omit",
      );
      const rows = actualTcp.sockets.filter(
        (r) =>
          r.sourceAddress === actualSocket.tuple.sourceAddress &&
          r.sourcePort === actualSocket.tuple.sourcePort &&
          r.remoteAddress === actualSocket.tuple.remoteAddress &&
          r.remotePort === actualSocket.tuple.remotePort,
      );
      requireFact(rows.length === 1);
      const owners = actualTcp.owners.filter((o) => o.pid === rows[0].ownerPid);
      requireFact(owners.length === 1);
      const postflightFloor = this.now();
      const postflight = structuredClone(await this.options.inputs.read(request, signal));
      guard();
      requireFact(postflight.state === "observed");
      requireFact(
        postflight.sampleId !== inputs.sampleId &&
          postflight.startedAtMono >= postflightFloor &&
          postflight.completedAtMono <= this.now(),
      );
      requireFact(environment(inputs) === environment(postflight));
      requireFact(associateCurrentConfiguration({ inputs: postflight, loader }, this.now()).valid);
      const mapping = createResolverFlowMapping(
        {
          target,
          transportProfileId: profile,
          factoryId: ANONYMOUS_TLS_FACTORY_ID,
          transportContextId: actualContext.transportContextId,
          inputs,
          loader,
          configuration,
          requestSocket: actualSocket,
          appOwner: owners[0],
          appTcp: actualTcp,
          incomingBefore: before,
          incomingAfter: after,
          kernelDns: dns,
          window: {
            sendAtMono: actualTiming.sentAtMono,
            sendAtWallMs: actualTiming.sentAtWall,
            headersAtMono: actualTiming.headersAtMono,
            headersAtWallMs: actualTiming.headersAtWall,
          },
        },
        this.now(),
      );
      requireFact(
        mapping.valid &&
          isIP(mapping.observation.incoming.remoteDestinationIp!) ===
            (target.addressFamily === "ipv4" ? 4 : 6),
      );
      requireFact(proofTargetKey(mapping.observation.target) === proofTargetKey(target));
      return Object.freeze({
        available: true,
        observation: Object.freeze({
          kind: "anonymous-factory-flow-observation",
          inputs,
          postflightInputs: postflight,
          configuration,
          loader,
          mapping: mapping.observation,
          tls: Object.freeze({ ...found.observation }),
          completedAtMono: this.now(),
          qualificationGranted: false,
        }),
      });
    } finally {
      const cleanup = await Promise.allSettled([
        capture?.dispose(),
        this.probe.whenIdle(),
        this.options.inputs.whenIdle(),
        this.options.readersWhenIdle(),
      ]);
      if (cleanup.some((r) => r.status === "rejected")) {
        this.cleanupFailed = true;
      }
    }
  }
}
