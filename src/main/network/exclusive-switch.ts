import { EventEmitter } from "node:events";
import type { ExclusiveAccessSnapshot, NetworkReason, PublicEgress } from "@shared/network";
import { NETWORK_TIMING } from "@shared/network";
import type { BusinessNetworkLease } from "./business-access";

export interface ProxySwitchObservation {
  state: "active" | "inactive" | "unknown";
  startedAtMono: number;
  completedAtMono: number;
}

export interface ExclusiveSwitchOptions {
  readProxy(signal: AbortSignal): Promise<ProxySwitchObservation>;
  readNetwork(): { available: boolean; hash: string | null };
  /** Optional diagnostic policy for legacy probes. Normal startup only reads the proxy switch. */
  probeDomestic?(signal: AbortSignal): Promise<PublicEgress>;
  whenIdle?(): Promise<void>;
  now?: () => number;
  wallNow?: () => number;
  timing?: Partial<{
    pollMs: number;
    stateTtlMs: number;
    warmupGapMs: number;
    egressRefreshMs: number;
    egressTtlMs: number;
  }>;
}

/** The user's mutually exclusive policy. It never reads accounts, cookies or rule matches.
 * OS change, enabled/unknown proxy, stale observation and suspension revoke every lease first.
 * A closed proxy controller is not itself an error: current Windows observations decide off/on.
 */
export class ExclusiveNetworkSwitch extends EventEmitter {
  private value: ExclusiveAccessSnapshot = {
    state: "checking",
    proxy: "unknown",
    reason: "CHECKING",
    generation: 1,
    checkedAt: null,
    expiresAt: null,
  };
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly timing;
  private expiresAtMono = 0;
  private revision = 0;
  private networkHash: string | null = null;
  private firstGoodAt: number | null = null;
  private egress: { value: PublicEgress; at: number } | null = null;
  private flight: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;
  private readonly leases = new Set<AbortController>();

  constructor(private readonly options: ExclusiveSwitchOptions) {
    super();
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.timing = {
      pollMs: 5_000,
      stateTtlMs: NETWORK_TIMING.proofTtlMs,
      warmupGapMs: NETWORK_TIMING.renewMs,
      egressRefreshMs: NETWORK_TIMING.egressRefreshMs,
      egressTtlMs: NETWORK_TIMING.egressTtlMs,
      ...options.timing,
    };
    if (Object.values(this.timing).some((v) => !Number.isFinite(v) || v <= 0))
      throw new Error("INVALID_EXCLUSIVE_SWITCH_TIMING");
  }

  read(): ExclusiveAccessSnapshot {
    if (this.expiresAtMono > 0 && this.now() >= this.expiresAtMono) this.invalidate("PROOF_EXPIRED");
    return { ...this.value };
  }

  domesticEgress(): PublicEgress | null {
    return this.egress && this.now() < this.egress.at + this.timing.egressTtlMs
      ? { ...this.egress.value }
      : null;
  }

  acquire(side: "domestic" | "overseas" = "domestic"): BusinessNetworkLease | null {
    const state = this.read();
    if (!this.running || state.state !== side || state.proxy !== (side === "domestic" ? "off" : "on"))
      return null;
    const abort = new AbortController(),
      generation = state.generation;
    this.leases.add(abort);
    let released = false;
    return {
      signal: abort.signal,
      isCurrent: () =>
        !released &&
        !abort.signal.aborted &&
        this.running &&
        this.read().state === side &&
        this.value.generation === generation,
      release: () => {
        released = true;
        this.leases.delete(abort);
      },
    };
  }

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.refresh(), this.timing.pollMs);
    this.timer.unref?.();
    void this.refresh();
  }

  /** A fresh positive controller TUN observation can close without waiting for the OS poll. */
  observeProxyEnabled(ageMs: number): void {
    if (
      !this.running ||
      this.disposed ||
      !Number.isFinite(ageMs) ||
      ageMs < 0 ||
      ageMs >= this.timing.stateTtlMs
    )
      return;
    // Even an unchanged on-state supersedes an off sample that is still in flight.
    this.revision++;
    this.abort?.abort();
    this.firstGoodAt = null;
    this.egress = null;
    this.networkHash = null;
    this.publishDecision("overseas", "on", "PROXY_ENABLED", this.now() + this.timing.stateTtlMs - ageMs);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    this.invalidate("NETWORK_CHANGED");
  }

  invalidate(reason: NetworkReason = "NETWORK_CHANGED"): void {
    this.revision++;
    this.abort?.abort();
    this.networkHash = null;
    this.firstGoodAt = null;
    this.egress = null;
    this.expiresAtMono = 0;
    clearTimeout(this.expiry);
    this.expiry = undefined;
    this.commit({ state: "checking", proxy: "unknown", reason, checkedAt: null, expiresAt: null }, true);
  }

  /** OS change/recovery: revoke immediately, then read again without waiting for a poll tick. */
  networkChanged(): void {
    this.invalidate("NETWORK_CHANGED");
    if (!this.running || this.disposed) return;
    const revision = this.revision;
    // The cancelled OS process must finish before a new read can own its slot.
    // Repeated changes coalesce; a stop or newer positive TUN observation wins.
    void this.whenIdle().then(
      () => {
        if (this.running && !this.disposed && revision === this.revision) void this.refresh();
      },
      () => {
        if (this.running && !this.disposed && revision === this.revision)
          this.invalidate("PROXY_STATE_UNKNOWN");
      },
    );
  }

  refresh(): Promise<void> {
    if (this.flight) return this.flight;
    if (!this.running || this.disposed) return Promise.resolve();
    const abort = new AbortController(),
      revision = this.revision;
    this.abort = abort;
    // Reserve the slot before invoking providers, which may synchronously trigger invalidation.
    const pending = Promise.resolve()
      .then(() => this.sample(revision, abort.signal))
      .catch(() => {
        if (this.current(revision, abort.signal)) this.invalidate("PROXY_STATE_UNKNOWN");
      })
      .finally(() => {
        if (this.flight === pending) this.flight = null;
        if (this.abort === abort) this.abort = null;
      });
    this.flight = pending;
    return pending;
  }

  async whenIdle(): Promise<void> {
    while (this.flight) await this.flight;
    await this.options.whenIdle?.();
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.stop();
    }
    await this.whenIdle();
    this.removeAllListeners();
  }

  private current(revision: number, signal: AbortSignal): boolean {
    return this.running && !this.disposed && !signal.aborted && revision === this.revision;
  }

  private network(): string | null {
    try {
      const current = this.options.readNetwork();
      return current.available && typeof current.hash === "string" && current.hash.length > 0
        ? current.hash
        : null;
    } catch {
      return null;
    }
  }

  private async sample(revision: number, signal: AbortSignal): Promise<void> {
    if (!this.current(revision, signal)) return;
    const before = this.network();
    const proxy = await this.options.readProxy(signal);
    if (!this.current(revision, signal)) return;
    const now = this.now();
    if (
      !Number.isFinite(proxy.startedAtMono) ||
      !Number.isFinite(proxy.completedAtMono) ||
      proxy.startedAtMono < 0 ||
      proxy.completedAtMono < proxy.startedAtMono ||
      proxy.completedAtMono > now ||
      proxy.startedAtMono + this.timing.stateTtlMs <= now
    ) {
      this.invalidate("PROXY_STATE_UNKNOWN");
      return;
    }
    const until = proxy.startedAtMono + this.timing.stateTtlMs;
    if (proxy.state !== "inactive") {
      this.firstGoodAt = null;
      this.egress = null;
      this.networkHash = null;
      this.publishDecision(
        proxy.state === "active" ? "overseas" : "checking",
        proxy.state === "active" ? "on" : "unknown",
        proxy.state === "active" ? "PROXY_ENABLED" : "PROXY_STATE_UNKNOWN",
        until,
      );
      return;
    }
    const after = this.network();
    if (!before || before !== after) {
      this.invalidate("NETWORK_CHANGED");
      return;
    }
    if (this.networkHash && this.networkHash !== after) {
      this.invalidate("NETWORK_CHANGED");
      return;
    }
    this.networkHash = after;
    // Proxy off is sufficient for the normal domestic session. Availability and
    // login errors are handled by the official page, not an unrelated IP echo site.
    if (!this.options.probeDomestic) {
      this.publishDecision("domestic", "off", "READY", until);
      return;
    }
    const needsSecond = this.value.state !== "domestic";
    if (needsSecond && this.firstGoodAt !== null && now < this.firstGoodAt + this.timing.warmupGapMs) {
      this.publishDecision("checking", "off", "CHECKING", until);
      return;
    }
    if (!this.egress || needsSecond || now >= this.egress.at + this.timing.egressRefreshMs) {
      const probeStartedAt = this.now();
      const result = await this.options.probeDomestic(signal);
      if (!this.current(revision, signal)) return;
      if (this.network() !== after || this.now() >= until) {
        this.invalidate("NETWORK_CHANGED");
        return;
      }
      // Re-read the proxy after the anonymous request. Enabling it during a probe cannot create
      // a permit from a late CN response or from a proxy node that also happens to exit in CN.
      const post = await this.options.readProxy(signal);
      if (!this.current(revision, signal)) return;
      if (post.state !== "inactive") {
        this.firstGoodAt = null;
        this.egress = null;
        this.publishDecision(
          post.state === "active" ? "overseas" : "checking",
          post.state === "active" ? "on" : "unknown",
          post.state === "active" ? "PROXY_ENABLED" : "PROXY_STATE_UNKNOWN",
          until,
        );
        return;
      }
      if (
        this.network() !== after ||
        this.now() >= until ||
        !Number.isFinite(post.startedAtMono) ||
        !Number.isFinite(post.completedAtMono) ||
        post.startedAtMono < proxy.completedAtMono ||
        post.completedAtMono < post.startedAtMono ||
        post.completedAtMono > this.now()
      ) {
        this.invalidate("NETWORK_CHANGED");
        return;
      }
      if (result.state !== "reachable" || result.country !== "CN") {
        this.firstGoodAt = null;
        this.egress = null;
        this.publishDecision(
          "unavailable",
          "off",
          result.state === "reachable" && result.country ? "EGRESS_OUTSIDE_CN" : "EGRESS_UNVERIFIED",
          until,
        );
        return;
      }
      // Cache age starts before the real probe; the postflight Windows read cannot extend it.
      this.egress = { value: { ...result }, at: probeStartedAt };
      if (this.firstGoodAt === null) {
        this.firstGoodAt = this.now();
        this.publishDecision("checking", "off", "CHECKING", until);
        return;
      }
    }
    this.publishDecision(
      "domestic",
      "off",
      "READY",
      Math.min(until, this.egress!.at + this.timing.egressTtlMs),
    );
  }

  private publishDecision(
    state: ExclusiveAccessSnapshot["state"],
    proxy: ExclusiveAccessSnapshot["proxy"],
    reason: NetworkReason,
    until: number,
  ): void {
    const now = this.now();
    if (until <= now) {
      this.invalidate("PROOF_EXPIRED");
      return;
    }
    this.expiresAtMono = until;
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => {
      this.read();
    }, until - now);
    this.expiry.unref?.();
    const changed =
      this.value.proxy !== proxy || (this.value.state === "domestic") !== (state === "domestic");
    this.commit(
      {
        state,
        proxy,
        reason,
        checkedAt: new Date(this.wallNow()).toISOString(),
        expiresAt: new Date(this.wallNow() + until - now).toISOString(),
      },
      changed,
    );
  }

  private commit(next: Omit<ExclusiveAccessSnapshot, "generation">, revoke: boolean): void {
    this.value = { ...next, generation: this.value.generation + (revoke ? 1 : 0) };
    if (revoke) {
      for (const lease of this.leases) lease.abort();
      this.leases.clear();
    }
    this.emit("state", { ...this.value });
  }
}
