import type { WebContents } from "electron";
import type { Account, AppSettings, CollectRun } from "@shared/types";
import { getPlatform, isLoginUrl, isPlatformHost } from "@shared/platforms";
import type { ToastEvent } from "@shared/ipc";
import type { Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import type { AccountService } from "@main/services/account-service";
import { LoggedOutError, RateLimitedError, type CollectorRegistry } from "./collectors";

export interface SchedulerOptions {
  store: Store;
  pool: ViewPool;
  collectors: CollectorRegistry;
  accounts: AccountService;
  notify: (toast: ToastEvent, system?: boolean) => void;
  onRun?: (run: CollectRun) => void;
  onMetrics?: (accountId: string) => void;
}

type Trigger = CollectRun["trigger"];

interface QueueItem {
  accountId: string;
  trigger: Trigger;
  resolve: (run: CollectRun | null) => void;
  reject: (error: Error) => void;
}

const MAX_CONCURRENCY = 2;
const PAGE_READY_TIMEOUT_MS = 25_000;
const MIN_GAP_BETWEEN_RUNS_MS = 90_000;
const BACKOFF_BASE_MS = 10 * 60_000;
const BACKOFF_MAX_MS = 6 * 3600_000;

/**
 * Runs collectors inside each account's own view. Work is serialized per
 * account, capped globally, jittered on the clock and backs off exponentially
 * when a platform answers with 429 or a risk-control payload.
 */
export class CollectScheduler {
  private readonly queue: QueueItem[] = [];
  private readonly running = new Set<string>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly backoffLevel = new Map<string, number>();
  private readonly lastRunAt = new Map<string, number>();
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private settings: AppSettings;
  private stopped = true;

  constructor(private readonly options: SchedulerOptions) {
    this.settings = options.store.settings.get();
  }

  start(): void {
    this.stopped = false;
    this.stopTimers();
    this.tickTimer = setInterval(() => this.tick(), 60_000);
    (this.tickTimer as unknown as { unref?: () => void }).unref?.();
    // First sweep shortly after launch so accounts that never collected
    // (e.g. a login whose first attempt hit a redirect) are not left waiting
    // for the regular interval.
    setTimeout(() => this.tick(true), 45_000);
  }

  stop(): void {
    this.stopped = true;
    this.stopTimers();
    for (const item of this.queue.splice(0)) item.resolve(null);
  }

  applySettings(next: AppSettings): void {
    this.settings = next;
  }

  private stopTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }

  /** Queue one collection. Duplicate pending requests for an account collapse. */
  enqueue(accountId: string, trigger: Trigger): Promise<CollectRun | null> {
    if (this.stopped) return Promise.resolve(null);
    const existing = this.queue.find((item) => item.accountId === accountId);
    if (existing) {
      return new Promise((resolve, reject) => {
        const prevResolve = existing.resolve;
        const prevReject = existing.reject;
        existing.resolve = (run) => {
          prevResolve(run);
          resolve(run);
        };
        existing.reject = (error) => {
          prevReject(error);
          reject(error);
        };
      });
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ accountId, trigger, resolve, reject });
      this.pump();
    });
  }

  async collectAll(trigger: Trigger): Promise<CollectRun[]> {
    const runs = await Promise.all(
      this.options.accounts.list().map((account) => this.enqueue(account.id, trigger)),
    );
    return runs.filter((run): run is CollectRun => Boolean(run));
  }

  private tick(initial = false): void {
    if (this.stopped) return;
    const now = Date.now();
    const accounts = this.options.accounts.list();
    for (const account of accounts) {
      if (account.status !== "online" && account.status !== "expiring") continue;
      // Skipped runs (page not ready, rate gap) are not attempts; an online
      // account that has never been collected is picked up on the first tick.
      const last = this.options.store.metrics.lastAttemptedRun(account.id);
      const lastAt = last ? Date.parse(last.finishedAt ?? last.startedAt) : 0;
      if (this.settings.collectEnabled) {
        const interval = this.settings.collectIntervalHours * 3600_000;
        const jitter = hashJitter(account.id, interval * 0.15);
        if (!last || now - lastAt >= interval + jitter) {
          void this.enqueue(account.id, !last && initial ? "login" : "scheduled");
          continue;
        }
      }
      if (this.settings.keepaliveEnabled) {
        const interval = this.settings.keepaliveIntervalHours * 3600_000;
        const sinceOnline = account.lastCheckedAt ? now - Date.parse(account.lastCheckedAt) : Infinity;
        if (sinceOnline >= interval) void this.enqueue(account.id, "keepalive");
      }
    }
  }

  private pump(): void {
    while (this.running.size < MAX_CONCURRENCY) {
      const index = this.queue.findIndex((item) => !this.running.has(item.accountId));
      if (index === -1) return;
      const [item] = this.queue.splice(index, 1);
      this.running.add(item.accountId);
      void this.execute(item)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running.delete(item.accountId);
          this.pump();
        });
    }
  }

  private async execute(item: QueueItem): Promise<CollectRun | null> {
    const { store, collectors, accounts, notify } = this.options;
    const account = store.accounts.get(item.accountId);
    if (!account) return null;
    const now = Date.now();

    // Operator actions and the first collection after a login always run;
    // only background triggers are rate-limited against the previous run.
    const immediate = item.trigger === "manual" || item.trigger === "login";
    const until = this.backoffUntil.get(account.id) ?? 0;
    if (until > now && item.trigger !== "manual")
      return this.skipped(account, item.trigger, "平台限流退避中");
    const last = this.lastRunAt.get(account.id) ?? 0;
    if (!immediate && now - last < MIN_GAP_BETWEEN_RUNS_MS)
      return this.skipped(account, item.trigger, "距上次采集过近");
    if (account.status === "needs_verification")
      return this.skipped(account, item.trigger, "账号需要安全验证");
    if (account.status === "offline" && item.trigger !== "manual")
      return this.skipped(account, item.trigger, "账号未登录");

    const collector = collectors.get(account.platformId);
    if (!collector) return this.skipped(account, item.trigger, "该平台暂不支持采集");

    const runId = store.metrics.startRun({
      accountId: account.id,
      platformId: account.platformId,
      startedAt: new Date().toISOString(),
      status: "failed",
      trigger: item.trigger,
    });

    try {
      const wc = await this.prepareView(account, collector.workingUrl, item.trigger === "keepalive");
      if (!wc) {
        // The page was mid-redirect (typical right after a QR login). Do not
        // count this as a run so the follow-up trigger is not rate-limited.
        const run = store.metrics.finishRun(runId, {
          status: "skipped",
          message: "账号页面未就绪或未登录",
          metricsWritten: 0,
          worksWritten: 0,
        });
        this.options.onRun?.(run);
        if (item.trigger === "login") this.retryAfterLogin(account.id);
        return run;
      }

      this.lastRunAt.set(account.id, Date.now());
      const result = await collector.collect({ webContents: wc, account });
      if (result.loggedOut) {
        void accounts.checkStatus(account.id);
        const run = store.metrics.finishRun(runId, {
          status: "skipped",
          message: "平台提示未登录",
          metricsWritten: 0,
          worksWritten: 0,
        });
        this.options.onRun?.(run);
        return run;
      }

      const metricsWritten = store.metrics.saveSnapshots(result.metrics);
      const worksWritten = store.metrics.upsertWorks(result.works);
      if (result.profile) {
        const patch: Record<string, unknown> = {};
        if (result.profile.avatarUrl) patch.avatarUrl = result.profile.avatarUrl;
        if (result.profile.handle) patch.handle = result.profile.handle;
        if (result.profile.externalId) patch.externalId = result.profile.externalId;
        if (result.profile.displayName && isGeneratedName(account))
          patch.displayName = result.profile.displayName.slice(0, 60);
        if (Object.keys(patch).length) accounts.update(account.id, patch);
      }
      this.backoffLevel.delete(account.id);
      this.backoffUntil.delete(account.id);

      const status = metricsWritten === 0 ? "failed" : result.warnings.length ? "partial" : "success";
      const run = store.metrics.finishRun(runId, {
        status,
        message: result.warnings.join(";") || null,
        metricsWritten,
        worksWritten,
      });
      this.options.onRun?.(run);
      if (metricsWritten > 0) this.options.onMetrics?.(account.id);
      if (item.trigger === "manual") {
        notify({
          kind: status === "failed" ? "warning" : "success",
          title:
            status === "failed"
              ? `${account.displayName} 采集未获取到数据`
              : `${account.displayName} 数据已更新`,
          message: result.warnings[0],
          accountId: account.id,
        });
      }
      return run;
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (error instanceof RateLimitedError) {
        const level = (this.backoffLevel.get(account.id) ?? 0) + 1;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (level - 1));
        this.backoffLevel.set(account.id, level);
        this.backoffUntil.set(account.id, Date.now() + delay);
        message = `平台限流,${Math.round(delay / 60_000)} 分钟后重试`;
        notify({
          kind: "warning",
          title: `${account.displayName} 触发平台限流`,
          message,
          accountId: account.id,
        });
      } else if (error instanceof LoggedOutError) {
        message = "平台提示未登录";
        void accounts.checkStatus(account.id);
      }
      const run = store.metrics.finishRun(runId, {
        status: "failed",
        message,
        metricsWritten: 0,
        worksWritten: 0,
      });
      this.options.onRun?.(run);
      return run;
    }
  }

  private readonly loginRetries = new Map<string, number>();

  /** A login-triggered run found the page still redirecting; try again shortly. */
  private retryAfterLogin(accountId: string): void {
    const attempts = this.loginRetries.get(accountId) ?? 0;
    if (attempts >= 3) {
      this.loginRetries.delete(accountId);
      return;
    }
    this.loginRetries.set(accountId, attempts + 1);
    setTimeout(
      () => {
        if (this.stopped) return;
        void this.enqueue(accountId, "login").then((run) => {
          if (run && run.status !== "skipped") this.loginRetries.delete(accountId);
        });
      },
      15_000 * (attempts + 1),
    );
  }

  private skipped(account: Account, trigger: Trigger, message: string): CollectRun {
    const id = this.options.store.metrics.startRun({
      accountId: account.id,
      platformId: account.platformId,
      startedAt: new Date().toISOString(),
      status: "skipped",
      trigger,
      message,
    });
    const run = this.options.store.metrics.finishRun(id, {
      status: "skipped",
      message,
      metricsWritten: 0,
      worksWritten: 0,
    });
    this.options.onRun?.(run);
    return run;
  }

  /**
   * Make sure the account's view is showing a first-party console page. The
   * view is created hidden when missing; a keep-alive forces a fresh home
   * navigation so server-side sliding sessions are renewed.
   */
  private async prepareView(
    account: Account,
    workingUrl: string,
    forceNavigate: boolean,
  ): Promise<WebContents | null> {
    const { pool } = this.options;
    const entry = pool.ensure({ id: account.id, platformId: account.platformId }, { navigate: false });
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return null;

    const current = wc.getURL();
    const onPlatform = current && isPlatformHost(account.platformId, safeHost(current));
    const needsNavigation =
      forceNavigate || !onPlatform || isLoginUrl(account.platformId, current) || current === "about:blank";
    if (needsNavigation) {
      // Never hijack what the operator is looking at: navigate only hidden views.
      if (entry.visible && onPlatform && !forceNavigate) {
        return isLoginUrl(account.platformId, current) ? null : wc;
      }
      if (entry.visible && forceNavigate) return isLoginUrl(account.platformId, current) ? null : wc;
      await pool.navigate(account.id, workingUrl).catch(() => undefined);
    }
    await waitForIdle(wc, PAGE_READY_TIMEOUT_MS);
    const finalUrl = wc.isDestroyed() ? "" : wc.getURL();
    if (!finalUrl || !isPlatformHost(account.platformId, safeHost(finalUrl))) return null;
    if (
      isLoginUrl(account.platformId, finalUrl) &&
      !finalUrl.startsWith(getPlatform(account.platformId).routes.home)
    ) {
      void this.options.accounts.checkStatus(account.id);
      return null;
    }
    return wc;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function hashJitter(seed: string, max: number): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ((h % 1000) / 1000) * max;
}

function isGeneratedName(account: Account): boolean {
  const platform = getPlatform(account.platformId);
  return new RegExp(`^${platform.shortName}账号 \\d+$`).test(account.displayName);
}

async function waitForIdle(wc: WebContents, timeoutMs: number): Promise<void> {
  if (wc.isDestroyed()) return;
  if (!wc.isLoading()) {
    await sleep(800);
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.removeListener("did-stop-loading", finish);
      wc.removeListener("destroyed", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    wc.once("did-stop-loading", finish);
    wc.once("destroyed", finish);
  });
  // SPAs hydrate after load; give their initial XHRs a moment.
  await sleep(1_500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
