import type { EventEmitter } from "node:events";
import type { ViewState } from "@shared/types";
import { PLATFORM_LIST, getPlatform } from "@shared/platforms";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBusinessNetwork, accountForWebContents } from "@main/network/business-access";

const fixtures = vi.hoisted(() => ({
  contents: [] as any[],
  guards: [] as any[],
  sessions: [] as any[],
  qrObservers: [] as any[],
  failGuard: false,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Contents extends EventEmitter {
    destroyed = false;
    url = "";
    stop = vi.fn();
    setWebRTCIPHandlingPolicy = vi.fn();
    close = vi.fn();
    navDispose = vi.fn();
    isDestroyed = () => this.destroyed;
    getURL = () => this.url;
    getTitle = () => "test page";
    isLoading = () => false;
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
    });
    destroy() {
      this.destroyed = true;
      this.emit("destroyed");
    }
  }
  return {
    WebContentsView: class {
      private readonly contents = new Contents();
      // Electron's view no longer exposes its WebContents inside the destroyed callback.
      get webContents() {
        return this.contents.destroyed ? undefined : this.contents;
      }
      setBackgroundColor = vi.fn();
      setVisible = vi.fn();
      setBounds = vi.fn();
      constructor() {
        fixtures.contents.push(this.contents);
      }
    },
  };
});
vi.mock("./account-session", () => ({
  configureAccountSession: (accountId: string) => {
    const session = {
      partition: `persist:test-${accountId}`,
      session: {},
      ready: Promise.resolve(),
      dispose: vi.fn(),
    };
    fixtures.sessions.push(session);
    return session;
  },
}));
vi.mock("./cookie-guard", () => ({
  CookieGuard: class {
    flush = vi.fn(async () => undefined);
    persistExisting = vi.fn(async () => undefined);
    dispose = vi.fn();
    constructor() {
      if (fixtures.failGuard) throw new Error("native initialization failure");
      fixtures.guards.push(this);
    }
  },
}));
vi.mock("./navigation-policy", () => ({
  installNavigationPolicy: (contents: { navDispose: () => void }) => contents.navDispose,
}));
vi.mock("./douyin-qr-observer", () => ({
  DouyinQrObserver: class {
    dispose = vi.fn();
    constructor(_contents: unknown, readonly accountId: string, readonly report: (value: unknown) => void) {
      fixtures.qrObservers.push(this);
    }
  },
}));

import { ViewPool } from "./view-pool";

interface FixtureContents extends EventEmitter {
  destroyed: boolean;
  stop: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  navDispose: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  destroy(): void;
}

describe("ViewPool ownership through actual destruction", () => {
  let restoreController: () => void;
  const pools: ViewPool[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    fixtures.contents.length = 0;
    fixtures.guards.length = 0;
    fixtures.sessions.length = 0;
    fixtures.qrObservers.length = 0;
    fixtures.failGuard = false;
    restoreController = installBusinessNetwork({
      enforcement: "observe",
      check: () => ({ allowed: false, reason: "CHECKING" }),
      acquire: () => null,
    });
  });
  afterEach(() => {
    for (const pool of pools.splice(0)) pool.dispose();
    for (const contents of fixtures.contents) if (!contents.destroyed) contents.destroy();
    restoreController();
    vi.useRealTimers();
  });
  const account = (id: string) => ({ id, platformId: "bilibili" as const });
  function fixture() {
    const pool = new ViewPool({
      maxLive: 2,
      window: { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } } as never,
    });
    pools.push(pool);
    const create = (id: string) => {
      pool.ensure(account(id), { navigate: false });
      return fixtures.contents.at(-1) as FixtureContents;
    };
    return { pool, create };
  }

  it("only attaches QR diagnostics to Douyin, without turning observations into account activity", async () => {
    const onActivity = vi.fn(), onQrDiagnostic = vi.fn();
    const pool = new ViewPool({ maxLive: 2, onActivity, onQrDiagnostic,
      window: { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } } as never });
    pools.push(pool);
    pool.ensure({ id: "douyin", platformId: "douyin" }, { navigate: false });
    pool.ensure({ id: "bilibili", platformId: "bilibili" }, { navigate: false });
    expect(fixtures.qrObservers).toHaveLength(1);
    fixtures.qrObservers[0].report({ stage: "get", httpStatus: 429 });
    expect(onQrDiagnostic).toHaveBeenCalledExactlyOnceWith("douyin", { stage: "get", httpStatus: 429 });
    expect(onActivity).not.toHaveBeenCalled();
    const closed = pool.suspendNetworkAccount("douyin");
    expect(fixtures.qrObservers[0].dispose).toHaveBeenCalled();
    fixtures.contents[0].destroy();
    await closed;
  });

  it.each(PLATFORM_LIST)("opens $id at its default foreground homepage without first loading management", async (platform) => {
    const f = fixture();
    const state = await f.pool.show(
      { id: "one", platformId: platform.id },
      { x: 0, y: 0, width: 640, height: 480 },
      true,
    );
    const expected = platform.routes.site ?? platform.routes.home;
    expect(state.visible).toBe(true);
    expect(f.pool.getState("one")?.url).toBe(expected);
    expect(fixtures.contents[0].loadURL).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("restores the current page on repeated account entry and still honors explicit navigation", async () => {
    const f = fixture();
    const wc = f.create("one");
    const bounds = { x: 0, y: 0, width: 640, height: 480 };
    const platform = getPlatform("bilibili");
    await f.pool.navigate("one", platform.routes.home);
    await f.pool.show(account("one"), bounds, false);
    expect(wc.loadURL).toHaveBeenCalledExactlyOnceWith(platform.routes.home);
    await f.pool.show(account("one"), bounds, true);
    expect(wc.loadURL).toHaveBeenCalledExactlyOnceWith(platform.routes.home);
    await f.pool.navigate("one", platform.routes.site!);
    expect(wc.loadURL).toHaveBeenCalledTimes(2);
    expect(wc.loadURL).toHaveBeenLastCalledWith(platform.routes.site);
    expect(fixtures.contents).toHaveLength(1);
  });

  it("switches away and back without reloading a public homepage QR dialog", async () => {
    const f = fixture();
    const bounds = { x: 0, y: 0, width: 640, height: 480 };
    const first = { id: "first", platformId: "douyin" as const };
    await f.pool.show(first, bounds, true);
    const wc = fixtures.contents[0];
    await f.pool.show(account("second"), bounds, true);
    await f.pool.show(first, bounds, true);
    expect(f.pool.getWebContents("first")).toBe(wc);
    expect(wc.loadURL).toHaveBeenCalledExactlyOnceWith(getPlatform("douyin").routes.site);
    expect(f.pool.getState("first")?.visible).toBe(true);
    expect(f.pool.getState("second")?.visible).toBe(false);
  });

  it("does not issue another homepage request while the first entry is still loading", async () => {
    const f = fixture();
    const wc = f.create("one");
    let complete!: () => void;
    wc.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    const bounds = { x: 0, y: 0, width: 640, height: 480 };
    await f.pool.show(account("one"), bounds, true);
    await f.pool.show(account("one"), bounds, true);
    expect(wc.loadURL).toHaveBeenCalledOnce();
    complete();
  });

  it("briefly protects a hidden homepage QR dialog, then evicts it without a background ensure renewing the grace", async () => {
    const f = fixture();
    const bounds = { x: 0, y: 0, width: 640, height: 480 };
    await f.pool.show(account("first"), bounds, true);
    const first = fixtures.contents[0];
    await f.pool.show(account("second"), bounds, true);
    await vi.advanceTimersByTimeAsync(60_000);
    f.pool.ensure(account("first"));
    await f.pool.show(account("third"), bounds, true);
    expect(f.pool.listStates()).toHaveLength(3);
    expect(first.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    expect(f.pool.has("first")).toBe(false);
    expect(f.pool.has("second")).toBe(true);
    expect(f.pool.getState("third")?.visible).toBe(true);
    expect(f.pool.listStates()).toHaveLength(2);
  });

  it("claims the foreground before a slow homepage load and leaves management navigation responsive", async () => {
    const f = fixture();
    const wc = f.create("one");
    let complete!: () => void;
    wc.loadURL.mockImplementationOnce(() => {
      expect(f.pool.getState("one")?.visible).toBe(true);
      return new Promise<void>((resolve) => { complete = resolve; });
    });
    const state = await f.pool.show(account("one"), { x: 0, y: 0, width: 640, height: 480 }, true);
    expect(state.visible).toBe(true);
    await f.pool.navigate("one", getPlatform("bilibili").routes.home);
    complete();
    await Promise.resolve();
    expect(f.pool.getState("one")?.url).toBe(getPlatform("bilibili").routes.home);
  });

  it("retains evicted contents so a later network suspension waits for their destruction", async () => {
    const f = fixture();
    const old = f.create("old");
    f.create("second");
    f.create("third"); // LRU removes old from the visible/live map only.
    expect(f.pool.getWebContents("old")).toBeNull();
    expect(old.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    let settled = false;
    const revoked = f.pool.suspendNetworkAccount("old").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(old.navDispose).not.toHaveBeenCalled();
    expect(accountForWebContents(old)).toBe("old");
    old.destroy();
    await revoked;
    expect(old.navDispose).toHaveBeenCalledOnce();
    expect(fixtures.guards[0].dispose).toHaveBeenCalledOnce();
    expect(() => accountForWebContents(old)).toThrow();
  });

  it("retains a message page and its account partition across switches, hides and LRU pressure", async () => {
    const f = fixture();
    const first = f.create("first");
    const bounds = { x: 0, y: 0, width: 640, height: 480 };
    f.pool.setMessageMode("first", true);
    await f.pool.navigate("first", "https://message.bilibili.com/#/whisper");
    await f.pool.show(account("first"), bounds, true);
    f.pool.hide("first");
    f.create("second");
    f.create("third");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(first.close).not.toHaveBeenCalled();
    expect(f.pool.getState("first")).toMatchObject({ messageMode: true, visible: false });
    await f.pool.show(account("first"), bounds, true);
    expect(f.pool.getWebContents("first")).toBe(first);
    expect(first.loadURL).toHaveBeenCalledExactlyOnceWith("https://message.bilibili.com/#/whisper");
    expect(fixtures.sessions.filter(session => session.partition === "persist:test-first")).toHaveLength(1);
    f.pool.hide("first");
    f.pool.setMessageMode("first", false);
    // Make the released message page the LRU candidate again.
    await vi.advanceTimersByTimeAsync(1);
    f.pool.ensure(account("third"), { navigate: false });
    f.create("fourth");
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("refuses background navigation of a pinned message page until explicit release", async () => {
    const f = fixture();
    const wc = f.create("one");
    f.pool.setMessageMode("one", true);
    await f.pool.navigate("one", "https://message.bilibili.com/#/whisper");
    await f.pool.navigate("one", getPlatform("bilibili").routes.home, { background: true });
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
    expect(f.pool.getState("one")?.messageMode).toBe(true);
    f.pool.setMessageMode("one", false);
    await f.pool.navigate("one", getPlatform("bilibili").routes.home, { background: true });
    expect(wc.loadURL).toHaveBeenCalledTimes(2);
  });

  it("invalidates a collector navigation waiting on session initialization before opening messages", async () => {
    const f = fixture();
    const wc = f.create("one");
    let ready!: () => void;
    fixtures.sessions[0].ready = new Promise<void>(resolve => { ready = resolve; });
    const background = f.pool.navigate("one", getPlatform("bilibili").routes.home, { background: true });
    f.pool.setMessageMode("one", true);
    const messages = f.pool.navigate("one", "https://message.bilibili.com/#/whisper");
    ready();
    await Promise.all([background, messages]);
    expect(wc.loadURL).toHaveBeenCalledExactlyOnceWith("https://message.bilibili.com/#/whisper");
  });

  it("never starts a delayed load after its view has begun closing", async () => {
    const f = fixture();
    const wc = f.create("one");
    let ready!: () => void;
    fixtures.sessions[0].ready = new Promise<void>(resolve => { ready = resolve; });
    const background = f.pool.navigate("one", getPlatform("bilibili").routes.home, { background: true });
    f.pool.remove("one");
    ready();
    await background;
    expect(wc.loadURL).not.toHaveBeenCalled();
  });

  it("does not retry or surface a stale collector error over the newly opened message page", async () => {
    const f = fixture();
    const wc = f.create("one");
    let reject!: (error: unknown) => void;
    wc.loadURL.mockImplementationOnce(() => new Promise<void>((_resolve, no) => { reject = no; }));
    const background = f.pool.navigate("one", getPlatform("bilibili").routes.home, { background: true });
    await Promise.resolve();
    f.pool.setMessageMode("one", true);
    await f.pool.navigate("one", "https://message.bilibili.com/#/whisper");
    reject(Object.assign(new Error("old request failed"), { errno: -105 }));
    await background;
    await vi.advanceTimersByTimeAsync(1000);
    expect(wc.loadURL).toHaveBeenCalledTimes(2);
    expect(f.pool.getState("one")?.lastError).toBeNull();
  });

  it("still force-closes protected messages when network access is revoked", async () => {
    const f = fixture();
    const wc = f.create("one");
    f.pool.setMessageMode("one", true);
    const revoked = f.pool.suspendNetworkAccount("one");
    expect(wc.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    expect(f.pool.has("one")).toBe(false);
    wc.destroy();
    await revoked;
  });

  it("emits a versioned destroyed state on recycling and rebuilds crashed pages with the same partition", async () => {
    const f = fixture();
    const states: ViewState[] = [];
    f.pool.on("state", (state) => states.push(state));
    const old = f.create("one");
    old.emit("render-process-gone", {}, { reason: "crashed" });
    expect(f.pool.getState("one")?.lifecycle).toBe("crashed");
    expect(f.pool.getWebContents("one")).toBeNull();
    f.pool.reload("one");
    old.destroy();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixtures.sessions.map((s) => s.partition)).toEqual(["persist:test-one", "persist:test-one"]);
    f.pool.remove("one");
    expect(states.at(-1)?.lifecycle).toBe("destroyed");
    expect(states.at(-1)?.revision).toBeGreaterThan(states[0].revision!);
  });

  it("keeps ownership when initialization fails after the native view was created", async () => {
    const f = fixture();
    fixtures.failGuard = true;
    expect(() => f.create("one")).toThrow("ACCOUNT_VIEW_INITIALIZATION_FAILED");
    const old = fixtures.contents[0] as FixtureContents;
    expect(old.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    const pending = f.pool.suspendNetworkAccount("one");
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    old.destroy();
    await pending;
    expect(old.navDispose).toHaveBeenCalledOnce();
  });

  it("does not rebuild the same account while its old view is still closing", async () => {
    const f = fixture();
    const old = f.create("one");
    f.pool.remove("one");
    expect(() => f.create("one")).toThrow("等待国内网络");
    expect(fixtures.contents).toHaveLength(1);
    const closing = f.pool.suspendNetworkAccount("one");
    old.destroy();
    await closing;
    expect(() => f.create("one")).not.toThrow();
    expect(fixtures.contents).toHaveLength(2);
  });

  it("releases a view exactly once when native close synchronously clears view.webContents", async () => {
    const f = fixture();
    const old = f.create("one");
    old.close.mockImplementation(() => old.destroy());

    await expect(f.pool.suspendNetworkAccount("one")).resolves.toBeUndefined();
    await expect(f.pool.suspendNetworkAccount("one")).resolves.toBeUndefined();
    f.pool.remove("one");
    f.pool.dispose();

    expect(old.close).toHaveBeenCalledOnce();
    expect(old.navDispose).toHaveBeenCalledOnce();
    expect(fixtures.guards[0].dispose).toHaveBeenCalledOnce();
    expect(fixtures.sessions[0].dispose).toHaveBeenCalledOnce();
    expect(f.pool.getWebContents("one")).toBeNull();
    expect(f.pool.listStates()).toEqual([]);
    expect(() => accountForWebContents(old)).toThrow();
  });

  it("cleans up spontaneous destruction and can reopen the account in the same partition", () => {
    const f = fixture();
    const old = f.create("one");
    expect(() => old.destroy()).not.toThrow();
    expect(f.pool.has("one")).toBe(false);
    expect(() => f.pool.stop("one")).not.toThrow();
    expect(old.navDispose).toHaveBeenCalledOnce();
    expect(fixtures.sessions[0].dispose).toHaveBeenCalledOnce();

    const replacement = f.create("one");
    expect(replacement).not.toBe(old);
    expect(fixtures.sessions[1].partition).toBe(fixtures.sessions[0].partition);
    expect(f.pool.getWebContents("one")).toBe(replacement);
  });

  it("does not navigate destroyed contents after session initialization finishes", async () => {
    const f = fixture();
    const old = f.create("one");
    let ready!: () => void;
    fixtures.sessions[0].ready = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const navigation = f.pool.navigate("one", "https://member.bilibili.com/platform/home");
    expect(() => old.destroy()).not.toThrow();
    ready();

    await expect(navigation).resolves.toBeUndefined();
    expect(old.loadURL).not.toHaveBeenCalled();
  });

  it("retains a failed force-close result and its contents instead of claiming successful suspension", async () => {
    const f = fixture();
    const old = f.create("one");
    old.close.mockImplementation(() => {
      throw new Error("native close error?private=secret");
    });
    expect(() => f.pool.remove("one")).not.toThrow();
    await expect(f.pool.suspendNetworkAccount("one")).rejects.toThrow(/^ACCOUNT_VIEWS_CLOSE_FAILED$/);
    await expect(f.pool.suspendNetworkAccount("one")).rejects.toThrow(/^ACCOUNT_VIEWS_CLOSE_FAILED$/);
    expect(old.close).toHaveBeenCalledOnce();
    expect(old.navDispose).not.toHaveBeenCalled();
    expect(() => f.create("one")).toThrow("等待国内网络");
    old.destroy();
    await expect(f.pool.suspendNetworkAccount("one")).resolves.toBeUndefined();
    expect(old.navDispose).toHaveBeenCalledOnce();
  });

  it("a missing destroyed event times out without losing the old renderer from revocation", async () => {
    const f = fixture();
    const old = f.create("one");
    f.pool.remove("one");
    const rejected = expect(f.pool.suspendNetworkAccount("one")).rejects.toThrow(
      "ACCOUNT_VIEWS_CLOSE_FAILED",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    await expect(f.pool.suspendNetworkAccount("one")).rejects.toThrow("ACCOUNT_VIEWS_CLOSE_FAILED");
    expect(old.destroyed).toBe(false);
    expect(old.navDispose).not.toHaveBeenCalled();
  });

  it("keeps evicted Cookie guards available to shutdown flushing while close is pending", async () => {
    const f = fixture();
    f.create("one");
    f.pool.remove("one");
    await f.pool.flushAll();
    expect(fixtures.guards[0].flush).toHaveBeenCalledOnce();
    expect(fixtures.guards[0].dispose).not.toHaveBeenCalled();
  });

  it("dispose force-closes live and already removed contents and rejects further view creation", async () => {
    const f = fixture();
    const removed = f.create("one"),
      live = f.create("two");
    f.pool.remove("one");
    f.pool.dispose();
    expect(removed.close).toHaveBeenCalledOnce();
    expect(live.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    expect(() => f.create("three")).toThrow("等待国内网络");
    const first = f.pool.suspendNetworkAccount("one"),
      second = f.pool.suspendNetworkAccount("two");
    removed.destroy();
    live.destroy();
    await Promise.all([first, second]);
  });

  it.each(["abort", "late-success"])(
    "explicit navigate rejects a revoked %s instead of reporting upload-page success",
    async (outcome) => {
      const f = fixture();
      const wc = f.create("one");
      const abort = new AbortController();
      let allowed = true;
      const removeController = installBusinessNetwork({
        enforcement: "strict",
        check: () => ({ allowed, reason: allowed ? "READY" : "GATE_REVOKED" }),
        acquire: () => ({ signal: abort.signal, isCurrent: () => !abort.signal.aborted, release: vi.fn() }),
      });
      let resolve!: () => void, reject!: (error: unknown) => void;
      wc.loadURL.mockReturnValueOnce(
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      const navigation = f.pool.navigate("one", "https://member.bilibili.com/platform/upload/video/frame");
      await Promise.resolve();
      expect(wc.loadURL).toHaveBeenCalledOnce();
      allowed = false;
      abort.abort();
      if (outcome === "abort") reject(Object.assign(new Error("ERR_ABORTED"), { errno: -3 }));
      else resolve();
      await expect(navigation).rejects.toThrow("等待国内网络");
      expect(f.pool.getState("one")?.lastError).toBe("等待国内网络");
      removeController();
    },
  );

  it("keeps an ordinary superseded navigation benign while its lease is still current", async () => {
    const f = fixture();
    const wc = f.create("one");
    wc.loadURL.mockRejectedValueOnce(Object.assign(new Error("ERR_ABORTED"), { errno: -3 }));
    await expect(
      f.pool.navigate("one", "https://member.bilibili.com/platform/home"),
    ).resolves.toBeUndefined();
    expect(f.pool.getState("one")?.lastError).toBeNull();
  });

  it("reuses an existing login view without requiring or loading the unused creator homepage", async () => {
    const f = fixture();
    const wc = f.create("one");
    await f.pool.navigate("one", "https://passport.bilibili.com/login");
    const check = vi.fn((_id: string, url?: string) => ({
      allowed: url === undefined || url.startsWith("https://passport.bilibili.com/"),
      reason: "READY" as const,
    }));
    const remove = installBusinessNetwork({ enforcement: "strict", check, acquire: () => null });
    try {
      expect(() => f.pool.ensure(account("one"))).not.toThrow();
      expect(wc.loadURL).toHaveBeenCalledTimes(1);
      expect(check).toHaveBeenCalledWith("one", undefined);
      expect(() => f.pool.ensure(account("new"))).toThrow(/等待国内网络/);
    } finally {
      remove();
    }
  });
});
