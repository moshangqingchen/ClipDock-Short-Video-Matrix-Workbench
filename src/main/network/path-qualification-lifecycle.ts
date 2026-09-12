import type { KnownSelectedLoaderContract } from "./configuration-association";
import type { RetainedPathQualification } from "./path-conformance";
import type { ProofScopeVersion } from "./proof-issuer";

/** Main-process producer only. Its idle barrier includes work that cannot be cancelled promptly. */
export interface PathQualificationProducer {
  prepare(
    loader: KnownSelectedLoaderContract,
    signal: AbortSignal,
  ): Promise<RetainedPathQualification | null>;
  whenIdle(): Promise<void>;
  /** Synchronous main-process memory check; must not perform I/O or start preparation. */
  isQualificationCurrent?(
    qualification: RetainedPathQualification,
    loader: KnownSelectedLoaderContract,
  ): boolean;
}
export interface PathQualificationLifecycleOptions {
  producer?: PathQualificationProducer;
  readVersion(): ProofScopeVersion | null;
  now?: () => number;
}
interface Binding {
  loaderKey: string;
  versionKey: string;
  epoch: number;
}
interface Ready extends Binding {
  qualification: RetainedPathQualification;
  expiresAtMono: number;
  qualifiedAtMono: number;
  evidenceId: string;
}
interface Job extends Binding {
  controller: AbortController;
  promise: Promise<RetainedPathQualification | null>;
  settle(value: RetainedPathQualification | null): void;
}
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
function loaderKey(loader: KnownSelectedLoaderContract): string | null {
  if (
    !loader ||
    loader.source !== "main-process-selected-loader-contract" ||
    ![loader.selectionId, loader.loaderProfileId, loader.sourcePathIdentity, loader.decoderIdentity].every(
      nonempty,
    ) ||
    !Number.isFinite(loader.selectedAtMono) ||
    loader.selectedAtMono < 0 ||
    !Array.isArray(loader.qualificationEvidenceIds) ||
    !loader.qualificationEvidenceIds.length ||
    !loader.qualificationEvidenceIds.every(nonempty)
  )
    return null;
  return JSON.stringify([
    loader.source,
    loader.selectionId,
    loader.loaderProfileId,
    loader.sourcePathIdentity,
    loader.decoderIdentity,
    loader.selectedAtMono,
    loader.qualificationEvidenceIds,
  ]);
}
function versionKey(version: ProofScopeVersion | null): string | null {
  return version &&
    Number.isSafeInteger(version.generation) &&
    version.generation >= 0 &&
    nonempty(version.rulesVersion)
    ? JSON.stringify([version.generation, version.rulesVersion])
    : null;
}

/**
 * Explicit preparation and a synchronous, observation-free getter. This owns no Gate or business
 * session. It retains the producer's original branded object; PathConformanceAdapter still checks
 * all original facts and their applicability to fresh configuration, DNS, rules and OS inputs.
 */
export class PathQualificationLifecycle {
  private readonly now: () => number;
  private epoch = 0;
  private ready: Ready | null = null;
  private active: Job | null = null;
  private idle: Promise<void> = Promise.resolve();
  private drainFailed = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private checkingProducer = false;

  constructor(private readonly options: PathQualificationLifecycleOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  /** No implicit preparation. A new Gate generation needs explicit prepare, not new socket samples. */
  getQualification(loader: KnownSelectedLoaderContract): RetainedPathQualification | null {
    const entry = this.ready;
    if (!entry || this.disposed || this.drainFailed) return null;
    if (!this.isCurrent(entry, loader)) return null;
    const q = entry.qualification;
    if (
      q.source !== "main-process-retained-path-qualification" ||
      q.evidenceId !== entry.evidenceId ||
      q.expiresAtMono !== entry.expiresAtMono ||
      q.qualifiedAtMono !== entry.qualifiedAtMono ||
      loaderKey(q.loader) !== entry.loaderKey
    ) {
      this.invalidate();
      return null;
    }
    if (!this.producerAccepts(q, loader) || !this.isCurrent(entry, loader)) return null;
    // Version/review getters can synchronously invalidate; never return the captured old entry.
    return this.ready === entry && entry.epoch === this.epoch ? q : null;
  }

  prepare(loader: KnownSelectedLoaderContract): Promise<RetainedPathQualification | null> {
    if (this.disposed || this.drainFailed || !this.options.producer) return Promise.resolve(null);
    const epoch = this.epoch;
    let key: string | null, currentVersion: string | null, captured: KnownSelectedLoaderContract;
    try {
      key = loaderKey(loader);
      currentVersion = versionKey(this.options.readVersion());
      captured = structuredClone(loader);
      Object.freeze(captured.qualificationEvidenceIds);
      Object.freeze(captured);
    } catch {
      this.invalidate();
      return Promise.resolve(null);
    }
    if (this.disposed || this.epoch !== epoch) return Promise.resolve(null);
    if (!key || !currentVersion || loaderKey(captured) !== key) {
      this.invalidate();
      return Promise.resolve(null);
    }
    if (this.active) {
      if (
        !this.active.controller.signal.aborted &&
        this.active.epoch === epoch &&
        this.active.loaderKey === key &&
        this.active.versionKey === currentVersion
      )
        return this.active.promise;
      this.invalidate();
      return Promise.resolve(null); // Caller retries explicitly after whenIdle; no hidden queued sampling.
    }
    if (this.ready && (this.ready.loaderKey !== key || this.ready.versionKey !== currentVersion))
      this.invalidate();
    const lookupEpoch = this.epoch;
    const existing = this.getQualification(captured);
    if (existing) return Promise.resolve(existing);
    // A reentrant readVersion callback can revoke this explicit preparation too. An expired
    // entry cleared by the getter likewise needs a new explicit call, never a hidden restart.
    if (this.disposed || this.drainFailed || this.epoch !== lookupEpoch) return Promise.resolve(null);
    this.ready = null;
    let settle!: Job["settle"];
    const promise = new Promise<RetainedPathQualification | null>((resolve) => {
      settle = resolve;
    });
    const job: Job = {
      loaderKey: key,
      versionKey: currentVersion,
      epoch: this.epoch,
      controller: new AbortController(),
      promise,
      settle,
    };
    job.controller.signal.addEventListener("abort", () => job.settle(null), { once: true });
    this.active = job;
    // Enter asynchronously only after the slot and its public cancellation path are installed.
    this.idle = Promise.resolve().then(() => this.run(job, captured));
    void this.idle.catch(() => undefined); // The explicit whenIdle/dispose caller still receives failure.
    return promise;
  }

  /** Clear synchronously before invoking any producer abort handlers. */
  invalidate(): void {
    this.ready = null;
    this.epoch++;
    this.active?.controller.abort();
  }
  whenIdle(): Promise<void> {
    return this.idle;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.invalidate();
    this.disposal = this.idle;
    return this.disposal;
  }

  private isCurrent(binding: Binding, loader: KnownSelectedLoaderContract): boolean {
    if (this.disposed || this.drainFailed || binding.epoch !== this.epoch) return false;
    let currentVersion: string | null, key: string | null, now: number;
    try {
      key = loaderKey(loader);
      currentVersion = versionKey(this.options.readVersion());
      now = this.now();
    } catch {
      this.invalidate();
      return false;
    }
    if (this.disposed || binding.epoch !== this.epoch) return false;
    if (
      key !== binding.loaderKey ||
      currentVersion !== binding.versionKey ||
      !Number.isFinite(now) ||
      now < 0 ||
      ("expiresAtMono" in binding &&
        (now >= (binding as Ready).expiresAtMono || now < (binding as Ready).qualifiedAtMono))
    ) {
      this.invalidate();
      return false;
    }
    return true;
  }
  private producerAccepts(q: RetainedPathQualification, loader: KnownSelectedLoaderContract): boolean {
    if (this.checkingProducer) {
      this.invalidate();
      return false;
    }
    const epoch = this.epoch;
    this.checkingProducer = true;
    try {
      const check = this.options.producer?.isQualificationCurrent;
      if (check === undefined) return true;
      if (typeof check !== "function") {
        this.invalidate();
        return false;
      }
      if (check.call(this.options.producer, q, loader) !== true) {
        this.invalidate();
        return false;
      }
      return !this.disposed && !this.drainFailed && this.epoch === epoch;
    } catch {
      this.invalidate();
      return false;
    } finally {
      this.checkingProducer = false;
    }
  }
  private async run(job: Job, loader: KnownSelectedLoaderContract): Promise<void> {
    const producer = this.options.producer!;
    let candidate: RetainedPathQualification | null = null;
    let drained = false;
    try {
      if (this.isCurrent(job, loader) && !job.controller.signal.aborted) {
        try {
          candidate = await producer.prepare(loader, job.controller.signal);
        } catch {
          /* Unavailable. */
        }
      }
      // Always wait for nested cleanup, including prepare failure and cancellation.
      await producer.whenIdle();
      drained = true;
      if (!candidate || !this.isCurrent(job, loader) || job.controller.signal.aborted) return;
      const entry: Ready = {
        ...job,
        qualification: candidate,
        evidenceId: candidate.evidenceId,
        expiresAtMono: candidate.expiresAtMono,
        qualifiedAtMono: candidate.qualifiedAtMono,
      };
      if (
        candidate.source !== "main-process-retained-path-qualification" ||
        !nonempty(entry.evidenceId) ||
        loaderKey(candidate.loader) !== job.loaderKey ||
        !Number.isFinite(entry.qualifiedAtMono) ||
        entry.qualifiedAtMono < 0 ||
        !Number.isFinite(entry.expiresAtMono) ||
        entry.expiresAtMono <= entry.qualifiedAtMono ||
        !this.isCurrent(entry, loader)
      )
        return;
      if (
        !this.producerAccepts(candidate, loader) ||
        !this.isCurrent(entry, loader) ||
        job.controller.signal.aborted
      )
        return;
      // This is a current preparation binding, not a rewrite of q.inputs' historical generation.
      this.ready = entry;
      job.settle(candidate);
    } finally {
      if (!drained) {
        this.drainFailed = true;
        this.invalidate();
      }
      job.settle(null);
      if (this.active === job) this.active = null;
    }
  }
}
