import type { ChromePageState } from "./chrome-cdp";
import { globalUploadInput } from "./global-upload-input";
import { globalPageScript, type GlobalPageRead } from "@main/data/global-web-page";
import { session, WebContentsView, type BaseWindow, type Session, type WebContents } from "electron";
import path from "node:path";
import { globalAccountIdSchema } from "@shared/global-accounts";
import { globalWebRoute } from "@shared/global-platforms";
import { GLOBAL_WEB_ENTRY_URLS, isGlobalWebHost } from "@main/network/global-web-target-policy";
import type { GlobalPlatformId } from "@shared/platforms";
import type { GlobalBrowserLaunchInput, ManagedGlobalBrowser } from "./global-browser-launcher";
import {
  GLOBAL_PAGE_TEXT_SCRIPT,
  observationPage,
  type GlobalPageText,
} from "@main/data/global-web-observation";

export function globalPartition(id: string): string {
  return `persist:sv-global-account-${globalAccountIdSchema.parse(id).toLowerCase()}`;
}

export function allowGlobalUrl(platform: GlobalPlatformId, raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      isGlobalWebHost(platform, url.hostname)
    );
  } catch {
    return false;
  }
}

/** One isolated Electron Session per account, stopped when its network mode is withdrawn. */
export class GlobalEmbeddedBrowser {
  private readonly active = new Map<string, ManagedGlobalBrowser>();
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly window: BaseWindow) {}

  async wipe(id: string): Promise<void> {
    if (this.active.has(id)) throw new Error("GLOBAL_WEB_CLEANUP_FAILED");
    const ses = this.sessions.get(id) ?? session.fromPartition(globalPartition(id));
    await ses.closeAllConnections();
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    await ses.clearHostResolverCache();
    await ses.cookies.flushStore();
  }

  async launch(input: GlobalBrowserLaunchInput): Promise<ManagedGlobalBrowser> {
    const id = globalAccountIdSchema.parse(
      input.transport === "system" ? input.accountId : path.basename(input.profile.directory),
    );
    if (this.active.has(id) || this.window.isDestroyed()) throw new Error("GLOBAL_WEB_PROFILE_BUSY");
    input.assertCurrent();
    if (input.transport !== "system") await input.profile.assertCurrent();
    const ses = session.fromPartition(globalPartition(id), { cache: true });
    this.sessions.set(id, ses);
    // Follow the user's system proxy/TUN for website sessions; the switch lease gates all requests.
    await ses.setProxy(
      input.transport === "system"
        ? { mode: "system" }
        : {
            mode: "fixed_servers",
            proxyRules: `http=127.0.0.1:${input.endpoint.port};https=127.0.0.1:${input.endpoint.port}`,
            proxyBypassRules: "<-loopback>",
          },
    );
    await ses.closeAllConnections();
    await ses.clearHostResolverCache();
    input.assertCurrent();
    const permitted = () => {
      try {
        input.assertCurrent();
        return !input.signal.aborted;
      } catch {
        return false;
      }
    };
    ses.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(permitted() && ["clipboard-sanitized-write", "fullscreen"].includes(permission)),
    );
    ses.setPermissionCheckHandler(
      (_wc, permission) => permitted() && ["clipboard-sanitized-write", "fullscreen"].includes(permission),
    );
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.webRequest.onBeforeRequest((details, callback) => {
      // Local blob/data resources are usable; remote requests require a live network lease.
      const local = details.url.startsWith("blob:") || details.url.startsWith("data:");
      callback({
        cancel:
          !permitted() ||
          (!local && !allowGlobalUrl(input.platformId, details.url.replace(/^wss:/, "https:"))),
      });
    });
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: true,
        devTools: true,
      },
    });
    const wc = view.webContents;
    const popups = new Set<WebContents>();
    let stopped = false;
    let stopPromise: Promise<void> | null = null;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: Error) => void;
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    // A failure can arrive before the service has received the browser handle.
    void closed.catch(() => undefined);
    const guard = (contents: WebContents) => {
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      contents.on("will-navigate", (event, url) => {
        if (!permitted() || !allowGlobalUrl(input.platformId, url)) event.preventDefault();
      });
      contents.on("will-redirect", (event, url) => {
        if (!permitted() || !allowGlobalUrl(input.platformId, url)) event.preventDefault();
      });
      contents.setWindowOpenHandler(({ url }) => {
        if (!permitted() || !allowGlobalUrl(input.platformId, url)) return { action: "deny" };
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            parent: this.window,
            autoHideMenuBar: true,
            width: 700,
            height: 780,
            webPreferences: {
              session: ses,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webviewTag: false,
              devTools: true,
            },
          },
        };
      });
      contents.on("did-create-window", (popup) => {
        const popupContents = popup.webContents;
        popups.add(popupContents);
        guard(popupContents);
        popup.on("closed", () => popups.delete(popupContents));
      });
    };
    guard(wc);
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    const hide = () => {
      if (!stopped) view.setVisible(false);
    };
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopped = true;
      view.setVisible(false);
      for (const popup of popups) if (!popup.isDestroyed()) popup.close({ waitForBeforeUnload: false });
      popups.clear();
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
      stopPromise = (async () => {
        await ses.closeAllConnections();
        await ses.clearStorageData({ storages: ["serviceworkers"] });
        await ses.clearHostResolverCache();
        await ses.cookies.flushStore();
        this.active.delete(id);
        input.signal.removeEventListener("abort", onAbort);
        resolveClosed();
      })();
      return stopPromise;
    };
    const onAbort = () => {
      void stop().catch(() => undefined);
    };
    const pageListeners = new Set<(state: ChromePageState) => void>();
    const pageState = () => ({
      url: wc.isDestroyed() ? "" : wc.getURL(),
      title: wc.isDestroyed() ? "" : wc.getTitle(),
      loading: !wc.isDestroyed() && wc.isLoading(),
      canGoBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
      canGoForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
    });
    const changed = () => {
      for (const listener of pageListeners) listener(pageState());
    };
    wc.on("did-navigate", changed);
    wc.on("did-navigate-in-page", changed);
    wc.on("did-start-loading", changed);
    wc.on("did-stop-loading", changed);
    wc.on("page-title-updated", changed);
    const browser: ManagedGlobalBrowser = {
      getPageState: pageState,
      onPageState: (listener) => {
        pageListeners.add(listener);
        return () => pageListeners.delete(listener);
      },
      openDevTools: async () => {
        input.assertCurrent();
        wc.openDevTools({ mode: "detach" });
      },
      readIdentity: async () => {
        input.assertCurrent();
        const raw = (await wc.executeJavaScript(globalPageScript(input.platformId))) as GlobalPageRead;
        input.assertCurrent();
        return raw.identity;
      },
      navigateOfficial: async (url) => {
        input.assertCurrent();
        if (!allowGlobalUrl(input.platformId, url)) throw new Error("GLOBAL_WEB_ROUTE_UNAVAILABLE");
        await wc.loadURL(url);
      },
      readBackground: async (url) => {
        input.assertCurrent();
        if (!allowGlobalUrl(input.platformId, url)) throw new Error("GLOBAL_WEB_ROUTE_UNAVAILABLE");
        const background = new WebContentsView({
          webPreferences: {
            session: ses,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });
        const contents = background.webContents;
        popups.add(contents);
        guard(contents);
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        try {
          await contents.loadURL(url);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          input.assertCurrent();
          const raw = (await contents.executeJavaScript(
            globalPageScript(input.platformId),
          )) as GlobalPageRead;
          input.assertCurrent();
          return raw;
        } finally {
          popups.delete(contents);
          if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
        }
      },
      attachFiles: async (files) => {
        input.assertCurrent();
        const url = wc.getURL(),
          selector = globalUploadInput(input.platformId, url);
        if (!selector) throw new Error("请先进入官方上传页面");
        const already = wc.debugger.isAttached();
        if (!already) wc.debugger.attach("1.3");
        try {
          const { root } = await wc.debugger.sendCommand("DOM.getDocument", { depth: 0 });
          const { nodeId } = await wc.debugger.sendCommand("DOM.querySelector", {
            nodeId: root.nodeId,
            selector,
          });
          if (!nodeId) return 0;
          if (wc.getURL() !== url) throw new Error("页面已变化，请重新选择文件");
          input.assertCurrent();
          await wc.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files });
          return files.length;
        } finally {
          if (!already && wc.debugger.isAttached()) wc.debugger.detach();
        }
      },
      readPage: async () => {
        input.assertCurrent();
        if (stopped || wc.isDestroyed() || wc.isLoadingMainFrame())
          throw new Error("WEB_OBSERVE_UNAVAILABLE");
        const before = wc.getURL();
        if (!observationPage(input.platformId, before)) throw new Error("WEB_OBSERVE_PAGE_REQUIRED");
        const frame = wc.mainFrame;
        const raw = (await wc.executeJavaScript(GLOBAL_PAGE_TEXT_SCRIPT)) as GlobalPageText;
        input.assertCurrent();
        if (
          stopped ||
          wc.isDestroyed() ||
          wc.mainFrame !== frame ||
          wc.getURL() !== before ||
          raw.url !== before
        )
          throw new Error("WEB_OBSERVE_CANCELLED");
        return raw;
      },
      closed,
      stop,
      hide,
      show: (bounds) => {
        if (stopped || !permitted() || this.window.isDestroyed()) return;
        for (const [other, browser] of this.active) if (other !== id) browser.hide?.();
        const content = this.window.getContentBounds();
        const x = Math.max(0, Math.min(content.width, Math.round(bounds.x)));
        const y = Math.max(0, Math.min(content.height, Math.round(bounds.y)));
        view.setBounds({
          x,
          y,
          width: Math.max(0, Math.min(Math.round(bounds.width), content.width - x)),
          height: Math.max(0, Math.min(Math.round(bounds.height), content.height - y)),
        });
        view.setVisible(true);
      },
      go: async (capability) => {
        input.assertCurrent();
        let url = globalWebRoute(input.platformId, capability, wc.getURL());
        if (!url && input.platformId === "x" && capability === "works") {
          const identity = ((await wc.executeJavaScript(globalPageScript("x"))) as GlobalPageRead).identity;
          if (identity.status === "online" && /^[a-zA-Z0-9_]{1,15}$/.test(identity.subjectId ?? ""))
            url = "https://x.com/" + identity.subjectId;
        }
        input.assertCurrent();
        if (!url || !allowGlobalUrl(input.platformId, url)) throw new Error("GLOBAL_WEB_ROUTE_UNAVAILABLE");
        await wc.loadURL(url);
      },
      command: (command) => {
        input.assertCurrent();
        if (command === "reload") wc.reload();
        else if (command === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        else if (command === "forward" && wc.navigationHistory.canGoForward())
          wc.navigationHistory.goForward();
      },
    };
    this.active.set(id, browser);
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) {
      await stop();
      throw new Error("GLOBAL_WEB_PROXY_UNVERIFIED");
    }
    const failMainFrame = () => {
      if (stopped) return;
      rejectClosed(new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE"));
      void stop().catch(() => undefined);
    };
    wc.on("render-process-gone", failMainFrame);
    wc.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      // Redirect cancellations and failed optional resources must not close a usable page.
      if (isMainFrame && code !== -3) failMainFrame();
    });
    void wc.loadURL(GLOBAL_WEB_ENTRY_URLS[input.platformId]).catch((error: unknown) => {
      const failure = error as { code?: string; errno?: number } | null;
      if (failure?.code !== "ERR_ABORTED" && failure?.errno !== -3) failMainFrame();
    });
    return browser;
  }
}
