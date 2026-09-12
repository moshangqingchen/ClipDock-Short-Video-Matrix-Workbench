import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { NETWORK_REASON_TEXT, NETWORK_TIMING, type NetworkReason } from "@shared/network";
import {
  normalizeProofTarget,
  proofScopeKey,
  type AccountProofScope,
  type DirectEvidenceBatch,
} from "./direct-proof";
import type { EgressGate, GateRevocation, RouteDecision } from "./egress-gate";

export interface ProofIssuerClock {
  monotonicMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface ProofScopeVersion {
  generation: number;
  rulesVersion: string;
}
export interface ProofCollectionRequest extends ProofScopeVersion {
  /** A fresh sampling nonce. Success must echo it in both requestId and batch.sampleId. */
  requestId: string;
  scope: AccountProofScope;
  startedAtMono: number;
  signal: AbortSignal;
}
export type ProofCollectionResult =
  | { kind: "unavailable"; reason: NetworkReason }
  | { kind: "evidence"; requestId: string; batch: DirectEvidenceBatch };
export interface ProofEvidenceSource {
  /**
   * Main-process anonymous, read-only observations only: no account Session, Cookie, login probe,
   * collector, renderer proof or business request. Must honor signal and retain evidence provenance.
   * No default producer exists. A source may explicitly reject any unsupported scope/path.
   */
  collect(request: ProofCollectionRequest): Promise<ProofCollectionResult>;
}
export interface ProofIssuerResult {
  status: "accepted" | "waiting" | "rejected" | "cancelled";
  reason: NetworkReason;
  decision: RouteDecision | null;
}
export interface ProofIssuerOptions {
  gate: EgressGate;
  source?: ProofEvidenceSource;
  clock?: ProofIssuerClock;
  renewMs?: number;
  warmupGapMs?: number;
  sourceTimeoutMs?: number;
  maxConcurrent?: number;
  /** Defaults to the Gate's monotonic deadline. A scheduling hint only; never extends permission. */
  readPermitDeadline?: (accountId: string, contextId: string) => number | null;
  renewLeadMs?: number;
}
interface Job {
  id: string;
  epoch: number;
  promise: Promise<ProofIssuerResult>;
  resolve(result: ProofIssuerResult): void;
  controller: AbortController;
  timeout: unknown | null;
  startedAtMono: number | null;
}
interface ScopeEntry {
  scope: AccountProofScope;
  key: string;
  version: ProofScopeVersion | null;
  epoch: number;
  enabled: boolean;
  nextDue: number;
  job: Job | null;
  lastReason: NetworkReason;
}
const SYSTEM_CLOCK: ProofIssuerClock = {
  monotonicMs: () => performance.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const rejectionReason = (reason: unknown): NetworkReason =>
  typeof reason === "string" &&
  Object.hasOwn(NETWORK_REASON_TEXT, reason) &&
  reason !== "READY" &&
  reason !== "CHECKING"
    ? (reason as NetworkReason)
    : "EGRESS_UNVERIFIED";
const rejected = (
  reason: NetworkReason,
  status: ProofIssuerResult["status"] = "rejected",
): ProofIssuerResult => ({ status, reason, decision: null });

/**
 * Transient main-process sampling coordinator. It never persists or fabricates a permit.
 * Controller/OS observers still own current Gate network state; registerScope must be called again
 * with their current version after a global generation change. Session cleanup remains Runtime's job.
 */
export class ProofIssuer {
  private readonly gate: EgressGate;
  private source: ProofEvidenceSource | undefined;
  private readonly clock: ProofIssuerClock;
  private readonly renewMs: number;
  private readonly warmupGapMs: number;
  private readonly sourceTimeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly renewLeadMs: number;
  private readonly readPermitDeadline: (accountId: string, contextId: string) => number | null;
  private readonly entries = new Map<string, ScopeEntry>();
  /** A Runtime cleanup/re-register cycle cannot erase the retry interval of a cancelled sample. */
  private readonly retryAfter = new Map<string, number>();
  /** Aborted sources that ignore their signal still occupy a real concurrency slot. */
  private readonly runningAccounts = new Set<string>();
  private running = false;
  private disposed = false;
  private timer: unknown | null = null;
  private ownRevocation = 0;
  private readonly onRevoked = (event: GateRevocation) => {
    if (this.ownRevocation || this.disposed) return;
    const entry = this.entries.get(event.accountId);
    if (!entry) return;
    // Gate has already closed authority before publishing this event.
    this.cancelWork(entry, event.reason);
    if (entry.version?.generation !== event.generation) entry.version = null;
    entry.nextDue = this.clock.monotonicMs() + this.renewMs;
    this.arm();
  };

  constructor(options: ProofIssuerOptions) {
    this.gate = options.gate;
    this.source = options.source;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.renewMs = options.renewMs ?? NETWORK_TIMING.renewMs;
    this.warmupGapMs = options.warmupGapMs ?? NETWORK_TIMING.warmupGapMs;
    this.sourceTimeoutMs = options.sourceTimeoutMs ?? NETWORK_TIMING.proofTtlMs;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.renewLeadMs = options.renewLeadMs ?? NETWORK_TIMING.controllerTimeoutMs;
    this.readPermitDeadline =
      options.readPermitDeadline ??
      ((accountId, contextId) => this.gate.permitExpiresAtMono(accountId, contextId));
    if (
      [this.renewMs, this.warmupGapMs, this.sourceTimeoutMs, this.renewLeadMs].some(
        (n) => !Number.isFinite(n) || n <= 0,
      ) ||
      this.renewMs >= NETWORK_TIMING.proofTtlMs ||
      !Number.isInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      this.maxConcurrent > 16
    )
      throw new Error("Invalid proof issuer limits");
    this.gate.on("revoked", this.onRevoked);
  }

  /** Idempotent for the same scope/version. Changed scope closes its old permit before sampling. */
  registerScope(scope: AccountProofScope, version: ProofScopeVersion): void {
    if (this.disposed) throw new Error("Proof issuer disposed");
    const key = proofScopeKey(scope);
    if (
      !key ||
      !scope.accountId ||
      !Number.isSafeInteger(version.generation) ||
      version.generation !== this.gate.generation ||
      !version.rulesVersion
    )
      throw new Error("Invalid current proof scope version");
    const previous = this.entries.get(scope.accountId);
    if (
      previous &&
      previous.key === key &&
      previous.scope.catalogReviewed === scope.catalogReviewed &&
      previous.version?.generation === version.generation &&
      previous.version.rulesVersion === version.rulesVersion
    ) {
      previous.enabled = true;
      this.pump();
      return;
    }
    if (previous) this.close(previous, "NETWORK_CHANGED");
    // Runtime can have registered the exact same scope already; Gate registration is idempotent.
    this.gate.registerAccount(scope);
    const frozen: AccountProofScope = Object.freeze({
      ...scope,
      targets: Object.freeze(scope.targets.map((target) => Object.freeze(normalizeProofTarget(target)!))),
    });
    this.entries.set(scope.accountId, {
      scope: frozen,
      key,
      version: { ...version },
      epoch: (previous?.epoch ?? 0) + 1,
      enabled: true,
      nextDue: Math.max(this.clock.monotonicMs(), this.retryAfter.get(scope.accountId) ?? 0),
      job: null,
      lastReason: "CHECKING",
    });
    this.pump();
  }

  /** Explicitly start anonymous background work. Construction/registration alone never samples. */
  start(): void {
    if (this.disposed) throw new Error("Proof issuer disposed");
    if (this.running) return;
    this.running = true;
    for (const entry of this.entries.values())
      entry.nextDue = Math.max(entry.nextDue, this.clock.monotonicMs());
    this.pump();
  }

  /** Join an existing queued/running round; recovery requests cannot shorten the warm-up interval. */
  request(accountId: string): Promise<ProofIssuerResult> {
    const entry = this.entries.get(accountId);
    if (this.disposed || !this.running || !entry)
      return Promise.resolve(rejected("GATE_REVOKED", "cancelled"));
    if (!entry.version || entry.version.generation !== this.gate.generation)
      return Promise.resolve(rejected("NETWORK_CHANGED"));
    if (entry.scope.catalogReviewed !== true) return Promise.resolve(rejected("CATALOG_UNVERIFIED"));
    if (!this.source) {
      this.close(entry, "EGRESS_UNVERIFIED");
      return Promise.resolve(rejected("EGRESS_UNVERIFIED"));
    }
    entry.enabled = true;
    const job = entry.job ?? this.makeJob(entry);
    this.pump();
    return job.promise;
  }

  /** Pause this account until an explicit request/registerScope resumes it. */
  cancel(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    entry.enabled = false;
    this.close(entry, "GATE_REVOKED");
    this.arm();
  }

  /** Session/Gate ownership stays with Runtime; removing a sampler never removes its Session guard. */
  removeScope(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    this.close(entry, "GATE_REVOKED");
    this.entries.delete(accountId);
    this.arm();
  }

  /**
   * Runtime has already withdrawn a scope while closing its Session. Avoid a second revocation
   * cleanup cycle, but never trust that assumption if Gate still holds a usable permit.
   */
  forgetRevokedScope(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    const now = this.clock.monotonicMs();
    for (const [id, deadline] of this.retryAfter) if (deadline <= now) this.retryAfter.delete(id);
    if (entry.job?.startedAtMono !== null && entry.job?.startedAtMono !== undefined)
      this.retryAfter.set(accountId, now + this.renewMs);
    const decision = this.gate.checkAction(accountId, entry.scope.contextId);
    if (decision.allowed) this.revokeGate(entry, "GATE_REVOKED");
    this.cancelWork(entry, "GATE_REVOKED");
    this.entries.delete(accountId);
    this.arm();
  }

  /** Source/config loss closes all permits and requires fresh external version bindings. */
  invalidate(reason: NetworkReason = "NETWORK_CHANGED"): void {
    const safeReason = rejectionReason(reason);
    // Global epoch closes every old proof before any individual source's abort handler can run.
    this.ownRevocation++;
    try {
      this.gate.invalidate(safeReason);
    } finally {
      this.ownRevocation--;
    }
    for (const entry of this.entries.values()) {
      this.cancelWork(entry, safeReason);
      entry.version = null;
    }
    this.arm();
  }

  setSource(source?: ProofEvidenceSource): void {
    if (this.disposed) throw new Error("Proof issuer disposed");
    if (source === this.source) return;
    this.invalidate("EGRESS_UNVERIFIED");
    this.source = source;
  }

  /** Synchronously withdraws permission, then aborts. Does not await an uncooperative source forever. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    for (const entry of this.entries.values()) this.close(entry, "GATE_REVOKED");
  }
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.gate.removeListener("revoked", this.onRevoked);
    this.entries.clear();
    this.retryAfter.clear();
  }

  /** Scheduling diagnostics only: no TargetEvidence, exit IPs, credentials or persisted authority. */
  snapshot(): {
    running: boolean;
    activeSources: number;
    accounts: {
      accountId: string;
      bound: boolean;
      queued: boolean;
      collecting: boolean;
      enabled: boolean;
      reason: NetworkReason;
    }[];
  } {
    return {
      running: this.running,
      activeSources: this.runningAccounts.size,
      accounts: [...this.entries.values()].map((entry) => ({
        accountId: entry.scope.accountId,
        bound: !!entry.version && entry.version.generation === this.gate.generation,
        queued: !!entry.job && entry.job.startedAtMono === null,
        collecting: this.runningAccounts.has(entry.scope.accountId),
        enabled: entry.enabled,
        reason: entry.lastReason,
      })),
    };
  }

  private makeJob(entry: ScopeEntry): Job {
    let resolve!: Job["resolve"];
    const promise = new Promise<ProofIssuerResult>((done) => {
      resolve = done;
    });
    const job: Job = {
      id: randomUUID(),
      epoch: entry.epoch,
      promise,
      resolve,
      controller: new AbortController(),
      timeout: null,
      startedAtMono: null,
    };
    entry.job = job;
    return job;
  }
  private eligible(entry: ScopeEntry): boolean {
    return (
      entry.enabled &&
      entry.scope.catalogReviewed === true &&
      !!entry.version &&
      entry.version.generation === this.gate.generation &&
      !this.runningAccounts.has(entry.scope.accountId)
    );
  }
  private current(entry: ScopeEntry, job: Job): boolean {
    return (
      this.running &&
      !this.disposed &&
      this.entries.get(entry.scope.accountId) === entry &&
      entry.job === job &&
      entry.epoch === job.epoch &&
      !job.controller.signal.aborted &&
      entry.version?.generation === this.gate.generation
    );
  }
  private pump(): void {
    if (!this.running || this.disposed || !this.source) return this.arm();
    while (this.runningAccounts.size < this.maxConcurrent) {
      const now = this.clock.monotonicMs();
      const entry = [...this.entries.values()]
        .filter((candidate) => this.eligible(candidate) && candidate.nextDue <= now)
        .sort((a, b) => a.nextDue - b.nextDue)[0];
      if (!entry) break;
      this.collect(entry, entry.job ?? this.makeJob(entry));
    }
    this.arm();
  }
  private collect(entry: ScopeEntry, job: Job): void {
    const source = this.source!;
    const version = entry.version!;
    job.startedAtMono = this.clock.monotonicMs();
    this.runningAccounts.add(entry.scope.accountId);
    job.timeout = this.clock.setTimeout(() => {
      if (this.current(entry, job)) this.fail(entry, job, "PROOF_EXPIRED");
    }, this.sourceTimeoutMs);
    const request: ProofCollectionRequest = Object.freeze({
      ...version,
      scope: entry.scope,
      requestId: job.id,
      startedAtMono: job.startedAtMono,
      signal: job.controller.signal,
    });
    let work: Promise<ProofCollectionResult>;
    try {
      work = Promise.resolve(source.collect(request));
    } catch {
      work = Promise.reject(new Error("SOURCE_UNAVAILABLE"));
    }
    void work
      .then((result) => {
        if (!this.current(entry, job)) return;
        if (result.kind !== "evidence") return this.fail(entry, job, rejectionReason(result.reason));
        const batch = result.batch;
        if (result.requestId !== job.id || batch.sampleId !== job.id)
          return this.fail(entry, job, "EGRESS_UNVERIFIED");
        if (batch.generation !== version.generation || batch.rulesVersion !== version.rulesVersion)
          return this.fail(entry, job, "NETWORK_CHANGED");
        if (batch.contextId !== entry.scope.contextId || batch.catalogVersion !== entry.scope.catalogVersion)
          return this.fail(entry, job, "CONTEXT_UNVERIFIED");
        // New request IDs cannot relabel cached short-lived observations. Egress keeps its own TTL.
        const samples = [
          batch.observedAtMono,
          ...batch.targets.flatMap((target) => [
            target.route.observedAtMono,
            target.tls.observedAtMono,
            target.dns.observedAtMono,
          ]),
        ];
        const now = this.clock.monotonicMs();
        if (samples.some((at) => !Number.isFinite(at) || at < job.startedAtMono! || at > now))
          return this.fail(entry, job, "PROOF_EXPIRED");
        // Preserve constructed rule-evidence identity; do not clone/reconstruct its authority fields.
        const decision = this.gate.acceptEvidence(entry.scope.accountId, batch);
        if (!this.current(entry, job)) return; // A synchronous Runtime revocation can cancel this round.
        if (!decision.allowed && decision.reason !== "CHECKING")
          return this.fail(entry, job, decision.reason);
        if (decision.allowed) {
          const deadline = this.readPermitDeadline(entry.scope.accountId, entry.scope.contextId);
          if (!this.current(entry, job)) return;
          if (deadline === null || !Number.isFinite(deadline) || deadline <= now)
            return this.fail(entry, job, "PROOF_EXPIRED");
          const lead = Math.max(this.renewLeadMs, now - job.startedAtMono! + 250);
          entry.nextDue = Math.max(
            // A delayed controller refresh must not cause rapid resampling of one capped deadline.
            // If this minimum interval misses the deadline, Gate expires normally; never extend it.
            now + Math.min(this.renewMs, this.renewLeadMs),
            Math.min(Math.min(...samples) + this.renewMs, deadline - lead),
          );
        } else entry.nextDue = now + this.warmupGapMs;
        entry.lastReason = decision.reason;
        this.finish(entry, job, {
          status: decision.allowed ? "accepted" : "waiting",
          reason: decision.reason,
          decision,
        });
      })
      .catch(() => {
        if (this.current(entry, job)) this.fail(entry, job, "EGRESS_UNVERIFIED");
      })
      .finally(() => {
        if (job.timeout !== null) this.clock.clearTimeout(job.timeout);
        this.runningAccounts.delete(entry.scope.accountId);
        this.pump();
      });
  }
  private finish(entry: ScopeEntry, job: Job, result: ProofIssuerResult): void {
    if (job.timeout !== null) this.clock.clearTimeout(job.timeout);
    job.timeout = null;
    if (entry.job === job) entry.job = null;
    job.resolve(result);
  }
  private fail(entry: ScopeEntry, job: Job, reason: NetworkReason): void {
    if (["CONTROLLER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "NETWORK_CHANGED"].includes(reason)) {
      this.invalidate(reason);
      return;
    }
    this.revokeGate(entry, rejectionReason(reason));
    entry.lastReason = rejectionReason(reason);
    entry.epoch++;
    job.controller.abort(entry.lastReason);
    entry.nextDue = this.clock.monotonicMs() + this.renewMs;
    this.finish(entry, job, rejected(entry.lastReason));
    this.arm();
  }
  private revokeGate(entry: ScopeEntry, reason: NetworkReason): void {
    this.ownRevocation++;
    try {
      this.gate.revoke(entry.scope.accountId, reason);
    } finally {
      this.ownRevocation--;
    }
  }
  private close(entry: ScopeEntry, reason: NetworkReason): void {
    this.revokeGate(entry, reason);
    this.cancelWork(entry, reason);
  }
  private cancelWork(entry: ScopeEntry, reason: NetworkReason): void {
    entry.epoch++;
    entry.lastReason = reason;
    const job = entry.job;
    if (job) {
      job.controller.abort(reason);
      this.finish(entry, job, rejected(reason, "cancelled"));
    }
  }
  private arm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (!this.running || this.disposed || !this.source || this.runningAccounts.size >= this.maxConcurrent)
      return;
    const times = [...this.entries.values()]
      .filter((entry) => this.eligible(entry))
      .map((entry) => entry.nextDue);
    if (!times.length) return;
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        this.pump();
      },
      Math.max(0, Math.min(...times) - this.clock.monotonicMs()),
    );
  }
}
