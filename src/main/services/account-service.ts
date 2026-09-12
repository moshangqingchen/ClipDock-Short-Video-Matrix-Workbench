import { EventEmitter } from "node:events";
import type {
  Account,
  AccountCheckInfo,
  AccountCreateInput,
  AccountStatus,
  AccountUpdateInput,
  ViewBounds,
  ViewState,
} from "@shared/types";
import { consoleHost, getPlatform, isLoginUrl, isVerificationUrl, platformEntryUrl, type PlatformId } from "@shared/platforms";
import type { ToastEvent } from "@shared/ipc";
import type { Store } from "@main/db";
import { configureAccountSession, wipeAccountSession } from "@main/browser/account-session";
import { buildInPageProbeScript, detectLoginState, type ProbeResponse } from "@main/browser/login-detector";
import { buildHomepageLoginScript, isHomepageContext, type HomepageLoginVerdict } from "@main/browser/homepage-login";
import type { ViewPool } from "@main/browser/view-pool";
import { evaluateWithLease } from "@main/network/page-evaluation";
import {
  assertBusinessNetwork,
  beginBusinessOperation,
  businessPageOrigin,
  canUseBusinessNetwork,
  isNetworkDormantError,
  isStrictBusinessNetwork,
  NetworkDormantError,
  prepareBusinessOperation,
} from "@main/network/business-access";
import type { DomesticOperation } from "@main/network/operation-catalog";
import { persistableMediaReference, type MediaIntake } from "./media-intake";

export type AccountRoute = "home" | "site" | "login" | "upload" | "analytics" | "works" | "comments";

export interface ProfileInfo {
  displayName?: string | null;
  avatarUrl?: string | null;
  handle?: string | null;
  externalId?: string | null;
}

export interface AccountServiceOptions {
  store: Store;
  viewPool: ViewPool;
  fetchProfile?: (account: Account) => Promise<ProfileInfo | null>;
  mediaIntake?: MediaIntake;
  onSessionChange?: (accountId: string, kind: "delete" | "reset" | "restore") => Promise<void>;
  notify: (toast: ToastEvent, system?: boolean) => void;
}

export interface AccountServiceEvents {
  "account-changed": (account: Account) => void;
  "account-online": (account: Account) => void;
  "accounts-reloaded": () => void;
}

const CHECK_DEBOUNCE_MS = 1_200;
const PROBE_MIN_INTERVAL_MS = 30_000;
const PATROL_INTERVAL_MS = 5 * 60_000;
const PATROL_STAGGER_MS = 700;
const ATTENTION_STATES: ReadonlySet<AccountStatus> = new Set(["offline", "needs_verification", "expiring"]);

export class AccountService extends EventEmitter {
  private readonly pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private readonly flights = new Map<string, Promise<Account>>();
  private activeChecks = 0;
  private readonly checkWaiters: Array<() => void> = [];
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly negativeEvidence = new Map<string, { key: string; at: number }>();
  private readonly consumedEvidence = new Map<string, string>();
  private readonly activityDuringCheck = new Set<string>();
  private readonly pageActivitySequence = new Map<string, number>();
  private attemptSequence = 0;
  private readonly lastProbeAt = new Map<string, number>();
  private patrolTimer: ReturnType<typeof setInterval> | undefined;
  private startupPatrolTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly accountEpoch = new Map<string, number>();
  private readonly sessionChanges = new Set<string>();
  private readonly profileRequests = new Map<string, number>();
  private disposed = false;
  private patrolGeneration = 0;

  constructor(private readonly options: AccountServiceOptions) {
    super();
    for (const account of options.store.accounts.list()) {
      if (account.checkInfo?.state === "checking")
        options.store.accounts.updateCheckInfo(account.id, {
          ...account.checkInfo,
          state: "unconfirmed",
          reason: "上次检查未完成，等待复核",
        });
    }
  }

  get store(): Store {
    return this.options.store;
  }

  list(): Account[] {
    return this.options.store.accounts.list();
  }

  get(id: string): Account {
    const account = this.options.store.accounts.get(id);
    if (!account) throw new Error("账号不存在");
    return account;
  }

  create(input: AccountCreateInput): Account {
    const account = this.options.store.accounts.create(input);
    this.options.store.audit.append({
      action: "account.create",
      accountId: account.id,
      details: { platformId: account.platformId },
    });
    this.emit("account-changed", account);
    return account;
  }

  update(id: string, patch: AccountUpdateInput): Account {
    const account = this.options.store.accounts.update(id, patch);
    if (!account) throw new Error("账号不存在");
    this.emit("account-changed", account);
    return account;
  }

  reorder(ids: string[]): void {
    this.options.store.accounts.reorder(ids);
    this.emit("accounts-reloaded");
  }

  async delete(id: string): Promise<void> {
    const account = this.get(id);
    await this.prepareSessionChange(id, "delete");
    this.options.viewPool.remove(id);
    // Deleting an account is the explicit "forget everything" action: the
    // partition would otherwise remain on disk with live cookies.
    await wipeAccountSession(id).catch(() => undefined);
    this.options.store.accounts.delete(id);
    this.sessionChanges.delete(id);
    this.options.store.audit.append({
      action: "account.delete",
      accountId: id,
      details: { platformId: account.platformId },
    });
    this.emit("accounts-reloaded");
  }

  async resetEnvironment(id: string): Promise<Account> {
    const account = this.get(id);
    await this.prepareSessionChange(id, "reset");
    this.options.viewPool.remove(id);
    await wipeAccountSession(id);
    const updated = this.options.store.accounts.clearSessionState(id)!;
    this.finishSessionChange(id);
    this.options.store.audit.append({ action: "account.reset-environment", accountId: id });
    this.emit("account-changed", updated);
    this.options.notify({ kind: "info", title: `${account.displayName} 登录环境已重置`, accountId: id });
    return updated;
  }

  /* ---------------- browser view proxy ---------------- */

  /** Revoke queued and in-flight work before destructive session or backup changes. */
  async prepareSessionChange(accountId: string, kind: "delete" | "reset" | "restore"): Promise<void> {
    this.sessionChanges.add(accountId);
    this.suspendNetworkAccount(accountId);
    await this.options.onSessionChange?.(accountId, kind);
  }

  sessionChangeVersion(accountId: string): number {
    return this.accountEpoch.get(accountId) ?? 0;
  }

  finishSessionChange(accountId: string, expectedVersion = this.sessionChangeVersion(accountId)): boolean {
    if (this.disposed || expectedVersion !== this.sessionChangeVersion(accountId)) return false;
    this.sessionChanges.delete(accountId);
    return true;
  }

  private assertSessionAvailable(accountId: string): void {
    if (this.sessionChanges.has(accountId)) throw new Error("账号环境正在重建，请稍后重试");
  }

  async showView(id: string, bounds: ViewBounds, enterHomepage = false): Promise<ViewState> {
    const account = this.get(id);
    this.assertSessionAvailable(id);
    const currentUrl = this.options.viewPool.getState(id)?.url;
    const entryUrl = platformEntryUrl(account.platformId);
    const currentHomepage = isHomepageContext(account.platformId, currentUrl ?? "");
    this.prepareNetworkOperation(
      id,
      enterHomepage || currentHomepage ? "view-navigate" : businessPageOrigin(currentUrl) ? "check-status" : "view-home",
      enterHomepage ? entryUrl : currentHomepage ? currentUrl : undefined,
    );
    assertBusinessNetwork(
      id,
      enterHomepage ? entryUrl : businessPageOrigin(currentUrl) ? currentUrl : getPlatform(account.platformId).routes.home,
    );
    const state = await this.options.viewPool.show(
      { id: account.id, platformId: account.platformId },
      bounds,
      enterHomepage,
    );
    this.scheduleCheck(id);
    return state;
  }

  ensureView(id: string): void {
    const account = this.get(id);
    this.assertSessionAvailable(id);
    assertBusinessNetwork(id);
    this.options.viewPool.ensure({ id: account.id, platformId: account.platformId });
  }

  async go(id: string, route: AccountRoute): Promise<void> {
    const account = this.get(id);
    this.assertSessionAvailable(id);
    const routes = getPlatform(account.platformId).routes;
    const url = routes[route] ?? routes.home;
    this.prepareNetworkOperation(
      id,
      route === "home"
        ? "view-home"
        : route === "login"
          ? "view-login"
          : route === "upload"
            ? "view-upload"
            : "view-navigate",
      url,
    );
    assertBusinessNetwork(id, url);
    this.options.viewPool.ensure({ id: account.id, platformId: account.platformId }, { navigate: false });
    await this.options.viewPool.navigate(id, url);
  }

  /** Main-process activity declaration; does not open a page or wait for a network permit. */
  prepareNetworkOperation(id: string, operation: DomesticOperation, targetUrl?: string): void {
    this.get(id);
    this.assertSessionAvailable(id);
    if (this.disposed) throw new NetworkDormantError("GATE_REVOKED");
    const targetPageOrigin = operation === "view-navigate" ? businessPageOrigin(targetUrl) : null;
    if (operation === "view-navigate" && !targetPageOrigin) {
      if (isStrictBusinessNetwork()) throw new NetworkDormantError("UNKNOWN_TARGET");
      return;
    }
    prepareBusinessOperation(id, {
      operation,
      activePageOrigin: businessPageOrigin(this.options.viewPool.getState(id)?.url),
      ...(targetPageOrigin ? { targetPageOrigin } : {}),
    });
  }

  /* ---------------- login state ---------------- */

  /** Called by the view pool on navigation / cookie changes. */
  onActivity(accountId: string, reason: "navigated" | "cookies" | "loaded" | "identity"): void {
    const account = this.options.store.accounts.get(accountId);
    if (!account) return;
    const homepage = isHomepageContext(account.platformId, this.options.viewPool.getState(accountId)?.url ?? "");
    // Creator identity responses do not describe a consumer homepage session.
    if (reason === "identity" && homepage) return;
    if (reason !== "identity")
      this.pageActivitySequence.set(accountId, (this.pageActivitySequence.get(accountId) ?? 0) + 1);
    this.lastAttemptAt.delete(accountId);
    if (this.flights.has(accountId)) {
      this.activityDuringCheck.add(accountId);
      return;
    }
    this.scheduleCheck(accountId, reason === "identity" ? 100 : CHECK_DEBOUNCE_MS);
  }

  scheduleCheck(accountId: string, delay = CHECK_DEBOUNCE_MS): void {
    this.cancelCheck(accountId);
    if (this.disposed || this.sessionChanges.has(accountId) || !canUseBusinessNetwork(accountId)) return;
    const timer = setTimeout(() => {
      this.pendingChecks.delete(accountId);
      void this.checkStatus(accountId).catch(() => undefined);
    }, delay);
    this.pendingChecks.set(accountId, timer);
  }

  private cancelCheck(accountId: string): void {
    const timer = this.pendingChecks.get(accountId);
    if (timer) clearTimeout(timer);
    this.pendingChecks.delete(accountId);
  }

  /** Network revocation does not modify stored login status or emit account-online. */
  suspendNetworkAccount(accountId: string): void {
    this.cancelCheck(accountId);
    this.lastProbeAt.delete(accountId);
    this.lastAttemptAt.delete(accountId);
    this.negativeEvidence.delete(accountId);
    this.consumedEvidence.delete(accountId);
    this.pageActivitySequence.delete(accountId);
    this.options.viewPool.invalidateIdentity?.(accountId);
    this.accountEpoch.set(accountId, (this.accountEpoch.get(accountId) ?? 0) + 1);
  }

  checkStatus(
    accountId: string,
    opts: { skipProbe?: boolean; silent?: boolean; force?: boolean } = {},
  ): Promise<Account> {
    const running = this.flights.get(accountId);
    if (running) return running;
    const execute = async () => {
      if (this.activeChecks >= 2) await new Promise<void>((resolve) => this.checkWaiters.push(resolve));
      else this.activeChecks++;
      try {
        return await this.performCheck(accountId, opts);
      } finally {
        const next = this.checkWaiters.shift();
        if (next) next();
        else this.activeChecks--;
      }
    };
    const task = execute().finally(() => {
      if (this.flights.get(accountId) === task) this.flights.delete(accountId);
      if (this.activityDuringCheck.delete(accountId)) {
        this.lastAttemptAt.delete(accountId);
        this.scheduleCheck(accountId, 100);
      }
    });
    this.flights.set(accountId, task);
    return task;
  }

  private recordCheck(accountId: string, state: AccountCheckInfo["state"], reason: string): Account {
    const account = this.options.store.accounts.updateCheckInfo(accountId, {
      state,
      reason,
      attemptedAt: new Date().toISOString(),
    });
    if (!account) throw new Error("账号不存在");
    this.emit("account-changed", account);
    return account;
  }

  private prepareCheckNetwork(accountId: string, platformId: PlatformId): void {
    const currentUrl = this.options.viewPool.getState(accountId)?.url;
    // A read-only homepage check reuses its existing page-origin scope. The
    // creator probe's scope is unrelated and must not pause this observation.
    if (currentUrl && isHomepageContext(platformId, currentUrl))
      this.prepareNetworkOperation(accountId, "view-navigate", currentUrl);
    else this.prepareNetworkOperation(accountId, "check-status");
  }

  private async performCheck(
    accountId: string,
    opts: { skipProbe?: boolean; silent?: boolean; force?: boolean } = {},
  ): Promise<Account> {
    const account = this.options.store.accounts.get(accountId);
    if (!account) throw new Error("账号不存在");
    if (this.disposed || this.sessionChanges.has(accountId)) return account;
    if (this.inFlight.has(accountId)) return account;
    try {
      this.prepareCheckNetwork(accountId, account.platformId);
    } catch (error) {
      if (isNetworkDormantError(error))
        return this.recordCheck(accountId, "paused", "国内网络暂停，等待代理关闭或网络检查完成");
      throw error;
    }
    if (!canUseBusinessNetwork(accountId))
      return this.recordCheck(accountId, "paused", "国内网络暂停，登录状态保留");
    if (
      !opts.force &&
      opts.skipProbe === undefined &&
      Date.now() - (this.lastAttemptAt.get(accountId) ?? 0) < PROBE_MIN_INTERVAL_MS
    )
      return account;
    const operation = beginBusinessOperation(accountId);
    const epoch = this.accountEpoch.get(accountId) ?? 0;
    this.inFlight.add(accountId);
    try {
      this.lastAttemptAt.set(accountId, Date.now());
      this.recordCheck(accountId, "checking", "正在核实平台登录状态");
      const viewState = this.options.viewPool.getState(accountId);
      const pageActivity = this.pageActivitySequence.get(accountId) ?? 0;
      const homepageContext = isHomepageContext(account.platformId, viewState?.url ?? "");
      const startingEvidence = this.options.viewPool.getIdentityEvidence?.(accountId);
      const pooled = this.options.viewPool.getSession(accountId)?.session;
      const ses = pooled ?? configureAccountSession(account.id, account.platformId).session;
      // Debounce creator API checks, but always read a homepage's own identity
      // after its navigation, loading or login-cookie state changes.
      const lastProbe = this.lastProbeAt.get(accountId) ?? 0;
      const healthy = account.status === "online" || account.status === "expiring";
      const skipProbe =
        opts.skipProbe ?? (!opts.force && healthy && !this.negativeEvidence.has(accountId) &&
          Date.now() - lastProbe < PROBE_MIN_INTERVAL_MS);
      const result = await detectLoginState({
        accountId,
        platformId: account.platformId,
        session: ses,
        currentUrl: viewState?.url ?? null,
        loading: viewState?.loading ?? false,
        skipProbe,
        probe: this.inPageProbe(accountId, account.platformId, viewState),
        previousStatus: account.status,
        lastOnlineAt: account.lastOnlineAt,
        evidence: startingEvidence,
        homepage: homepageContext ? await this.homepageLogin(accountId, account.platformId, viewState) : undefined,
      });
      operation.assertCurrent();
      if (this.disposed || (this.accountEpoch.get(accountId) ?? 0) !== epoch)
        return this.options.store.accounts.get(accountId) ?? account;
      // Bilibili challenges and throttled/missing probes are not fresh authentication observations.
      const currentEvidence = this.options.viewPool.getIdentityEvidence?.(accountId);
      const currentView = this.options.viewPool.getState(accountId);
      if (
        viewState?.instanceId !== currentView?.instanceId ||
        viewState?.navigationId !== currentView?.navigationId ||
        viewState?.url !== currentView?.url ||
        pageActivity !== (this.pageActivitySequence.get(accountId) ?? 0) ||
        (!homepageContext && currentEvidence?.key !== startingEvidence?.key)
      ) {
        this.activityDuringCheck.add(accountId);
        return this.recordCheck(accountId, "unconfirmed", "页面状态已变化，等待新的身份结果");
      }
      if (result.unconfirmed) return this.recordCheck(accountId, "unconfirmed", result.message);
      if (result.status === "network_error")
        return this.recordCheck(accountId, "network_error", result.message);
      if (result.evidenceKey && this.consumedEvidence.get(accountId) === result.evidenceKey)
        return this.recordCheck(accountId, "unconfirmed", "本次没有新的身份结果，上次结论保留");
      if (result.evidenceKey) this.consumedEvidence.set(accountId, result.evidenceKey);
      if (
        result.status === "offline" &&
        (healthy || this.negativeEvidence.has(accountId) ||
          account.platformId === "kuaishou" || account.platformId === "weixin_channels")
      ) {
        const key = result.evidenceKey ?? `probe:${epoch}:${++this.attemptSequence}`;
        const prior = this.negativeEvidence.get(accountId);
        this.negativeEvidence.set(accountId, { key, at: Date.now() });
        const settledLoginPage = viewState?.url && !viewState.loading &&
          isLoginUrl(account.platformId, viewState.url);
        if ((result.source === "homepage" || !settledLoginPage) &&
          (!prior || prior.key === key || Date.now() - prior.at > 60000)) {
          this.lastAttemptAt.delete(accountId);
          this.scheduleCheck(accountId, 3000);
          return this.recordCheck(accountId, "unconfirmed", result.source === "homepage"
            ? "主页提示未登录，正在复核；上次登录结论保留"
            : "身份接口提示异常，正在复核；上次登录结论保留");
        }
      } else if (result.status === "online" || result.status === "expiring")
        this.negativeEvidence.delete(accountId);
      if (!skipProbe) this.lastProbeAt.set(accountId, Date.now());
      const previous = account.status;
      const profile =
        result.source !== "homepage" && result.evidenceKey && result.status === "online"
          ? startingEvidence?.profile : undefined;
      if (profile) {
        const patch = profilePatch(this.get(accountId), profile);
        if (Object.keys(patch).length) this.options.store.accounts.update(accountId, patch);
      }
      const updated = this.options.store.accounts.updateStatus(accountId, result.status, result.message, {
        sessionExpiresAt: result.sessionExpiresAt ?? null,
      })!;
      const checked = this.recordCheck(accountId, "confirmed", result.message);
      if (result.source === "homepage" && result.status === "online") {
        const avatar = profileAvatar(result.avatarUrl);
        if (avatar) this.options.mediaIntake?.avatar(accountId, avatar);
      } else if (profile) {
        const avatar = profileAvatar(profile.avatarUrl);
        if (avatar) this.options.mediaIntake?.avatar(accountId, avatar);
      }
      if (previous !== result.status) {
        this.options.store.audit.append({
          action: "account.status",
          accountId,
          details: { from: previous, to: result.status, probe: result.probeStatus ?? null },
        });
        if (!opts.silent) this.notifyTransition(updated, previous);
        if (
          (result.status === "online" || result.status === "expiring") &&
          previous !== "online" &&
          previous !== "expiring"
        ) {
          this.emit("account-online", updated);
        }
      }
      return checked;
    } catch (error) {
      if (isNetworkDormantError(error)) {
        if (this.disposed || this.sessionChanges.has(accountId))
          return this.options.store.accounts.get(accountId) ?? account;
        return this.recordCheck(accountId, "paused", "网络状态已变化，本次检查已暂停");
      }
      if (this.disposed || (this.accountEpoch.get(accountId) ?? 0) !== epoch)
        return this.options.store.accounts.get(accountId) ?? account;
      return this.recordCheck(accountId, "network_error", "本次检查未完成，请稍后重试；上次登录结论保留");
    } finally {
      operation.release();
      this.inFlight.delete(accountId);
    }
  }

  /** Inspect only the account's existing homepage; never fetch or navigate to its creator console. */
  private async homepageLogin(
    accountId: string,
    platformId: PlatformId,
    viewState: ViewState | null,
  ): Promise<HomepageLoginVerdict> {
    const pending: HomepageLoginVerdict = {
      kind: "unconfirmed", reason: "等待主页加载并确认登录状态，上次登录结论保留", source: "homepage",
    };
    const wc = this.options.viewPool.getWebContents(accountId);
    if (!wc || wc.isDestroyed() || !viewState?.url || viewState.loading) return pending;
    const operation = beginBusinessOperation(accountId, viewState.url);
    try {
      const result = await evaluateWithLease<HomepageLoginVerdict>(
        wc, buildHomepageLoginScript(platformId), operation, 3000,
      );
      operation.assertCurrent();
      return result && result.source === "homepage" &&
        ["online", "offline", "unconfirmed"].includes(result.kind) && typeof result.reason === "string"
        ? result : pending;
    } catch (error) {
      operation.assertCurrent();
      if (isNetworkDormantError(error)) throw error;
      return pending;
    } finally {
      operation.release();
    }
  }

  /**
   * Probe from inside the account's page whenever one is live on a first-party
   * URL. Returns undefined otherwise so the detector decides whether a
   * main-process probe is acceptable for this platform.
   */
  private inPageProbe(
    accountId: string,
    platformId: PlatformId,
    viewState: ViewState | null,
  ): (() => Promise<ProbeResponse | null>) | undefined {
    const wc = this.options.viewPool.getWebContents(accountId);
    if (!wc || !viewState?.url) return undefined;
    if (platformId === "weixin_channels") return undefined;
    // A consumer homepage has a different authentication context from its creator
    // console. Do not turn a cross-origin request failure into a login conclusion,
    // or silently replace it with a main-process probe.
    if (!isProfilePage(platformId, viewState)) return async () => null;
    return async () => {
      if (wc.isDestroyed()) return null;
      const operation = beginBusinessOperation(accountId, getPlatform(platformId).login.probe.url);
      try {
        const result = await evaluateWithLease<ProbeResponse>(
          wc,
          buildInPageProbeScript(platformId),
          operation,
          8000,
        );
        operation.assertCurrent();
        return result;
      } catch (error) {
        operation.assertCurrent();
        if (isNetworkDormantError(error)) throw error;
        return { status: 0, text: "页面身份检查超时或中断", url: "" };
      } finally {
        operation.release();
      }
    };
  }

  private notifyTransition(account: Account, previous: AccountStatus): void {
    const settings = this.options.store.settings.get();
    const wasHealthy = previous === "online" || previous === "expiring" || previous === "unknown";
    if (account.status === "offline" && wasHealthy && previous !== "unknown" && settings.notifyOnOffline) {
      this.options.notify(
        {
          kind: "warning",
          title: `${account.displayName} 已掉线`,
          message: account.statusMessage ?? "请重新扫码登录",
          accountId: account.id,
        },
        true,
      );
    } else if (account.status === "needs_verification") {
      this.options.notify(
        {
          kind: "warning",
          title: `${account.displayName} 需要安全验证`,
          message: "请在账号页面完成验证",
          accountId: account.id,
        },
        true,
      );
    } else if (account.status === "expiring" && settings.notifyOnExpiring && previous !== "expiring") {
      this.options.notify(
        {
          kind: "info",
          title: `${account.displayName} 登录态即将过期`,
          message: "打开账号页面即可自动续期",
          accountId: account.id,
        },
        true,
      );
    } else if (
      account.status === "online" &&
      (previous === "offline" || previous === "needs_verification" || previous === "unknown")
    ) {
      this.options.notify({ kind: "success", title: `${account.displayName} 已登录`, accountId: account.id });
    }
  }

  async refreshProfile(accountId: string): Promise<Account> {
    const account = this.get(accountId);
    if (!this.options.fetchProfile) return account;
    if (this.disposed || this.sessionChanges.has(accountId)) return account;
    const startingView = this.options.viewPool.getState(accountId);
    if (startingView && !isProfilePage(account.platformId, startingView)) return account;
    const startingSubject = this.options.viewPool.getIdentityEvidence?.(accountId)?.subject;
    try {
      this.prepareNetworkOperation(accountId, "profile");
    } catch (error) {
      if (isNetworkDormantError(error)) return account;
      throw error;
    }
    if (!canUseBusinessNetwork(accountId)) return account;
    const operation = beginBusinessOperation(accountId);
    const epoch = this.accountEpoch.get(accountId) ?? 0;
    const request = (this.profileRequests.get(accountId) ?? 0) + 1;
    this.profileRequests.set(accountId, request);
    try {
      const info = await this.options.fetchProfile(account);
      operation.assertCurrent();
      if (
        this.disposed ||
        (this.accountEpoch.get(accountId) ?? 0) !== epoch ||
        this.profileRequests.get(accountId) !== request
      )
        return this.options.store.accounts.get(accountId) ?? account;
      const current = this.get(accountId);
      const currentView = this.options.viewPool.getState(accountId);
      const currentSubject = this.options.viewPool.getIdentityEvidence?.(accountId)?.subject;
      if (
        startingView?.instanceId !== currentView?.instanceId ||
        startingView?.navigationId !== currentView?.navigationId ||
        startingView?.url !== currentView?.url ||
        (currentView && !isProfilePage(account.platformId, currentView)) ||
        startingSubject !== currentSubject ||
        (current.status !== account.status && current.status !== "online" && current.status !== "expiring")
      )
        return current;
      if (!info) return current;
      const patch = profilePatch(current, info);
      if (Object.keys(patch).length === 0) return current;
      const updated = this.update(accountId, patch);
      operation.assertCurrent();
      const avatar = profileAvatar(info.avatarUrl);
      if (avatar) this.options.mediaIntake?.avatar(accountId, avatar);
      return updated;
    } catch (error) {
      if (isNetworkDormantError(error)) return this.options.store.accounts.get(accountId) ?? account;
      throw error;
    } finally {
      operation.release();
    }
  }

  /* ---------------- patrol ---------------- */

  startPatrol(): void {
    this.stopPatrol();
    if (this.disposed) return;
    this.patrolTimer = setInterval(() => void this.patrol(), PATROL_INTERVAL_MS);
    (this.patrolTimer as unknown as { unref?: () => void }).unref?.();
    // Initial sweep shortly after startup. It probes (cookies alone cannot
    // distinguish a guest cookie from a login) but staggers the requests so
    // boot never looks like a burst to any platform.
    this.startupPatrolTimer = setTimeout(() => void this.patrol(), 3_000);
  }

  stopPatrol(): void {
    this.patrolGeneration++;
    if (this.startupPatrolTimer) clearTimeout(this.startupPatrolTimer);
    this.startupPatrolTimer = undefined;
    if (this.patrolTimer) clearInterval(this.patrolTimer);
    this.patrolTimer = undefined;
  }

  private async patrol(): Promise<void> {
    const generation = this.patrolGeneration;
    for (const account of this.list()) {
      if (this.disposed || generation !== this.patrolGeneration) return;
      try {
        this.prepareCheckNetwork(account.id, account.platformId);
        if (!canUseBusinessNetwork(account.id)) continue;
        await this.checkStatus(account.id, { silent: account.status === "unknown" });
      } catch {
        // continue with next account
      }
      await new Promise((resolve) => setTimeout(resolve, PATROL_STAGGER_MS));
    }
  }

  attentionAccounts(): Account[] {
    return this.list().filter((a) => ATTENTION_STATES.has(a.status));
  }

  platformOf(accountId: string): PlatformId {
    return this.get(accountId).platformId;
  }

  dispose(): void {
    this.disposed = true;
    this.stopPatrol();
    for (const timer of this.pendingChecks.values()) clearTimeout(timer);
    this.pendingChecks.clear();
  }
}

function isGeneratedName(account: Account): boolean {
  const platform = getPlatform(account.platformId);
  return new RegExp(`^${platform.shortName}账号 \\d+$`).test(account.displayName);
}

function isProfilePage(platformId: PlatformId, state: ViewState): boolean {
  if (state.loading || state.isLoginPage || !state.url || isLoginUrl(platformId, state.url) ||
    isVerificationUrl(platformId, state.url)) return false;
  try {
    const url = new URL(state.url);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    // Bilibili's nav API explicitly supports its consumer and creator contexts.
    return platformId === "bilibili"
      ? ["www.bilibili.com", "member.bilibili.com", "api.bilibili.com"].includes(url.hostname)
      : url.hostname === consoleHost(platformId);
  } catch {
    return false;
  }
}

function profileText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().slice(0, limit) || undefined;
}

function profileId(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  const text = profileText(value, 256);
  return text && text !== "0" ? text : undefined;
}

function profileAvatar(value: unknown): string | undefined {
  const text = profileText(value, 8192);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Missing/placeholder scan fields never mean that saved account information was deleted. */
export function profilePatch(account: Account, info: ProfileInfo): AccountUpdateInput {
  const patch: AccountUpdateInput = {};
  const displayName = profileText(info.displayName, 60);
  const avatarUrl = profileAvatar(info.avatarUrl);
  const handle = profileId(info.handle);
  const externalId = profileId(info.externalId);
  if (displayName && isGeneratedName(account)) patch.displayName = displayName;
  if (avatarUrl) patch.avatarUrl = persistableMediaReference(avatarUrl);
  if (handle) patch.handle = handle;
  if (externalId) patch.externalId = externalId;
  return patch;
}
