import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { NETWORK_TIMING, type AccountNetworkState, type NetworkReason } from "@shared/network";
import { isCnPlatformId } from "@shared/platforms";
import {
  normalizeProofTarget,
  proofScopeKey,
  proofTargetKey,
  validateDirectEvidence,
  type AccountProofScope,
  type DirectEvidenceBatch,
  type DirectProof,
  type ProofEnvironment,
  type ProofTarget,
} from "./direct-proof";

export interface GateClock {
  monotonicMs(): number;
  wallTimeMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GateTiming {
  proofTtlMs: number;
  egressTtlMs: number;
  controllerTtlMs: number;
  warmupGapMs: number;
}

export interface RouteDecision {
  accountId: string;
  allowed: boolean;
  /** Observation decisions are descriptive and have no request-cancellation authority. */
  enforce: boolean;
  cancel: boolean;
  reason: NetworkReason;
  generation: number;
  proofId: string | null;
}

export interface GateLease {
  id: string;
  generation: number;
  signal: AbortSignal;
  /** Must be checked before a delayed callback writes auth state, retries or enqueues work. */
  isCurrent(): boolean;
  release(): void;
}

export interface GateRevocation {
  accountId: string;
  generation: number;
  reason: NetworkReason;
  /** A Session owner should abort/close resources only when true. */
  enforce: boolean;
}

export interface GateProofVersion {
  generation: number;
  rulesVersion: string;
}

interface AccountEntry {
  scope: AccountProofScope;
  scopeKey: string;
  epoch: number;
  reason: NetworkReason;
  checkedAtMono: number | null;
  minObservationMono: number;
  proof: DirectProof | null;
  warmup: DirectEvidenceBatch | null;
  lastSample: DirectEvidenceBatch | null;
  leases: Map<string, AbortController>;
  seenSamples: Map<string, number>;
}

const SYSTEM_CLOCK: GateClock = {
  monotonicMs: () => performance.now(),
  wallTimeMs: () => Date.now(),
  setTimeout: (callback, delay) => {
    const handle = setTimeout(callback, delay);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function freshRound(batch: DirectEvidenceBatch, previous: DirectEvidenceBatch): boolean {
  if (batch.sampleId === previous.sampleId || batch.observedAtMono <= previous.observedAtMono) return false;
  // Changing a sample ID cannot re-label cached route/TLS/DNS observations as a new round.
  return batch.targets.every((target) => {
    const prior = previous.targets.find(
      (old) => proofTargetKey(old.target) === proofTargetKey(target.target),
    );
    return (
      prior &&
      target.route.observedAtMono > prior.route.observedAtMono &&
      target.tls.observedAtMono > prior.tls.observedAtMono &&
      target.dns.observedAtMono > prior.dns.observedAtMono
    );
  });
}

function minimumRoundGap(batch: DirectEvidenceBatch, previous: DirectEvidenceBatch): number {
  return Math.min(
    batch.observedAtMono - previous.observedAtMono,
    ...batch.targets.flatMap((target) => {
      const prior = previous.targets.find(
        (old) => proofTargetKey(old.target) === proofTargetKey(target.target),
      );
      return prior
        ? [
            target.route.observedAtMono - prior.route.observedAtMono,
            target.tls.observedAtMono - prior.tls.observedAtMono,
            target.dns.observedAtMono - prior.dns.observedAtMono,
          ]
        : [-Infinity];
    }),
  );
}

/**
 * Main-process fail-closed authority. No persistence, Electron dependency, auth-status mutation,
 * online event or production evidence issuer is provided here. Observation mode is opt-in.
 * Events: `state` (AccountNetworkState[]), `revoked` (GateRevocation), and `network`
 * (GateProofVersion|null, after the environment is committed; no route/egress evidence).
 */
export class EgressGate extends EventEmitter {
  readonly enforcement: "observe" | "strict";
  private readonly clock: GateClock;
  private readonly timing: GateTiming;
  private readonly accounts = new Map<string, AccountEntry>();
  private environment: ProofEnvironment = {
    controllerReadable: false,
    mode: "unknown",
    tun: false,
    rulesVersion: null,
    generation: 1,
    expiresAtMono: 0,
  };
  private timer: unknown = null;
  private disposed = false;

  constructor(
    options: { enforcement?: "observe" | "strict"; clock?: GateClock; timing?: Partial<GateTiming> } = {},
  ) {
    super();
    this.enforcement = options.enforcement ?? "strict";
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.timing = {
      proofTtlMs: NETWORK_TIMING.proofTtlMs,
      egressTtlMs: NETWORK_TIMING.egressTtlMs,
      controllerTtlMs: NETWORK_TIMING.proofTtlMs,
      warmupGapMs: NETWORK_TIMING.warmupGapMs,
      ...options.timing,
    };
    if (Object.values(this.timing).some((value) => !Number.isFinite(value) || value <= 0))
      throw new Error("Invalid gate timing");
  }

  get generation(): number {
    return this.environment.generation;
  }

  /** Current main-process sampling binding only; this does not grant any account permission. */
  currentProofVersion(): GateProofVersion | null {
    this.expire();
    if (
      this.disposed ||
      !this.environment.controllerReadable ||
      this.environment.mode !== "rule" ||
      !this.environment.rulesVersion ||
      this.environment.expiresAtMono <= this.clock.monotonicMs()
    )
      return null;
    return { generation: this.generation, rulesVersion: this.environment.rulesVersion };
  }

  /** Main-process sampler input. A copy prevents consumers from widening the Gate's registered scope. */
  registeredScopes(): AccountProofScope[] {
    return [...this.accounts.values()].map((entry) => structuredClone(entry.scope));
  }

  /** Main-process renewal scheduling hint; it never authorizes an action or extends a proof. */
  permitExpiresAtMono(accountId: string, contextId: string): number | null {
    this.expire();
    const entry = this.accounts.get(accountId);
    return entry?.scope.contextId === contextId ? (entry.proof?.expiresAtMono ?? null) : null;
  }

  registerAccount(scope: AccountProofScope): void {
    if (this.disposed) throw new Error("Gate is disposed");
    const scopeKey = proofScopeKey(scope);
    if (
      !scope.accountId ||
      !isCnPlatformId(scope.platformId) ||
      !scope.contextId ||
      !scope.catalogVersion ||
      !scopeKey
    )
      throw new Error("Invalid domestic account proof scope");
    const existing = this.accounts.get(scope.accountId);
    if (existing?.scopeKey === scopeKey && existing.scope.catalogReviewed === scope.catalogReviewed) return;
    if (existing) this.revokeEntry(existing, "NETWORK_CHANGED");
    this.accounts.set(scope.accountId, {
      scope: {
        ...structuredClone(scope),
        targets: scope.targets.map((target) => normalizeProofTarget(target)!),
      },
      scopeKey,
      epoch: (existing?.epoch ?? 0) + 1,
      reason: "CHECKING",
      checkedAtMono: null,
      minObservationMono: this.clock.monotonicMs(),
      proof: null,
      warmup: null,
      lastSample: null,
      leases: new Map(),
      seenSamples: existing?.seenSamples ?? new Map(),
    });
    this.publish();
    this.armTimer();
  }

  unregisterAccount(accountId: string): void {
    const entry = this.accounts.get(accountId);
    if (!entry) return;
    this.revokeEntry(entry, "GATE_REVOKED");
    this.accounts.delete(accountId);
    this.publish();
    this.armTimer();
  }

  /** Call only on a completed, current controller read. Stale async responses must be discarded upstream. */
  setNetworkState(
    state: {
      controllerReadable: boolean;
      mode: string;
      tun: boolean;
      rulesVersion: string | null;
    },
    ageMs = 0,
  ): number {
    if (this.disposed) return this.generation;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= this.timing.controllerTtlMs) {
      this.invalidate("CONTROLLER_UNAVAILABLE");
      return this.generation;
    }
    this.expire();
    const changed =
      state.controllerReadable !== this.environment.controllerReadable ||
      state.mode !== this.environment.mode ||
      state.tun !== this.environment.tun ||
      state.rulesVersion !== this.environment.rulesVersion;
    const reason: NetworkReason = !state.controllerReadable
      ? "CONTROLLER_UNAVAILABLE"
      : state.mode === "global"
        ? "GLOBAL_MODE"
        : state.mode !== "rule"
          ? "RULE_UNVERIFIABLE"
          : "NETWORK_CHANGED";
    if (changed || !state.controllerReadable || !state.rulesVersion) this.invalidate(reason);
    this.environment = {
      ...state,
      generation: this.generation,
      expiresAtMono:
        state.controllerReadable && state.rulesVersion
          ? this.clock.monotonicMs() + this.timing.controllerTtlMs - ageMs
          : 0,
    };
    this.armTimer();
    this.notify("network", this.currentProofVersion());
    return this.generation;
  }

  acceptEvidence(accountId: string, input: DirectEvidenceBatch): RouteDecision {
    this.expire();
    const entry = this.accounts.get(accountId);
    if (!entry || this.disposed) return this.decision(accountId, "GATE_REVOKED");
    const now = this.clock.monotonicMs();
    const oldestSample = now - this.timing.warmupGapMs - this.timing.proofTtlMs;
    for (const [id, at] of entry.seenSamples) if (at < oldestSample) entry.seenSamples.delete(id);
    if (entry.seenSamples.has(input.sampleId)) return this.checkAction(accountId, entry.scope.contextId);
    entry.seenSamples.set(input.sampleId, now);
    // A late success from before an account-local cancellation cannot start its recovery warm-up.
    if (
      input.observedAtMono < entry.minObservationMono ||
      input.targets.some(
        (target) =>
          target.route.observedAtMono < entry.minObservationMono ||
          target.tls.observedAtMono < entry.minObservationMono ||
          target.dns.observedAtMono < entry.minObservationMono,
      )
    )
      return this.decision(accountId, "GATE_REVOKED");
    const result = validateDirectEvidence(entry.scope, input, this.environment, now, this.timing);
    if (!result.valid) {
      this.revokeEntry(entry, result.reason);
      this.publish();
      this.armTimer();
      return this.decision(accountId, result.reason);
    }
    if (entry.lastSample && !freshRound(input, entry.lastSample))
      return this.checkAction(accountId, entry.scope.contextId);
    const batch = structuredClone(input);
    entry.checkedAtMono = now;
    if (!entry.proof) {
      const first = entry.warmup;
      const gap = first ? batch.observedAtMono - first.observedAtMono : 0;
      if (!first || gap > this.timing.warmupGapMs + this.timing.proofTtlMs) {
        entry.warmup = batch;
        entry.lastSample = batch;
        entry.reason = "CHECKING";
        this.publish();
        return this.decision(accountId, "CHECKING");
      }
      if (!freshRound(batch, first) || minimumRoundGap(batch, first) < this.timing.warmupGapMs) {
        // Preserve the first successful sample; fast timer refreshes cannot shorten the warm-up.
        entry.lastSample = batch;
        return this.decision(accountId, "CHECKING");
      }
    }
    entry.proof = {
      proofId: randomUUID(),
      accountId,
      generation: this.generation,
      rulesVersion: batch.rulesVersion,
      contextId: batch.contextId,
      catalogVersion: batch.catalogVersion,
      scopeKey: result.scopeKey,
      sampleId: batch.sampleId,
      observedAtMono: batch.observedAtMono,
      expiresAtMono: result.expiresAtMono,
      targets: result.targets,
    };
    entry.warmup = null;
    entry.lastSample = batch;
    entry.reason = "READY";
    this.publish();
    this.armTimer();
    return this.decision(accountId, "READY", entry.proof);
  }

  checkRequest(input: { accountId: string; contextId: string; target: ProofTarget }): RouteDecision {
    const action = this.checkAction(input.accountId, input.contextId);
    if (!action.allowed) return action;
    const entry = this.accounts.get(input.accountId)!;
    const key = proofTargetKey(input.target);
    if (!key || !entry.proof!.targets.some((target) => proofTargetKey(target) === key)) {
      // An unexpected target invalidates this operation's readiness; it is never auto-enrolled.
      this.revoke(input.accountId, "UNKNOWN_TARGET");
      return this.decision(input.accountId, "UNKNOWN_TARGET");
    }
    return action;
  }

  checkAction(accountId: string, contextId: string): RouteDecision {
    this.expire();
    const entry = this.accounts.get(accountId);
    if (!entry || this.disposed) return this.decision(accountId, "GATE_REVOKED");
    if (entry.scope.contextId !== contextId) return this.decision(accountId, "CONTEXT_UNVERIFIED");
    if (!entry.proof) return this.decision(accountId, entry.reason);
    if (
      entry.proof.generation !== this.generation ||
      entry.proof.rulesVersion !== this.environment.rulesVersion
    ) {
      this.revoke(accountId, "NETWORK_CHANGED");
      return this.decision(accountId, "NETWORK_CHANGED");
    }
    return this.decision(accountId, "READY", entry.proof);
  }

  acquireLease(accountId: string, contextId: string): { decision: RouteDecision; lease: GateLease | null } {
    const decision = this.checkAction(accountId, contextId);
    if (!decision.allowed || !decision.enforce) return { decision, lease: null };
    const entry = this.accounts.get(accountId)!;
    const epoch = entry.epoch;
    const generation = this.generation;
    const controller = new AbortController();
    const id = randomUUID();
    entry.leases.set(id, controller);
    let released = false;
    return {
      decision,
      lease: {
        id,
        generation,
        signal: controller.signal,
        isCurrent: () =>
          !released &&
          !controller.signal.aborted &&
          this.accounts.get(accountId) === entry &&
          entry.epoch === epoch &&
          this.generation === generation &&
          this.checkAction(accountId, contextId).allowed,
        release: () => {
          released = true;
          entry.leases.delete(id);
        },
      },
    };
  }

  invalidate(reason: NetworkReason = "NETWORK_CHANGED"): void {
    if (this.disposed) return;
    this.environment = {
      ...this.environment,
      controllerReadable: false,
      rulesVersion: null,
      generation: this.generation + 1,
      expiresAtMono: 0,
    };
    for (const entry of this.accounts.values()) this.revokeEntry(entry, reason);
    this.publish();
    this.armTimer();
    this.notify("network", null);
  }

  revoke(accountId: string, reason: NetworkReason = "GATE_REVOKED"): void {
    const entry = this.accounts.get(accountId);
    if (!entry) return;
    this.revokeEntry(entry, reason);
    this.publish();
    this.armTimer();
  }

  snapshot(accountId?: string): AccountNetworkState[] {
    this.expire();
    const now = this.clock.monotonicMs();
    const wallNow = this.clock.wallTimeMs();
    const iso = (at: number) => new Date(wallNow + at - now).toISOString();
    return [...this.accounts.values()]
      .filter((entry) => !accountId || entry.scope.accountId === accountId)
      .map((entry) => ({
        accountId: entry.scope.accountId,
        state: entry.proof ? "allowed" : entry.reason === "CHECKING" ? "checking" : "dormant",
        reason: entry.reason,
        generation: this.generation,
        checkedAt: entry.checkedAtMono === null ? null : iso(entry.checkedAtMono),
        proofExpiresAt: entry.proof ? iso(entry.proof.expiresAtMono) : null,
      }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidate("GATE_REVOKED");
    this.disposed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.removeAllListeners();
  }

  private decision(
    accountId: string,
    reason: NetworkReason,
    proof: DirectProof | null = null,
  ): RouteDecision {
    const allowed = reason === "READY" && proof !== null;
    const enforce = this.enforcement === "strict";
    return {
      accountId,
      allowed,
      enforce,
      cancel: enforce && !allowed,
      reason,
      generation: this.generation,
      proofId: allowed ? proof!.proofId : null,
    };
  }

  private revokeEntry(entry: AccountEntry, reason: NetworkReason): void {
    // Close authority before synchronously emitting abort or revocation events.
    entry.proof = null;
    entry.warmup = null;
    entry.lastSample = null;
    entry.minObservationMono = this.clock.monotonicMs();
    entry.epoch++;
    entry.reason = reason;
    for (const controller of entry.leases.values()) controller.abort("GATE_REVOKED");
    entry.leases.clear();
    this.notify("revoked", {
      accountId: entry.scope.accountId,
      generation: this.generation,
      reason,
      enforce: this.enforcement === "strict",
    } satisfies GateRevocation);
  }

  private expire(): void {
    if (this.disposed) return;
    const now = this.clock.monotonicMs();
    if (this.environment.controllerReadable && this.environment.expiresAtMono <= now) {
      this.invalidate("CONTROLLER_UNAVAILABLE");
      return;
    }
    let changed = false;
    for (const entry of this.accounts.values()) {
      if (entry.proof && entry.proof.expiresAtMono <= now) {
        this.revokeEntry(entry, "PROOF_EXPIRED");
        changed = true;
      }
    }
    if (changed) {
      this.publish();
      this.armTimer();
    }
  }

  private publish(): void {
    this.notify("state", this.snapshot());
  }

  private notify(
    event: "state" | "revoked" | "network",
    value: AccountNetworkState[] | GateRevocation | GateProofVersion | null,
  ): void {
    // One failing audit/UI subscriber cannot prevent the remaining Session owners from revoking.
    for (const listener of this.rawListeners(event)) {
      try {
        listener.call(this, value);
      } catch {
        /* Authority is already closed before notification. */
      }
    }
  }

  private armTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    const deadlines = [...this.accounts.values()].flatMap((entry) =>
      entry.proof ? [entry.proof.expiresAtMono] : [],
    );
    if (this.environment.controllerReadable) deadlines.push(this.environment.expiresAtMono);
    if (!deadlines.length) return;
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        this.expire();
        this.armTimer();
      },
      Math.max(0, Math.min(...deadlines) - this.clock.monotonicMs()),
    );
  }
}
