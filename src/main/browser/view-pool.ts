import { EventEmitter } from "node:events";
import { WebContentsView, type BaseWindow, type WebContents } from "electron";
import { getPlatform, isLoginUrl, isVerificationUrl, type PlatformId } from "@shared/platforms";
import type { ViewBounds, ViewState } from "@shared/types";
import { configureAccountSession, type ConfiguredSession } from "./account-session";
import { CookieGuard } from "./cookie-guard";
import { installNavigationPolicy } from "./navigation-policy";

export interface ViewPoolAccount {
  id: string;
  platformId: PlatformId;
}

export interface ViewPoolOptions {
  window: BaseWindow;
  maxLive: number;
  /** Hook for status detection: fired after navigation settles or cookies change. */
  onActivity?: (accountId: string, reason: "navigated" | "cookies" | "loaded") => void;
}

interface LiveView {
  account: ViewPoolAccount;
  view: WebContentsView;
  session: ConfiguredSession;
  cookieGuard: CookieGuard;
  disposeNavigation: () => void;
  attached: boolean;
  visible: boolean;
  lastUsedAt: number;
  lastError: string | null;
  bounds: ViewBounds | null;
  /** Set once the first real navigation has been issued. */
  navigated: boolean;
}

export interface ViewPoolEvents {
  state: (state: ViewState) => void;
}

const MIN_BOUNDS: ViewBounds = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Owns every account WebContentsView. Views are long-lived: switching accounts
 * or opening a modal only toggles visibility, which keeps QR polling, login
 * redirects and page state intact. Views are destroyed only through LRU
 * eviction (never while visible or on a login page) or explicit removal.
 */
export class ViewPool extends EventEmitter {
  private readonly live = new Map<string, LiveView>();
  private maxLive: number;

  constructor(private readonly options: ViewPoolOptions) {
    super();
    this.maxLive = Math.max(2, Math.min(12, options.maxLive));
  }

  setMaxLive(value: number): void {
    this.maxLive = Math.max(2, Math.min(12, value));
    this.evictIfNeeded(null);
  }

  has(accountId: string): boolean {
    return this.live.has(accountId);
  }

  listStates(): ViewState[] {
    return [...this.live.values()].map((entry) => this.toState(entry));
  }

  getState(accountId: string): ViewState | null {
    const entry = this.live.get(accountId);
    return entry ? this.toState(entry) : null;
  }

  /** WebContents for read-only in-session scripting (collectors, detectors). */
  getWebContents(accountId: string): WebContents | null {
    const entry = this.live.get(accountId);
    if (!entry || entry.view.webContents.isDestroyed()) return null;
    return entry.view.webContents;
  }

  getSession(accountId: string): ConfiguredSession | null {
    return this.live.get(accountId)?.session ?? null;
  }

  /**
   * Make sure a view exists for the account (hidden if new). Used by the
   * collectors so background work never has to touch the visible pane.
   */
  ensure(account: ViewPoolAccount, opts: { navigate?: boolean } = {}): LiveView {
    let entry = this.live.get(account.id);
    if (entry && entry.view.webContents.isDestroyed()) {
      this.teardown(entry);
      entry = undefined;
    }
    if (!entry) {
      this.evictIfNeeded(account.id);
      entry = this.create(account);
      this.live.set(account.id, entry);
    }
    entry.lastUsedAt = Date.now();
    if (opts.navigate !== false && !entry.navigated) {
      entry.navigated = true;
      void this.load(entry, getPlatform(account.platformId).routes.home);
    }
    return entry;
  }

  async show(account: ViewPoolAccount, bounds: ViewBounds): Promise<ViewState> {
    const entry = this.ensure(account);
    for (const other of this.live.values()) {
      if (other !== entry && other.visible) this.setVisible(other, false);
    }
    if (!entry.attached) {
      this.options.window.contentView.addChildView(entry.view);
      entry.attached = true;
    }
    this.applyBounds(entry, bounds);
    this.setVisible(entry, true);
    entry.lastUsedAt = Date.now();
    this.emitState(entry);
    return this.toState(entry);
  }

  hide(accountId: string): void {
    const entry = this.live.get(accountId);
    if (!entry) return;
    this.setVisible(entry, false);
    this.emitState(entry);
  }

  hideAll(): void {
    for (const entry of this.live.values()) {
      if (entry.visible) {
        this.setVisible(entry, false);
        this.emitState(entry);
      }
    }
  }

  setBounds(accountId: string, bounds: ViewBounds): void {
    const entry = this.live.get(accountId);
    if (!entry) return;
    this.applyBounds(entry, bounds);
  }

  async navigate(accountId: string, url: string): Promise<void> {
    const entry = this.live.get(accountId);
    if (!entry) throw new Error("view-not-live");
    entry.navigated = true;
    await this.load(entry, url);
  }

  reload(accountId: string): void {
    this.live.get(accountId)?.view.webContents.reload();
  }

  back(accountId: string): void {
    const wc = this.live.get(accountId)?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(accountId: string): void {
    const wc = this.live.get(accountId)?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  stop(accountId: string): void {
    this.live.get(accountId)?.view.webContents.stop();
  }

  openDevTools(accountId: string): void {
    this.live.get(accountId)?.view.webContents.openDevTools({ mode: "detach" });
  }

  /** Destroy the view (partition data is retained). */
  remove(accountId: string): void {
    const entry = this.live.get(accountId);
    if (!entry) return;
    this.teardown(entry);
    this.live.delete(accountId);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((entry) => entry.cookieGuard.flush()));
  }

  dispose(): void {
    for (const entry of this.live.values()) this.teardown(entry);
    this.live.clear();
  }

  /* ------------------------------------------------------------------ */

  private create(account: ViewPoolAccount): LiveView {
    const session = configureAccountSession(account.id, account.platformId);
    const view = new WebContentsView({
      webPreferences: {
        partition: session.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        // Hidden views must keep running timers so QR polling and login
        // callbacks complete while the operator looks at another account.
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        defaultFontFamily: { standard: "Microsoft YaHei", sansSerif: "Microsoft YaHei" },
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);

    const entry: LiveView = {
      account,
      view,
      session,
      cookieGuard: new CookieGuard(session.session, account.platformId, {
        onSessionCookiesChanged: () => this.options.onActivity?.(account.id, "cookies"),
      }),
      disposeNavigation: () => undefined,
      attached: false,
      visible: false,
      lastUsedAt: Date.now(),
      lastError: null,
      bounds: null,
      navigated: false,
    };
    entry.disposeNavigation = installNavigationPolicy(view.webContents, account.platformId);
    this.bindEvents(entry);
    void entry.cookieGuard.persistExisting();
    return entry;
  }

  private bindEvents(entry: LiveView): void {
    const wc = entry.view.webContents;
    const emit = () => this.emitState(entry);
    wc.on("did-start-loading", emit);
    wc.on("did-stop-loading", () => {
      emit();
      this.options.onActivity?.(entry.account.id, "loaded");
    });
    wc.on("did-navigate", () => {
      entry.lastError = null;
      emit();
      this.options.onActivity?.(entry.account.id, "navigated");
    });
    wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
      if (isMainFrame) {
        emit();
        this.options.onActivity?.(entry.account.id, "navigated");
      }
    });
    wc.on("page-title-updated", emit);
    wc.on("did-fail-load", (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      entry.lastError = `${code}: ${description}`;
      emit();
    });
    wc.on("render-process-gone", (_e, details) => {
      entry.lastError = `renderer:${details.reason}`;
      emit();
      // The next show() will rebuild the view against the same partition.
      setTimeout(() => {
        if (this.live.get(entry.account.id) === entry && !entry.visible) this.remove(entry.account.id);
      }, 0);
    });
    wc.on("destroyed", () => {
      if (this.live.get(entry.account.id) === entry) this.live.delete(entry.account.id);
    });
    wc.on("focus", () => {
      entry.lastUsedAt = Date.now();
    });
  }

  private async load(entry: LiveView, url: string): Promise<void> {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    try {
      await wc.loadURL(url);
    } catch (error) {
      const code = (error as { errno?: number; code?: string }).errno ?? (error as { code?: string }).code;
      // ERR_ABORTED is Chromium's "superseded by another navigation" and is
      // routine on login shells that redirect client-side.
      if (code === -3 || String(code) === "ERR_ABORTED") return;
      entry.lastError = error instanceof Error ? error.message : String(error);
      this.emitState(entry);
    }
  }

  private applyBounds(entry: LiveView, bounds: ViewBounds): void {
    const clamped = clampBounds(bounds, this.options.window);
    entry.bounds = clamped;
    entry.view.setBounds(clamped);
  }

  private setVisible(entry: LiveView, visible: boolean): void {
    if (entry.visible === visible) return;
    entry.visible = visible;
    entry.view.setVisible(visible);
    if (visible && entry.bounds) entry.view.setBounds(entry.bounds);
    if (!visible) entry.view.setBounds(MIN_BOUNDS);
  }

  private evictIfNeeded(incomingId: string | null): void {
    const needed = incomingId && !this.live.has(incomingId) ? 1 : 0;
    while (this.live.size + needed > this.maxLive) {
      const candidates = [...this.live.values()]
        .filter((entry) => !entry.visible)
        .filter((entry) => !this.isOnLoginPage(entry))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const victim = candidates[0];
      if (!victim) break;
      this.remove(victim.account.id);
    }
  }

  private isOnLoginPage(entry: LiveView): boolean {
    const url = entry.view.webContents.isDestroyed() ? "" : entry.view.webContents.getURL();
    return (
      Boolean(url) &&
      (isLoginUrl(entry.account.platformId, url) || isVerificationUrl(entry.account.platformId, url))
    );
  }

  private teardown(entry: LiveView): void {
    entry.disposeNavigation();
    entry.cookieGuard.dispose();
    entry.session.dispose();
    try {
      if (entry.attached) this.options.window.contentView.removeChildView(entry.view);
    } catch {
      // window may be closing
    }
    try {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    } catch {
      // ignore
    }
    entry.attached = false;
    entry.visible = false;
  }

  private toState(entry: LiveView): ViewState {
    const wc = entry.view.webContents;
    const destroyed = wc.isDestroyed();
    const url = destroyed ? "" : wc.getURL();
    return {
      accountId: entry.account.id,
      attached: entry.attached,
      visible: entry.visible,
      url,
      title: destroyed ? "" : wc.getTitle(),
      loading: destroyed ? false : wc.isLoading(),
      canGoBack: destroyed ? false : wc.navigationHistory.canGoBack(),
      canGoForward: destroyed ? false : wc.navigationHistory.canGoForward(),
      isLoginPage: Boolean(url) && isLoginUrl(entry.account.platformId, url),
      isVerificationPage: Boolean(url) && isVerificationUrl(entry.account.platformId, url),
      lastError: entry.lastError,
    };
  }

  private emitState(entry: LiveView): void {
    this.emit("state", this.toState(entry));
  }
}

function clampBounds(bounds: ViewBounds, window: BaseWindow): ViewBounds {
  let { x, y, width, height } = bounds;
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  try {
    const content = window.getContentBounds();
    if (content.width > 0) {
      x = Math.min(x, content.width - 1);
      width = Math.min(width, content.width - x);
    }
    if (content.height > 0) {
      y = Math.min(y, content.height - 1);
      height = Math.min(height, content.height - y);
    }
  } catch {
    // window may be destroyed mid-resize
  }
  return { x, y, width, height };
}
