import { EventEmitter } from "node:events";
import { WebContentsView, type BaseWindow, type WebContents } from "electron";
import { getPlatform, isLoginUrl, isVerificationUrl, platformEntryUrl, type PlatformId } from "@shared/platforms";
import type { ViewBounds, ViewState } from "@shared/types";
import { configureAccountSession, type ConfiguredSession } from "./account-session";
import { CookieGuard, type CookieDiagnostic } from "./cookie-guard";
import { IdentityObserver } from "./identity-observer";
import { DouyinQrObserver, type DouyinQrDiagnostic } from "./douyin-qr-observer";
import { isHomepageContext } from "./homepage-login";
import { isHomepageRecheckSource } from "./homepage-recheck";
import { HomepageCheckHost } from "./homepage-check-host";
import { WorksRequestObserver } from "./works-request-observer";
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
  onCookieDiagnostic?: (accountId: string, diagnostic: CookieDiagnostic) => void;
  onQrDiagnostic?: (accountId: string, diagnostic: DouyinQrDiagnostic) => void;
}

interface LiveView {
  qrObserver?: DouyinQrObserver;
  worksObserver?: WorksRequestObserver;
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
  checkHostAttached: boolean;
  visible: boolean;
  messageMode: boolean;
  lastUsedAt: number;
  homepageRetainUntil: number;
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
// Public sites can show their QR dialog without changing the page URL.
const HOMEPAGE_SWITCH_GRACE_MS = 2 * 60_000;
const HOMEPAGE_CHECK_TIMEOUT_MS = 12_000;
const HOMEPAGE_CHECK_BOUNDS: ViewBounds = { x: 0, y: 0, width: 1280, height: 800 };

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
  private homepageEvictionTimer: ReturnType<typeof setTimeout> | undefined;
  /** Temporary canonical views, never an extra renderer in the same account partition. */
  private readonly homepageCheckEntries = new Map<string, {
    entry: LiveView; navigationVersion: number; pageVersion: number;
  }>();
  private readonly homepageCheckPresentation = new Map<string, {
    entry: LiveView; bounds: ViewBounds; muted: boolean; attached: boolean;
  }>();
  private readonly homepageCheckHost = new HomepageCheckHost();

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
  getWorksRequest(accountId: string) {
    return this.live.get(accountId)?.worksObserver?.read() ?? null;
  }

  getState(accountId: string): ViewState | null {
    const entry = this.live.get(accountId);
    return entry ? this.toState(entry) : null;
  }

  /** Official messaging owns this page until an explicit user navigation leaves it. */
  setMessageMode(accountId: string, enabled: boolean): void {
    const entry = this.live.get(accountId);
    if (!entry || entry.webContents.isDestroyed()) throw new Error("view-not-live");
    if (enabled) this.abandonHomepageCheck(accountId);
    if (entry.messageMode === enabled) return;
    entry.messageMode = enabled;
    // Invalidate delayed loads before a message navigation is issued. In
    // particular, session initialization may still be holding an old collector load.
    entry.navigationVersion++;
    if (enabled && entry.webContents.isLoading()) entry.webContents.stop();
    this.emitState(entry);
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

  /** Eligibility only; callers must declare the exact homepage network scope before rechecking. */
  canCheckHomepage(accountId: string, platformId: PlatformId): boolean {
    if (this.disposed || !getPlatform(platformId).routes.site) return false;
    const entry = this.live.get(accountId);
    if ([...(this.owned.get(accountId) ?? [])].some((owned) =>
      owned !== entry && !owned.webContents.isDestroyed())) return false;
    // Background checks must not cause the ordinary LRU to evict another account's draft.
    if (!entry) return this.live.size < this.maxLive;
    return entry.account.platformId === platformId && !entry.crashed && !entry.closePromise &&
      !entry.visible && !entry.messageMode && !entry.webContents.isDestroyed() &&
      !entry.webContents.isLoading() && isHomepageRecheckSource(platformId, entry.webContents.getURL());
  }

  /** One bounded homepage load; it never refreshes a homepage that already exists. */
  async recheckHomepage(account: ViewPoolAccount): Promise<boolean> {
    if (!this.canCheckHomepage(account.id, account.platformId)) return false;
    const url = getPlatform(account.platformId).routes.site!;
    assertBusinessNetwork(account.id, url);
    const created = !this.live.has(account.id);
    const entry = this.ensure(account, { navigate: false });
    const wc = entry.webContents;
    const initialUrl = wc.getURL();
    let navigationVersion = entry.navigationVersion;
    let pageVersion = entry.pageVersion;
    let issued = false, cancelled = false, firstNavigation = false;
    if (created) this.homepageCheckEntries.set(account.id, { entry, navigationVersion, pageVersion });
    const operation = beginBusinessOperation(account.id, url);
    const owned = () => !this.disposed && this.live.get(account.id) === entry &&
      !entry.closePromise && !entry.crashed && !wc.isDestroyed() &&
      !entry.visible && !entry.messageMode && entry.navigationVersion === navigationVersion &&
      entry.pageVersion === pageVersion;
    const onNavigation = (_event: unknown, target: string, inPlace: boolean, mainFrame: boolean) => {
      if (issued && !firstNavigation && mainFrame && !inPlace && target === url &&
          entry.navigationVersion === navigationVersion) {
        firstNavigation = true;
        pageVersion = entry.pageVersion;
      }
    };
    wc.on("did-start-navigation", onNavigation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const interrupted = new Promise<boolean>((resolve) => {
      cancel = () => {
        cancelled = true;
        // Never stop a user's new navigation, an adopted page, or a QR redirect.
        if (issued && owned()) wc.stop();
        resolve(issued);
      };
      timer = setTimeout(cancel, HOMEPAGE_CHECK_TIMEOUT_MS);
    });
    const onState = (state: ViewState) => {
      if (state.accountId === account.id && (state.visible || state.messageMode ||
          this.live.get(account.id) !== entry)) cancel();
    };
    this.on("state", onState);
    operation.signal.addEventListener("abort", cancel, { once: true });
    try {
      const navigate = async () => {
        await entry.session.ready;
        if (cancelled) return issued;
        operation.assertCurrent();
        if (!owned() || wc.getURL() !== initialUrl ||
            !this.canCheckHomepage(account.id, account.platformId)) return false;
        const priorPresentation = this.homepageCheckPresentation.get(account.id);
        this.homepageCheckPresentation.set(account.id, priorPresentation?.entry === entry
          ? priorPresentation : { entry, bounds: entry.view.getBounds(), muted: wc.isAudioMuted(), attached: entry.attached });
        // Hidden pooled pages otherwise have a 1×1 viewport. Give the official
        // header a usable layout and silence video autoplay until observation ends.
        wc.setAudioMuted(true);
        if (entry.attached) {
          this.options.window.contentView.removeChildView(entry.view);
          entry.attached = false;
        }
        entry.view.setBounds(HOMEPAGE_CHECK_BOUNDS);
        this.homepageCheckHost.attach(entry.view);
        entry.checkHostAttached = true;
        entry.navigated = true;
        navigationVersion = ++entry.navigationVersion;
        const temporary = this.homepageCheckEntries.get(account.id);
        if (temporary?.entry === entry) temporary.navigationVersion = navigationVersion;
        issued = true;
        try {
          await wc.loadURL(url);
        } catch {
          // Official redirects/abort/errors are inspected by the later DOM check.
          // No automatic retry: it could generate a second login QR challenge.
        }
        if (!cancelled) operation.assertCurrent();
        return issued;
      };
      if (operation.signal.aborted) cancel();
      return await Promise.race([navigate(), interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      operation.signal.removeEventListener("abort", cancel);
      this.removeListener("state", onState);
      wc.removeListener("did-start-navigation", onNavigation);
      operation.release();
    }
  }

  /** Release only a never-shown view created by recheckHomepage, after its DOM observation. */
  async finishHomepageCheck(accountId: string): Promise<void> {
    const temporary = this.homepageCheckEntries.get(accountId);
    this.homepageCheckEntries.delete(accountId);
    if (temporary) {
      const { entry, navigationVersion, pageVersion } = temporary;
      if (this.live.get(accountId) === entry && !entry.visible && !entry.messageMode &&
          entry.navigationVersion === navigationVersion && entry.pageVersion === pageVersion) {
        // Do not briefly unmute an autoplaying temporary page before asynchronous destruction.
        this.homepageCheckPresentation.delete(accountId);
        this.live.delete(accountId);
        this.emitRemoved(entry, "destroyed");
        await this.beginClose(entry);
        return;
      }
    }
    const presentation = this.homepageCheckPresentation.get(accountId);
    if (presentation && this.live.get(accountId) === presentation.entry &&
        !presentation.entry.visible && !presentation.entry.messageMode &&
        !presentation.entry.webContents.isDestroyed()) {
      // The original management page is now a video homepage. Restore its hidden
      // viewport, but preserve the original audio preference until a real takeover.
      this.restoreHomepageCheckPresentation(presentation, false);
      return;
    }
    this.abandonHomepageCheck(accountId);
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
      void this.load(entry, getPlatform(account.platformId).routes.home, false, true).catch(() => undefined);
    }
    return entry;
  }

  async show(account: ViewPoolAccount, bounds: ViewBounds, enterHomepage = false): Promise<ViewState> {
    this.abandonHomepageCheck(account.id);
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
    if (enterHomepage && !entry.navigated) {
      // Claim the foreground before loading so collectors cannot treat this
      // entry as a hidden page and redirect it into the creator console.
      // Re-entering an existing account only restores its live page, including
      // QR dialogs and in-progress login redirects. go/navigate are explicit.
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
    if (entry.checkHostAttached) {
      entry.bounds = clampBounds(bounds, this.options.window);
      return;
    }
    // A queued ResizeObserver update can arrive before show() claims the page.
    if (entry.visible) this.abandonHomepageCheck(accountId);
    this.applyBounds(entry, bounds);
  }

  async navigate(accountId: string, url: string, options: { background?: boolean } = {}): Promise<void> {
    assertBusinessNetwork(accountId, url);
    const entry = this.live.get(accountId);
    if (!entry) throw new Error("view-not-live");
    if (options.background && entry.messageMode) return;
    this.abandonHomepageCheck(accountId);
    entry.navigated = true;
    await this.load(entry, url, false, options.background);
  }

  reload(accountId: string): void {
    this.abandonHomepageCheck(accountId);
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
    this.abandonHomepageCheck(accountId);
    assertBusinessNetwork(accountId);
    const wc = this.getWebContents(accountId);
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(accountId: string): void {
    this.abandonHomepageCheck(accountId);
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
    if (this.homepageEvictionTimer) clearTimeout(this.homepageEvictionTimer);
    const closing = [...this.owned.values()].flatMap((entries) => [...entries].map((entry) => this.beginClose(entry)));
    this.live.clear();
    // beginClose detaches every child first. Retain native ownership until the
    // close results settle, then destroy the now-empty hidden layout host.
    void Promise.allSettled(closing).then(() => this.homepageCheckHost.dispose());
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
      checkHostAttached: false,
      visible: false,
      messageMode: false,
      lastUsedAt: Date.now(),
      homepageRetainUntil: 0,
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
        this.reportActivity(entry, "identity"),
      );
      if (account.platformId === "weixin_channels") entry.worksObserver = new WorksRequestObserver(webContents, account.id);
      if (account.platformId === "douyin") entry.qrObserver = new DouyinQrObserver(webContents, account.id,
        (diagnostic) => this.options.onQrDiagnostic?.(account.id, diagnostic));
      entry.disposeNavigation = installNavigationPolicy(webContents, account.platformId, {
        allowNetwork: () => canUseBusinessNetwork(account.id),
      });
      entry.cookieGuard = new CookieGuard(session.session, account.platformId, {
        onSessionCookiesChanged: () => this.reportActivity(entry, "cookies"),
        onDiagnostic: (diagnostic) => this.options.onCookieDiagnostic?.(account.id, diagnostic),
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
      if (mainFrame) {
        entry.pageVersion++;
        const temporary = this.homepageCheckEntries.get(entry.account.id);
        if (temporary?.entry === entry && temporary.navigationVersion === entry.navigationVersion)
          temporary.pageVersion = entry.pageVersion;
      }
    });
    wc.on("did-start-loading", emit);
    wc.on("did-stop-loading", () => {
      emit();
      this.reportActivity(entry, "loaded");
    });
    wc.on("did-navigate", () => {
      entry.lastError = null;
      emit();
      this.reportActivity(entry, "navigated");
    });
    wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
      if (isMainFrame) {
        emit();
        this.reportActivity(entry, "navigated");
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

  private async load(entry: LiveView, url: string, retry = false, background = false): Promise<void> {
    this.abandonHomepageCheck(entry.account.id);
    const wc = entry.webContents;
    if (wc.isDestroyed()) return;
    const navigationVersion = ++entry.navigationVersion;
    let pageVersion = entry.pageVersion;
    const operation = beginBusinessOperation(entry.account.id, url);
    try {
      await entry.session.ready;
      operation.assertCurrent();
      if (wc.isDestroyed() || entry.closePromise || navigationVersion !== entry.navigationVersion ||
          background && entry.messageMode) return;
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
        if (navigationVersion === entry.navigationVersion && !entry.closePromise) {
          entry.lastError = "等待国内网络";
          this.emitState(entry);
        }
        throw failure;
      }
      if (failure !== error) throw failure;
      if (navigationVersion !== entry.navigationVersion || entry.closePromise || background && entry.messageMode) return;
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
          await this.load(entry, url, true, background);
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
    entry.homepageRetainUntil = !visible && isHomepageContext(entry.account.platformId, entry.webContents.getURL())
      ? Date.now() + HOMEPAGE_SWITCH_GRACE_MS : 0;
    entry.view.setVisible(visible);
    if (visible && entry.bounds) entry.view.setBounds(entry.bounds);
    if (!visible) entry.view.setBounds(MIN_BOUNDS);
    this.scheduleHomepageEviction();
  }

  private evictIfNeeded(incomingId: string | null): void {
    const needed = incomingId && !this.live.has(incomingId) ? 1 : 0;
    while (this.live.size + needed > this.maxLive) {
      const candidates = [...this.live.values()]
        .filter((entry) => !entry.visible)
        .filter((entry) => !entry.messageMode)
        .filter((entry) => !this.isOnLoginPage(entry))
        .filter((entry) => entry.homepageRetainUntil <= Date.now())
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const victim = candidates[0];
      if (!victim) break;
      this.remove(victim.account.id);
    }
    this.scheduleHomepageEviction();
  }

  private scheduleHomepageEviction(): void {
    if (this.homepageEvictionTimer) clearTimeout(this.homepageEvictionTimer);
    this.homepageEvictionTimer = undefined;
    if (this.disposed) return;
    const deadlines = [...this.live.values()]
      .filter((entry) => !entry.visible && entry.homepageRetainUntil > Date.now())
      .map((entry) => entry.homepageRetainUntil);
    if (!deadlines.length) return;
    this.homepageEvictionTimer = setTimeout(() => {
      this.homepageEvictionTimer = undefined;
      this.evictIfNeeded(null);
    }, Math.max(1, Math.min(...deadlines) - Date.now()));
  }

  private isOnLoginPage(entry: LiveView): boolean {
    const url = entry.webContents.isDestroyed() ? "" : entry.webContents.getURL();
    return (
      Boolean(url) &&
      (isLoginUrl(entry.account.platformId, url) || isVerificationUrl(entry.account.platformId, url))
    );
  }

  private detach(entry: LiveView): void {
    if (entry.checkHostAttached) {
      this.homepageCheckHost.detach(entry.view);
      entry.checkHostAttached = false;
    }
    try {
      if (entry.attached) this.options.window.contentView.removeChildView(entry.view);
    } catch {
      // window may be closing
    }
    entry.attached = false;
    entry.visible = false;
  }

  private beginClose(entry: LiveView): Promise<void> {
    // A closing renderer must stay muted, including revocation and application shutdown.
    if (this.homepageCheckEntries.get(entry.account.id)?.entry === entry)
      this.homepageCheckEntries.delete(entry.account.id);
    if (this.homepageCheckPresentation.get(entry.account.id)?.entry === entry)
      this.homepageCheckPresentation.delete(entry.account.id);
    if (entry.closePromise) return entry.closePromise;
    entry.identityObserver?.dispose();
    entry.worksObserver?.dispose();
    entry.qrObserver?.dispose();
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
    if (entry.checkHostAttached) {
      this.homepageCheckHost.detach(entry.view);
      entry.checkHostAttached = false;
    }
    if (this.homepageCheckEntries.get(entry.account.id)?.entry === entry)
      this.homepageCheckEntries.delete(entry.account.id);
    if (this.homepageCheckPresentation.get(entry.account.id)?.entry === entry)
      this.homepageCheckPresentation.delete(entry.account.id);
    if (!entry.webContents.isDestroyed()) return;
    this.detach(entry);
    if (!entry.resourcesReleased) {
      entry.resourcesReleased = true;
      for (const release of [
        () => entry.identityObserver?.dispose(),
        () => entry.worksObserver?.dispose(),
        () => entry.qrObserver?.dispose(),
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

  private abandonHomepageCheck(accountId: string): void {
    this.homepageCheckEntries.delete(accountId);
    const presentation = this.homepageCheckPresentation.get(accountId);
    this.homepageCheckPresentation.delete(accountId);
    if (!presentation || this.live.get(accountId) !== presentation.entry ||
        presentation.entry.webContents.isDestroyed()) return;
    this.restoreHomepageCheckPresentation(presentation, true);
  }

  private restoreHomepageCheckPresentation(presentation: {
    entry: LiveView; bounds: ViewBounds; muted: boolean; attached: boolean;
  }, restoreAudio: boolean): void {
    const { entry } = presentation;
    if (entry.checkHostAttached) {
      this.homepageCheckHost.detach(entry.view);
      entry.checkHostAttached = false;
      if (presentation.attached) {
        this.options.window.contentView.addChildView(entry.view);
        entry.attached = true;
      }
      entry.view.setVisible(entry.visible);
    }
    entry.view.setBounds(presentation.bounds);
    if (restoreAudio) entry.webContents.setAudioMuted(presentation.muted);
  }

  private reportActivity(entry: LiveView, reason: "navigated" | "cookies" | "loaded" | "identity"): void {
    if (this.live.get(entry.account.id) === entry && !entry.closePromise &&
        !entry.webContents.isDestroyed()) this.options.onActivity?.(entry.account.id, reason);
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
      messageMode: entry.messageMode,
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
