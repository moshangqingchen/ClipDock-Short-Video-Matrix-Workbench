import type { WebContents } from "electron";
import type { Account, AppSettings, CollectRun } from "@shared/types";
import { initialProgress, type CollectionProgress, type CollectJob } from "@shared/collect-jobs";
import { createHash } from "node:crypto";
import { isLoginUrl, isVerificationUrl, getPlatform } from "@shared/platforms";
import type { BusinessAnalyticsService } from "./business-analytics-service";
import { analyticsPageAllowed } from "./business-analytics-page";
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
  analytics?: BusinessAnalyticsService;
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
const KEEPALIVE_RETRY_BASE_MS = 30 * 60_000;
const KEEPALIVE_RETRY_MAX_MS = 6 * 3600_000;
const BACKOFF_BASE_MS = 10 * 60_000;
const BACKOFF_MAX_MS = 6 * 3600_000;
const eligible = (account: Account) => account.status === "online" || account.status === "expiring";
class JobCancelledError extends Error {}
class IdentityNotReadyError extends Error {}
class CollectionContextChangedError extends Error {}
function wait(milliseconds: number, _value?: undefined, options?: { signal?: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

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
    return Boolean(page?.visible && (isHomepageContext(account.platformId, page.url) || /(?:upload|publish|(?:^|[/_-])edit(?:or)?(?:[/?#_-]|$)|\/post\/create)/i.test(page.url)));
  }

  /** Complete a local skip before a background job can expand the homepage's network scope. */
  private finishHomepageSkip(job: CollectJob): void {
    if (this.running.has(job.accountId)) return;
    const claimed = this.options.store.collectJobs.transition(job.id, ["queued", "waiting-network"], "running");
    if (!claimed) return;
    this.finish(claimed, new Date().toISOString(), "skipped", "正在浏览主页，已跳过后台采集，当前页面和账号资料已保留");
  }

  /** Accept immediately. Repeated buttons/ticks reuse the same active task ID. */
  enqueue(accountId: string, trigger: Trigger, scope: CollectionProgress["scope"] = "recent"): CollectJob {
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
    let job = store.collectJobs.enqueue(accountId, trigger, waiting, scope);
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
  pauseJob(id: string, paused: boolean): CollectJob | null {
    const job = this.options.store.collectJobs.pause(id, paused);
    if (paused && job) this.running.get(job.accountId)?.abort.abort();
    this.changed(job);
    if (!paused) queueMicrotask(() => this.pump());
    return job;
  }
  retryJob(id: string): CollectJob | null {
    const job = this.options.store.collectJobs.get(id);
    if (!job || job.state !== "failed") return job;
    const active = this.options.store.collectJobs.list(job.accountId, true, 1)[0];
    if (active) return active;
    const account = this.options.store.accounts.get(job.accountId);
    if (!account || !eligible(account)) throw new Error("请先完成账号登录");
    this.options.store.collectJobs.recheckCursor(id);
    const next = this.options.store.collectJobs.transition(id, ["failed"], "queued", "从已保存进度重试");
    this.changed(next);
    queueMicrotask(() => this.pump());
    return next;
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
        if (last && this.options.analytics?.enabled(account.platformId) && this.options.analytics.due(account.id)) {
          this.enqueue(account.id, "scheduled", "analytics");
          continue;
        }
        const historyAt = this.options.store.collectJobs.lastHistoryAt(account.id);
        const historyAttempt = this.options.store.collectJobs.lastHistoryAttemptAt(account.id) ?? historyAt;
        if (historyAt && historyAttempt && now - Date.parse(historyAttempt) >= 7 * 86400_000) {
          this.enqueue(account.id, "scheduled", "history");
          continue;
        }
        const interval = this.settings.collectIntervalHours * 3600_000;
        if (!last || now - lastAt >= interval + hashJitter(account.id, interval * 0.15)) {
          this.enqueue(account.id, !last && initial ? "login" : "scheduled");
          continue;
        }
      }
      if (this.settings.keepaliveEnabled) {
        const history = this.options.store.metrics.recentKeepaliveRuns(account.id);
        const latest = history[0];
        const attemptedAt = latest?.finishedAt ?? latest?.startedAt ?? account.createdAt;
        const since = attemptedAt ? now - Date.parse(attemptedAt) : Infinity;
        const firstSuccess = history.findIndex((run) => run.status === "success");
        const unsuccessful = firstSuccess < 0 ? history.length : firstSuccess;
        // A deferred/unconfirmed check is not a successful keepalive. Retry slowly,
        // with a durable capped backoff instead of silently consuming the full interval.
        const interval = !latest || latest.status === "success"
          ? this.settings.keepaliveIntervalHours * 3600_000
          : Math.min(this.settings.keepaliveIntervalHours * 3600_000,
            KEEPALIVE_RETRY_MAX_MS, KEEPALIVE_RETRY_BASE_MS * 2 ** Math.max(0, unsuccessful - 1));
        if (since >= interval) this.enqueue(account.id, "keepalive");
      }
    }
    this.pump();
  }
  private pump(): void {
    if (this.stopped) return;
    const { store } = this.options;
    for (const job of store.collectJobs.list(undefined, true)) {
      if (this.running.size >= MAX_CONCURRENCY) return;
      if (job.state !== "queued" || job.paused || (job.notBefore ?? 0) > Date.now() || this.running.has(job.accountId)) continue;
      const account = store.accounts.get(job.accountId);
      if (account && [...this.running.keys()].some((id) => store.accounts.get(id)?.platformId === account.platformId)) continue;
      if (account && Number(store.db.get("SELECT not_before FROM collection_platform_backoff WHERE platform_id=?", [account.platformId])?.not_before ?? 0) > Date.now()) continue;
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
    if (!current || current.state === "cancelled" || current.paused) throw new JobCancelledError();
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
    let metricsWrittenTotal = 0;
    let worksWrittenTotal = 0;
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), 180_000);
    const startedAt = new Date().toISOString();
    try {
      const collector = collectors.get(account.platformId);
      lease = beginBusinessOperation(account.id, collector?.workingUrl);
      const check = () => this.assertCurrent(job, active, lease!);
      const signal = AbortSignal.any([lease.signal, active.abort.signal, deadline.signal]);
      check();
      const immediate = job.trigger === "manual" || job.trigger === "login";
      if (!collector) {
        this.finish(job, startedAt, "skipped", "该平台暂不支持采集");
        return;
      }
      if ((this.backoffUntil.get(account.id) ?? 0) > Date.now()) {
        this.changed(store.collectJobs.defer(job.id, this.backoffUntil.get(account.id)!, "平台限流退避中"));
        return;
      }
      if (!immediate && !(job.progress?.pagesDone) && Date.now() - (this.lastRunAt.get(account.id) ?? 0) < MIN_GAP_BETWEEN_RUNS_MS) {
        if (job.trigger === "keepalive") {
          this.changed(store.collectJobs.defer(job.id,
            this.lastRunAt.get(account.id)! + MIN_GAP_BETWEEN_RUNS_MS,
            "等待上次任务冷却后检查登录状态"));
        } else this.finish(job, startedAt, "skipped", "距上次采集过近");
        return;
      }
      if (job.trigger === "keepalive") {
        const checked = await withBusinessTaskSignal(signal, () => accounts.checkStatus(account.id,
          account.platformId === "weixin_channels" ? { force: true, refreshPage: true } : undefined));
        lease.assertCurrent();
        if (this.stopped || active.abort.signal.aborted || store.collectJobs.get(job.id)?.state !== "running")
          return;
        this.lastRunAt.set(account.id, Date.now());
        const fresh = Boolean(checked.checkInfo?.attemptedAt && Date.parse(checked.checkInfo.attemptedAt) >= Date.parse(startedAt));
        const outcome = fresh && checked.checkInfo?.state === "confirmed"
          ? eligible(checked) ? "success" : "failed"
          : fresh && checked.checkInfo?.state === "network_error" ? "failed" : "skipped";
        this.finish(
          job,
          startedAt,
          outcome,
          checked.checkInfo?.reason ?? "轻量身份检查完成",
        );
        return;
      }
      if (job.progress?.scope === "analytics") this.options.analytics?.attempt(account.id);
      const wc = await withBusinessTaskSignal(signal, () =>
        this.prepareView(account, job.progress?.scope === "analytics" ? getPlatform(account.platformId).routes.analytics : collector.workingUrl,
          job.progress?.scope === "analytics" ? !analyticsPageAllowed(account.platformId, this.options.pool.getState(account.id)?.url ?? "") :
            account.platformId === "weixin_channels" && Boolean(this.options.pool.getWorksRequest) && !this.options.pool.getWorksRequest?.(account.id), signal, check),
      );
      check();
      if (!wc) {
        if (job.progress?.scope === "analytics") this.options.analytics?.defer(account.id);
        this.finish(job, startedAt, "skipped", "请打开账号管理页后采集，当前页面和账号资料已保留");
        if (job.trigger === "login") this.retryAfterLogin(account.id);
        return;
      }
      if (job.progress?.scope === "analytics") {
        const written = await withBusinessTaskSignal(signal, () => this.options.analytics!.collect(account.id, wc, check));
        check();
        this.finish(job, startedAt, written ? "partial" : "skipped", "已读取官方页面当前统计区间；历史覆盖范围见经营分析", written);
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
      const warnings = new Set<string>();
      let progress = store.collectJobs.get(job.id)?.progress ?? initialProgress();
      let further = false;
      let incomplete = false;
      for (let batchPage = 0; batchPage < 5; batchPage++) {
        check();
        signal.throwIfAborted();
        const result = await withBusinessTaskSignal(signal, () => collector.collect({
          webContents: wc, account, progress,
          skipProfile: batchPage > 0 || progress.pagesDone > 0,
          identityProfile: this.options.pool.getIdentityEvidence?.(account.id)?.profile,
          observedWorksRequest: () => this.options.pool.getWorksRequest?.(account.id) ?? null,
        }));
        check();
        signal.throwIfAborted();
        if (!collectionIsCurrent()) throw new CollectionContextChangedError();
        if (result.loggedOut) throw new LoggedOutError();
        // A full-history request can join while this page is awaiting its response.
        if (store.collectJobs.get(job.id)?.progress?.scope === "history") {
          progress = { ...progress, scope: "history", cutoff: null };
        }
        for (const warning of result.warnings) warnings.add(warning);
        const fingerprint = createHash("sha256").update(result.works.map((work) => work.remoteId).sort().join("\n")).digest("hex");
        if (result.works.length && progress.fingerprints.includes(fingerprint)) {
          warnings.add("平台返回重复页，已停止翻页；进度保留，可重新核对");
          progress.reason = "平台返回重复页，重试将从第一页重新核对，已采作品保留";
          store.collectJobs.checkpoint(job.id, progress);
          further = false;
          incomplete = true;
          break;
        }
        const page = result.page;
        if (page?.receivedCount != null && page.receivedCount !== result.works.length) {
          page.hasMore = null;
          page.reason = "部分作品标识未能识别，已保存可识别作品，请重新核对平台字段";
        }
        const recentDone = progress.cutoff && result.works.length > 0 &&
          result.works.every((work) => work.publishedAt && work.publishedAt < progress.cutoff!);
        const complete = Boolean(page && (page.hasMore === false || recentDone));
        further = Boolean(page?.hasMore === true && !complete);
        incomplete = !page || page.hasMore === null;
        const next: CollectionProgress = {
          ...progress, page: page?.hasMore == null ? progress.page : page.nextPage,
          cursor: page?.hasMore == null ? progress.cursor : page.nextCursor,
          variant: page?.variant ?? progress.variant, pagesDone: progress.pagesDone + (page ? 1 : 0),
          worksSeen: progress.worksSeen + result.works.length, total: page?.total ?? progress.total,
          fingerprints: result.works.length && page?.hasMore != null ? [...progress.fingerprints, fingerprint] : progress.fingerprints,
          complete, reason: incomplete ? page?.reason ?? "作品分页信息未就绪" : undefined,
        };
        const written = store.db.transaction(() => {
          check();
          if (!collectionIsCurrent!()) throw new CollectionContextChangedError();
          const metrics = store.metrics.saveSnapshots(result.metrics);
          const works = store.metrics.upsertWorks(result.works.map((work) => ({ ...work, coverUrl: persistableMediaReference(work.coverUrl) })));
          let newlySeen = 0;
          for (const work of result.works) newlySeen += store.db.run("INSERT OR IGNORE INTO collection_seen(job_id,remote_id) VALUES(?,?)", [job.id, work.remoteId]).changes;
          next.worksSeen = progress.worksSeen + newlySeen;
          if (result.profile) {
            const patch = profilePatch(store.accounts.get(account.id)!, result.profile);
            if (Object.keys(patch).length) accounts.update(account.id, patch);
          }
          store.collectJobs.checkpoint(job.id, next);
          check();
          return { metrics, works };
        });
        metricsWrittenTotal += written.metrics;
        worksWrittenTotal += written.works;
        progress = next;
        this.changed(store.collectJobs.get(job.id));
        if (written.metrics || written.works) this.options.onMetrics?.(account.id);
        lease.assertCurrent();
        if (result.profile?.avatarUrl) this.options.mediaIntake?.avatar(account.id, result.profile.avatarUrl);
        this.options.mediaIntake?.covers(account.id, result.works);
        if (!further) break;
        if (batchPage < 4) await wait(2_000 + Math.floor(Math.random() * 3_001), undefined, { signal });
      }
      this.lastRunAt.set(account.id, Date.now());
      this.loginRetries.delete(account.id);
      this.backoffLevel.delete(account.id);
      this.backoffUntil.delete(account.id);
      const hasData = metricsWrittenTotal > 0 || worksWrittenTotal > 0;
      if (incomplete) warnings.add(progress.reason ?? "作品范围未确认，已保留本次取得的数据");
      const status = !hasData && !progress.complete ? "failed" : warnings.size || further ? "partial" : "success";
      this.finish(job, startedAt, status, [...warnings].join("；") || null,
        metricsWrittenTotal, worksWrittenTotal, true, further ? "continue" : incomplete && progress.scope === "history" ? "incomplete" : undefined);
      if (job.trigger === "manual" && !further) notify({
        kind: status === "success" ? "success" : "warning",
        title: account.displayName + (status === "success" ? " 数据已更新" : hasData ? " 部分数据已更新" : " 采集未获取到数据"),
        message: [...warnings].join("；") || undefined, accountId: account.id,
      });
    } catch (error) {
      if (this.stopped) return;
      const current = store.collectJobs.get(job.id);
      if (current?.paused) return;
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
      if (deadline.signal.aborted) message = "本批采集已超时，已保留完成页和进度";
      if (error instanceof IdentityNotReadyError) message = "账号概览尚未就绪，请完成管理页登录或验证后重试";
      else if (error && typeof error === "object" && "errcode" in error && error.errcode === 11)
        message = "本地采集数据库损坏，数据无法保存，需要修复数据库";
      if (error instanceof RateLimitedError) {
        const level = (this.backoffLevel.get(account.id) ?? 0) + 1;
        const delay = Math.max(error.retryAfterMs, Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (level - 1)));
        this.backoffLevel.set(account.id, level);
        this.backoffUntil.set(account.id, Date.now() + delay);
        message = "平台限流，" + Math.round(delay / 60_000) + " 分钟后重试";
        notify({
          kind: "warning",
          title: account.displayName + " 触发平台限流",
          message,
          accountId: account.id,
        });
        store.audit.append({ action: "collection.rate-limited", accountId: account.id, details: { stage: "request", retryAt: Date.now() + delay } });
        store.db.run("INSERT INTO collection_platform_backoff(platform_id,not_before) VALUES(?,?) ON CONFLICT(platform_id) DO UPDATE SET not_before=MAX(not_before,excluded.not_before)", [account.platformId, Date.now() + delay]);
        this.changed(store.collectJobs.defer(job.id, Date.now() + delay, message));
        return;
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
      store.audit.append({ action: "collection.failed", accountId: account.id, details: {
        stage: deadline.signal.aborted ? "deadline" : error instanceof IdentityNotReadyError ? "identity" : "collect-or-save",
        pagesDone: store.collectJobs.get(job.id)?.progress?.pagesDone ?? 0,
      } });
      this.finish(job, startedAt, metricsWrittenTotal || worksWrittenTotal ? "partial" : "failed", message,
        metricsWrittenTotal, worksWrittenTotal, true, "incomplete");
    } finally {
      clearTimeout(deadlineTimer);
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
    continuation?: "continue" | "incomplete",
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
      const next = continuation === "continue" ? store.collectJobs.defer(job.id, Date.now() + 3_000, "本批已保存，等待下一批") : store.collectJobs.transition(
        job.id,
        ["running"],
        status === "failed" || continuation === "incomplete" ? "failed" : "done",
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
