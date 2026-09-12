import { EventEmitter } from "node:events";
import type { BaseWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalEmbeddedBrowser, globalPartition } from "./global-embedded-browser";
import type { GlobalBrowserLaunchInput, ManagedGlobalBrowser } from "./global-browser-launcher";

const mocks = vi.hoisted(() => ({ sessions: new Map<string, any>(), views: [] as any[] }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    session: {
      fromPartition: vi.fn((partition: string) => {
        if (!mocks.sessions.has(partition))
          mocks.sessions.set(partition, {
            setProxy: vi.fn(async () => undefined),
            closeAllConnections: vi.fn(async () => undefined),
            clearHostResolverCache: vi.fn(async () => undefined),
            clearStorageData: vi.fn(async () => undefined),
            clearCache: vi.fn(async () => undefined),
            clearAuthCache: vi.fn(async () => undefined),
            cookies: { flushStore: vi.fn(async () => undefined) },
            setPermissionRequestHandler: vi.fn(),
            setPermissionCheckHandler: vi.fn(),
            setDevicePermissionHandler: vi.fn(),
            setDisplayMediaRequestHandler: vi.fn(),
            webRequest: { onBeforeRequest: vi.fn() },
          });
        return mocks.sessions.get(partition);
      }),
    },
    WebContentsView: class {
      webContents = Object.assign(new EventEmitter(), {
        isDestroyed: vi.fn(() => false),
        setWebRTCIPHandlingPolicy: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        loadURL: vi.fn(async () => undefined),
        close: vi.fn(),
        getURL: vi.fn(() => "https://studio.youtube.com/"),
      });
      setVisible = vi.fn();
      setBounds = vi.fn();
      constructor(readonly options: unknown) {
        mocks.views.push(this);
      }
    },
  };
});

const firstId = "8e65b156-a2ee-48ac-957e-2f990141c207";
const secondId = "8e65b156-a2ee-48ac-957e-2f990141c208";
const running: ManagedGlobalBrowser[] = [];
function fixture() {
  const window = {
    isDestroyed: vi.fn(() => false),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  };
  const manager = new GlobalEmbeddedBrowser(window as unknown as BaseWindow);
  async function open(id = firstId) {
    const abort = new AbortController();
    const input: GlobalBrowserLaunchInput = {
      transport: "system",
      accountId: id,
      platformId: "youtube",
      signal: abort.signal,
      assertCurrent: () => {
        if (abort.signal.aborted) throw new Error("PROXY_OFF");
      },
    };
    const browser = await manager.launch(input);
    running.push(browser);
    return { browser, abort, session: mocks.sessions.get(globalPartition(id)), view: mocks.views.at(-1) };
  }
  return { manager, window, open };
}
afterEach(async () => {
  await Promise.all(running.splice(0).map((browser) => browser.stop()));
  mocks.sessions.clear();
  mocks.views.length = 0;
  vi.clearAllMocks();
});

describe("in-app global website system transport", () => {
  it("uses a separate persistent system-proxy session per account", async () => {
    const f = fixture();
    const first = await f.open(),
      second = await f.open(secondId);
    expect(first.session).not.toBe(second.session);
    expect(first.session.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(second.session.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(first.view.options.webPreferences).toMatchObject({
      session: first.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(first.view.webContents.loadURL).toHaveBeenCalledWith("https://studio.youtube.com/");
  });

  it("blocks new requests immediately on proxy-off and closes views without clearing login storage", async () => {
    const f = fixture(),
      current = await f.open();
    const request = current.session.webRequest.onBeforeRequest.mock.calls[0][0];
    const callback = vi.fn();
    request({ url: "https://accounts.google.com/" }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: false });
    request({ url: "https://creator.douyin.com/" }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    request({ url: "http://studio.youtube.com/" }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    current.abort.abort();
    request({ url: "https://accounts.google.com/" }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    await current.browser.closed;
    expect(current.view.webContents.close).toHaveBeenCalledOnce();
    expect(f.window.contentView.removeChildView).toHaveBeenCalledWith(current.view);
    expect(current.session.clearStorageData).toHaveBeenCalledExactlyOnceWith({
      storages: ["serviceworkers"],
    });
    expect(current.session.clearCache).not.toHaveBeenCalled();
    expect(current.session.clearAuthCache).not.toHaveBeenCalled();
    expect(current.session.cookies.flushStore).toHaveBeenCalledOnce();
    await f.open(); // The account can reuse the same saved session after cleanup.
  });

  it("releases popup references without reading a destroyed BrowserWindow getter", async () => {
    const f = fixture(),
      current = await f.open();
    const popup = new EventEmitter();
    const contents = Object.assign(new EventEmitter(), {
      setWebRTCIPHandlingPolicy: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    });
    Object.defineProperty(popup, "webContents", { configurable: true, get: () => contents });
    current.view.webContents.emit("did-create-window", popup);
    Object.defineProperty(popup, "webContents", {
      get: () => {
        throw new Error("destroyed getter");
      },
    });
    expect(() => popup.emit("closed")).not.toThrow();
  });

  it("reports a failed main document and releases its view for a retry", async () => {
    const f = fixture(),
      current = await f.open();
    current.view.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://studio.youtube.com/",
      true,
    );
    await expect(current.browser.closed).rejects.toThrow("GLOBAL_WEB_BROWSER_UNAVAILABLE");
    await current.browser.stop();
    expect(f.window.contentView.removeChildView).toHaveBeenCalledWith(current.view);
    expect(current.view.webContents.close).toHaveBeenCalledOnce();
    await f.open();
  });

  it("keeps the page open for subresource failures and aborted main-frame redirects", async () => {
    const f = fixture(),
      current = await f.open();
    current.view.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://i.ytimg.com/image.png",
      false,
    );
    current.view.webContents.emit(
      "did-fail-load",
      {},
      -3,
      "ERR_ABORTED",
      "https://accounts.google.com/",
      true,
    );
    await Promise.resolve();
    expect(current.view.webContents.close).not.toHaveBeenCalled();
    expect(f.window.contentView.removeChildView).not.toHaveBeenCalled();
  });
});
