import { EventEmitter } from "node:events";
import type { ExclusiveAccessSnapshot, NetworkReason } from "@shared/network";
import type { BusinessNetworkLease } from "./business-access";
import type { SessionRegistration } from "./runtime";
import type { GlobalProxyRuntime } from "@main/api/global-proxy-runtime";
import type { GlobalOAuthEligibility } from "@main/api/global-oauth-service";
import { GlobalWebRelay } from "./global-web-relay";
import { isDomesticWebHost } from "./domestic-web-target-policy";
import type { DomesticRuleAdmission, DomesticRuleTransport } from "./domestic-rule-transport";

interface Options {
  source: Pick<
    GlobalProxyRuntime,
    "acquireEligibility" | "openWebTunnel" | "sync" | "invalidate" | "subscribe" | "dispose"
  > & {
    readAuthority?: GlobalProxyRuntime["readAuthority"];
    readAdmission?(): DomesticRuleAdmission;
    openAccountTunnel?: DomesticRuleTransport["openAccountTunnel"];
    releaseAccount?: DomesticRuleTransport["releaseAccount"];
  };
  readSwitch(): ExclusiveAccessSnapshot;
  acquireOff(): BusinessNetworkLease | null;
  readController(): { readable: boolean; mode: string | null };
}

/** Adds a verified DIRECT lane to the existing proxy-off policy. No renderer grants,
 * cookie copying, rule writes, implicit system-proxy bypass or automatic submission. */
export class DomesticDirectAccess extends EventEmitter {
  private generation = 1;
  private key = "";
  private epoch = new AbortController();
  private lease: GlobalOAuthEligibility | null = null;
  private probing: Promise<void> | null = null;
  private retryAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private syncing = false;
  private readonly relays = new Map<string, GlobalWebRelay>();
  private readonly configurations = new Map<string, AbortController>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;
  private cleanupFailed = false;
  constructor(private readonly options: Options) {
    super();
    this.unsubscribe = options.source.subscribe(() => this.sync());
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.sync(), 1_000);
    this.timer.unref?.();
    this.sync();
  }
  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.invalidate();
  }
  invalidate(): void {
    this.lease?.release();
    this.lease = null;
    this.options.source.invalidate();
    this.retryAt = 0;
    this.key = "";
    this.rotate();
    this.sync();
  }
  private rotate(): void {
    this.generation++;
    this.epoch.abort();
    this.epoch = new AbortController();
    for (const [accountId, token] of this.configurations) {
      token.abort();
      this.options.source.releaseAccount?.(accountId);
    }
    this.configurations.clear();
    for (const relay of this.relays.values()) {
      this.retire(relay);
    }
    this.relays.clear();
  }
  private retire(relay: GlobalWebRelay): void {
    const work = relay.dispose();
    this.retiring.add(work);
    void work.catch(() => {
      this.cleanupFailed = true;
      this.options.source.invalidate();
      this.sync();
    });
    void work.finally(() => this.retiring.delete(work)).catch(() => undefined);
  }
  releaseSession(accountId: string): void {
    const token = this.configurations.get(accountId);
    this.configurations.delete(accountId);
    token?.abort();
    const relay = this.relays.get(accountId);
    if (relay) {
      this.relays.delete(accountId);
      this.retire(relay);
    }
    this.options.source.releaseAccount?.(accountId);
  }
  private snapshot(): ExclusiveAccessSnapshot {
    const raw = this.options.readSwitch();
    if (!this.running)
      return {
        ...raw,
        state: "checking",
        reason: "CHECKING",
        generation: this.generation,
        checkedAt: null,
        expiresAt: null,
      };
    if (raw.proxy !== "on") return { ...raw, generation: this.generation };
    const controller = this.options.readController();
    const current = this.running && this.lease?.isCurrent();
    const admission = current ? this.options.source.readAdmission?.() : null;
    const authority =
      current && !this.options.source.readAdmission ? this.options.source.readAuthority?.() : null;
    const checkedAtMono = admission?.checkedAtMono ?? authority?.checkedAtMono;
    const expiresAtMono = admission?.expiresAtMono ?? authority?.expiresAtMono;
    const ready =
      !this.cleanupFailed &&
      controller.readable &&
      controller.mode === "rule" &&
      (this.options.source.readAdmission
        ? admission?.ready === true
        : authority?.egress?.countryCode === "CN") &&
      typeof checkedAtMono === "number" &&
      Number.isFinite(checkedAtMono) &&
      typeof expiresAtMono === "number" &&
      Number.isFinite(expiresAtMono) &&
      expiresAtMono > performance.now();
    const reason: NetworkReason = !controller.readable
      ? "CONTROLLER_UNAVAILABLE"
      : controller.mode !== "rule"
        ? "GLOBAL_MODE"
        : ready
          ? "READY"
          : "EGRESS_UNVERIFIED";
    return {
      ...raw,
      state: ready ? "dual" : "overseas",
      reason,
      generation: this.generation,
      checkedAt: ready
        ? new Date(Date.now() - (performance.now() - checkedAtMono!)).toISOString()
        : raw.checkedAt,
      expiresAt: ready
        ? new Date(Date.now() + (expiresAtMono! - performance.now())).toISOString()
        : raw.expiresAt,
    };
  }
  read(): ExclusiveAccessSnapshot {
    return this.snapshot();
  }
  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      this.options.source.sync();
      if (this.lease && !this.lease.isCurrent()) {
        this.lease.release();
        this.lease = null;
      }
      const raw = this.options.readSwitch();
      const value = this.snapshot();
      const key = `${raw.generation}:${value.state}:${value.proxy}:${value.reason}:${this.lease?.generation ?? ""}`;
      if (key !== this.key) {
        this.key = key;
        this.rotate();
        this.emit("state", this.snapshot());
      } else if (value.state === "dual") this.emit("state", value);
      const controller = this.options.readController();
      if (
        this.running &&
        !this.cleanupFailed &&
        raw.proxy === "on" &&
        controller.readable &&
        controller.mode === "rule" &&
        !this.lease &&
        !this.probing &&
        performance.now() >= this.retryAt
      ) {
        this.retryAt = performance.now() + 15_000;
        // Independent lifetime: successful admission rotates browser leases, not this renewal lease.
        const signal = new AbortController().signal;
        this.probing = this.options.source
          .acquireEligibility("douyin", signal)
          .then((lease) => {
            if (!this.running) lease?.release();
            else this.lease = lease;
          })
          .catch(() => undefined)
          .finally(() => {
            this.probing = null;
            this.sync();
          });
      }
    } finally {
      this.syncing = false;
    }
  }
  acquire(): BusinessNetworkLease | null {
    const value = this.read();
    if (!this.running) return null;
    const epoch = this.epoch;
    const domesticOff = value.state === "domestic" && value.proxy === "off";
    if (!domesticOff && value.state !== "dual") return null;
    const source = domesticOff ? this.options.acquireOff() : null;
    if (domesticOff && !source) return null;
    const signal = source ? AbortSignal.any([epoch.signal, source.signal]) : epoch.signal;
    let released = false;
    const lease: BusinessNetworkLease = {
      signal,
      isCurrent: () => {
        if (released || signal.aborted || !this.running || epoch !== this.epoch) return false;
        const current = this.read();
        return domesticOff
          ? current.state === "domestic" && current.proxy === "off" && source!.isCurrent()
          : current.state === "dual";
      },
      release: () => {
        if (released) return;
        released = true;
        source?.release();
      },
    };
    if (!lease.isCurrent()) {
      lease.release();
      return null;
    }
    return lease;
  }
  allowUrl(platformId: string, url: URL): boolean {
    return (
      ["https:", "wss:"].includes(url.protocol) &&
      (!url.port || url.port === "443") &&
      !url.username &&
      !url.password &&
      isDomesticWebHost(platformId, url.hostname)
    );
  }
  async configureSession(entry: SessionRegistration): Promise<void> {
    this.releaseSession(entry.accountId);
    const token = new AbortController(),
      epoch = this.epoch;
    this.configurations.set(entry.accountId, token);
    const current = () =>
      this.configurations.get(entry.accountId) === token &&
      !token.signal.aborted &&
      !epoch.signal.aborted &&
      this.epoch === epoch;
    try {
      if (this.read().proxy !== "on") {
        await entry.session.setProxy({ mode: "direct" });
      } else if (this.read().state !== "dual") {
        // A checking generation has no authority yet. Its next admission rebuilds the closed route.
        await entry.session.setProxy({
          mode: "fixed_servers",
          proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9",
          proxyBypassRules: "<-loopback>",
        });
      } else {
        const relay = new GlobalWebRelay({
          platformId: entry.platformId,
          signal: AbortSignal.any([epoch.signal, token.signal]),
          maxConnections: 64,
          requestTimeoutMs: 15_000,
          assertCurrent: () => {
            if (!current() || this.read().state !== "dual") throw new Error("DOMESTIC_DIRECT_UNAVAILABLE");
          },
          allowTarget: isDomesticWebHost,
          openTunnel: (input) =>
            this.options.source.openAccountTunnel
              ? this.options.source.openAccountTunnel(entry.accountId, input)
              : this.options.source.openWebTunnel(input),
        });
        // Own the pending listener before start yields, so deleting/resetting an account cancels it.
        this.relays.set(entry.accountId, relay);
        const endpoint = await relay.start();
        if (!current()) return;
        await entry.session.setProxy({
          mode: "fixed_servers",
          proxyRules: `http=${endpoint.host}:${endpoint.port};https=${endpoint.host}:${endpoint.port}`,
          proxyBypassRules: "<-loopback>",
        });
      }
      if (!current()) return;
      await entry.session.closeAllConnections();
      if (!current()) return;
      await entry.session.clearHostResolverCache();
    } catch (error) {
      const cancelled = !current();
      // A stale completion must not retire the newer configuration for the same account.
      if (this.configurations.get(entry.accountId) === token) this.releaseSession(entry.accountId);
      if (!cancelled) throw error;
    }
  }
  async dispose(): Promise<void> {
    this.stop();
    this.unsubscribe();
    await this.probing;
    await this.options.source.dispose();
    await Promise.all([...this.retiring]);
    this.removeAllListeners();
    if (this.cleanupFailed) throw new Error("DOMESTIC_DIRECT_CLEANUP_FAILED");
  }
}
