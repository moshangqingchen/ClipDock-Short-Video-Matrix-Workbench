import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Account } from "@shared/types";
import type { CnPlatformId } from "@shared/platforms";
import {
  checkingNetworkSnapshot,
  NETWORK_TIMING,
  type NetworkSnapshot,
  type NetworkSettings,
  type NetworkReason,
  type ObservedTarget,
} from "@shared/network";
import { candidateTargets, observationKey, suggestedDirectRules, type CatalogTarget } from "./catalog";
import { evaluateRules } from "./rules";
import type { ClashReadResult } from "./clash-reader";
import type { DiagnosticResults } from "./diagnostics";

interface Reader {
  read(): Promise<ClashReadResult>;
}
interface Diagnostics {
  run(port: number): Promise<DiagnosticResults>;
  stop(): void;
  pause?(): Promise<void>;
  resume?(): void;
  whenIdle?(): Promise<void>;
}
export interface ObserverOptions {
  accounts(): Account[];
  settings(): NetworkSettings;
  reader(settings: NetworkSettings): Reader;
  diagnostics: Diagnostics;
  audit?(action: string, details: Record<string, string | number | boolean | null>): void;
}

/** Read-only observation milestone. No renderer setting can activate enforcement. */
export class NetworkObserver extends EventEmitter {
  private value: NetworkSnapshot = { ...checkingNetworkSnapshot(), instanceId: randomUUID() };
  private readonly observed = new Map<string, CatalogTarget>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<NetworkSnapshot> | null = null;
  private diagnosticFlight: Promise<void> | null = null;
  private diagnosticEpoch = 0;
  private diagnosticPauses = 0;
  private diagnosticPauseDrain: Promise<void> | null = null;
  private diagnosticPauseFailed = false;
  private nextDiagnostics = 0;
  private revision = 0;
  private stopped = true;
  private reader: Reader;

  constructor(private readonly options: ObserverOptions) {
    super();
    this.reader = this.createReader();
  }

  private createReader(): Reader {
    try {
      return this.options.reader(this.options.settings());
    } catch {
      return {
        read: async () => {
          throw new Error("网络控制器配置不可用");
        },
      };
    }
  }

  snapshot(): NetworkSnapshot {
    const result = structuredClone(this.value);
    for (const key of ["direct", "proxy"] as const) {
      const sample = result[key];
      const checkedAt = sample.checkedAt ? Date.parse(sample.checkedAt) : NaN;
      if (
        sample.state === "reachable" &&
        (!Number.isFinite(checkedAt) || checkedAt + NETWORK_TIMING.egressTtlMs <= Date.now())
      ) {
        result[key] = { ...checkingNetworkSnapshot()[key], state: "unavailable" };
      }
    }
    return result;
  }

  record(platformId: CnPlatformId, host: string): void {
    // Store only normalized hostname, no request path, query, referrer, header or body.
    host = host.toLowerCase().replace(/\.$/, "");
    if (this.stopped || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || this.observed.size >= 1024)
      return;
    const key = observationKey(platformId, host);
    if (!this.observed.has(key)) this.observed.set(key, { platformId, host, purpose: "observed" });
  }

  start(): void {
    this.stopped = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(), NETWORK_TIMING.renewMs);
    this.timer.unref?.();
    void this.refresh();
  }

  private publish(): void {
    this.value.sequence++;
    this.emit("snapshot", this.snapshot());
  }

  private resetDiagnostics(): void {
    // A fingerprint may recur after a rule change or a controller outage.
    // Every interruption ends the old sampling lifetime, regardless of whether
    // the transport honors cancellation or eventually returns the same rules.
    this.diagnosticEpoch++;
    this.nextDiagnostics = 0;
    this.value.direct = checkingNetworkSnapshot().direct;
    this.value.proxy = checkingNetworkSnapshot().proxy;
    this.options.diagnostics.stop();
  }

  /** A quiet-window handle pauses anonymous traffic only. Controller refreshes remain active.
   * No release restarts this observer or advances the normal diagnostic deadline. */
  async pauseDiagnostics(): Promise<() => void> {
    const diagnostics = this.options.diagnostics;
    if (!diagnostics.pause || !diagnostics.resume || !diagnostics.whenIdle || this.diagnosticPauseFailed)
      throw new Error("DIAGNOSTICS_QUIET_UNAVAILABLE");
    this.diagnosticPauses++;
    this.diagnosticEpoch++;
    this.value.direct = checkingNetworkSnapshot().direct;
    this.value.proxy = checkingNetworkSnapshot().proxy;
    if (!this.diagnosticPauseDrain && this.diagnosticPauses === 1) {
      // Reserve the shared barrier before either native pause or snapshot listeners can reenter.
      let finishPause!: () => void, rejectPause!: (reason: unknown) => void;
      const paused = new Promise<void>((resolve, reject) => {
        finishPause = resolve;
        rejectPause = reject;
      });
      const pending = Promise.allSettled([
        paused,
        this.diagnosticFlight,
        Promise.resolve().then(() => diagnostics.whenIdle!()),
      ])
        .then((results) => {
          if (results.some((value) => value.status === "rejected")) {
            this.diagnosticPauseFailed = true;
            throw new Error("DIAGNOSTICS_QUIET_UNAVAILABLE");
          }
        })
        .finally(() => {
          if (this.diagnosticPauseDrain === pending) this.diagnosticPauseDrain = null;
        });
      this.diagnosticPauseDrain = pending;
      // Start native abort synchronously after reservation, before emitting any external event.
      try {
        void Promise.resolve(diagnostics.pause()).then(finishPause, rejectPause);
      } catch {
        rejectPause(new Error("DIAGNOSTICS_QUIET_UNAVAILABLE"));
      }
    }
    try {
      if (!this.stopped) this.publish();
      await this.diagnosticPauseDrain;
      // A rule interruption can call stop() while another quiet handle is already held.
      // Recheck that real cleanup too; nesting must not substitute an old successful drain.
      await diagnostics.whenIdle();
      if (this.diagnosticPauseFailed) throw new Error("DIAGNOSTICS_QUIET_UNAVAILABLE");
    } catch {
      this.diagnosticPauseFailed = true;
      this.diagnosticPauses--;
      throw new Error("DIAGNOSTICS_QUIET_UNAVAILABLE");
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.diagnosticPauses--;
      if (this.diagnosticPauses === 0 && !this.diagnosticPauseFailed) {
        try {
          diagnostics.resume!();
        } catch {
          this.diagnosticPauseFailed = true;
        }
      }
    };
  }

  invalidate(): void {
    this.revision++;
    this.resetDiagnostics();
    this.value = {
      ...checkingNetworkSnapshot(),
      instanceId: this.value.instanceId,
      sequence: this.value.sequence,
      reason: "NETWORK_CHANGED",
    };
    if (!this.stopped) this.publish();
    this.reader = this.createReader();
    // An older in-flight sample is discarded before any new sample publishes.
    void (this.inFlight ?? Promise.resolve()).then(() => {
      if (!this.stopped) void this.refresh();
    });
  }

  directRules(): string {
    return suggestedDirectRules(this.targets());
  }

  private targets(): CatalogTarget[] {
    const result = new Map(
      candidateTargets().map((target) => [observationKey(target.platformId, target.host), target]),
    );
    for (const [key, value] of this.observed) if (!result.has(key)) result.set(key, value);
    return [...result.values()];
  }

  refresh(): Promise<NetworkSnapshot> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped) return Promise.resolve(this.snapshot());
    const revision = this.revision;
    this.inFlight = this.sample(revision).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async sample(revision: number): Promise<NetworkSnapshot> {
    const now = new Date().toISOString();
    let reason: NetworkReason = "CONTROLLER_UNAVAILABLE";
    const previousVersion = this.value.rulesVersion;
    let targets: ObservedTarget[] = [];
    try {
      const result = await this.reader.read();
      if (this.stopped || revision !== this.revision) return this.snapshot();
      this.value.controller = {
        readable: true,
        mode: result.mode,
        tun: result.tun,
        ruleCount: result.rules.length,
        version: result.version,
      };
      this.value.rulesVersion = result.fingerprint;
      if (previousVersion && previousVersion !== result.fingerprint) {
        this.resetDiagnostics();
      }
      targets = this.targets().map((target) => {
        const decision = evaluateRules(result.mode, result.rules, {
          host: target.host,
          port: 443,
          network: "tcp",
        });
        return { ...target, route: decision.route, reason: decision.reason, ruleType: decision.ruleType };
      });
      reason =
        result.mode === "global"
          ? "GLOBAL_MODE"
          : targets.some((target) => target.route === "unknown")
            ? "RULE_UNVERIFIABLE"
            : targets.some((target) => target.route === "proxy")
              ? "NOT_DIRECT"
              : "CONTEXT_UNVERIFIED";
      if (
        this.diagnosticPauses === 0 &&
        !this.diagnosticPauseFailed &&
        Date.now() >= this.nextDiagnostics &&
        !this.diagnosticFlight
      ) {
        this.nextDiagnostics = Date.now() + NETWORK_TIMING.egressRefreshMs;
        const rulesVersion = result.fingerprint;
        const diagnosticEpoch = this.diagnosticEpoch;
        this.diagnosticFlight = this.options.diagnostics
          .run(this.options.settings().diagnosticProxyPort)
          .then((egress) => {
            if (
              this.stopped ||
              this.diagnosticPauses > 0 ||
              this.diagnosticPauseFailed ||
              revision !== this.revision ||
              diagnosticEpoch !== this.diagnosticEpoch ||
              rulesVersion !== this.value.rulesVersion ||
              !this.value.controller.readable
            )
              return;
            this.value.direct = egress.direct;
            this.value.proxy = egress.proxy;
            this.publish();
          })
          .catch(() => {
            if (
              this.stopped ||
              this.diagnosticPauses > 0 ||
              this.diagnosticPauseFailed ||
              revision !== this.revision ||
              diagnosticEpoch !== this.diagnosticEpoch ||
              rulesVersion !== this.value.rulesVersion ||
              !this.value.controller.readable
            )
              return;
            this.value.direct = { ...checkingNetworkSnapshot().direct, state: "unavailable" };
            this.value.proxy = { ...checkingNetworkSnapshot().proxy, state: "unavailable" };
            this.publish();
          })
          .finally(() => {
            this.diagnosticFlight = null;
          });
      }
    } catch (error) {
      if (this.stopped || revision !== this.revision) return this.snapshot();
      if (error && typeof error === "object" && "code" in error && error.code === "CREDENTIAL_UNAVAILABLE")
        reason = "CREDENTIAL_UNAVAILABLE";
      this.value.controller = { readable: false, mode: null, tun: null, ruleCount: 0, version: null };
      this.value.rulesVersion = null;
      this.resetDiagnostics();
    }
    if (this.stopped || revision !== this.revision) return this.snapshot();
    this.value.targets = targets;
    this.value.reason = reason;
    this.value.checkedAt = now;
    // Rule candidates and anonymous endpoint success cannot certify account paths.
    this.value.state = "checking";
    this.value.accounts = this.options.accounts().map((account) => ({
      accountId: account.id,
      state: "checking",
      reason,
      generation: this.revision,
      checkedAt: now,
      proofExpiresAt: null,
    }));
    if (previousVersion !== this.value.rulesVersion) {
      this.options.audit?.("network.observation", {
        mode: this.value.controller.mode,
        tun: this.value.controller.tun,
        rulesVersion: this.value.rulesVersion,
        targetCount: targets.length,
        enforcement: "observe",
        reason,
      });
    }
    this.publish();
    return this.snapshot();
  }

  stop(): void {
    this.stopped = true;
    this.revision++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.resetDiagnostics();
  }
}
