import { createHash } from "node:crypto";
import type {
  AnonymousPhysicalRouteCollector,
  AnonymousPhysicalRouteObservation,
} from "./anonymous-physical-route-collector";
import { ANONYMOUS_TLS_FACTORY_ID } from "./anonymous-proof-probe";
import { ANONYMOUS_EGRESS_FACTORY_ID } from "./anonymous-egress-probe";
import { associateCurrentConfiguration, type KnownSelectedLoaderContract } from "./configuration-association";
import { normalizeProofTarget, proofTargetKey, type ProofTarget } from "./direct-proof";
import {
  PathConformanceAdapter,
  validatePathDiagnosticMetadata,
  type PathConformanceOptions,
  type RetainedPathQualification,
} from "./path-conformance";
import type { PathQualificationProducer } from "./path-qualification-lifecycle";
import type { ProofScopeVersion } from "./proof-issuer";
import { validateResolverFlowMapping } from "./resolver-flow-mapping";

type ResolverEquivalence = NonNullable<RetainedPathQualification["resolver"]["profileEquivalences"]>[number];
/** Main-process review of applicable factories/resolver policy and family constraints. Missing
 * review stays unavailable; runtime experiments/reports are never loaded here as a substitute.
 * The review supplies its actual lifetime. The producer cannot extend or invent one. */
export interface PathPreparationReview {
  readonly source: "main-process-path-preparation-review";
  readonly evidenceId: string;
  readonly reviewedAtMono: number;
  readonly expiresAtMono: number;
  readonly electronVersion: string;
  readonly transport: RetainedPathQualification["transport"];
  readonly tcpQualification: RetainedPathQualification["tcpQualification"];
  readonly origins: RetainedPathQualification["origins"];
  readonly diagnosticPaths: RetainedPathQualification["diagnosticPaths"];
  /** One reviewed representative per possible family, not one socket observation per URL. */
  readonly representatives: readonly ProofTarget[];
  readonly resolver: {
    readonly evidenceId: string;
    readonly sourceEvidenceIds: readonly string[];
    readonly profileEquivalences: readonly Omit<ResolverEquivalence, "sourceObservationIds">[];
  };
  /** Explicit physical-path applicability to the three factories; never derived from same PID. */
  readonly routeProfileEvidenceIds: readonly string[];
}
export interface ObservedPathQualificationProducerOptions {
  collector: Pick<AnonymousPhysicalRouteCollector, "collect" | "whenIdle">;
  readReview(loader: KnownSelectedLoaderContract): PathPreparationReview | null;
  readVersion(): ProofScopeVersion | null;
  readChromiumRuntime?: PathConformanceOptions["readChromiumRuntime"];
  now?: () => number;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const references = (values: readonly string[]) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.length <= 64 &&
  values.every(
    (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 4096 && !/[\r\n\0]/.test(v),
  ) &&
  new Set(values).size === values.length;
const loaderIdentity = (v: KnownSelectedLoaderContract) =>
  hash([
    v.source,
    v.selectionId,
    v.loaderProfileId,
    v.sourcePathIdentity,
    v.decoderIdentity,
    v.selectedAtMono,
    v.qualificationEvidenceIds,
  ]);
const sameVersion = (a: ProofScopeVersion | null, b: ProofScopeVersion | null) =>
  !!a && !!b && a.generation === b.generation && a.rulesVersion === b.rulesVersion;
function fact(value: unknown): asserts value {
  if (!value) throw new Error("PATH_PREPARATION_UNAVAILABLE");
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}

/** Collects actual original records, then assembles a retained qualification. It never selects a
 * policy, adds factory equivalence, sets a one-family flag, or issues a Gate permit on its own.
 * The application supplies the real quiet window through its collector; this producer has no IPC.
 */
export class ObservedPathQualificationProducer implements PathQualificationProducer {
  private readonly now: () => number;
  private pending: Promise<RetainedPathQualification | null> | null = null;
  private drainFailed = false;
  private readonly retained = new WeakMap<
    RetainedPathQualification,
    {
      reviewHash: string;
      loaderIdentity: string;
      reviewedAtMono: number;
      qualifiedAtMono: number;
      expiresAtMono: number;
    }
  >();
  private readonly checking = new WeakSet<RetainedPathQualification>();
  constructor(private readonly options: ObservedPathQualificationProducerOptions) {
    this.now = options.now ?? (() => performance.now());
  }
  prepare(
    loader: KnownSelectedLoaderContract,
    signal: AbortSignal,
  ): Promise<RetainedPathQualification | null> {
    if (this.pending || this.drainFailed || signal.aborted) return Promise.resolve(null);
    let captured: KnownSelectedLoaderContract;
    try {
      captured = freeze(structuredClone(loader));
    } catch {
      return Promise.resolve(null);
    }
    const work = Promise.resolve()
      .then(() => this.run(captured, signal))
      .catch(() => null)
      .finally(() => {
        if (this.pending === work) this.pending = null;
      });
    this.pending = work;
    return work;
  }
  async whenIdle(): Promise<void> {
    while (this.pending) await this.pending;
    if (this.drainFailed) throw new Error("PATH_PREPARATION_CLEANUP_FAILED");
  }
  /** Original object plus a current in-memory review. No collection, report read, or TTL rewrite. */
  isQualificationCurrent(q: RetainedPathQualification, loader: KnownSelectedLoaderContract): boolean {
    const record = this.retained.get(q);
    if (!record || this.drainFailed) return false;
    if (this.checking.has(q)) {
      this.retained.delete(q);
      return false;
    }
    this.checking.add(q);
    try {
      const current = this.options.readReview(loader),
        checkedAt = this.now();
      const valid =
        current !== null &&
        hash(current) === record.reviewHash &&
        loaderIdentity(loader) === record.loaderIdentity &&
        loaderIdentity(q.loader) === record.loaderIdentity &&
        q.qualifiedAtMono === record.qualifiedAtMono &&
        q.expiresAtMono === record.expiresAtMono &&
        Number.isFinite(checkedAt) &&
        checkedAt >= record.reviewedAtMono &&
        checkedAt >= record.qualifiedAtMono &&
        checkedAt < record.expiresAtMono &&
        !this.drainFailed &&
        this.retained.get(q) === record;
      if (!valid) this.retained.delete(q);
      return valid;
    } catch {
      this.retained.delete(q);
      return false;
    } finally {
      this.checking.delete(q);
    }
  }
  private async run(
    loader: KnownSelectedLoaderContract,
    signal: AbortSignal,
  ): Promise<RetainedPathQualification | null> {
    let output: RetainedPathQualification;
    let finalGuard: () => void;
    let reviewBinding: { reviewHash: string; loaderIdentity: string; reviewedAtMono: number };
    try {
      const version = structuredClone(this.options.readVersion());
      const raw = this.options.readReview(loader);
      if (!raw || !version || signal.aborted) return null;
      const review = freeze(structuredClone(raw));
      const reviewHash = hash(review);
      reviewBinding = {
        reviewHash,
        loaderIdentity: loaderIdentity(loader),
        reviewedAtMono: review.reviewedAtMono,
      };
      const guard = () => {
        const currentVersion = this.options.readVersion();
        const currentReview = this.options.readReview(loader);
        const checkedAt = this.now();
        fact(
          !signal.aborted &&
            sameVersion(version, currentVersion) &&
            currentReview &&
            hash(currentReview) === reviewHash &&
            Number.isFinite(checkedAt) &&
            checkedAt >= review.reviewedAtMono &&
            checkedAt < review.expiresAtMono,
        );
        fact(!signal.aborted);
      };
      finalGuard = guard;
      guard();
      this.validateReview(review);
      const observations: AnonymousPhysicalRouteObservation[] = [];
      for (const target of review.representatives) {
        guard();
        const result = await this.options.collector.collect(
          target,
          loader,
          review.transport.tlsProfileId,
          signal,
        );
        guard();
        fact(result.available);
        const observed = result.observation;
        fact(
          observed.kind === "anonymous-physical-route-observation" &&
            observed.qualificationGranted === false &&
            observed.factoryId === ANONYMOUS_TLS_FACTORY_ID &&
            observed.transportProfileId === review.transport.tlsProfileId &&
            proofTargetKey(observed.target) === proofTargetKey(target) &&
            loaderIdentity(observed.loader) === loaderIdentity(loader) &&
            observed.inputs.generation === version.generation &&
            observed.inputs.rulesVersion === version.rulesVersion &&
            observed.completedAtMono <= this.now() &&
            observed.completedAtMono >= observed.postflightInputs.completedAtMono &&
            observed.inputs.startedAtMono >= review.reviewedAtMono &&
            observed.flows.length === 2 &&
            observed.flows.every((flow) =>
              validateResolverFlowMapping(
                flow.resolverMapping,
                observed.inputs,
                observed.loader,
                observed.configuration,
                observed.completedAtMono,
              ),
            ),
        );
        observations.push(observed);
      }
      guard();
      const anchor = observations.at(-1)!.postflightInputs;
      const associated = associateCurrentConfiguration({ inputs: anchor, loader }, this.now());
      fact(associated.valid);
      const mappings = observations.flatMap((o) => o.flows.map((flow) => flow.resolverMapping));
      fact(new Set(mappings.map((m) => m.evidenceId)).size === mappings.length);
      const profiles = [
        review.transport.accountProfileId,
        review.transport.tlsProfileId,
        review.transport.egressProfileId,
      ];
      const resolverEquivalences = review.resolver.profileEquivalences.map((equivalence) => ({
        ...equivalence,
        sourceObservationIds: mappings
          .filter(
            (m) =>
              m.transportProfileId === equivalence.fromProfileId &&
              equivalence.addressFamilies.includes(m.target.addressFamily),
          )
          .map((m) => m.evidenceId),
      }));
      const routes = observations.map((observation) => {
        const { completedAtMono: _completed, ...original } = observation.routeFacts;
        fact(
          original.source === "main-process-route-conformance" &&
            original.samples.length === 2 &&
            original.transportProfileIds.length === 1 &&
            original.transportProfileIds[0] === review.transport.tlsProfileId &&
            original.samples.every((s) => s.transportProfileId === review.transport.tlsProfileId) &&
            original.binding.generation === anchor.generation &&
            original.binding.rulesVersion === anchor.rulesVersion &&
            original.binding.sourceGeneration === anchor.configurationAfter.sourceGeneration &&
            original.binding.fileFingerprint === anchor.configurationAfter.fileFingerprint &&
            original.binding.kernelEpoch === anchor.ownerAfter.kernelEpoch &&
            original.binding.osNetworkHash === anchor.networkAfter.hash &&
            original.binding.addressFamily === observation.target.addressFamily,
        );
        return freeze({
          ...structuredClone(original),
          evidenceId: hash([original.evidenceId, review.evidenceId]),
          transportProfileIds: profiles,
          sourceEvidenceIds: [
            ...new Set([
              ...original.sourceEvidenceIds,
              original.evidenceId,
              review.evidenceId,
              ...review.routeProfileEvidenceIds,
            ]),
          ],
          expiresAtMono: review.expiresAtMono,
        });
      });
      const q: RetainedPathQualification = {
        source: "main-process-retained-path-qualification",
        evidenceId: hash([
          reviewHash,
          observations.map((o) => o.routeFacts.evidenceId),
          mappings.map((m) => m.evidenceId),
          associated.association.evidenceId,
        ]),
        inputs: freeze(structuredClone(anchor)),
        loader: freeze(structuredClone(loader)),
        configuration: associated.association,
        qualifiedAtMono: this.now(),
        expiresAtMono: review.expiresAtMono,
        electronVersion: review.electronVersion,
        transport: review.transport,
        tcpQualification: review.tcpQualification,
        origins: review.origins,
        diagnosticPaths: review.diagnosticPaths,
        routes,
        resolver: {
          source: "reviewed-kernel-query-path-conformance",
          evidenceId: review.resolver.evidenceId,
          sourceEvidenceIds: review.resolver.sourceEvidenceIds,
          transportProfileIds: profiles,
          observations: mappings,
          profileEquivalences: resolverEquivalences,
          observationContexts: observations.map((o) => ({
            observationEvidenceIds: o.flows.map((flow) => flow.resolverMapping.evidenceId),
            inputs: freeze(structuredClone(o.inputs)),
            loader: freeze(structuredClone(o.loader)),
            configuration: o.configuration,
          })),
        },
      };
      const verifier = new PathConformanceAdapter({
        loader,
        qualification: q,
        readVersion: this.options.readVersion,
        getController: () => null,
        readChromiumRuntime: this.options.readChromiumRuntime,
        now: this.now,
      });
      try {
        fact(verifier.hasValidRetainedQualification());
      } finally {
        verifier.dispose();
        await verifier.whenIdle();
      }
      guard();
      output = freeze(q);
    } finally {
      try {
        await this.options.collector.whenIdle();
      } catch {
        this.drainFailed = true;
      }
    }
    if (signal.aborted || this.drainFailed) return null;
    // Cleanup is part of preparation. It must not make a completed review current again.
    finalGuard();
    fact(this.now() >= output.qualifiedAtMono && !signal.aborted);
    this.retained.set(output, {
      ...reviewBinding,
      qualifiedAtMono: output.qualifiedAtMono,
      expiresAtMono: output.expiresAtMono,
    });
    return output;
  }
  private validateReview(review: PathPreparationReview): void {
    fact(
      validatePathDiagnosticMetadata(review) &&
        review.source === "main-process-path-preparation-review" &&
        references([review.evidenceId, review.electronVersion]) &&
        Number.isFinite(review.reviewedAtMono) &&
        review.reviewedAtMono >= 0 &&
        Number.isFinite(review.expiresAtMono) &&
        review.expiresAtMono > review.reviewedAtMono &&
        review.transport.tlsFactoryId === ANONYMOUS_TLS_FACTORY_ID &&
        review.transport.egressFactoryId === ANONYMOUS_EGRESS_FACTORY_ID &&
        references(review.routeProfileEvidenceIds) &&
        references([review.resolver.evidenceId]) &&
        references(review.resolver.sourceEvidenceIds),
    );
    const families = [...new Set(review.origins.flatMap((origin) => origin.possibleAddressFamilies))].sort();
    fact(
      families.length > 0 &&
        families.length <= 2 &&
        review.representatives.length === families.length &&
        JSON.stringify(review.representatives.map((t) => t.addressFamily).sort()) ===
          JSON.stringify(families) &&
        review.representatives.every(
          (t) =>
            normalizeProofTarget(t) &&
            t.protocol === "https:" &&
            review.origins.some(
              (o) =>
                o.origin.host === t.host &&
                o.origin.protocol === t.protocol &&
                o.origin.port === t.port &&
                o.possibleAddressFamilies.includes(t.addressFamily),
            ),
        ),
    );
    for (const profile of [review.transport.accountProfileId, review.transport.egressProfileId]) {
      fact(
        families.every((family) =>
          review.resolver.profileEquivalences.some(
            (e) =>
              e.fromProfileId === review.transport.tlsProfileId &&
              e.toProfileId === profile &&
              e.addressFamilies.includes(family) &&
              references([e.evidenceId]) &&
              references(e.sourceEvidenceIds),
          ),
        ),
      );
    }
  }
}
