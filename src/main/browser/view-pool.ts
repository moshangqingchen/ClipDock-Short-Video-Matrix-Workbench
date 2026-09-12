import { EventEmitter } from "node:events";
import { WebContentsView, type BaseWindow, type WebContents } from "electron";
import { getPlatform, isLoginUrl, isVerificationUrl, platformEntryUrl, type PlatformId } from "@shared/platforms";
import type { ViewBounds, ViewState } from "@shared/types";
import { configureAccountSession, type ConfiguredSession } from "./account-session";
import { CookieGuard } from "./cookie-guard";
import { IdentityObserver } from "./identity-observer";
import type { IdentityEvidence } from "./identity-evidence";
import { closeAccountView } from "@main/network/close-account-view";
import { installNavigationPolicy } from "./navigation-policy";
import {
  assertBusinessNetwork,
  beginBusinessOperation,
  bindAccountWebContents,
  canUseBusinessNetwork,
  isNetworkDormantError,
  NetworkDormantError,
} from "@main/network/business-access";

export interface ViewPoolAccount {
  id: string;
  platformId: PlatformId;
}

export interface ViewPoolOptions {
  window: BaseWindow;
  maxLive: number;
  /** Hook for status detection: fired after navigation settles or cookies change. */
  onActivity?: (accountId: string, reason: "navigated" | "cookies" | "loaded" | "identity") => void;
}

interface LiveView {
  account: ViewPoolAccount;
  view: WebContentsView;
  /** Keep the original handle: Electron clears view.webContents during destruction. */
  webContents: WebContents;
  session: ConfiguredSession;
  cookieGuard: CookieGuard | null;
  identityObserver: IdentityObserver | null;
  crashed: boolean;
  navigationVersion: number;
  pageVersion: number;
  disposeNavigation: () => void;
  disposeNetworkBinding: () => void;
  attached: boolean;
  visible: boolean;
  lastUsedAt: number;
  lastError: string | null;
  bounds: ViewBounds | null;
  /** Set once the first real navigation has been issued. */
  navigated: boolean;
  resourcesReleased: boolean;
  closePromise: Promise<void> | null;
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
  /** Includes hidden/evicted/closing views until Chromium confirms actual destruction. */
  private readonly owned = new Map<string, Set<LiveView>>();
  private maxLive: number;
  private disposed = false;
  private revision = 0;

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
    if (!entry || entry.crashed || entry.webContents.isDestroyed()) return null;
    return entry.webContents;
  }

  getSession(accountId: string): ConfiguredSession | null {
    return this.live.get(accountId)?.session ?? null;
  }

  getIdentityEvidence(accountId: string): IdentityEvidence | null {
    return this.live.get(accountId)?.identityObserver?.read() ?? null;
  }
  getIdentitySubject(accountId: string): string | null {
    return this.live.get(accountId)?.identityObserver?.readSubject() ?? null;
  }

  invalidateIdentity(accountId: string): void {
    this.live.get(accountId)?.identityObserver?.invalidate();
  }

  /**
   * Make sure a view exists for the account (hidden if new). Used by the
   * collectors so background work never has to touch the visible pane.
   */
  ensure(account: ViewPoolAccount, opts: { navigate?: boolean } = {}): LiveView {
    if (this.disposed) throw new NetworkDormantError("GATE_REVOKED");
    const present = this.live.get(account.id);
    const loadsHome =
      opts.navigate !== false && (!present || present.webContents.isDestroyed() || !present.navigated);
    assertBusinessNetwork(account.id, loadsHome ? getPlatform(account.platformId).routes.home : undefined);
    let entry = this.live.get(account.id);
    if (entry?.crashed) throw new Error("页面已退出，请点击重新加载");
    if (entry && entry.webContents.isDestroyed()) {
      this.releaseDestroyed(entry);
      entry = undefined;
    }
    if (
      [...(this.owned.get(account.id) ?? [])].some(
        (other) => other !== entry && !other.webContents.isDestroyed(),
      )
    )
      throw new NetworkDormantError("GATE_REVOKED");
    if (!entry) {
      this.evictIfNeeded(account.id);
      entry = this.create(account);
      this.live.set(account.id, entry);
    }
    entry.lastUsedAt = Date.now();
    if (opts.navigate !== false && !entry.navigated) {
      entry.navigated = true;
      void this.load(entry, getPlatform(account.platformId).routes.home).catch(() => undefined);
    }
    return entry;
  }

  async show(account: ViewPoolAccount, bounds: ViewBounds, enterHomepage = false): Promise<ViewState> {
    assertBusinessNetwork(account.id);
    const previous = this.live.get(account.id);
    if (previous?.crashed) {
      this.live.delete(account.id);
      await this.beginClose(previous);
    }
    const entry = this.ensure(account, { navigate: !enterHomepage });
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
    if (enterHomepage) {
      // Claim the foreground before loading so collectors cannot treat this
      // entry as a hidden page and redirect it into the creator console.
      // Page loading stays asynchronous, allowing account switches and an
      // explicit management click to supersede a slow homepage request.
      entry.navigated = true;
      void this.load(entry, platformEntryUrl(account.platformId)).catch(() => undefined);
    }
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
    assertBusinessNetwork(accountId, url);
    const entry = this.live.get(accountId);
    if (!entry) throw new Error("view-not-live");
    entry.navigated = true;
    await this.load(entry, url);
  }

  reload(accountId: string): void {
    const entry = this.live.get(accountId);
    if (entry?.crashed) {
      const { account, bounds, visible } = entry;
      this.live.delete(accountId);
      void this.beginClose(entry)
        .then(() => {
          if (visible && bounds) return this.show(account, bounds);
          this.ensure(account);
        })
        .catch(() => undefined);
      return;
    }
    const wc = this.getWebContents(accountId);
    assertBusinessNetwork(accountId, wc?.getURL());
    wc?.reload();
  }

  /** Read the exact pending history destination before an outer IPC declares navigation scope. */
  historyTarget(accountId: string, direction: "back" | "forward"): string | null {
    const wc = this.getWebContents(accountId);
    if (!wc || wc.isDestroyed()) return null;
    const history = wc.navigationHistory;
    if (direction === "back" ? !history.canGoBack() : !history.canGoForward()) return null;
    const index = history.getActiveIndex() + (direction === "back" ? -1 : 1);
    return history.getEntryAtIndex(index)?.url ?? null;
  }

  back(accountId: string): void {
    assertBusinessNetwork(accountId);
    const wc = this.getWebContents(accountId);
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(accountId: string): void {
    assertBusinessNetwork(accountId);
    const wc = this.getWebContents(accountId);
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  stop(accountId: string): void {
    this.getWebContents(accountId)?.stop();
  }

  openDevTools(accountId: string): void {
    this.getWebContents(accountId)?.openDevTools({ mode: "detach" });
  }

  /** Destroy the view (partition data is retained). */
  remove(accountId: string): void {
    const entry = this.live.get(accountId);
    if (!entry) return;
    this.live.delete(accountId);
    this.emitRemoved(entry, "destroyed");
    this.beginClose(entry);
  }

  /** Closing, not merely hiding/stopping, terminates the renderer's existing streams and WS. */
  suspendNetworkAccount(accountId: string): Promise<void> {
    const entries = [...(this.owned.get(accountId) ?? [])];
    if (!entries.length) return Promise.resolve();
    const live = this.live.get(accountId);
    const state = live ? this.toState(live) : null;
    this.live.delete(accountId);
    const closing = entries.map((entry) => this.beginClose(entry));
    if (state)
      this.emit("state", {
        ...state,
        attached: false,
        visible: false,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        lastError: "等待国内网络",
        lifecycle: "sleeping",
        revision: ++this.revision,
      } satisfies ViewState);
    return Promise.allSettled(closing).then((results) => {
      if (results.some((result) => result.status === "rejected"))
        throw new Error("ACCOUNT_VIEWS_CLOSE_FAILED");
    });
  }

  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.owned.values()].flatMap((entries) => [...entries].map((entry) => entry.cookieGuard?.flush())),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const entries of this.owned.values()) for (const entry of entries) this.beginClose(entry);
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
    const webContents = view.webContents;
    webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    const entry: LiveView = {
      account,
      view,
      webContents,
      session,
      cookieGuard: null,
      identityObserver: null,
      crashed: false,
      navigationVersion: 0,
      pageVersion: 0,
      disposeNavigation: () => undefined,
      disposeNetworkBinding: () => undefined,
      attached: false,
      visible: false,
      lastUsedAt: Date.now(),
      lastError: null,
      bounds: null,
      navigated: false,
      resourcesReleased: false,
      closePromise: null,
    };
    const owned = this.owned.get(account.id) ?? new Set<LiveView>();
    owned.add(entry);
    this.owned.set(account.id, owned);
    try {
      this.bindEvents(entry);
      view.setBackgroundColor("#ffffff");
      view.setVisible(false);
      entry.disposeNetworkBinding = bindAccountWebContents(webContents, account.id);
      entry.identityObserver = new IdentityObserver(webContents, account.id, account.platformId, () =>
        this.options.onActivity?.(account.id, "identity"),
      );
      entry.disposeNavigation = installNavigationPolicy(webContents, account.platformId, {
        allowNetwork: () => canUseBusinessNetwork(account.id),
      });
      entry.cookieGuard = new CookieGuard(session.session, account.platformId, {
        onSessionCookiesChanged: () => this.options.onActivity?.(account.id, "cookies"),
      });
      void entry.cookieGuard.persistExisting();
      return entry;
    } catch {
      // A native view created before another initializer failed still belongs to the revocation set.
      this.beginClose(entry);
      throw new Error("ACCOUNT_VIEW_INITIALIZATION_FAILED");
    }
  }

  private bindEvents(entry: LiveView): void {
    const wc = entry.webContents;
    const emit = () => this.emitState(entry);
    wc.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) entry.pageVersion++;
    });
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
      entry.crashed = true;
      entry.identityObserver?.invalidate();
      entry.lastError = `renderer:${details.reason}`;
      emit();
      // The next show() will rebuild the view against the same partition.
    });
    wc.on("destroyed", () => {
      this.releaseDestroyed(entry);
    });
    wc.on("focus", () => {
      entry.lastUsedAt = Date.now();
    });
  }

  private async load(entry: LiveView, url: string, retry = false): Promise<void> {
    const wc = entry.webContents;
    if (wc.isDestroyed()) return;
    const navigationVersion = ++entry.navigationVersion;
    let pageVersion = entry.pageVersion;
    const operation = beginBusinessOperation(entry.account.id, url);
    try {
      await entry.session.ready;
      operation.assertCurrent();
      if (wc.isDestroyed()) return;
      const loading = wc.loadURL(url);
      pageVersion = entry.pageVersion;
      await loading;
      operation.assertCurrent();
    } catch (error) {
      let failure = error;
      try {
        // Chromium commonly rejects a revoked load with ERR_ABORTED; inspect its lease before
        // treating that code as an ordinary platform redirect or superseding navigation.
        operation.assertCurrent();
      } catch (revoked) {
        failure = revoked;
      }
      if (isNetworkDormantError(failure)) {
        entry.lastError = "等待国内网络";
        this.emitState(entry);
        throw failure;
      }
      if (failure !== error) throw failure;
      const code = (error as { errno?: number; code?: string }).errno ?? (error as { code?: string }).code;
      // ERR_ABORTED is Chromium's "superseded by another navigation" and is
      // routine on login shells that redirect client-side.
      if (code === -3 || String(code) === "ERR_ABORTED") return;
      entry.lastError = error instanceof Error ? error.message : String(error);
      this.emitState(entry);
      if (
        !retry &&
        [-105, -106, -118, -101, -102].includes(Number(code)) &&
        navigationVersion === entry.navigationVersion &&
        pageVersion === entry.pageVersion &&
        !wc.isDestroyed() &&
        canUseBusinessNetwork(entry.account.id)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (
          navigationVersion === entry.navigationVersion &&
          pageVersion === entry.pageVersion &&
          !wc.isDestroyed() &&
          canUseBusinessNetwork(entry.account.id)
        )
          await this.load(entry, url, true);
      }
    } finally {
      operation.release();
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
    const url = entry.webContents.isDestroyed() ? "" : entry.webContents.getURL();
    return (
      Boolean(url) &&
      (isLoginUrl(entry.account.platformId, url) || isVerificationUrl(entry.account.platformId, url))
    );
  }

  private detach(entry: LiveView): void {
    try {
      if (entry.attached) this.options.window.contentView.removeChildView(entry.view);
    } catch {
      // window may be closing
    }
    entry.attached = false;
    entry.visible = false;
  }

  private beginClose(entry: LiveView): Promise<void> {
    if (entry.closePromise) return entry.closePromise;
    entry.identityObserver?.dispose();
    entry.identityObserver = null;
    entry.navigationVersion++;
    this.detach(entry);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    entry.closePromise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // LRU/remove are synchronous callers, but subsequent revocation must retain any failure.
    void entry.closePromise.catch(() => undefined);
    try {
      void closeAccountView(entry.webContents).then(
        () => {
          this.releaseDestroyed(entry);
          resolve();
        },
        () => reject(new Error("ACCOUNT_VIEW_CLOSE_FAILED")),
      );
    } catch {
      reject(new Error("ACCOUNT_VIEW_CLOSE_FAILED"));
    }
    return entry.closePromise;
  }

  private releaseDestroyed(entry: LiveView): void {
    if (!entry.webContents.isDestroyed()) return;
    this.detach(entry);
    if (!entry.resourcesReleased) {
      entry.resourcesReleased = true;
      for (const release of [
        () => entry.identityObserver?.dispose(),
        entry.disposeNavigation,
        entry.disposeNetworkBinding,
        () => entry.cookieGuard?.dispose(),
        () => entry.session.dispose(),
      ]) {
        try {
          release();
        } catch {
          /* Destruction was confirmed; release all remaining local listeners. */
        }
      }
    }
    if (this.live.get(entry.account.id) === entry) {
      this.live.delete(entry.account.id);
      this.emitRemoved(entry, "destroyed");
    }
    const owned = this.owned.get(entry.account.id);
    owned?.delete(entry);
    if (owned?.size === 0) this.owned.delete(entry.account.id);
  }

  private toState(entry: LiveView): ViewState {
    const wc = entry.webContents;
    const destroyed = wc.isDestroyed();
    const url = destroyed ? "" : wc.getURL();
    return {
      accountId: entry.account.id,
      lifecycle: destroyed ? "destroyed" : entry.crashed ? "crashed" : wc.isLoading() ? "loading" : "ready",
      revision: ++this.revision,
      instanceId: wc.id,
      navigationId: entry.pageVersion,
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
    if (this.live.get(entry.account.id) !== entry) return;
    this.emit("state", this.toState(entry));
  }

  private emitRemoved(entry: LiveView, lifecycle: "destroyed" | "sleeping"): void {
    this.emit("state", {
      ...this.toState(entry),
      lifecycle,
      attached: false,
      visible: false,
      loading: false,
    });
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
