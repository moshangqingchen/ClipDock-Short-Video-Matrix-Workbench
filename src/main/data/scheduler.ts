import type { WebContents } from "electron";
import { setTimeout as wait } from "node:timers/promises";
import type { Account, AppSettings, CollectRun } from "@shared/types";
import type { CollectJob } from "@shared/collect-jobs";
import { isLoginUrl, isVerificationUrl } from "@shared/platforms";
import type { ToastEvent } from "@shared/ipc";
import type { Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import { isHomepageContext } from "@main/browser/homepage-login";
import { profilePatch, type AccountService } from "@main/services/account-service";
import { persistableMediaReference, type MediaIntake } from "@main/services/media-intake";
import {
  beginBusinessOperation,
  withBusinessTaskSignal,
  canUseBusinessNetwork,
  isNetworkDormantError,
  NetworkDormantError,
  type BusinessOperation,
} from "@main/network/business-access";
import { LoggedOutError, RateLimitedError, type CollectorRegistry } from "./collectors";

export interface SchedulerOptions {
  store: Store;
  pool: ViewPool;
  collectors: CollectorRegistry;
  accounts: AccountService;
  notify: (toast: ToastEvent, system?: boolean) => void;
  onRun?: (run: CollectRun) => void;
  onMetrics?: (accountId: string) => void;
  mediaIntake?: MediaIntake;
  /** Local cache lookup only; one missing-image refresh per account and process. */
  needsMediaRefresh?: (accountId: string) => boolean;
}
type Trigger = CollectRun["trigger"];
interface ActiveRun {
  jobId: string;
  abort: AbortController;
}
const MAX_CONCURRENCY = 2;
const PAGE_READY_TIMEOUT_MS = 25_000;
const MIN_GAP_BETWEEN_RUNS_MS = 90_000;
const BACKOFF_BASE_MS = 10 * 60_000;
const BACKOFF_MAX_MS = 6 * 3600_000;
const eligible = (account: Account) => account.status === "online" || account.status === "expiring";
class JobCancelledError extends Error {}
class IdentityNotReadyError extends Error {}

/** Durable data-only queue. Network permits are never persisted with a task. */
export class CollectScheduler {
  private readonly running = new Map<string, ActiveRun>();
  private readonly suspended = new Set<string>();
  private readonly listeners = new Set<(job: CollectJob) => void>();
  private readonly lastReportedState = new Map<string, CollectJob["state"]>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly backoffLevel = new Map<string, number>();
  private readonly lastRunAt = new Map<string, number>();
  private readonly loginRetries = new Map<string, number>();
  private readonly mediaRefreshAttempted = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;
  private settings: AppSettings;
  private stopped = true;

  constructor(private readonly options: SchedulerOptions) {
    this.settings = options.store.settings.get();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.store.collectJobs.recoverInterrupted();
    for (const account of this.options.accounts.list()) this.resumeNetworkAccount(account.id);
    this.tickTimer = setInterval(() => this.tick(), 60_000);
    this.tickTimer.unref?.();
    this.initialTimer = setTimeout(() => this.tick(true), 45_000);
    this.initialTimer.unref?.();
  }
  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.tickTimer = undefined;
    this.initialTimer = undefined;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const [accountId] of this.running) this.suspendNetworkAccount(accountId);
  }
  applySettings(next: AppSettings): void {
    this.settings = next;
  }
  onJobChange(listener: (job: CollectJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(job: CollectJob | null): void {
    if (!job) return;
    if (job.state === "waiting-network" && this.lastReportedState.get(job.id) !== job.state) {
      this.options.store.audit.append({
        action: "scheduler-skip",
        accountId: job.accountId,
        details: { taskId: job.id, trigger: job.trigger, reason: "waiting-network" },
      });
    }
    if (job.state === "done" || job.state === "failed" || job.state === "cancelled")
      this.lastReportedState.delete(job.id);
    else this.lastReportedState.set(job.id, job.state);
    for (const listener of this.listeners) listener(job);
  }
  listJobs(accountId?: string): CollectJob[] {
    return this.options.store.collectJobs.list(accountId);
  }

  private prepareRequiredOperation(accountId: string, trigger: Trigger): boolean {
    try {
      this.options.accounts.prepareNetworkOperation(
        accountId,
        trigger === "keepalive" ? "keepalive" : "collect",
      );
      return true;
    } catch (error) {
      if (isNetworkDormantError(error)) return false;
      throw error;
    }
  }

  private shouldSkipHomepage(account: Account, trigger: Trigger): boolean {
    if (trigger === "manual") return false;
    const page = this.options.pool.getState(account.id);
    return Boolean(page?.visible && isHomepageContext(account.platformId, page.url));
  }

  /** Complete a local skip before a background job can expand the homepage's network scope. */
  private finishHomepageSkip(job: CollectJob): void {
    if (this.running.has(job.accountId)) return;
    const claimed = this.options.store.collectJobs.transition(job.id, ["queued", "waiting-network"], "running");
    if (!claimed) return;
    this.finish(claimed, new Date().toISOString(), "skipped", "正在浏览主页，已跳过后台采集，当前页面和账号资料已保留");
  }

  /** Accept immediately. Repeated buttons/ticks reuse the same active task ID. */
  enqueue(accountId: string, trigger: Trigger): CollectJob {
    const { store } = this.options;
    const account = store.accounts.get(accountId);
    if (!account) throw new Error("国内账号不存在");
    const workingUrl = this.options.collectors.get(account.platformId)?.workingUrl;
    const skipHomepage = !this.stopped && eligible(account) && this.shouldSkipHomepage(account, trigger);
    const prepared =
      skipHomepage ||
      !this.stopped &&
      !this.suspended.has(accountId) &&
      eligible(account) &&
      this.prepareRequiredOperation(accountId, trigger);
    const waiting =
      !skipHomepage && (!prepared || this.suspended.has(accountId) || !canUseBusinessNetwork(accountId, workingUrl));
    let job = store.collectJobs.enqueue(accountId, trigger, waiting);
    if (!eligible(account) && job.state !== "running") {
      job =
        store.collectJobs.transition(
          job.id,
          ["queued", "waiting-network"],
          "failed",
          "账号未登录或需要验证，请先确认登录状态",
        ) ?? job;
    } else if (!waiting && job.state === "waiting-network") {
      job = store.collectJobs.transition(job.id, ["waiting-network"], "queued") ?? job;
    }
    this.changed(job);
    queueMicrotask(() => this.pump());
    return job;
  }
  collectAll(trigger: Trigger): CollectJob[] {
    return this.options.accounts.list().map((a) => this.enqueue(a.id, trigger));
  }
  cancelJob(id: string): CollectJob | null {
    const job = this.options.store.collectJobs.cancel(id);
    if (job?.state === "cancelled") {
      const running = this.running.get(job.accountId);
      if (running?.jobId === job.id) running.abort.abort();
      this.clearRetry(job.accountId);
    }
    this.changed(job);
    return job;
  }
  /** Delete/reset/replace is terminal for old tasks, even in observation mode. */
  suspendForAccountChange(accountId: string): void {
    this.suspended.add(accountId);
    for (const job of this.options.store.collectJobs.list(accountId, true)) this.cancelJob(job.id);
    this.running.get(accountId)?.abort.abort();
    this.clearRetry(accountId);
    this.loginRetries.delete(accountId);
    this.lastRunAt.delete(accountId);
    this.backoffUntil.delete(accountId);
    this.backoffLevel.delete(accountId);
  }
  suspendNetworkAccount(accountId: string): void {
    this.suspended.add(accountId);
    this.clearRetry(accountId);
    for (const job of this.options.store.collectJobs.list(accountId, true)) {
      this.changed(
        this.options.store.collectJobs.transition(
          job.id,
          ["queued", "running"],
          "waiting-network",
          "等待国内网络",
        ),
      );
    }
    this.running.get(accountId)?.abort.abort();
  }
  /** Restores only data jobs for accounts whose authentication is still valid. */
  resumeNetworkAccount(accountId: string): void {
    if (this.stopped) return;
    const account = this.options.store.accounts.get(accountId);
    if (!account) return;
    let jobs = this.options.store.collectJobs
      .list(accountId, true)
      .filter((job) => job.state === "waiting-network" || job.state === "queued");
    // An allowed login probe is not a collection permit. With no eligible work,
    // clear suspension without checking a collector target or declaring its scope.
    if (!eligible(account) || jobs.length === 0) {
      this.suspended.delete(accountId);
      return;
    }
    jobs = jobs.filter((job) => {
      if (!this.shouldSkipHomepage(account, job.trigger)) return true;
      this.finishHomepageSkip(job);
      return false;
    });
    if (jobs.length === 0) {
      this.suspended.delete(accountId);
      return;
    }
    for (const job of jobs) {
      if (!this.prepareRequiredOperation(accountId, job.trigger)) return;
    }
    if (!canUseBusinessNetwork(accountId, this.options.collectors.get(account.platformId)?.workingUrl))
      return;
    this.suspended.delete(accountId);
    for (const job of jobs) {
      if (!this.running.has(accountId))
        this.changed(this.options.store.collectJobs.transition(job.id, ["waiting-network"], "queued"));
    }
    queueMicrotask(() => this.pump());
  }
  private tick(initial = false): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const account of this.options.accounts.list()) {
      if (!eligible(account)) continue;
      // Older versions deliberately discarded remote image URLs. Read fresh
      // sources once using the account's collector, without disturbing its
      // foreground homepage or repeatedly retrying an unavailable image.
      if (!this.mediaRefreshAttempted.has(account.id) &&
          !this.shouldSkipHomepage(account, "scheduled") &&
          this.options.needsMediaRefresh?.(account.id)) {
        this.enqueue(account.id, "scheduled");
        continue;
      }
      const last = this.options.store.metrics.lastAttemptedRun(account.id);
      const lastAt = last ? Date.parse(last.finishedAt ?? last.startedAt) : 0;
      if (this.settings.collectEnabled) {
        const interval = this.settings.collectIntervalHours * 3600_000;
        if (!last || now - lastAt >= interval + hashJitter(account.id, interval * 0.15)) {
          this.enqueue(account.id, !last && initial ? "login" : "scheduled");
          continue;
        }
      }
      if (this.settings.keepaliveEnabled) {
        const attemptedAt = this.options.store.metrics.lastKeepaliveRun(account.id)?.startedAt ?? account.createdAt;
        const since = attemptedAt ? now - Date.parse(attemptedAt) : Infinity;
        if (since >= this.settings.keepaliveIntervalHours * 3600_000) this.enqueue(account.id, "keepalive");
      }
    }
    this.pump();
  }
  private pump(): void {
    if (this.stopped) return;
    const { store } = this.options;
    for (const job of store.collectJobs.list(undefined, true)) {
      if (this.running.size >= MAX_CONCURRENCY) return;
      if (job.state !== "queued" || this.running.has(job.accountId)) continue;
      const account = store.accounts.get(job.accountId);
      if (!account || !eligible(account)) {
        this.changed(
          store.collectJobs.transition(
            job.id,
            ["queued"],
            "failed",
            "账号未登录或需要验证，请先确认登录状态",
          ),
        );
        continue;
      }
      if (this.shouldSkipHomepage(account, job.trigger)) {
        this.finishHomepageSkip(job);
        continue;
      }
      const workingUrl = this.options.collectors.get(account.platformId)?.workingUrl;
      const prepared = this.prepareRequiredOperation(account.id, job.trigger);
      if (!prepared || this.suspended.has(account.id) || !canUseBusinessNetwork(account.id, workingUrl)) {
        this.changed(store.collectJobs.transition(job.id, ["queued"], "waiting-network", "等待国内网络"));
        continue;
      }
      const claimed = store.collectJobs.transition(job.id, ["queued"], "running");
      if (!claimed) continue;
      const active = { jobId: job.id, abort: new AbortController() };
      this.running.set(account.id, active);
      this.changed(claimed);
      void this.execute(claimed, active).finally(() => {
        if (this.running.get(account.id) === active) this.running.delete(account.id);
        if (!this.stopped && !this.suspended.has(account.id)) this.resumeNetworkAccount(account.id);
        this.pump();
      });
    }
  }
  private assertCurrent(job: CollectJob, active: ActiveRun, lease: BusinessOperation): void {
    if (this.stopped) throw new NetworkDormantError("GATE_REVOKED");
    const current = this.options.store.collectJobs.get(job.id);
    if (!current || current.state === "cancelled") throw new JobCancelledError();
    if (this.suspended.has(job.accountId) || current.state !== "running")
      throw new NetworkDormantError("GATE_REVOKED");
    lease.assertCurrent();
    if (active.abort.signal.aborted) throw new JobCancelledError();
    const account = this.options.store.accounts.get(job.accountId);
    if (!account || !eligible(account)) throw new JobCancelledError("账号登录状态已改变");
  }
  private async execute(job: CollectJob, active: ActiveRun): Promise<void> {
    const { store, collectors, accounts, notify } = this.options;
    const account = store.accounts.get(job.accountId);
    if (!account) return;
    let lease: BusinessOperation | undefined;
    let collectionIsCurrent: (() => boolean) | undefined;
    const startedAt = new Date().toISOString();
    try {
      const collector = collectors.get(account.platformId);
      lease = beginBusinessOperation(account.id, collector?.workingUrl);
      const check = () => this.assertCurrent(job, active, lease!);
      const signal = AbortSignal.any([lease.signal, active.abort.signal]);
      check();
      const immediate = job.trigger === "manual" || job.trigger === "login";
      if (!collector) {
        this.finish(job, startedAt, "skipped", "该平台暂不支持采集");
        return;
      }
      if ((this.backoffUntil.get(account.id) ?? 0) > Date.now() && job.trigger !== "manual") {
        this.finish(job, startedAt, "skipped", "平台限流退避中");
        return;
      }
      if (!immediate && Date.now() - (this.lastRunAt.get(account.id) ?? 0) < MIN_GAP_BETWEEN_RUNS_MS) {
        this.finish(job, startedAt, "skipped", "距上次采集过近");
        return;
      }
      if (job.trigger === "keepalive") {
        const checked = await withBusinessTaskSignal(signal, () => accounts.checkStatus(account.id,
          account.platformId === "weixin_channels" ? { force: true, refreshPage: true } : undefined));
        lease.assertCurrent();
        if (this.stopped || active.abort.signal.aborted || store.collectJobs.get(job.id)?.state !== "running")
          return;
        this.lastRunAt.set(account.id, Date.now());
        this.finish(
          job,
          startedAt,
          checked.checkInfo?.state === "confirmed" ? "success" : "skipped",
          checked.checkInfo?.reason ?? "轻量身份检查完成",
        );
        return;
      }
      const wc = await withBusinessTaskSignal(signal, () =>
        this.prepareView(account, collector.workingUrl, false, signal, check),
      );
      check();
      if (!wc) {
        this.finish(job, startedAt, "skipped", "请打开账号管理页后采集，当前页面和账号资料已保留");
        if (job.trigger === "login") this.retryAfterLogin(account.id);
        return;
      }
      // Reusing an old console does not produce a fresh auth_data response.
      // Refresh that same console when needed, instead of fabricating a POST
      // or treating an expired 30-second identity observation as a logout.
      if (account.platformId === "weixin_channels" || account.platformId === "kuaishou") {
        const fresh = () => {
          const evidence = this.options.pool.getIdentityEvidence(account.id);
          return evidence?.kind === "online" && evidence.profile ? evidence : null;
        };
        if (!fresh()) {
          await this.options.pool.navigate(account.id, wc.getURL());
          await waitForIdle(wc, PAGE_READY_TIMEOUT_MS, signal);
          const deadline = Date.now() + 5000;
          while (!fresh() && Date.now() < deadline) {
            check();
            await wait(100, undefined, { signal });
          }
          check();
          if (!fresh()) throw new IdentityNotReadyError();
        }
      }
      const page = this.options.pool.getState(account.id);
      const pageUrl = wc.getURL();
      const identitySubject = () => this.options.pool.getIdentitySubject
        ? this.options.pool.getIdentitySubject(account.id)
        : this.options.pool.getIdentityEvidence?.(account.id)?.subject ?? this.options.pool.getIdentityEvidence?.(account.id)?.key;
      const startingSubject = identitySubject();
      collectionIsCurrent = () => {
        const current = this.options.pool.getState(account.id);
        return (
          !wc.isDestroyed() &&
          !wc.isLoading() &&
          wc.getURL() === pageUrl &&
          current?.instanceId === page?.instanceId &&
          current?.navigationId === page?.navigationId &&
          identitySubject() === startingSubject
        );
      };
      this.mediaRefreshAttempted.add(account.id);
      const result = await withBusinessTaskSignal(signal, () =>
        collector.collect({
          webContents: wc,
          account,
          identityProfile: this.options.pool.getIdentityEvidence?.(account.id)?.profile,
        }),
      );
      check();
      if (!collectionIsCurrent()) {
        this.finish(job, startedAt, "skipped", "采集期间页面或登录身份已变化，已保留原账号资料");
        return;
      }
      if (result.loggedOut) {
        await withBusinessTaskSignal(signal, () => accounts.checkStatus(account.id));
        lease.assertCurrent();
        if (this.stopped || store.collectJobs.get(job.id)?.state !== "running" || active.abort.signal.aborted)
          return;
        this.finish(job, startedAt, "skipped", "平台提示未登录");
        return;
      }
      const run = store.db.transaction(() => {
        check();
        const metricsWritten = store.metrics.saveSnapshots(result.metrics);
        const worksWritten = store.metrics.upsertWorks(
          result.works.map((work) => ({ ...work, coverUrl: persistableMediaReference(work.coverUrl) })),
        );
        if (result.profile) {
          const patch = profilePatch(store.accounts.get(account.id)!, result.profile);
          if (Object.keys(patch).length) accounts.update(account.id, patch);
        }
        check();
        const status = metricsWritten === 0 ? "failed" : result.warnings.length ? "partial" : "success";
        return this.finish(
          job,
          startedAt,
          status,
          result.warnings.join(";") || null,
          metricsWritten,
          worksWritten,
          false,
        );
      });
      // Submit optional previews only after the collection transaction commits and its lease is current.
      lease.assertCurrent();
      if (result.profile?.avatarUrl) this.options.mediaIntake?.avatar(account.id, result.profile.avatarUrl);
      this.options.mediaIntake?.covers(account.id, result.works);
      this.lastRunAt.set(account.id, Date.now());
      this.loginRetries.delete(account.id);
      this.backoffLevel.delete(account.id);
      this.backoffUntil.delete(account.id);
      this.options.onRun?.(run);
      this.changed(store.collectJobs.get(job.id));
      if (run.metricsWritten > 0) this.options.onMetrics?.(account.id);
      if ((store.collectJobs.get(job.id)?.trigger ?? job.trigger) === "manual")
        notify({
          kind: run.status === "failed" ? "warning" : "success",
          title:
            run.status === "failed"
              ? account.displayName + " 采集未获取到数据"
              : account.displayName + " 数据已更新",
          accountId: account.id,
        });
    } catch (error) {
      if (this.stopped) return;
      const current = store.collectJobs.get(job.id);
      if (!current || current.state === "cancelled" || current.state === "done" || current.state === "failed")
        return;
      if (
        isNetworkDormantError(error) ||
        this.suspended.has(account.id) ||
        (lease && !lease.isCurrent()) ||
        !canUseBusinessNetwork(account.id)
      ) {
        this.changed(
          store.collectJobs.transition(job.id, ["running", "queued"], "waiting-network", "等待国内网络"),
        );
        return;
      }
      if (error instanceof JobCancelledError || active.abort.signal.aborted) {
        this.changed(
          store.collectJobs.transition(job.id, ["running"], "cancelled", "任务已取消或登录状态已改变"),
        );
        return;
      }
      if (collectionIsCurrent && !collectionIsCurrent()) {
        this.finish(job, startedAt, "skipped", "采集期间页面或登录身份已变化，已保留原账号资料");
        return;
      }
      let message = "采集未完成，请稍后重试";
      if (error instanceof IdentityNotReadyError) message = "账号概览尚未就绪，请完成管理页登录或验证后重试";
      else if (error && typeof error === "object" && "errcode" in error && error.errcode === 11)
        message = "本地采集数据库损坏，数据无法保存，需要修复数据库";
      if (error instanceof RateLimitedError) {
        const level = (this.backoffLevel.get(account.id) ?? 0) + 1;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (level - 1));
        this.backoffLevel.set(account.id, level);
        this.backoffUntil.set(account.id, Date.now() + delay);
        message = "平台限流，" + Math.round(delay / 60_000) + " 分钟后重试";
        notify({
          kind: "warning",
          title: account.displayName + " 触发平台限流",
          message,
          accountId: account.id,
        });
      } else if (error instanceof LoggedOutError) {
        message = "平台提示未登录";
        try {
          if (lease) this.assertCurrent(job, active, lease);
          const probeSignal = lease
            ? AbortSignal.any([lease.signal, active.abort.signal])
            : active.abort.signal;
          await withBusinessTaskSignal(probeSignal, () => accounts.checkStatus(account.id));
          lease?.assertCurrent();
          if (
            this.stopped ||
            store.collectJobs.get(job.id)?.state !== "running" ||
            active.abort.signal.aborted
          )
            return;
        } catch (probeError) {
          if (this.stopped) return;
          if (isNetworkDormantError(probeError) || (lease && !lease.isCurrent())) {
            this.changed(
              store.collectJobs.transition(job.id, ["running"], "waiting-network", "等待国内网络"),
            );
            return;
          }
          if (store.collectJobs.get(job.id)?.state !== "running" || active.abort.signal.aborted) return;
        }
      }
      this.finish(job, startedAt, "failed", message);
    } finally {
      lease?.release();
    }
  }
  private finish(
    job: CollectJob,
    startedAt: string,
    status: CollectRun["status"],
    message: string | null,
    metricsWritten = 0,
    worksWritten = 0,
    emit = true,
  ): CollectRun {
    const { store } = this.options;
    const completed = store.db.transaction(() => {
      const account = store.accounts.get(job.accountId)!;
      const current = store.collectJobs.get(job.id);
      if (current?.state !== "running") throw new JobCancelledError();
      const id = store.metrics.startRun({
        accountId: account.id,
        platformId: account.platformId,
        startedAt,
        status,
        trigger: current.trigger,
        message,
      });
      const run = store.metrics.finishRun(id, { status, message, metricsWritten, worksWritten });
      const next = store.collectJobs.transition(
        job.id,
        ["running"],
        status === "failed" ? "failed" : "done",
        message,
        id,
      );
      if (!next) throw new JobCancelledError();
      return { run, job: next };
    });
    if (emit) {
      this.options.onRun?.(completed.run);
      this.changed(completed.job);
    }
    return completed.run;
  }
  private clearRetry(accountId: string): void {
    const timer = this.retryTimers.get(accountId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(accountId);
  }
  private retryAfterLogin(accountId: string): void {
    const attempts = this.loginRetries.get(accountId) ?? 0;
    if (attempts >= 3) {
      this.loginRetries.delete(accountId);
      return;
    }
    this.clearRetry(accountId);
    this.loginRetries.set(accountId, attempts + 1);
    const timer = setTimeout(
      () => {
        this.retryTimers.delete(accountId);
        if (this.stopped) return;
        const account = this.options.store.accounts.get(accountId);
        if (
          !this.suspended.has(accountId) &&
          account &&
          eligible(account) &&
          canUseBusinessNetwork(accountId)
        )
          this.enqueue(accountId, "login");
      },
      15_000 * (attempts + 1),
    );
    timer.unref?.();
    this.retryTimers.set(accountId, timer);
  }
  private async prepareView(
    account: Account,
    workingUrl: string,
    forceNavigate: boolean,
    signal: AbortSignal,
    check: () => void,
  ): Promise<WebContents | null> {
    check();
    const { pool } = this.options;
    const entry = pool.ensure({ id: account.id, platformId: account.platformId }, { navigate: false });
    check();
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return null;
    const current = wc.getURL();
    // Public feeds and creator consoles can share a platform while using different
    // login contexts. Never run creator API/DOM collectors against a public feed.
    const onConsole = isWorkingOrigin(current, workingUrl);
    if (isLoginUrl(account.platformId, current) || isVerificationUrl(account.platformId, current))
      return null;
    const needsNavigation = forceNavigate || !onConsole;
    if (needsNavigation) {
      if (entry.visible) return null;
      check();
      try {
        await pool.navigate(account.id, workingUrl);
      } catch (error) {
        check();
        if (isNetworkDormantError(error)) throw error;
        return null;
      }
      check();
    }
    await waitForIdle(wc, PAGE_READY_TIMEOUT_MS, signal);
    check();
    const finalUrl = wc.isDestroyed() ? "" : wc.getURL();
    if (wc.isDestroyed() || wc.isLoading() || !isWorkingOrigin(finalUrl, workingUrl)) return null;
    if (isLoginUrl(account.platformId, finalUrl) || isVerificationUrl(account.platformId, finalUrl))
      return null;
    return wc;
  }
}

function isWorkingOrigin(url: string, workingUrl: string): boolean {
  try {
    const page = new URL(url);
    return (
      page.protocol === "https:" &&
      !page.username &&
      !page.password &&
      page.origin === new URL(workingUrl).origin
    );
  } catch {
    return false;
  }
}
function hashJitter(seed: string, max: number): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ((h % 1000) / 1000) * max;
}
async function waitForIdle(wc: WebContents, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new JobCancelledError();
  if (wc.isDestroyed()) return;
  if (wc.isLoading())
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        wc.removeListener("did-stop-loading", finish);
        wc.removeListener("destroyed", finish);
        signal.removeEventListener("abort", abort);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(new JobCancelledError());
      };
      const timer = setTimeout(finish, timeoutMs);
      wc.once("did-stop-loading", finish);
      wc.once("destroyed", finish);
      signal.addEventListener("abort", abort, { once: true });
    });
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new JobCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 800);
    const abort = () => {
      clearTimeout(timer);
      reject(new JobCancelledError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
