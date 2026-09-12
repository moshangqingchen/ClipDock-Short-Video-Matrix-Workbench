import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { Store } from "@main/db";
import type { GlobalAccountRepository } from "@main/api/global-account-repository";
import { GlobalWorkspaceRepository } from "@main/data/global-workspace-repository";
import { GlobalWebObservationRepository } from "@main/data/global-web-observation-repository";
import { parseWebObservation } from "@main/data/global-web-observation";
import { GLOBAL_PLATFORM_DEFINITIONS, globalWebRoute } from "@shared/global-platforms";
import {
  webIdentitySchema,
  globalWorkSchema,
  type GlobalPublishInput,
  type WebCollectJob,
  type WebIdentity,
} from "@shared/global-workspace";
import type { GlobalWebService } from "./global-web-service";

const terminal = (job: WebCollectJob) => ["done", "failed", "cancelled"].includes(job.state);
export class GlobalWorkspaceService {
  readonly repository: GlobalWorkspaceRepository;
  private readonly observations: GlobalWebObservationRepository;
  private readonly running = new Set<string>();
  private readonly checking = new Set<string>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly retryAfter = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private epoch = 0;
  private ticking = false;
  constructor(
    private readonly options: {
      store: Store;
      accounts: GlobalAccountRepository;
      web: GlobalWebService;
      openExternal(url: string): Promise<void>;
      changed(id: string): void;
    },
  ) {
    this.repository = new GlobalWorkspaceRepository(options.store.db);
    this.observations = new GlobalWebObservationRepository(options.store.db);
  }
  private account(id: string) {
    const value = this.options.accounts.get(id);
    if (!value) throw new Error("国外账号不存在");
    return value;
  }
  identity(id: string) {
    this.account(id);
    return this.repository.identity(id);
  }
  cancelAccount(id: string): void {
    for (const job of this.repository.jobs(id)) if (!terminal(job)) this.cancelJob(job.id);
  }
  async useBrowser(id: string, engine: "chrome" | "embedded"): Promise<void> {
    this.account(id);
    for (const job of this.repository.jobs(id)) if (!terminal(job)) this.cancelJob(job.id);
    await this.options.web.close(id);
    this.options.accounts.setBrowserEngine(id, engine);
    this.options.changed(id);
    await this.options.web.ensureOpen(id);
  }
  works(id: string) {
    this.account(id);
    return this.repository.works(id);
  }
  jobs(id?: string) {
    if (id) this.account(id);
    return this.repository.jobs(id);
  }
  async checkLogin(id: string): Promise<WebIdentity> {
    this.account(id);
    const epoch = this.epoch;
    const state = await this.options.web.ensureOpen(id);
    if (state.phase !== "open") throw new Error("请先开启国外平台网络");
    const identity = await this.options.web.withBrowser(id, async (browser) => {
      if (!browser.readIdentity) throw new Error("请使用支持登录检测的浏览器");
      let value = webIdentitySchema.parse(await browser.readIdentity());
      if (value.status === "unknown" && browser.readBackground)
        value = webIdentitySchema.parse(
          (await browser.readBackground(GLOBAL_PLATFORM_DEFINITIONS[this.account(id).platformId].entry))
            .identity,
        );
      return value;
    });
    const previous = this.repository.identity(id);
    if (epoch !== this.epoch) throw new Error("WEB_OBSERVE_CANCELLED");
    this.account(id);
    this.repository.saveIdentity(id, identity);
    this.options.changed(id);
    if (
      identity.status === "online" &&
      (previous?.status !== "online" || previous.subjectId !== identity.subjectId) &&
      this.options.store.settings.get().collectEnabled
    )
      this.collect(id, "login");
    return identity;
  }
  async resetEnvironment(id: string): Promise<void> {
    this.account(id);
    for (const job of this.repository.jobs(id)) if (!terminal(job)) this.cancelJob(job.id);
    await this.options.web.resetEnvironment(id);
    const previous = this.repository.identity(id);
    this.repository.saveIdentity(id, {
      status: "unknown",
      subjectId: previous?.subjectId ?? null,
      displayName: previous?.displayName ?? null,
      checkedAt: new Date().toISOString(),
    });
    this.options.changed(id);
  }
  async openLoginWindow(id: string): Promise<void> {
    await this.options.web.ensureOpen(id);
    await this.options.web.withBrowser(id, async (browser) => {
      if (!browser.openLoginWindow) throw new Error("请先切换到 Chrome");
      await browser.openLoginWindow();
    });
  }
  async openDevTools(id: string): Promise<void> {
    await this.options.web.withBrowser(id, async (browser) => {
      if (!browser.openDevTools) throw new Error("请先打开支持调试的账号页面");
      await browser.openDevTools();
    });
  }
  async openSystemBrowser(id: string): Promise<void> {
    const account = this.account(id);
    if (this.options.web.state(id).phase !== "open") {
      const state = await this.options.web.ensureOpen(id);
      if (state.phase !== "open") throw new Error("请先开启国外平台网络");
    }
    await this.options.openExternal(GLOBAL_PLATFORM_DEFINITIONS[account.platformId].routes.home!);
  }
  publishList(id?: string) {
    if (id) this.account(id);
    return this.repository.publishList(id);
  }
  publishSave(input: GlobalPublishInput) {
    const account = this.account(input.accountId);
    for (const id of input.assetIds)
      if (!this.options.store.assets.get(id)) throw new Error("所选素材不存在");
    const record = this.repository.publishSave(input, account.platformId);
    this.options.changed(account.id);
    return record;
  }
  publishDelete(id: string): void {
    this.repository.publishDelete(id);
  }
  async openUpload(id: string): Promise<void> {
    this.account(id);
    const state = await this.options.web.ensureOpen(id);
    if (state.phase !== "open") throw new Error("请先开启国外平台网络");
    await this.options.web.go(id, "upload");
  }
  async attachFiles(id: string, assetIds: string[]): Promise<{ attached: number; message?: string }> {
    this.account(id);
    const files: string[] = [];
    for (const assetId of assetIds) {
      const asset = this.options.store.assets.get(assetId);
      if (!asset || !(await fs.stat(asset.filePath).catch(() => null))?.isFile())
        throw new Error("素材文件不存在，请重新选择");
      files.push(asset.filePath);
    }
    if (!files.length) return { attached: 0, message: "请先选择素材" };
    return this.options.web.withBrowser(id, async (browser, check) => {
      if (!browser.attachFiles) return { attached: 0, message: "请使用支持文件填入的浏览器" };
      check();
      const attached = await browser.attachFiles(files);
      return { attached, ...(attached ? {} : { message: "当前页面没有文件控件，请先打开官方上传页" }) };
    });
  }
  async openWork(id: string, remoteId: string): Promise<void> {
    const work = this.works(id).find((work) => work.remoteId === remoteId);
    if (!work) throw new Error("作品不存在，请重新采集");
    await this.options.web.ensureOpen(id);
    await this.options.web.withBrowser(id, async (browser) => {
      if (!browser.navigateOfficial) throw new Error("页面导航暂不可用");
      await browser.navigateOfficial(work.url);
    });
  }
  collect(id: string, trigger: WebCollectJob["trigger"] = "manual"): WebCollectJob {
    this.account(id);
    if (trigger === "manual") this.failures.delete(id);
    const existing = this.repository.jobs(id).find((job) => !terminal(job));
    if (existing) return existing;
    const now = new Date().toISOString();
    const job: WebCollectJob = {
      id: randomUUID(),
      accountId: id,
      state: "queued",
      trigger,
      message: null,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    this.repository.saveJob(job);
    this.options.changed(id);
    void this.tick();
    return job;
  }
  cancelJob(id: string): void {
    const job = this.repository.job(id);
    if (job && !terminal(job)) {
      this.update(job, "cancelled", "已取消");
      this.retryAfter.delete(id);
    }
  }
  private update(job: WebCollectJob, state: WebCollectJob["state"], message: string | null = null) {
    job.state = state;
    job.message = message;
    job.updatedAt = new Date().toISOString();
    this.repository.saveJob(job);
    this.options.changed(job.accountId);
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const job of this.repository.jobs())
      if (job.state === "running") this.update(job, "queued", "正在恢复采集任务");
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref?.();
    void this.tick();
  }
  stop(): void {
    this.epoch++;
    this.stopped = true;
    clearInterval(this.timer);
  }
  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const settings = this.options.store.settings.get();
      for (const account of this.options.accounts.list()) {
        const identity = this.repository.identity(account.id);
        if (
          this.options.web.state(account.id).phase === "open" &&
          !this.checking.has(account.id) &&
          (!identity || Date.now() - Date.parse(identity.checkedAt) > 60000)
        ) {
          this.checking.add(account.id);
          void this.checkLogin(account.id)
            .catch(() => undefined)
            .finally(() => this.checking.delete(account.id));
        }
        const snapshot = this.observations.get(account.id);
        if (
          settings.collectEnabled &&
          (this.failures.get(account.id)?.until ?? 0) <= Date.now() &&
          identity?.status === "online" &&
          (!snapshot ||
            Date.now() - Date.parse(snapshot.capturedAt) >= settings.collectIntervalHours * 3600000)
        ) {
          const recent = this.repository.jobs(account.id)[0];
          if (!recent || Date.now() - Date.parse(recent.updatedAt) >= 90000)
            this.collect(account.id, "scheduled");
        }
      }
      for (const job of this.repository.jobs().reverse()) {
        if (this.running.size >= 2) break;
        if (
          terminal(job) ||
          this.running.has(job.accountId) ||
          (this.retryAfter.get(job.id) ?? 0) > Date.now()
        )
          continue;
        if (job.trigger !== "manual" && !settings.collectEnabled) continue;
        this.running.add(job.accountId);
        void this.run(job).finally(() => this.running.delete(job.accountId));
      }
    } finally {
      this.ticking = false;
    }
  }
  private async run(job: WebCollectJob): Promise<void> {
    const epoch = this.epoch;
    const checkJob = () => {
      if (
        epoch !== this.epoch ||
        this.stopped ||
        !this.repository.job(job.id) ||
        this.repository.job(job.id)?.state === "cancelled" ||
        !this.options.accounts.get(job.accountId)
      )
        throw new Error("WEB_OBSERVE_CANCELLED");
    };
    try {
      checkJob();
      const state = await this.options.web.ensureOpen(job.accountId);
      checkJob();
      if (state.phase !== "open") {
        this.update(job, "waiting-network", "等待国外平台网络可用");
        this.retryAfter.set(job.id, Date.now() + 30000);
        return;
      }
      job.attempts++;
      this.update(job, "running");
      await this.options.web.withBrowser(job.accountId, async (browser, assertCurrent) => {
        const check = () => {
          assertCurrent();
          checkJob();
        };
        if (!browser.readBackground) throw new Error("WEB_OBSERVE_UNAVAILABLE");
        const account = this.account(job.accountId);
        let identity = webIdentitySchema.parse(await browser.readIdentity?.());
        check();
        if (identity.status === "unknown") {
          identity = webIdentitySchema.parse(
            (await browser.readBackground(GLOBAL_PLATFORM_DEFINITIONS[account.platformId].entry)).identity,
          );
          check();
        }
        this.repository.saveIdentity(account.id, identity);
        if (identity.status !== "online" || !identity.subjectId) {
          this.update(
            job,
            "waiting-login",
            identity.status === "needs_verification" ? "请在官网完成验证" : "请在官网完成登录",
          );
          this.retryAfter.set(job.id, Date.now() + 60000);
          return;
        }
        const currentUrl = browser.getPageState?.().url ?? "";
        const url =
          globalWebRoute(account.platformId, "analytics", currentUrl) ??
          GLOBAL_PLATFORM_DEFINITIONS[account.platformId].entry;
        const raw = await browser.readBackground(url);
        check();
        if (raw.identity.status !== "online" || raw.identity.subjectId !== identity.subjectId)
          throw new Error("WEB_OBSERVE_CANCELLED");
        const snapshot = {
          ...parseWebObservation(account.id, account.platformId, browser.engine ?? "embedded", raw),
          subjectId: identity.subjectId,
        };
        check();
        if (snapshot.metrics.length) this.observations.save(snapshot);
        const worksUrl =
          globalWebRoute(account.platformId, "works", raw.url) ??
          (account.platformId === "x" ? `https://x.com/${identity.subjectId}` : null);
        let worksAvailable = false;
        if (worksUrl) {
          try {
            const page = await browser.readBackground(worksUrl);
            check();
            if (page.identity.subjectId === identity.subjectId) {
              this.repository.saveWorks(
                page.works.map((work) =>
                  globalWorkSchema.parse({
                    ...work,
                    accountId: account.id,
                    platformId: account.platformId,
                    subjectId: identity.subjectId,
                    capturedAt: snapshot.capturedAt,
                  }),
                ),
              );
              worksAvailable = page.works.length > 0;
            }
          } catch {
            check();
          }
        }
        if (!snapshot.metrics.length && !worksAvailable) throw new Error("WEB_OBSERVE_UNAVAILABLE");
        check();
        this.failures.delete(job.accountId);
        this.update(
          job,
          "done",
          worksAvailable
            ? snapshot.metrics.length
              ? "指标与作品已更新"
              : "作品已更新；当前账号的数据中心未提供可识别指标"
            : "指标已更新；官网未提供可识别的作品列表",
        );
      });
    } catch {
      if (
        epoch !== this.epoch ||
        this.stopped ||
        !this.options.accounts.get(job.accountId) ||
        this.repository.job(job.id)?.state === "cancelled"
      )
        return;
      if (this.options.web.state(job.accountId).phase !== "open") {
        this.update(job, "waiting-network", "网络变化，等待恢复后重新采集");
        this.retryAfter.set(job.id, Date.now() + 30000);
      } else {
        const count = (this.failures.get(job.accountId)?.count ?? 0) + 1;
        this.failures.set(job.accountId, {
          count,
          until: Date.now() + Math.min(6 * 3600000, 10 * 60000 * 2 ** Math.min(count - 1, 6)),
        });
        this.update(job, "failed", "暂未读到可用数据，请检查官网权限、登录状态与数据页面");
      }
    }
  }
}
