import { networkSettingsSchema, type NetworkSettings } from "@shared/network";
import type { KnownSelectedLoaderContract } from "./configuration-association";
import type {
  ProofCollectionRequest,
  ProofCollectionResult,
  ProofEvidenceSource,
  ProofScopeVersion,
} from "./proof-issuer";
import { createProductionProofComponents } from "./production-proof-components";
import type { RetainedPathQualification } from "./path-conformance";
import type { PathPreparationReview } from "./path-qualification-producer";
import { normalizeExactOrigin, type ExactOrigin } from "./operation-catalog";
import type { ProofTarget } from "./direct-proof";

export interface ProofSourceBundle {
  inspect(): Promise<boolean>;
  /** Explicit main-process preparation; never invoked by inspect/collect or a synchronous getter. */
  prepareQualification?(signal: AbortSignal): Promise<boolean>;
  /** Already prepared and validated main-process facts only; no I/O or implicit preparation. */
  resolveAddressFamilies?(origin: ExactOrigin): readonly ProofTarget["addressFamily"][] | null;
  collect(request: ProofCollectionRequest): Promise<ProofCollectionResult>;
  /** Withdraw synchronously; dispose must also drain cancelled underlying work. */
  invalidate(): void;
  dispose(): Promise<void>;
}
export interface ProofBundleInput {
  settings: NetworkSettings & { selectedClientResourcesPath: string };
  onInvalidated(): void;
}
export interface ProductionProofRuntimeOptions {
  enforcement: "observe" | "strict";
  settings(): NetworkSettings;
  getSecret(): string | null;
  readVersion(): ProofScopeVersion | null;
  /** Owner closes the Gate before returning; this callback never receives source data or secrets. */
  onInvalidated(): void;
  /** Main-process facts only. Absence remains unavailable; no persisted report is loaded. */
  getQualification?: (loader: KnownSelectedLoaderContract) => RetainedPathQualification | null;
  /** Actual review and application-wide quiet condition. No default review or quiet=true fallback. */
  preparation?: {
    readReview(loader: KnownSelectedLoaderContract): PathPreparationReview | null;
    isQuiescent(): boolean;
  };
  /** Test seam; construction itself must not perform I/O. */
  components?: {
    create(input: ProofBundleInput): ProofSourceBundle;
    dispose(): Promise<void>;
  };
}
interface Entry {
  key: string;
  bundle: ProofSourceBundle;
  invalid: boolean;
}
const unavailable = (): ProofCollectionResult => ({ kind: "unavailable", reason: "EGRESS_UNVERIFIED" });

/** Source lifecycle only. It cannot change enforcement, select a directory or fabricate a qualification. */
export class ProductionProofRuntime implements ProofEvidenceSource {
  private readonly components: NonNullable<ProductionProofRuntimeOptions["components"]>;
  private entry: Entry | null = null;
  private draining: Promise<void> | null = null;
  private inspection: Promise<boolean> | null = null;
  private running = false;
  private disposed = false;
  private cleanupFailed = false;
  private refreshAfterDrain = false;
  private revision = 0;
  private finalDisposal: Promise<void> | null = null;
  private projectingFamilies = false;
  private familyProjectionRevision = 0;

  constructor(private readonly options: ProductionProofRuntimeOptions) {
    this.components = options.components ?? createProductionProofComponents(options);
  }

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    void this.refresh();
  }

  stop(): void {
    this.running = false;
    this.refreshAfterDrain = false;
    this.invalidate();
  }

  /** Called after the owner's synchronous Gate revocation, including secret changes. */
  configurationChanged(): void {
    this.invalidate();
    if (this.running) void this.refresh();
  }

  invalidate(): void {
    this.revision++;
    this.inspection = null;
    const entry = this.entry;
    this.entry = null;
    if (!entry) return;
    entry.invalid = true;
    try {
      entry.bundle.invalidate();
    } catch {
      this.cleanupFailed = true;
    }
    const drain = Promise.resolve()
      .then(() => entry.bundle.dispose())
      .catch(() => {
        this.cleanupFailed = true;
      });
    this.draining = drain;
    void drain.then(() => {
      if (this.draining !== drain) return;
      this.draining = null;
      if (this.refreshAfterDrain && this.running && !this.disposed && !this.cleanupFailed) {
        this.refreshAfterDrain = false;
        void this.refresh();
      }
    });
  }

  /** Read the explicitly selected local source only; this method never performs TLS/egress probes. */
  refresh(): Promise<boolean> {
    if (!this.running || this.disposed || this.cleanupFailed) return Promise.resolve(false);
    if (this.draining) {
      this.refreshAfterDrain = true;
      return Promise.resolve(false);
    }
    if (this.inspection) return this.inspection;
    const entry = this.ensureEntry(),
      revision = this.revision;
    if (!entry) return Promise.resolve(false);
    const work = Promise.resolve()
      .then(() => {
        if (!this.current(entry, revision)) return false;
        return entry.bundle.inspect();
      })
      .then(
        (value) => this.current(entry, revision) && value,
        () => false,
      );
    this.inspection = work;
    void work.then(() => {
      if (this.inspection === work) this.inspection = null;
    });
    return work;
  }

  async collect(request: ProofCollectionRequest): Promise<ProofCollectionResult> {
    // Even a test-injected/late future provider cannot issue accepted evidence in observe mode.
    if (this.options.enforcement !== "strict" || !this.running || this.disposed || request.signal.aborted)
      return unavailable();
    const version = this.options.readVersion();
    if (
      !version ||
      version.generation !== request.generation ||
      version.rulesVersion !== request.rulesVersion
    )
      return unavailable();
    const entry = this.ensureEntry(),
      revision = this.revision;
    if (!entry || this.inspection) return unavailable();
    try {
      const captured = { ...request, scope: structuredClone(request.scope) };
      const result = await entry.bundle.collect(captured);
      const next = this.options.readVersion();
      if (
        !this.current(entry, revision) ||
        request.signal.aborted ||
        !next ||
        next.generation !== request.generation ||
        next.rulesVersion !== request.rulesVersion
      )
        return unavailable();
      return result;
    } catch {
      return unavailable();
    }
  }

  /** The caller owns the real quiet window. This neither changes enforcement nor opens the Gate. */
  async prepareQualification(signal: AbortSignal): Promise<boolean> {
    if (this.options.enforcement !== "strict" || !this.running || this.disposed || signal.aborted)
      return false;
    const revision = this.revision;
    try {
      const version = structuredClone(this.options.readVersion());
      if (!version || signal.aborted || revision !== this.revision || this.inspection) return false;
      const entry = this.ensureEntry();
      if (!entry?.bundle.prepareQualification || !this.current(entry, revision)) return false;
      const prepared = await entry.bundle.prepareQualification(signal);
      const next = this.options.readVersion();
      return (
        prepared &&
        this.current(entry, revision) &&
        !signal.aborted &&
        !!next &&
        next.generation === version.generation &&
        next.rulesVersion === version.rulesVersion
      );
    } catch {
      return false;
    }
  }

  /** Used for both operation scopes and request checks. Missing/expired authority remains null;
   * the caller must not convert this into an IPv4 or dual-family fallback. */
  resolveAddressFamilies(origin: ExactOrigin): readonly ProofTarget["addressFamily"][] | null {
    if (this.projectingFamilies) {
      this.familyProjectionRevision++;
      return null;
    }
    if (this.options.enforcement !== "strict" || !this.running || this.disposed || this.draining) return null;
    const entry = this.entry;
    const revision = this.revision;
    const projectionRevision = this.familyProjectionRevision;
    if (!entry?.bundle.resolveAddressFamilies) return null;
    this.projectingFamilies = true;
    try {
      const target = normalizeExactOrigin(origin);
      if (!target || target.protocol !== "https:" || !this.current(entry, revision)) return null;
      const version = this.options.readVersion();
      if (!version || !this.current(entry, revision)) return null;
      const captured = { ...version };
      const families = entry.bundle.resolveAddressFamilies(Object.freeze({ ...target }));
      const next = this.options.readVersion();
      if (
        !Array.isArray(families) ||
        families.length < 1 ||
        families.length > 2 ||
        new Set(families).size !== families.length ||
        families.some((family) => family !== "ipv4" && family !== "ipv6") ||
        !next ||
        next.generation !== captured.generation ||
        next.rulesVersion !== captured.rulesVersion ||
        !this.current(entry, revision) ||
        projectionRevision !== this.familyProjectionRevision
      )
        return null;
      return Object.freeze([...families]);
    } catch {
      return null;
    } finally {
      this.projectingFamilies = false;
    }
  }

  dispose(): Promise<void> {
    if (this.finalDisposal) return this.finalDisposal;
    this.disposed = true;
    this.stop();
    this.finalDisposal = (async () => {
      // A synchronous factory callback may dispose us before its returned bundle is registered.
      await Promise.resolve();
      while (this.draining) await this.draining;
      await this.components.dispose();
    })();
    return this.finalDisposal;
  }

  private current(entry: Entry, revision: number): boolean {
    let sameSettings = false;
    try {
      const settings = networkSettingsSchema.parse(this.options.settings());
      sameSettings =
        entry.key === JSON.stringify([settings.controllerUrl, settings.selectedClientResourcesPath]);
    } catch {
      /* Invalid settings cannot keep a previous result current. */
    }
    return (
      sameSettings &&
      this.running &&
      !this.disposed &&
      !this.cleanupFailed &&
      !entry.invalid &&
      this.entry === entry &&
      this.revision === revision
    );
  }

  private ensureEntry(): Entry | null {
    if (this.draining || this.cleanupFailed || !this.running || this.disposed) return null;
    let settings: NetworkSettings;
    try {
      settings = networkSettingsSchema.parse(this.options.settings());
    } catch {
      return null;
    }
    if (!settings.selectedClientResourcesPath) return null;
    const key = JSON.stringify([settings.controllerUrl, settings.selectedClientResourcesPath]);
    if (this.entry && this.entry.key !== key) {
      try {
        this.options.onInvalidated();
      } catch {
        /* Owner failure cannot keep old source authority. */
      } finally {
        this.invalidate();
      }
      return null;
    }
    if (this.entry) return this.entry;
    let entry: Entry | null = null;
    const revision = this.revision;
    try {
      let invalidatedDuringConstruction = false;
      const bundle = this.components.create({
        settings: { ...settings, selectedClientResourcesPath: settings.selectedClientResourcesPath },
        onInvalidated: () => {
          if (!entry) {
            invalidatedDuringConstruction = true;
            return;
          }
          if (this.entry !== entry || entry.invalid) return;
          entry.invalid = true;
          try {
            this.options.onInvalidated();
          } finally {
            this.invalidate();
          }
        },
      });
      entry = {
        key,
        bundle,
        invalid:
          invalidatedDuringConstruction || this.disposed || !this.running || revision !== this.revision,
      };
      this.entry = entry;
      if (entry.invalid) {
        this.invalidate();
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }
}
