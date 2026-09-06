import { EventEmitter } from "node:events";
import { session as electronSession } from "electron";
import type {
  Account,
  AccountCreateInput,
  AccountStatus,
  AccountUpdateInput,
  ViewBounds,
  ViewState,
} from "@shared/types";
import { consoleHost, getPlatform, isLoginUrl, isPlatformHost, type PlatformId } from "@shared/platforms";
import type { ToastEvent } from "@shared/ipc";
import type { Store } from "@main/db";
import { partitionForAccount, wipeAccountSession } from "@main/browser/account-session";
import { buildInPageProbeScript, detectLoginState, type ProbeResponse } from "@main/browser/login-detector";
import type { ViewPool } from "@main/browser/view-pool";

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
  private readonly lastProbeAt = new Map<string, number>();
  private patrolTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: AccountServiceOptions) {
    super();
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
    this.cancelCheck(id);
    this.options.viewPool.remove(id);
    // Deleting an account is the explicit "forget everything" action: the
    // partition would otherwise remain on disk with live cookies.
    await wipeAccountSession(id).catch(() => undefined);
    this.options.store.accounts.delete(id);
    this.options.store.audit.append({
      action: "account.delete",
      accountId: id,
      details: { platformId: account.platformId },
    });
    this.emit("accounts-reloaded");
  }

  async resetEnvironment(id: string): Promise<Account> {
    const account = this.get(id);
    this.cancelCheck(id);
    this.options.viewPool.remove(id);
    await wipeAccountSession(id);
    const updated = this.options.store.accounts.clearSessionState(id)!;
    this.options.store.audit.append({ action: "account.reset-environment", accountId: id });
    this.emit("account-changed", updated);
    this.options.notify({ kind: "info", title: `${account.displayName} 登录环境已重置`, accountId: id });
    return updated;
  }

  /* ---------------- browser view proxy ---------------- */

  async showView(id: string, bounds: ViewBounds): Promise<ViewState> {
    const account = this.get(id);
    const state = await this.options.viewPool.show(
      { id: account.id, platformId: account.platformId },
      bounds,
    );
    this.scheduleCheck(id);
    return state;
  }

  ensureView(id: string): void {
    const account = this.get(id);
    this.options.viewPool.ensure({ id: account.id, platformId: account.platformId });
  }

  async go(id: string, route: AccountRoute): Promise<void> {
    const account = this.get(id);
    const routes = getPlatform(account.platformId).routes;
    const url = routes[route] ?? routes.home;
    this.options.viewPool.ensure({ id: account.id, platformId: account.platformId }, { navigate: false });
    await this.options.viewPool.navigate(id, url);
  }

  /* ---------------- login state ---------------- */

  /** Called by the view pool on navigation / cookie changes. */
  onActivity(accountId: string, _reason: "navigated" | "cookies" | "loaded"): void {
    this.scheduleCheck(accountId);
  }

  scheduleCheck(accountId: string, delay = CHECK_DEBOUNCE_MS): void {
    this.cancelCheck(accountId);
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

  async checkStatus(
    accountId: string,
    opts: { skipProbe?: boolean; silent?: boolean } = {},
  ): Promise<Account> {
    const account = this.options.store.accounts.get(accountId);
    if (!account) throw new Error("账号不存在");
    if (this.inFlight.has(accountId)) return account;
    this.inFlight.add(accountId);
    try {
      const viewState = this.options.viewPool.getState(accountId);
      const pooled = this.options.viewPool.getSession(accountId)?.session;
      const ses = pooled ?? electronSession.fromPartition(partitionForAccount(accountId), { cache: true });
      // A healthy account that was probed moments ago is re-evaluated from
      // cookies + URL only; SPA navigation bursts must not turn into a probe
      // request per route change.
      const lastProbe = this.lastProbeAt.get(accountId) ?? 0;
      const healthy = account.status === "online" || account.status === "expiring";
      const skipProbe = opts.skipProbe ?? (healthy && Date.now() - lastProbe < PROBE_MIN_INTERVAL_MS);
      const result = await detectLoginState({
        platformId: account.platformId,
        session: ses,
        currentUrl: viewState?.url ?? null,
        loading: viewState?.loading ?? false,
        skipProbe,
        probe: this.inPageProbe(accountId, account.platformId, viewState),
        previousStatus: account.status,
        lastOnlineAt: account.lastOnlineAt,
      });
      if (!skipProbe) this.lastProbeAt.set(accountId, Date.now());
      const previous = account.status;
      const updated = this.options.store.accounts.updateStatus(accountId, result.status, result.message, {
        sessionExpiresAt: result.sessionExpiresAt ?? null,
      })!;
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
          if (previous === "offline" || previous === "needs_verification")
            this.returnToConsoleAfterLogin(updated);
        }
      }
      this.emit("account-changed", updated);
      return updated;
    } finally {
      this.inFlight.delete(accountId);
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
    let host: string;
    try {
      host = new URL(viewState.url).hostname;
    } catch {
      return undefined;
    }
    if (!isPlatformHost(platformId, host)) return undefined;
    return async () => {
      if (wc.isDestroyed()) return null;
      try {
        return (await wc.executeJavaScript(buildInPageProbeScript(platformId), true)) as ProbeResponse;
      } catch {
        return null;
      }
    };
  }

  /**
   * Some passports (Bilibili) finish a QR login by opening the consumer
   * homepage rather than returning to the console. Bring the view back to the
   * creator console once, on the login transition only, so normal browsing of
   * the consumer site later is never interrupted.
   */
  private returnToConsoleAfterLogin(account: Account): void {
    const state = this.options.viewPool.getState(account.id);
    if (!state?.url) return;
    let host: string;
    try {
      host = new URL(state.url).hostname;
    } catch {
      return;
    }
    const console = consoleHost(account.platformId);
    if (host === console && !isLoginUrl(account.platformId, state.url)) return;
    setTimeout(() => {
      void this.go(account.id, "home").catch(() => undefined);
    }, 800);
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
    const info = await this.options.fetchProfile(account);
    if (!info) return account;
    const patch: AccountUpdateInput = {};
    if (info.displayName && info.displayName.trim() && isGeneratedName(account))
      patch.displayName = info.displayName.trim().slice(0, 60);
    if (info.avatarUrl) patch.avatarUrl = info.avatarUrl;
    if (info.handle) patch.handle = info.handle;
    if (info.externalId) patch.externalId = info.externalId;
    if (Object.keys(patch).length === 0) return account;
    return this.update(accountId, patch);
  }

  /* ---------------- patrol ---------------- */

  startPatrol(): void {
    this.stopPatrol();
    this.patrolTimer = setInterval(() => void this.patrol(), PATROL_INTERVAL_MS);
    (this.patrolTimer as unknown as { unref?: () => void }).unref?.();
    // Initial sweep shortly after startup. It probes (cookies alone cannot
    // distinguish a guest cookie from a login) but staggers the requests so
    // boot never looks like a burst to any platform.
    setTimeout(() => void this.patrol(), 3_000);
  }

  stopPatrol(): void {
    if (this.patrolTimer) clearInterval(this.patrolTimer);
    this.patrolTimer = undefined;
  }

  private async patrol(): Promise<void> {
    for (const account of this.list()) {
      try {
        await this.checkStatus(account.id, { skipProbe: false, silent: account.status === "unknown" });
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
    this.stopPatrol();
    for (const timer of this.pendingChecks.values()) clearTimeout(timer);
    this.pendingChecks.clear();
  }
}

function isGeneratedName(account: Account): boolean {
  const platform = getPlatform(account.platformId);
  return new RegExp(`^${platform.shortName}账号 \\d+$`).test(account.displayName);
}
