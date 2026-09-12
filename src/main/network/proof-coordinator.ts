import { proofScopeKey, type AccountProofScope } from "./direct-proof";
import type { EgressGate, GateProofVersion } from "./egress-gate";
import {
  ProofIssuer,
  type ProofEvidenceSource,
  type ProofIssuerOptions,
  type ProofIssuerResult,
} from "./proof-issuer";

export type ProofScopeEvent =
  { type: "upsert"; scope: AccountProofScope } | { type: "remove"; accountId: string };

/** Main-process Runtime projection: only scopes whose Session protection is ready are visible. */
export interface ProofScopeSource {
  listProofScopes(): readonly AccountProofScope[];
  subscribeProofScopes(listener: (event: ProofScopeEvent) => void): () => void;
}

export interface ProofCoordinatorOptions {
  gate: EgressGate;
  scopes: ProofScopeSource;
  source?: ProofEvidenceSource;
  issuerOptions?: Omit<ProofIssuerOptions, "gate" | "source">;
}

interface Binding extends GateProofVersion {
  scopeKey: string;
  catalogReviewed: boolean;
}

/**
 * Owns an Issuer, not Sessions or Gate. Construction never starts observations. Runtime controls
 * scope readiness; the Gate's committed network version controls whether it can be sampled.
 */
export class ProofCoordinator {
  private readonly gate: EgressGate;
  private readonly scopes: ProofScopeSource;
  private readonly issuer: ProofIssuer;
  private readonly bindings = new Map<string, Binding>();
  private running = false;
  private disposed = false;
  private unsubscribeScopes: (() => void) | null = null;
  private queued = false;
  private lifecycle = 0;

  private readonly onNetwork = () => {
    if (!this.running) return;
    // Global invalidation is already committed before this notification. Remove old bindings now,
    // not after a source's pending promise has had an opportunity to resolve.
    if (!this.gate.currentProofVersion()) this.forgetAll();
    this.schedule();
  };

  private readonly onScope = (event: ProofScopeEvent) => {
    if (!this.running) return;
    if (event.type === "remove") this.forget(event.accountId);
    else {
      const binding = this.bindings.get(event.scope.accountId);
      if (
        binding &&
        (binding.scopeKey !== proofScopeKey(event.scope) ||
          binding.catalogReviewed !== event.scope.catalogReviewed)
      )
        this.forget(event.scope.accountId);
    }
    this.schedule();
  };

  constructor(options: ProofCoordinatorOptions) {
    this.gate = options.gate;
    this.scopes = options.scopes;
    this.issuer = new ProofIssuer({ ...options.issuerOptions, gate: options.gate, source: options.source });
  }

  start(): void {
    if (this.disposed) throw new Error("Proof coordinator disposed");
    if (this.running) return;
    this.running = true;
    this.lifecycle++;
    this.gate.on("network", this.onNetwork);
    try {
      this.unsubscribeScopes = this.scopes.subscribeProofScopes(this.onScope);
      // Subscribe before reading so an account change during startup cannot be missed.
      this.reconcile();
      this.issuer.start();
    } catch {
      this.stop();
      throw new Error("PROOF_COORDINATOR_START_FAILED");
    }
  }

  request(accountId: string): Promise<ProofIssuerResult> {
    if (!this.running || !this.bindings.has(accountId))
      return Promise.resolve({ status: "cancelled", reason: "GATE_REVOKED", decision: null });
    return this.issuer.request(accountId);
  }

  /** Source replacement globally invalidates old evidence; observer/readiness still governs recovery. */
  setSource(source?: ProofEvidenceSource): void {
    if (this.disposed) throw new Error("Proof coordinator disposed");
    this.issuer.setSource(source);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.lifecycle++;
    this.queued = false;
    this.gate.removeListener("network", this.onNetwork);
    try {
      this.unsubscribeScopes?.();
    } finally {
      this.unsubscribeScopes = null;
      // Ignore any synchronous Runtime ready/upsert activity while permission is being withdrawn.
      this.issuer.stop();
      this.forgetAll();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    try {
      this.stop();
    } finally {
      this.disposed = true;
      this.issuer.dispose();
    }
  }

  snapshot(): ReturnType<ProofIssuer["snapshot"]> {
    return this.issuer.snapshot();
  }

  private forget(accountId: string): void {
    // Delete first: Runtime can synchronously emit remove while the defensive Gate check revokes.
    if (!this.bindings.delete(accountId)) return;
    this.issuer.forgetRevokedScope(accountId);
  }

  private forgetAll(): void {
    for (const accountId of [...this.bindings.keys()]) this.forget(accountId);
  }

  private schedule(): void {
    if (!this.running || this.disposed || this.queued) return;
    this.queued = true;
    const lifecycle = this.lifecycle;
    queueMicrotask(() => {
      if (!this.running || this.disposed || this.lifecycle !== lifecycle) return;
      this.queued = false;
      this.reconcile();
    });
  }

  private reconcile(): void {
    if (!this.running || this.disposed) return;
    const version = this.gate.currentProofVersion();
    if (!version) {
      this.forgetAll();
      return;
    }
    let current: Map<string, AccountProofScope>;
    try {
      const rows = this.scopes.listProofScopes();
      current = new Map(rows.map((scope) => [scope.accountId, structuredClone(scope)]));
      if (current.size !== rows.length || [...current.values()].some((scope) => !proofScopeKey(scope)))
        throw new Error("INVALID_SCOPE_PROJECTION");
    } catch {
      this.forgetAll();
      return;
    }
    let removed = false;
    for (const [accountId, binding] of this.bindings) {
      const scope = current.get(accountId);
      if (
        !scope ||
        binding.scopeKey !== proofScopeKey(scope) ||
        binding.catalogReviewed !== scope.catalogReviewed ||
        binding.generation !== version.generation ||
        binding.rulesVersion !== version.rulesVersion
      ) {
        this.forget(accountId);
        removed = true;
      }
    }
    if (removed) {
      // Revocation may have started asynchronous Session cleanup. Re-read Runtime readiness before
      // registering replacements; the snapshot taken before cleanup is no longer authoritative.
      this.schedule();
      return;
    }
    for (const scope of current.values()) {
      if (this.bindings.has(scope.accountId)) continue;
      const latest = this.gate.currentProofVersion();
      if (!latest || latest.generation !== version.generation || latest.rulesVersion !== version.rulesVersion)
        return this.schedule();
      // Record before register: lifecycle notifications can be synchronous. No Gate `state` listener
      // is used, so registering CHECKING/READY never recursively re-enters this path.
      this.bindings.set(scope.accountId, {
        ...version,
        scopeKey: proofScopeKey(scope)!,
        catalogReviewed: scope.catalogReviewed,
      });
      try {
        this.issuer.registerScope(scope, version);
      } catch {
        this.forget(scope.accountId);
      }
    }
  }
}
