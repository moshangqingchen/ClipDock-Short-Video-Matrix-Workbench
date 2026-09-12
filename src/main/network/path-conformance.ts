import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { app } from "electron";
import { readChromiumTransportState, type ChromiumTransportState } from "./chromium-transport";
import { NETWORK_TIMING } from "@shared/network";
import {
  associateCurrentConfiguration,
  validateConfigurationAssociation,
  type CurrentConfigurationAssociation,
  type KnownSelectedLoaderContract,
} from "./configuration-association";
import { ANONYMOUS_TLS_FACTORY_ID } from "./anonymous-proof-probe";
import { ANONYMOUS_EGRESS_FACTORY_ID } from "./anonymous-egress-probe";
import type { ClashReadResult } from "./clash-reader";
import { normalizeProofTarget, proofScopeKey, proofTargetKey, type ProofTarget } from "./direct-proof";
import type { CurrentPathInputs } from "./path-input-reader";
import type { ProofCollectionRequest, ProofScopeVersion } from "./proof-issuer";
import {
  currentDirectOutbound,
  cloneScopePathConformance,
  diagnosticObservationDigest,
  type DiagnosticSamplePathBinding,
  type ProductionProofSourceOptions,
  type ScopePathConformance,
} from "./production-proof-source";
import {
  routeApplicabilityBinding,
  validateRouteApplicability,
  verifyRouteApplicability,
  type RouteConformanceRecord,
  type CurrentPhysicalRouteProjection,
  type ValidatedRouteApplicability,
} from "./route-applicability";
import { evaluateRules } from "./rules";
import { cloneRuleContextSet, evaluateRuleContextSet } from "./rule-context-set";
import type { CurrentRuleContext, CurrentRuleConfiguration } from "./current-rule-context";
import { validateResolverFlowMapping, type ResolverFlowMappingObservation } from "./resolver-flow-mapping";
import {
  WindowsRouteSelectionReader,
  type WindowsRouteSelectionScope,
  type WindowsRouteSelectionSnapshot,
} from "./windows-route-selection";

type Family = ProofTarget["addressFamily"];
type Origin = Pick<ProofTarget, "protocol" | "host" | "port">;
type Callbacks = ProductionProofSourceOptions["conformance"];
type BindInput = Parameters<Callbacks["bindSamples"]>[0];
type RouteReader = Pick<WindowsRouteSelectionReader, "read" | "dispose" | "whenIdle">;

export interface RealResolverObservation {
  readonly kind?: "real-direct";
  readonly evidenceId: string;
  readonly target: ProofTarget;
  readonly transportProfileId: string;
  readonly kernelAddresses: readonly string[];
  readonly transportAddresses: readonly string[];
  readonly startedAtMono: number;
  readonly completedAtMono: number;
}

/** A preparation may collect its families sequentially. Each original mapping keeps its own
 * observed input window and branded association; no later round may replace those timestamps. */
export interface RetainedResolverObservationContext {
  readonly observationEvidenceIds: readonly string[];
  readonly inputs: CurrentPathInputs;
  readonly loader: KnownSelectedLoaderContract;
  readonly configuration: CurrentConfigurationAssociation;
}

/** Selected by the main-process qualification producer. This adapter does not perform that review. */
export interface RetainedPathQualification {
  readonly source: "main-process-retained-path-qualification";
  readonly evidenceId: string;
  readonly inputs: CurrentPathInputs;
  readonly loader: KnownSelectedLoaderContract;
  /** A retained, branded association from the actual original round; JSON restoration is rejected. */
  readonly configuration: CurrentConfigurationAssociation;
  readonly qualifiedAtMono: number;
  readonly expiresAtMono: number;
  readonly transport: ScopePathConformance["transport"];
  readonly electronVersion: string;
  readonly tcpQualification: {
    readonly evidenceId: string;
    readonly switch: "disable-quic";
    readonly startupProfileId: string;
    readonly sourceEvidenceIds: readonly string[];
  };
  readonly origins: readonly {
    readonly origin: Origin;
    readonly possibleAddressFamilies: readonly Family[];
    /** Retained family constraint/negative-test sources; missing means both families remain possible. */
    readonly familyConstraint: {
      readonly evidenceId: string;
      readonly sourceEvidenceIds: readonly string[];
    } | null;
  }[];
  readonly resolver: {
    readonly source: "reviewed-real-kernel-query-equivalence" | "reviewed-kernel-query-path-conformance";
    readonly evidenceId: string;
    readonly sourceEvidenceIds: readonly string[];
    readonly transportProfileIds: readonly string[];
    /** Explicit reviewed resolver equivalence can cover another factory without a fresh socket. */
    readonly profileEquivalences?: readonly {
      readonly evidenceId: string;
      readonly fromProfileId: string;
      readonly toProfileId: string;
      readonly addressFamilies: readonly Family[];
      readonly sourceObservationIds: readonly string[];
      readonly sourceEvidenceIds: readonly string[];
    }[];
    /** Original observed resolver correspondences, not a claim manufactured from current DNS answers. */
    readonly observations: readonly (RealResolverObservation | ResolverFlowMappingObservation)[];
    /** If supplied, covers every fake-IP mapping exactly once. Legacy one-round records omit it. */
    readonly observationContexts?: readonly RetainedResolverObservationContext[];
  };
  /** Original samples, including actual socket source and its attribution. Never refreshed in place. */
  readonly routes: readonly RouteConformanceRecord[];
  readonly diagnosticPaths: readonly {
    readonly kind: "tls" | "egress";
    readonly origin: Origin;
    readonly possibleAddressFamilies: readonly Family[];
    readonly basis: "validated-path-constraint" | "reviewed-path-equivalence";
    readonly evidenceId: string;
    readonly sourceEvidenceIds: readonly string[];
  }[];
}

export interface PathConformanceOptions {
  readonly loader: KnownSelectedLoaderContract | null;
  readonly qualification: RetainedPathQualification | null;
  readVersion(): ProofScopeVersion | null;
  /** Reuses an actual controller read from this input round; no additional controller HTTP is needed. */
  getController(): ClashReadResult | null;
  /** Optional reviewed matching-stage producer. Null is unavailable, never a legacy fallback. */
  readRuleContexts?: (input: {
    request: ProofCollectionRequest;
    inputs: CurrentPathInputs;
    configuration: CurrentRuleConfiguration;
    transport: ScopePathConformance["transport"];
  }) => readonly CurrentRuleContext[] | null;
  createRouteReader?: (scope: WindowsRouteSelectionScope) => RouteReader;
  /** Test adapter only. Production reads this Electron process's version and actual command-line switch. */
  readChromiumRuntime?: () => ChromiumTransportState & { electronVersion: string | null };
  now?: () => number;
  timeoutMs?: number;
}
export type PathConformanceFailure =
  | "QUALIFICATION_UNAVAILABLE"
  | "QUALIFICATION_INVALID"
  | "QUALIFICATION_CHANGED"
  | "CONFIGURATION_UNAVAILABLE"
  | "CONTEXT_UNQUALIFIED"
  | "PROTOCOL_UNQUALIFIED"
  | "INPUT_INVALID"
  | "INPUT_EXPIRED"
  | "NETWORK_CHANGED"
  | "RULE_UNVERIFIABLE"
  | "DNS_UNVERIFIED"
  | "ROUTE_UNAVAILABLE"
  | "ROUTE_CLASS_MISMATCH"
  | "SAMPLE_UNQUALIFIED"
  | "READ_BUSY"
  | "CANCELLED"
  | "DISPOSED";
class ConformanceError extends Error {
  constructor(readonly reason: PathConformanceFailure) {
    super(reason);
  }
}
function fail(reason: PathConformanceFailure): never {
  throw new ConformanceError(reason);
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ref = (s: unknown): s is string =>
  typeof s === "string" && s.trim().length > 0 && s.length <= 4096 && !/[\r\n\0]/.test(s);
const refs = (v: readonly string[]) =>
  Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every(ref) && new Set(v).size === v.length;
const families = (v: readonly Family[]) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= 2 &&
  v.every((f) => f === "ipv4" || f === "ipv6") &&
  new Set(v).size === v.length;
const set = (v: readonly string[]) => JSON.stringify([...v].sort());
const originKey = (v: Origin) => `${v.protocol}//${v.host}:${v.port}`;
const interval = (start: number, end: number, floor: number, ceiling: number) =>
  [start, end, floor, ceiling].every(Number.isFinite) &&
  floor >= 0 &&
  start >= floor &&
  end >= start &&
  end <= ceiling;
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
function echo(family: Family): ProofTarget {
  return {
    protocol: "https:",
    host: family === "ipv4" ? "myip.ipip.net" : "api6.ipify.org",
    port: 443,
    addressFamily: family,
  };
}
/** Checks the selected diagnostic directory, not factory/path evidence. The current binding
 * contract requires reviewed single-family correspondence for its two fixed echo origins; this
 * validator neither establishes nor enforces that constraint. No extra TLS/geo entry is required. */
export function validatePathDiagnosticMetadata(
  value: Pick<RetainedPathQualification, "origins" | "diagnosticPaths">,
): boolean {
  try {
    if (
      !Array.isArray(value.origins) ||
      !value.origins.length ||
      value.origins.length > 128 ||
      !Array.isArray(value.diagnosticPaths) ||
      !value.diagnosticPaths.length ||
      value.diagnosticPaths.length > 256
    )
      return false;
    const canonicalKey = (origin: Origin): string | null => {
      const normalized = normalizeProofTarget({ ...origin, addressFamily: "ipv4" });
      return normalized?.protocol === "https:" && originKey(normalized) === originKey(origin)
        ? originKey(normalized)
        : null;
    };
    const origins = new Map<string, readonly Family[]>();
    for (const entry of value.origins) {
      const key = canonicalKey(entry.origin);
      if (
        !key ||
        origins.has(key) ||
        !families(entry.possibleAddressFamilies) ||
        (entry.possibleAddressFamilies.length === 1 &&
          (!entry.familyConstraint ||
            !ref(entry.familyConstraint.evidenceId) ||
            !refs(entry.familyConstraint.sourceEvidenceIds)))
      )
        return false;
      origins.set(key, entry.possibleAddressFamilies);
    }
    const paths = new Set<string>();
    for (const path of value.diagnosticPaths) {
      const key = canonicalKey(path.origin);
      if (
        !key ||
        !["tls", "egress"].includes(path.kind) ||
        !["validated-path-constraint", "reviewed-path-equivalence"].includes(path.basis) ||
        !ref(path.evidenceId) ||
        !refs(path.sourceEvidenceIds) ||
        !families(path.possibleAddressFamilies) ||
        !origins.has(key) ||
        set(path.possibleAddressFamilies) !== set(origins.get(key)!)
      )
        return false;
      const pathKey = `${path.kind}:${key}`;
      if (paths.has(pathKey)) return false;
      paths.add(pathKey);
      if (
        path.kind === "egress" &&
        (path.possibleAddressFamilies.length !== 1 ||
          key !== originKey(echo(path.possibleAddressFamilies[0])))
      )
        return false;
    }
    const echoFamilies = new Map<string, Family>([
      [originKey(echo("ipv4")), "ipv4"],
      [originKey(echo("ipv6")), "ipv6"],
    ]);
    for (const [key, possible] of origins) {
      const echoFamily = echoFamilies.get(key);
      if (echoFamily) {
        if (set(possible) !== set([echoFamily]) || !paths.has(`egress:${key}`)) return false;
      } else if (!paths.has(`tls:${key}`)) return false;
      for (const family of possible) {
        const echoKey = originKey(echo(family));
        if (!origins.has(echoKey) || !paths.has(`egress:${echoKey}`)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
function dependencies(i: CurrentPathInputs): unknown {
  const c = i.configurationAfter;
  return [
    c.sourcePathIdentity,
    c.decoderIdentity,
    c.policy.fingerprint,
    c.currentDirectPolicy.policyFingerprint,
    i.ownerAfter.kernelEpoch,
    i.ownerAfter.owner,
    i.ownerAfter.scopeHash,
    i.networkAfter.hash,
    i.systemHostsAfter
      ? [i.systemHostsAfter.fileHash, i.systemHostsAfter.fileIdentity, i.systemHostsAfter.parserProfile]
      : null,
  ];
}
interface RetainedRound {
  request: Omit<ProofCollectionRequest, "signal">;
  inputs: CurrentPathInputs;
  record: ScopePathConformance;
  configuration: CurrentConfigurationAssociation;
}

/**
 * The adapter between actual input readers and ProductionProofSource. It performs current checks
 * and source-conditioned OS route reads; it issues neither qualification artifacts nor permits.
 * No account requests, public probes, configuration writes, IPC, persistence or timers after idle.
 */
export class PathConformanceAdapter implements Callbacks {
  private readonly now: () => number;
  private readonly loader: KnownSelectedLoaderContract | null;
  private readonly qualification: RetainedPathQualification | null;
  private readonly originalAssociation: CurrentConfigurationAssociation | null;
  private readonly originalResolverMappings: readonly ResolverFlowMappingObservation[];
  private readonly originalResolverContexts: readonly {
    readonly ids: readonly string[];
    readonly association: CurrentConfigurationAssociation;
  }[];
  private readonly timeoutMs: number;
  private readonly rounds = new Map<string, RetainedRound>();
  private readonly originalPaths = new Map<string, DiagnosticSamplePathBinding["originalPath"]>();
  private pending: Promise<ScopePathConformance | null> | null = null;
  private readonly draining = new Set<Promise<void>>();
  private pendingKey: string | null = null;
  private active: AbortController | null = null;
  private epoch = 0;
  private disposed = false;
  private reason: PathConformanceFailure | null = null;

  constructor(private readonly options: PathConformanceOptions) {
    this.now = options.now ?? (() => performance.now());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000)
      throw new Error("INVALID_CONFORMANCE_OPTIONS");
    this.loader = options.loader ? freeze(structuredClone(options.loader)) : null;
    this.originalAssociation = options.qualification?.configuration ?? null;
    // Keep main-process constructor provenance before copying the public record contents.
    this.originalResolverMappings = (options.qualification?.resolver.observations ?? []).filter(
      (value): value is ResolverFlowMappingObservation => value.kind === "fake-ip-kernel-destination",
    );
    this.originalResolverContexts = (options.qualification?.resolver.observationContexts ?? []).map((v) => ({
      ids: Object.freeze([...v.observationEvidenceIds]),
      association: v.configuration,
    }));
    this.qualification = options.qualification ? freeze(structuredClone(options.qualification)) : null;
  }
  /** Fixed main-only reason; contains no addresses, paths, tokens or raw errors. */
  lastFailure(): PathConformanceFailure | null {
    return this.reason;
  }
  /** Checks retained original facts and the actual Chromium startup contract only. This does not
   * sample current routes, authorize an account, or replace read()'s current applicability checks. */
  hasValidRetainedQualification(): boolean {
    try {
      if (this.disposed) return false;
      this.qualificationForNow();
      return true;
    } catch (error) {
      this.reason = error instanceof ConformanceError ? error.reason : "QUALIFICATION_INVALID";
      return false;
    }
  }
  /** Synchronous main-process projection of an already validated path review. It neither selects
   * a family from a URL nor samples/renews evidence; all listed families still need Gate permits. */
  resolveAddressFamilies(origin: Origin): readonly Family[] | null {
    const epoch = this.epoch;
    try {
      if (this.disposed) return null;
      const target = normalizeProofTarget({ ...origin, addressFamily: "ipv4" });
      if (!target || target.protocol !== "https:" || originKey(target) !== originKey(origin)) return null;
      const q = this.qualificationForNow();
      const match = q.origins.find((entry) => originKey(entry.origin) === originKey(target));
      if (!match || this.disposed || this.epoch !== epoch) return null;
      return Object.freeze([...match.possibleAddressFamilies]);
    } catch {
      return null;
    }
  }
  invalidate(): void {
    this.epoch++;
    this.active?.abort();
    this.rounds.clear();
    this.originalPaths.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  /** Includes real route-reader cleanup even when read() already returned null on cancellation. */
  whenIdle(): Promise<void> {
    return Promise.allSettled([...this.draining]).then(() => undefined);
  }

  read(request: ProofCollectionRequest, inputs: CurrentPathInputs): Promise<ScopePathConformance | null> {
    if (this.disposed || request.signal.aborted) {
      this.reason = this.disposed ? "DISPOSED" : "CANCELLED";
      return Promise.resolve(null);
    }
    const captured = { ...request, scope: structuredClone(request.scope) },
      observed = structuredClone(inputs);
    const key = hash([captured.generation, captured.rulesVersion, captured.scope, observed]);
    if (this.pending) {
      if (key !== this.pendingKey) {
        this.reason = "READ_BUSY";
        return Promise.resolve(null);
      }
      this.join(request.signal, this.active!, this.pending);
      return this.pending;
    }
    const abort = new AbortController(),
      epoch = this.epoch;
    this.active = abort;
    this.pendingKey = key;
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    const task = this.collect({ ...captured, signal: abort.signal }, observed, epoch);
    const cancellation = new Promise<never>((_resolve, reject) =>
      abort.signal.addEventListener("abort", () => reject(new ConformanceError("CANCELLED")), { once: true }),
    );
    const result = Promise.race([task, cancellation])
      .then((record) => {
        this.guard(captured, epoch, abort.signal);
        this.reason = null;
        return record;
      })
      .catch((error) => {
        this.reason = error instanceof ConformanceError ? error.reason : "INPUT_INVALID";
        return null;
      });
    this.pending = result;
    this.join(request.signal, abort, result);
    // Keep the real route reader's slot until whenIdle, even when public cancellation returns first.
    const draining = Promise.allSettled([task, result]).then(() => {
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
  private join(signal: AbortSignal, abort: AbortController, pending: Promise<unknown>): void {
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void pending.finally(() => signal.removeEventListener("abort", cancel));
  }
  private guard(request: ProofCollectionRequest, epoch: number, signal = request.signal): void {
    if (this.disposed) fail("DISPOSED");
    if (epoch !== this.epoch || signal.aborted) fail("CANCELLED");
    const version = this.options.readVersion();
    // The Gate getter may itself expire a permit and synchronously emit invalidation.
    if (this.disposed) fail("DISPOSED");
    if (epoch !== this.epoch || signal.aborted) fail("CANCELLED");
    if (
      !version ||
      version.generation !== request.generation ||
      version.rulesVersion !== request.rulesVersion
    )
      fail("NETWORK_CHANGED");
  }
  private qualificationForNow(): RetainedPathQualification {
    const q = this.qualification;
    if (!q || !this.loader) fail("QUALIFICATION_UNAVAILABLE");
    // This checks retained facts at their original observation time. Postflight review can finish
    // after that source window; it neither refreshes those facts nor replaces current()'s inputs.
    // Each mapping separately requires its actual request to fit the original DNS/source window.
    if (
      q.source !== "main-process-retained-path-qualification" ||
      !ref(q.evidenceId) ||
      !this.originalAssociation ||
      !validateConfigurationAssociation(
        this.originalAssociation,
        q.inputs,
        q.loader,
        this.originalAssociation.checkedAtMono,
      ) ||
      !interval(q.qualifiedAtMono, q.qualifiedAtMono, this.originalAssociation.checkedAtMono, this.now()) ||
      !Number.isFinite(q.expiresAtMono) ||
      q.expiresAtMono <= this.now()
    )
      fail("QUALIFICATION_INVALID");
    if (
      q.transport.tlsFactoryId !== ANONYMOUS_TLS_FACTORY_ID ||
      q.transport.egressFactoryId !== ANONYMOUS_EGRESS_FACTORY_ID ||
      ![
        q.transport.evidenceId,
        q.transport.accountProfileId,
        q.transport.tlsProfileId,
        q.transport.egressProfileId,
        q.electronVersion,
      ].every(ref) ||
      q.tcpQualification.switch !== "disable-quic" ||
      !ref(q.tcpQualification.startupProfileId) ||
      !ref(q.tcpQualification.evidenceId) ||
      !refs(q.tcpQualification.sourceEvidenceIds)
    )
      fail("QUALIFICATION_INVALID");
    const runtime = this.options.readChromiumRuntime?.() ?? {
      electronVersion: process.versions.electron ?? null,
      ...readChromiumTransportState(app),
    };
    if (
      runtime.electronVersion !== q.electronVersion ||
      runtime.profileId !== q.tcpQualification.startupProfileId ||
      !runtime.configuredBeforeReady ||
      !runtime.disableQuicSwitchPresent
    )
      fail("PROTOCOL_UNQUALIFIED");
    const profiles = [q.transport.accountProfileId, q.transport.tlsProfileId, q.transport.egressProfileId];
    if (
      !Array.isArray(q.origins) ||
      !q.origins.length ||
      q.origins.length > 128 ||
      new Set(q.origins.map((v) => originKey(v.origin))).size !== q.origins.length ||
      q.origins.some(
        (v) =>
          !normalizeProofTarget({ ...v.origin, addressFamily: "ipv4" }) ||
          !families(v.possibleAddressFamilies) ||
          (v.possibleAddressFamilies.length === 1 &&
            (!v.familyConstraint ||
              !ref(v.familyConstraint.evidenceId) ||
              !refs(v.familyConstraint.sourceEvidenceIds))),
      ) ||
      !validatePathDiagnosticMetadata(q)
    )
      fail("QUALIFICATION_INVALID");
    const resolver = q.resolver;
    const contexts = resolver.observationContexts;
    if (contexts !== undefined) {
      if (!Array.isArray(contexts) || !contexts.length || contexts.length > 64) fail("QUALIFICATION_INVALID");
      const covered: string[] = [];
      for (const context of contexts) {
        const originals = this.originalResolverContexts.filter((v) =>
          same(v.ids, context.observationEvidenceIds),
        );
        const config = context.inputs.configurationAfter;
        if (
          !refs(context.observationEvidenceIds) ||
          originals.length !== 1 ||
          !same(context.configuration, originals[0].association) ||
          !validateConfigurationAssociation(
            originals[0].association,
            context.inputs,
            context.loader,
            context.configuration.checkedAtMono,
          ) ||
          !interval(
            context.configuration.checkedAtMono,
            context.configuration.checkedAtMono,
            0,
            q.qualifiedAtMono,
          ) ||
          !same(dependencies(context.inputs), dependencies(q.inputs)) ||
          context.inputs.generation !== q.inputs.generation ||
          context.inputs.rulesVersion !== q.inputs.rulesVersion ||
          config.sourceGeneration !== q.inputs.configurationAfter.sourceGeneration ||
          config.fileFingerprint !== q.inputs.configurationAfter.fileFingerprint ||
          !same(
            [
              context.loader.source,
              context.loader.selectionId,
              context.loader.loaderProfileId,
              context.loader.sourcePathIdentity,
              context.loader.decoderIdentity,
              context.loader.selectedAtMono,
              context.loader.qualificationEvidenceIds,
            ],
            [
              q.loader.source,
              q.loader.selectionId,
              q.loader.loaderProfileId,
              q.loader.sourcePathIdentity,
              q.loader.decoderIdentity,
              q.loader.selectedAtMono,
              q.loader.qualificationEvidenceIds,
            ],
          )
        )
          fail("QUALIFICATION_INVALID");
        covered.push(...context.observationEvidenceIds);
      }
      const expected = resolver.observations
        .filter((v) => v.kind === "fake-ip-kernel-destination")
        .map((v) => v.evidenceId);
      if (new Set(covered).size !== covered.length || set(covered) !== set(expected))
        fail("QUALIFICATION_INVALID");
    }
    if (
      !["reviewed-real-kernel-query-equivalence", "reviewed-kernel-query-path-conformance"].includes(
        resolver.source,
      ) ||
      !ref(resolver.evidenceId) ||
      !refs(resolver.sourceEvidenceIds) ||
      !refs(resolver.transportProfileIds) ||
      profiles.some((p) => !resolver.transportProfileIds.includes(p)) ||
      !Array.isArray(resolver.observations) ||
      !resolver.observations.length ||
      resolver.observations.length > 64 ||
      resolver.observations.some((v) => {
        if (
          !ref(v.evidenceId) ||
          !normalizeProofTarget(v.target) ||
          !profiles.includes(v.transportProfileId) ||
          !refs(v.kernelAddresses) ||
          !interval(v.startedAtMono, v.completedAtMono, 0, q.qualifiedAtMono)
        )
          return true;
        if (v.kind === "fake-ip-kernel-destination") {
          const originals = this.originalResolverMappings.filter((o) => o.evidenceId === v.evidenceId);
          const profile = v.factoryId === ANONYMOUS_TLS_FACTORY_ID ? q.transport.tlsProfileId : null;
          const context = contexts?.find((c) => c.observationEvidenceIds.includes(v.evidenceId));
          const association = context
            ? this.originalResolverContexts.find((c) => same(c.ids, context.observationEvidenceIds))!
                .association
            : this.originalAssociation!;
          return (
            resolver.source !== "reviewed-kernel-query-path-conformance" ||
            v.transportProfileId !== profile ||
            originals.length !== 1 ||
            !same(originals[0], v) ||
            !validateResolverFlowMapping(
              originals[0],
              context?.inputs ?? q.inputs,
              context?.loader ?? q.loader,
              association,
              q.qualifiedAtMono,
            )
          );
        }
        // The observed transport may use only part of the reviewed real candidate set.
        // Current route projection below still checks every kernel candidate, not this subset.
        return (
          (v.kind !== undefined && v.kind !== "real-direct") ||
          !refs(v.transportAddresses) ||
          v.kernelAddresses.some(
            (address: string) => isIP(address) !== (v.target.addressFamily === "ipv4" ? 4 : 6),
          ) ||
          v.transportAddresses.some(
            (address: string) =>
              isIP(address) !== (v.target.addressFamily === "ipv4" ? 4 : 6) ||
              !v.kernelAddresses.includes(address),
          )
        );
      })
    )
      fail("QUALIFICATION_INVALID");
    const equivalences = resolver.profileEquivalences ?? [];
    if (
      !Array.isArray(equivalences) ||
      equivalences.length > 64 ||
      equivalences.some(
        (e) =>
          !ref(e.evidenceId) ||
          !profiles.includes(e.fromProfileId) ||
          !profiles.includes(e.toProfileId) ||
          e.fromProfileId === e.toProfileId ||
          !families(e.addressFamilies) ||
          !refs(e.sourceObservationIds) ||
          !refs(e.sourceEvidenceIds) ||
          e.sourceObservationIds.some(
            (id: string) =>
              !resolver.observations.some(
                (o) => o.evidenceId === id && o.transportProfileId === e.fromProfileId,
              ),
          ),
      )
    )
      fail("QUALIFICATION_INVALID");
    for (const family of new Set(q.origins.flatMap((v) => v.possibleAddressFamilies))) {
      for (const profile of profiles) {
        const observed = resolver.observations.some(
          (o) => o.transportProfileId === profile && o.target.addressFamily === family,
        );
        const equivalent = equivalences.some(
          (e) =>
            e.toProfileId === profile &&
            e.addressFamilies.includes(family) &&
            resolver.observations.some(
              (o) =>
                o.transportProfileId === e.fromProfileId &&
                o.target.addressFamily === family &&
                e.sourceObservationIds.includes(o.evidenceId),
            ),
        );
        if (!observed && !equivalent) fail("QUALIFICATION_INVALID");
      }
    }
    if (
      !Array.isArray(q.routes) ||
      !q.routes.length ||
      q.routes.length > 2 ||
      new Set(q.routes.map((v) => v.binding.addressFamily)).size !== q.routes.length ||
      q.routes.some(
        (r) =>
          !Array.isArray(r.samples) ||
          !r.samples.length ||
          r.observedAtMono > q.qualifiedAtMono ||
          r.samples.some(
            (s: RouteConformanceRecord["samples"][number]) =>
              s.completedAtMono > q.qualifiedAtMono ||
              !resolver.observations.some((d) => d.target.addressFamily === s.target.addressFamily),
          ),
      )
    )
      fail("QUALIFICATION_INVALID");
    return q;
  }
  private current(request: ProofCollectionRequest, inputs: CurrentPathInputs, epoch: number) {
    this.guard(request, epoch);
    const q = this.qualificationForNow();
    if (
      inputs.generation !== request.generation ||
      inputs.rulesVersion !== request.rulesVersion ||
      !request.scope.catalogReviewed
    )
      fail("INPUT_INVALID");
    const associated = associateCurrentConfiguration({ inputs, loader: this.loader }, this.now());
    if (!associated.valid) fail("CONFIGURATION_UNAVAILABLE");
    if (!same(dependencies(inputs), dependencies(q.inputs))) fail("QUALIFICATION_CHANGED");
    // Runtime owns this context. Its actual account factory must be included in the selected
    // qualification; no separate context certificate or same-PID requirement is introduced here.
    if (!ref(request.scope.contextId)) fail("CONTEXT_UNQUALIFIED");
    const liveValue = this.options.getController();
    if (!liveValue) fail("RULE_UNVERIFIABLE");
    const live = structuredClone(liveValue);
    if (
      live.mode !== "rule" ||
      live.fingerprint !== inputs.rulesVersion ||
      !same(live.rules, inputs.configurationAfter.rules) ||
      !interval(live.startedAtMono!, live.completedAtMono!, 0, this.now()) ||
      this.now() - live.startedAtMono! >= NETWORK_TIMING.proofTtlMs
    )
      fail("RULE_UNVERIFIABLE");
    const outbound = currentDirectOutbound(inputs, live);
    if (outbound.kind !== "direct" || outbound.dialer !== "none") fail("RULE_UNVERIFIABLE");
    const expected = new Map(request.scope.targets.map((t) => [proofTargetKey(t), t]));
    for (const t of request.scope.targets)
      expected.set(proofTargetKey(echo(t.addressFamily)), echo(t.addressFamily));
    if (
      !expected.size ||
      expected.size > 128 ||
      expected.has(null) ||
      set([...expected.keys()] as string[]) !== set(inputs.targets.map((t) => proofTargetKey(t) ?? ""))
    )
      fail("INPUT_INVALID");
    const rawContexts = this.options.readRuleContexts?.({
      request: { ...request, scope: structuredClone(request.scope) },
      inputs: structuredClone(inputs),
      configuration: {
        inputs: structuredClone(inputs),
        loader: this.loader,
        association: associated.association,
      },
      transport: structuredClone(q.transport),
    });
    this.guard(request, epoch);
    if (this.options.readRuleContexts && !rawContexts) fail("RULE_UNVERIFIABLE");
    const ruleContexts =
      rawContexts === undefined
        ? undefined
        : cloneRuleContextSet({
            configuration: { loader: this.loader, association: associated.association },
            contexts: rawContexts!,
          });
    let ruleContextsExpireAt = Infinity;
    for (const target of inputs.targets) {
      if (target.protocol !== "https:" || !normalizeProofTarget(target)) fail("INPUT_INVALID");
      const origin = q.origins.find((v) => originKey(v.origin) === originKey(target));
      if (!origin || !origin.possibleAddressFamilies.includes(target.addressFamily))
        fail("CONTEXT_UNQUALIFIED");
      if (ruleContexts !== undefined) {
        const profiles = new Set<string>();
        if (request.scope.targets.some((t) => proofTargetKey(t) === proofTargetKey(target))) {
          profiles.add(q.transport.accountProfileId);
          profiles.add(q.transport.tlsProfileId);
        }
        if (
          request.scope.targets.some((t) => proofTargetKey(echo(t.addressFamily)) === proofTargetKey(target))
        )
          profiles.add(q.transport.egressProfileId);
        for (const profile of profiles) {
          const decision = evaluateRuleContextSet(
            ruleContexts,
            inputs,
            {
              mode: live.mode,
              rules: live.rules,
              generation: request.generation,
              rulesVersion: request.rulesVersion,
              kernelEpoch: inputs.ownerAfter.kernelEpoch,
              observedAtMono: live.completedAtMono!,
            },
            target,
            request.scope.contextId,
            profile,
            "tcp",
            this.now(),
          );
          if (decision.route === "unknown" || decision.matchedPolicy !== outbound.name)
            fail("RULE_UNVERIFIABLE");
          if (decision.expiresAtMono === null || decision.expiresAtMono <= this.now()) fail("INPUT_EXPIRED");
          ruleContextsExpireAt = Math.min(ruleContextsExpireAt, decision.expiresAtMono);
        }
      } else {
        const decision = evaluateRules(live.mode, live.rules, {
          host: target.host,
          port: target.port,
          network: "tcp",
        });
        if (
          decision.route === "unknown" ||
          decision.ruleIndex === null ||
          live.rules[decision.ruleIndex].proxy !== outbound.name
        )
          fail("RULE_UNVERIFIABLE");
      }
      // Validate the original artifact before producing a distinct current binding. Never repair
      // an inconsistent old environment by overwriting its fields with this round's values.
      const originalOutbound = currentDirectOutbound(q.inputs, {
        ...live,
        directPolicy: q.inputs.configurationAfter.currentDirectPolicy,
      });
      if (
        q.routes.some(
          (original) =>
            !same(
              original.binding,
              routeApplicabilityBinding(q.inputs, originalOutbound, original.binding.addressFamily),
            ),
        )
      )
        fail("QUALIFICATION_INVALID");
    }
    const scopeFamilies = [...new Set(request.scope.targets.map(originKey))].map((key) => {
      const original = q.origins.find((v) => originKey(v.origin) === key)!;
      if (
        set(request.scope.targets.filter((t) => originKey(t) === key).map((t) => t.addressFamily)) !==
        set(original.possibleAddressFamilies)
      )
        fail("CONTEXT_UNQUALIFIED");
      return {
        origin: original.origin,
        possibleAddressFamilies: original.possibleAddressFamilies,
        constraintEvidenceId: original.familyConstraint?.evidenceId ?? null,
      };
    });
    return {
      q,
      live,
      outbound,
      associated: associated.association,
      scopeFamilies,
      ruleContexts,
      ruleContextsExpireAt,
    };
  }

  private async collect(
    request: ProofCollectionRequest,
    inputs: CurrentPathInputs,
    epoch: number,
  ): Promise<ScopePathConformance> {
    const checked = this.current(request, inputs, epoch),
      { q, outbound, associated, scopeFamilies } = checked;
    const dns: ScopePathConformance["dns"][number][] = [],
      projections: CurrentPhysicalRouteProjection[] = [];
    const routes = q.routes.map((original) => ({
      ...structuredClone(original),
      binding: routeApplicabilityBinding(inputs, outbound, original.binding.addressFamily),
      evidenceId: hash([original.evidenceId, inputs.sampleId, associated.evidenceId]),
      expiresAtMono: Math.min(
        original.expiresAtMono,
        q.expiresAtMono,
        inputs.expiresAtMono,
        associated.expiresAtMono,
      ),
      sourceEvidenceIds: [
        ...new Set([...original.sourceEvidenceIds, original.evidenceId, associated.evidenceId]),
      ],
    }));
    const jobs: { target: ProofTarget; address: string; localAddress: string; routeEvidenceId: string }[] =
      [];
    for (const target of inputs.targets) {
      const hosts = inputs.dnsAfter.hosts.filter((v) => v.host === target.host),
        queryType = target.addressFamily === "ipv4" ? "A" : "AAAA";
      const host = hosts[0],
        queries = host?.queries.filter((v) => v.type === queryType) ?? [];
      if (
        hosts.length !== 1 ||
        queries.length !== 1 ||
        queries[0].error ||
        !queries[0].response ||
        queries[0].response.status !== 0 ||
        queries[0].response.truncated ||
        queries[0].response.host !== target.host ||
        queries[0].response.queryType !== queryType
      )
        fail("DNS_UNVERIFIED");
      const addresses = host.addresses.filter((v) => v.addressFamily === target.addressFamily),
        original = q.routes.find((v) => v.binding.addressFamily === target.addressFamily);
      if (
        !original ||
        !addresses.length ||
        addresses.length > 128 ||
        addresses.some(
          (v) => v.addressClass !== "real" || isIP(v.address) !== (target.addressFamily === "ipv4" ? 4 : 6),
        )
      )
        fail("DNS_UNVERIFIED");
      const sources = new Set(original.samples.map((s) => s.socket.sourceAddress));
      if (sources.size !== 1) fail("ROUTE_CLASS_MISMATCH");
      const source = [...sources][0];
      const answerDeadline = Math.min(
        ...host.answers.filter((v) => v.queryType === queryType).map((v) => v.expiresAtMono),
      );
      if (!Number.isFinite(answerDeadline) || answerDeadline <= this.now()) fail("INPUT_EXPIRED");
      for (const address of addresses)
        jobs.push({
          target,
          address: address.address,
          localAddress: source,
          routeEvidenceId: original.evidenceId,
        });
      dns.push({
        source: "current-dns-path-match",
        evidenceId: hash([inputs.sampleId, target, q.resolver.evidenceId]),
        inputSampleId: inputs.sampleId,
        target,
        dnsPolicyEvidenceId: q.resolver.evidenceId,
        status: "resolved",
        candidateAddresses: addresses.map((v) => v.address),
        resolvedAddresses: addresses.map((v) => v.address),
        observedAtMono: queries[0].startedAtMono,
        expiresAtMono: Math.min(
          answerDeadline,
          inputs.expiresAtMono,
          associated.expiresAtMono,
          q.expiresAtMono,
        ),
      });
    }
    if (jobs.length > 256) fail("INPUT_INVALID");
    for (const source of new Set(jobs.map((v) => v.localAddress))) {
      const addresses = [
        ...new Set(jobs.filter((v) => v.localAddress === source).map((v) => v.address)),
      ].sort();
      for (let index = 0; index < addresses.length; index += 16) {
        this.guard(request, epoch);
        const scope = { addresses: addresses.slice(index, index + 16), localAddress: source },
          floor = this.now();
        const reader = this.options.createRouteReader?.(scope) ?? new WindowsRouteSelectionReader(scope);
        let result: WindowsRouteSelectionSnapshot;
        try {
          result = structuredClone(await reader.read(request.signal));
        } finally {
          reader.dispose();
          await reader.whenIdle();
        }
        this.guard(request, epoch);
        if (
          !result.available ||
          result.basis !== "windows-source-route-query" ||
          result.localAddress !== source ||
          result.socketObserved !== false ||
          !interval(result.startedAtMono, result.completedAtMono, floor, this.now()) ||
          set(result.selections.map((r) => r.targetAddress)) !== set(scope.addresses)
        )
          fail("ROUTE_UNAVAILABLE");
        for (const job of jobs.filter(
          (j) => j.localAddress === source && scope.addresses.includes(j.address),
        )) {
          const physicalRoute = result.selections.find((v) => v.targetAddress === job.address)!;
          const observed = inputs.routeBatches.flatMap((batch) =>
            batch.selections
              .filter((r) => r.targetAddress === job.address)
              .map((route) => ({ batch, route })),
          );
          if (observed.length !== 1 || physicalRoute.sourceAddress !== source) fail("ROUTE_UNAVAILABLE");
          projections.push({
            source: "current-physical-route-projection",
            evidenceId: hash([inputs.sampleId, job.target, result.selectionHash, source]),
            binding: routeApplicabilityBinding(inputs, outbound, job.target.addressFamily),
            host: job.target.host,
            candidateAddress: job.address,
            resolvedAddress: job.address,
            observedOsRoute: observed[0].route,
            physicalRoute,
            sourceEvidenceIds: [job.routeEvidenceId, result.selectionHash, associated.evidenceId],
            dnsMappingEvidenceId: null,
            startedAtMono: result.startedAtMono,
            completedAtMono: result.completedAtMono,
          });
        }
      }
    }
    const final = this.current(request, inputs, epoch);
    const record: ScopePathConformance = {
      source: "current-scope-path-conformance",
      evidenceId: hash([inputs.sampleId, associated.evidenceId, q.evidenceId, request.scope, this.now()]),
      inputSampleId: inputs.sampleId,
      accountContextId: request.scope.contextId,
      generation: request.generation,
      rulesVersion: request.rulesVersion,
      kernelEpoch: inputs.ownerAfter.kernelEpoch,
      fileFingerprint: inputs.configurationAfter.fileFingerprint,
      effectivePathPolicyVersion: inputs.configurationAfter.policy.fingerprint,
      osNetworkHash: inputs.networkAfter.hash,
      checkedAtMono: this.now(),
      expiresAtMono: Math.min(
        inputs.expiresAtMono,
        final.associated.expiresAtMono,
        final.ruleContextsExpireAt,
        q.expiresAtMono,
        ...dns.map((v) => v.expiresAtMono),
        ...projections.map((v) => v.startedAtMono + NETWORK_TIMING.proofTtlMs),
      ),
      transport: structuredClone(q.transport),
      families: scopeFamilies,
      dns,
      routes,
      physicalRouteProjections: projections,
      ...(final.ruleContexts === undefined ? {} : { ruleContexts: final.ruleContexts }),
    };
    for (const target of request.scope.targets) {
      const verified = verifyRouteApplicability(
        {
          inputs,
          target,
          echo: echo(target.addressFamily),
          outbound: final.outbound,
          snapshot: {
            mode: final.live.mode,
            rules: final.live.rules,
            generation: request.generation,
            rulesVersion: request.rulesVersion,
            kernelEpoch: inputs.ownerAfter.kernelEpoch,
            observedAtMono: final.live.completedAtMono!,
          },
          conformance: routes.find((r) => r.binding.addressFamily === target.addressFamily) ?? null,
          targetTransportProfileId: q.transport.accountProfileId,
          echoTransportProfileId: q.transport.egressProfileId,
          physicalRouteProjections: projections,
          ruleContexts: record.ruleContexts,
          scopeContextId: request.scope.contextId,
        },
        this.now(),
      );
      if (!verified.valid) fail("ROUTE_CLASS_MISMATCH");
    }
    this.guard(request, epoch);
    if (record.expiresAtMono <= this.now()) fail("INPUT_EXPIRED");
    this.prune();
    if (this.rounds.size >= 64) this.rounds.delete(this.rounds.keys().next().value!);
    this.rounds.set(record.evidenceId, {
      request: { ...request, scope: structuredClone(request.scope) },
      inputs: freeze(inputs),
      record: freeze(record),
      configuration: final.associated,
    });
    return cloneScopePathConformance(record);
  }

  async bindSamples(input: BindInput): Promise<readonly DiagnosticSamplePathBinding[] | null> {
    try {
      const epoch = this.epoch,
        request = { ...input.request, scope: structuredClone(input.request.scope) };
      const round = this.rounds.get(input.conformance.evidenceId);
      if (
        !round ||
        !same(input.conformance, round.record) ||
        !same(input.inputs, round.inputs) ||
        proofScopeKey(request.scope) !== proofScopeKey(round.request.scope)
      )
        fail("SAMPLE_UNQUALIFIED");
      const checked = this.current(request, round.inputs, epoch);
      if (round.record.expiresAtMono <= this.now()) fail("INPUT_EXPIRED");
      if (
        !Array.isArray(input.samples) ||
        !input.samples.length ||
        input.samples.length > 128 ||
        input.routes.length !== request.scope.targets.length
      )
        fail("SAMPLE_UNQUALIFIED");
      const verifiedRoutes = new Map<string, ValidatedRouteApplicability>();
      for (const route of input.routes) {
        if (
          !validateRouteApplicability(
            route,
            routeApplicabilityBinding(round.inputs, checked.outbound, route.target.addressFamily),
            route.target,
            echo(route.target.addressFamily),
            this.now(),
          ) ||
          !request.scope.targets.some((t) => proofTargetKey(t) === proofTargetKey(route.target)) ||
          verifiedRoutes.has(proofTargetKey(route.target)!)
        )
          fail("SAMPLE_UNQUALIFIED");
        verifiedRoutes.set(proofTargetKey(route.target)!, route);
      }
      const output: DiagnosticSamplePathBinding[] = [],
        additions = new Map<string, DiagnosticSamplePathBinding["originalPath"]>();
      for (const sample of structuredClone(input.samples)) {
        const observation = sample.observation,
          origin = "echo" in observation ? observation.echo.origin : observation.origin;
        const originalAt =
          "observedAtMono" in observation ? observation.observedAtMono : observation.completedAtMono;
        const expectedFactory =
          sample.kind === "egress" ? ANONYMOUS_EGRESS_FACTORY_ID : ANONYMOUS_TLS_FACTORY_ID;
        if (
          observation.factoryId !== expectedFactory ||
          !ref(observation.transportContextId) ||
          !interval(observation.startedAtMono, originalAt, checked.q.qualifiedAtMono, this.now())
        )
          fail("SAMPLE_UNQUALIFIED");
        const paths = checked.q.diagnosticPaths.filter(
          (p) =>
            p.kind === sample.kind &&
            p.origin.host === origin.host &&
            p.origin.port === origin.port &&
            p.origin.protocol === "https:",
        );
        if (
          paths.length !== 1 ||
          !ref(paths[0].evidenceId) ||
          !refs(paths[0].sourceEvidenceIds) ||
          !families(paths[0].possibleAddressFamilies) ||
          !["reviewed-path-equivalence", "validated-path-constraint"].includes(paths[0].basis)
        )
          fail("SAMPLE_UNQUALIFIED");
        const path = paths[0],
          applicable = [...verifiedRoutes.values()].filter((r) =>
            sample.kind === "egress"
              ? r.echo.host === origin.host && r.echo.port === origin.port
              : r.target.host === origin.host && r.target.port === origin.port,
          );
        if (
          !applicable.length ||
          applicable.some((r) => !path.possibleAddressFamilies.includes(r.target.addressFamily))
        )
          fail("SAMPLE_UNQUALIFIED");
        // An echo's response-body family is not its transport family. Equivalence must already
        // constrain this exact diagnostic origin to the one covered family, or it remains unknown.
        if (
          sample.kind === "egress" &&
          (path.possibleAddressFamilies.length !== 1 ||
            !("reportedAddressFamily" in observation) ||
            path.possibleAddressFamilies[0] !== observation.reportedAddressFamily)
        )
          fail("SAMPLE_UNQUALIFIED");
        if (
          sample.kind === "tls" &&
          set([...new Set(applicable.map((r) => r.target.addressFamily))]) !==
            set(path.possibleAddressFamilies)
        )
          fail("SAMPLE_UNQUALIFIED");
        const digest = diagnosticObservationDigest(observation);
        if (output.some((v) => v.observationDigest === digest)) fail("SAMPLE_UNQUALIFIED");
        const original = this.originalPaths.get(digest);
        if (
          sample.previousBinding &&
          (!original ||
            !same(sample.previousBinding.originalPath, original) ||
            sample.previousBinding.observationDigest !== digest ||
            sample.previousBinding.factoryId !== observation.factoryId ||
            sample.previousBinding.diagnosticContextId !== observation.transportContextId ||
            sample.previousBinding.originalStartedAtMono !== observation.startedAtMono ||
            sample.previousBinding.originalObservedAtMono !== originalAt)
        )
          fail("SAMPLE_UNQUALIFIED");
        const originalPath =
          original ??
          freeze({
            evidenceId: hash([checked.q.evidenceId, path.evidenceId, digest]),
            sourceEvidenceIds: [checked.q.evidenceId, path.evidenceId, ...path.sourceEvidenceIds],
            observedPhysicalFamily: null,
          });
        additions.set(digest, originalPath);
        output.push({
          source: "current-diagnostic-path-binding",
          evidenceId: hash([round.record.evidenceId, digest, this.now()]),
          observationDigest: digest,
          factoryId: observation.factoryId,
          diagnosticContextId: observation.transportContextId,
          origin,
          originalStartedAtMono: observation.startedAtMono,
          originalObservedAtMono: originalAt,
          originalPath,
          inputSampleId: round.inputs.sampleId,
          conformanceEvidenceId: round.record.evidenceId,
          checkedAtMono: this.now(),
          expiresAtMono: Math.min(
            round.record.expiresAtMono,
            checked.associated.expiresAtMono,
            checked.ruleContextsExpireAt,
            ...applicable.map((r) => r.expiresAtMono),
          ),
          coverage: applicable.map((route) => ({
            target: route.target,
            physicalRouteClass: route.physicalRouteClass,
            routeApplicabilityEvidenceId: route.evidenceId,
            accountTransportProfileId: checked.q.transport.accountProfileId,
            basis: path.basis,
            sourceEvidenceIds: [
              path.evidenceId,
              round.configuration.evidenceId,
              route.evidenceId,
              checked.q.transport.evidenceId,
            ],
          })),
        });
      }
      this.guard(request, epoch);
      if (round.record.expiresAtMono <= this.now() || output.some((item) => item.expiresAtMono <= this.now()))
        fail("INPUT_EXPIRED");
      for (const [key, value] of additions) {
        if (this.originalPaths.size >= 256 && !this.originalPaths.has(key))
          this.originalPaths.delete(this.originalPaths.keys().next().value!);
        this.originalPaths.set(key, value);
      }
      this.reason = null;
      return freeze(output);
    } catch (error) {
      this.reason = error instanceof ConformanceError ? error.reason : "INPUT_INVALID";
      return null;
    }
  }
  private prune(): void {
    for (const [key, round] of this.rounds)
      if (round.record.expiresAtMono <= this.now()) this.rounds.delete(key);
  }
}
