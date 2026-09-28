import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import type { IdentityEvidence } from "@main/browser/identity-evidence";
import type { Account, AccountStatus, ViewState } from "@shared/types";
import { getPlatform, platformEntryUrl, type CnPlatformId } from "@shared/platforms";
import { installBusinessNetwork, type BusinessNetworkController } from "@main/network/business-access";
import { AccountService, type ProfileInfo } from "./account-service";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { WebContents } from "electron";

const biliProbeUrl = "https://api.bilibili.com/x/web-interface/nav";
function responseAt(response: Response, url = biliProbeUrl): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

const browser = vi.hoisted(() => ({ configure: vi.fn(), wipe: vi.fn() }));
const nativeNet = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", () => ({ net: nativeNet }));
const nativeReplies = new WeakMap<object, () => Promise<Response>>();
vi.mock("@main/browser/account-session", () => ({
  configureAccountSession: browser.configure,
  wipeAccountSession: browser.wipe,
}));

const services: AccountService[] = [];
const stores: Store[] = [];
const uninstallers: Array<() => void> = [];

describe("Channels recovery and failed-page authentication", () => {
  it("waits for a Channels login redirect to settle before confirming logout", async () => {
    const f = fixture("online", true, undefined, "weixin_channels");
    f.viewPool.getState.mockReturnValue({ url: getPlatform("weixin_channels").routes.login, loading: false, lastError: null } as ViewState);
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.store.accounts.get(f.account.id)?.status).toBe("offline");
  });

  it("does not lose a page-refresh request coalesced with a running patrol", async () => {
    const f = fixture("online", true, undefined, "weixin_channels");
    const cookies = deferred<never[]>();
    f.session.cookies.get.mockImplementationOnce(() => cookies.promise);
    const patrol = f.service.checkStatus(f.account.id);
    const refresh = f.service.checkStatus(f.account.id, { force: true, refreshPage: true });
    f.viewPool.navigate.mockRejectedValue(new Error("synthetic load failure"));
    cookies.resolve([]);
    await Promise.all([patrol, refresh]);
    expect(f.viewPool.navigate).toHaveBeenCalledOnce();
    expect(f.store.accounts.get(f.account.id)?.status).toBe("online");
  });

  it.each(["ERR_TUNNEL_CONNECTION_FAILED", "ERR_NETWORK_CHANGED", "ERR_TIMED_OUT"])(
    "preserves stored authentication when a stopped login page failed with %s", async lastError => {
      const f = fixture("online", true, undefined, "weixin_channels");
      f.viewPool.getState.mockReturnValue({ url: getPlatform("weixin_channels").routes.login, loading: false, lastError } as ViewState);
      const checked = await f.service.checkStatus(f.account.id, { force: true });
      expect(checked).toMatchObject(authFields(f.account)!);
      expect(checked.checkInfo?.state).toBe("network_error");
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.store.audit.list().filter(e => e.action === "account.status")).toEqual([]);
    },
  );

  it("rechecks a previously offline Channels account after stable network recovery and fresh identity", async () => {
    const f = fixture("online", true, undefined, "weixin_channels");
    f.store.accounts.updateStatus(f.account.id, "offline", "账号页面已跳转至登录页");
    f.service.suspendNetworkAccount(f.account.id);
    f.viewPool.navigate.mockImplementation(async () => {
      f.viewPool.getState.mockReturnValue({ url: getPlatform("weixin_channels").routes.home, loading: false, lastError: null, instanceId: 1, navigationId: 1 } as ViewState);
      f.viewPool.getIdentityEvidence.mockReturnValue({ kind: "online", key: "recovered", sequence: 1, observedAt: Date.now(), reason: "平台网页已确认登录身份", subject: "self" });
    });
    f.service.resumeNetworkAccount(f.account.id);
    f.service.resumeNetworkAccount(f.account.id);
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.viewPool.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.viewPool.navigate).toHaveBeenCalledExactlyOnceWith(f.account.id, getPlatform("weixin_channels").routes.home, { background: true });
    expect(f.store.accounts.get(f.account.id)?.status).toBe("online");
    expect(browser.wipe).not.toHaveBeenCalled();
    f.service.resumeNetworkAccount(f.account.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.viewPool.navigate).toHaveBeenCalledOnce();
  });

  it("cancels a pending recovery when the network is revoked again", async () => {
    const f = fixture("online", true, undefined, "weixin_channels");
    f.service.suspendNetworkAccount(f.account.id);
    f.service.resumeNetworkAccount(f.account.id);
    f.revoke();
    f.service.suspendNetworkAccount(f.account.id);
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.viewPool.ensure).not.toHaveBeenCalled();
    expect(f.store.accounts.get(f.account.id)?.status).toBe("online");
  });

  it.each([
    { url: "https://channels.weixin.qq.com/platform/post/create", visible: false },
    { url: "https://channels.weixin.qq.com/platform/post/create", visible: false, lastError: "ERR_TIMED_OUT" },
    { url: "https://channels.weixin.qq.com/platform/post/create", visible: true, lastError: "ERR_TIMED_OUT" },
    { url: "https://channels.weixin.qq.com/login.html", visible: true },
    { url: "https://channels.weixin.qq.com/login.html", visible: false, lastError: "ERR_TIMED_OUT" },
    { url: "https://channels.weixin.qq.com/platform", visible: true },
    { url: "https://channels.weixin.qq.com/platform/post/list", visible: true },
    { url: "https://captcha.qq.com/verify", visible: false },
    { url: "https://channels.weixin.qq.com/platform/unknown", visible: false },
  ])("does not replace an active page or hidden editor during background refresh: $url", async page => {
    const f = fixture("online", true, undefined, "weixin_channels");
    f.viewPool.getState.mockReturnValue({ ...page, loading: false } as ViewState);
    await f.service.checkStatus(f.account.id, { force: true, refreshPage: true });
    expect(f.viewPool.navigate).not.toHaveBeenCalled();
    expect(browser.wipe).not.toHaveBeenCalled();
  });

  it.each([
    "https://channels.weixin.qq.com/platform?tab=home",
    "https://channels.weixin.qq.com/platform/post/list",
    "https://channels.weixin.qq.com/platform/post/list/?page=2",
    "https://channels.weixin.qq.com/platform/statistic/post",
    "https://channels.weixin.qq.com/platform/comment",
  ])("refreshes an idle hidden read-only Channels route for fresh identity: %s", async url => {
    const f = fixture("online", true, undefined, "weixin_channels");
    f.viewPool.getState.mockReturnValue({ url, visible: false, loading: false, instanceId: 1, navigationId: 1 } as ViewState);
    f.viewPool.navigate.mockImplementation(async () => {
      f.viewPool.getState.mockReturnValue({ url: getPlatform("weixin_channels").routes.home, visible: false, loading: false, instanceId: 1, navigationId: 2 } as ViewState);
      f.viewPool.getIdentityEvidence.mockReturnValue({ kind: "online", key: "fresh-safe-page", sequence: 1,
        observedAt: Date.now(), reason: "平台网页已确认登录身份", subject: "self" });
    });
    const checked = await f.service.checkStatus(f.account.id, { force: true, refreshPage: true });
    expect(f.viewPool.navigate).toHaveBeenCalledExactlyOnceWith(f.account.id, getPlatform("weixin_channels").routes.home, { background: true });
    expect(checked).toMatchObject({ status: "online", checkInfo: { state: "confirmed" } });
    expect(f.session.fetch).not.toHaveBeenCalled();
  });

  it("records the login-page basis separately from an identity response without retaining credentials", async () => {
    const f = fixture("online", true, undefined, "weixin_channels");
    f.viewPool.getState.mockReturnValue({ url: getPlatform("weixin_channels").routes.login, loading: false } as ViewState);
    await f.service.checkStatus(f.account.id, { force: true });
    await vi.advanceTimersByTimeAsync(3000);
    const logout = f.store.audit.list().find(event => event.action === "account.status");
    expect(logout?.details).toEqual({ from: "online", to: "offline", probe: null,
      source: "login-page", reason: "账号页面已跳转至登录页" });
    f.viewPool.getState.mockReturnValue({ url: getPlatform("weixin_channels").routes.home, loading: false } as ViewState);
    f.viewPool.getIdentityEvidence.mockReturnValue({ kind: "online", key: "identity-resumed", sequence: 1,
      observedAt: Date.now(), reason: "平台网页已确认登录身份", subject: "not-an-audit-field" });
    await f.service.checkStatus(f.account.id, { force: true });
    const login = f.store.audit.list().find(event => event.action === "account.status" && event.details?.to === "online");
    expect(login?.details).toEqual({ from: "offline", to: "online", probe: null,
      source: "identity-response", reason: "平台网页已确认登录身份" });
  });

  it("does not accept a late identity after revocation during a page refresh", async () => {
    const f = fixture("online", true, undefined, "weixin_channels");
    const navigation = deferred<void>();
    f.viewPool.navigate.mockReturnValue(navigation.promise);
    const checking = f.service.checkStatus(f.account.id, { force: true, refreshPage: true });
    f.revoke();
    f.service.suspendNetworkAccount(f.account.id);
    f.viewPool.getIdentityEvidence.mockReturnValue({ kind: "offline", key: "late", sequence: 1, observedAt: Date.now(), reason: "expired" });
    navigation.resolve();
    await checking;
    expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("preserves login when the refreshed management page fails", async () => {
    const f = fixture("online", true, undefined, "weixin_channels");
    f.viewPool.navigate.mockRejectedValue(new Error("ERR_TUNNEL_CONNECTION_FAILED"));
    const checked = await f.service.checkStatus(f.account.id, { force: true, refreshPage: true });
    expect(checked).toMatchObject(authFields(f.account)!);
    expect(checked.checkInfo?.state).toBe("network_error");
    expect(browser.wipe).not.toHaveBeenCalled();
  });
});

function authFields(account: Account | undefined) {
  if (!account) return account;
  const { checkInfo: _checkInfo, ...fields } = account;
  return fields;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture(
  status: AccountStatus = "offline",
  initiallyAllowed = true,
  onSessionChange?: (accountId: string, kind: "delete" | "reset" | "restore") => Promise<void>,
  platformId: CnPlatformId = "douyin",
) {
  const store = createStore(":memory:");
  stores.push(store);
  const created = store.accounts.create({ platformId });
  store.accounts.updateStatus(created.id, status, "preserved auth conclusion", {
    sessionExpiresAt: "2026-10-01T00:00:00.000Z",
  });
  const account = store.accounts.get(created.id)!;
  const session = {
    cookies: {
      get: vi.fn(async () =>
        platformId === "bilibili"
          ? ["SESSDATA", "bili_jct"].map((name) => ({
              name,
              value: "synthetic-local-fixture",
              domain: ".bilibili.com",
            }))
          : platformId === "baijiahao" ? [{ name: "BDUSS", value: "synthetic-local-fixture", domain: ".baidu.com" }]
          : [{ name: "sessionid", value: "synthetic-local-fixture", domain: ".douyin.com" }],
      ),
    },
    fetch: vi.fn<(_url: string, _init?: RequestInit) => Promise<Response>>(async (url) =>
      responseAt(
        Response.json(platformId === "bilibili" ? { code: 0, data: { isLogin: true } } : platformId === "baijiahao" ? { errno: 0, data: { id: "self" } } : { status_code: 0 }),
        url,
      ),
    ),
  };
  const probeResponse = vi.fn(async () => responseAt(Response.json({ code: 0, data: { isLogin: true } })));
  nativeReplies.set(session, probeResponse);
  browser.configure.mockReturnValue({ session, partition: account.partition, dispose: vi.fn() });
  const viewPool = {
    getState: vi.fn<(_id: string) => ViewState | null>(() => null),
    getSession: vi.fn(() => null),
    getWebContents: vi.fn<() => WebContents | null>(() => null),
    getIdentityEvidence: vi.fn<() => IdentityEvidence | null>(
      () => null,
    ),
    ensure: vi.fn(),
    navigate: vi.fn(async () => undefined),
    show: vi.fn(),
    setMessageMode: vi.fn(),
    canCheckHomepage: vi.fn(() => false),
    recheckHomepage: vi.fn(async () => false),
    finishHomepageCheck: vi.fn(async () => undefined),
    remove: vi.fn(),
  };
  const notify = vi.fn();
  const mediaIntake = { avatar: vi.fn(), covers: vi.fn() };
  const fetchProfile = vi.fn<(_account: typeof account) => Promise<ProfileInfo | null>>(async () => ({
    displayName: "Fixture creator",
    handle: "fixture-handle",
  }));
  const service = new AccountService({
    store,
    viewPool: viewPool as unknown as ViewPool,
    notify,
    fetchProfile,
    onSessionChange,
    mediaIntake,
  });
  services.push(service);
  let allowed = initiallyAllowed;
  let generation = 0;
  const signals = new Set<AbortController>();
  const network: BusinessNetworkController = {
    enforcement: "strict",
    prepareOperation: vi.fn(() => ({
      ready: Promise.resolve(),
      contextId: "fixture",
      scopeVersion: "fixture",
    })),
    check: vi.fn(() => ({ allowed, reason: allowed ? "READY" : "CHECKING" })),
    acquire: vi.fn(() => {
      if (!allowed) return null;
      const epoch = generation;
      const abort = new AbortController();
      signals.add(abort);
      let released = false;
      return {
        signal: abort.signal,
        isCurrent: () => epoch === generation && !released,
        release: () => {
          released = true;
          signals.delete(abort);
        },
      };
    }),
  };
  uninstallers.push(installBusinessNetwork(network));
  return {
    account: store.accounts.get(account.id)!,
    store,
    service,
    session,
    probeResponse,
    viewPool,
    notify,
    fetchProfile,
    network,
    mediaIntake,
    revoke() {
      allowed = false;
      generation += 1;
      for (const signal of signals) signal.abort();
    },
    reopen() {
      allowed = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-07T12:00:00.000Z");
  browser.configure.mockReset();
  browser.wipe.mockReset();
  nativeNet.request.mockReset();
  nativeNet.request.mockImplementation(
    (options: { session: object; url: string; credentials: string; method: string; redirect: string }) => {
      expect(options).toMatchObject({ credentials: "include", method: "GET", redirect: "manual" });
      const reply = nativeReplies.get(options.session);
      if (!reply) throw new Error("Unregistered test Session");
      let aborted = false,
        followed = false;
      let body: Readable | undefined;
      const request = Object.assign(new EventEmitter(), {
        setHeader: vi.fn(),
        followRedirect: vi.fn(() => {
          followed = true;
        }),
        abort: vi.fn(() => {
          aborted = true;
          body?.destroy();
        }),
        end: vi.fn(() => {
          void Promise.resolve()
            .then(async () => {
              const response = await reply();
              if (aborted) return;
              if (response.url && response.url !== options.url) {
                request.emit("redirect", 302, "GET", response.url, {});
                if (aborted || !followed) return;
              }
              const text = await response.text();
              if (aborted) return;
              body = Object.assign(Readable.from([Buffer.from(text)]), {
                statusCode: response.status,
                statusMessage: "Fixture",
                headers: {},
              });
              request.emit("response", body);
            })
            .catch((error: unknown) => {
              if (!aborted) request.emit("error", error);
            });
        }),
      });
      return request;
    },
  );
});

describe("foreground account homepage entry", () => {
  it.each(["douyin", "xiaohongshu", "bilibili", "baijiahao", "weixin_channels"] as const)(
    "declares the exact %s entry origin and forwards the entry flag",
    async (platformId) => {
      const f = fixture("online", true, undefined, platformId);
      const prepare = vi.spyOn(f.service, "prepareNetworkOperation");
      const bounds = { x: 0, y: 0, width: 640, height: 480 };
      await f.service.showView(f.account.id, bounds, true);
      expect(prepare).toHaveBeenCalledWith(f.account.id, "view-navigate", platformEntryUrl(platformId));
      expect(f.viewPool.show).toHaveBeenCalledWith({ id: f.account.id, platformId }, bounds, true);
    },
  );

  it("preserves an existing management page when restoring its hidden view", async () => {
    const f = fixture("online");
    f.viewPool.getState.mockReturnValue({ url: getPlatform("douyin").routes.home } as ViewState);
    const prepare = vi.spyOn(f.service, "prepareNetworkOperation");
    const bounds = { x: 0, y: 0, width: 640, height: 480 };
    await f.service.showView(f.account.id, bounds);
    expect(prepare).toHaveBeenCalledWith(f.account.id, "view-navigate", getPlatform("douyin").routes.home);
    expect(f.viewPool.show).toHaveBeenCalledWith(
      { id: f.account.id, platformId: "douyin" }, bounds, false,
    );
  });

  it.each([
    "https://creator.douyin.com/creator-micro/content/upload",
    "https://channels.weixin.qq.com/login.html",
  ])("restores an existing page using its own origin even when account entry was requested: %s", async url => {
    const platformId = url.includes("weixin") ? "weixin_channels" : "douyin";
    const f = fixture("online", true, undefined, platformId);
    f.viewPool.getState.mockReturnValue({ url, loading: false, lifecycle: "ready" } as ViewState);
    const prepare = vi.spyOn(f.service, "prepareNetworkOperation");
    await f.service.showView(f.account.id, { x: 0, y: 0, width: 640, height: 480 }, true);
    expect(prepare).toHaveBeenCalledWith(f.account.id, "view-navigate", url);
    expect(f.viewPool.navigate).not.toHaveBeenCalled();
  });

  it("restores a homepage and checks its login without requesting a creator API scope", async () => {
    const f = fixture("online");
    const url = getPlatform("douyin").routes.site!;
    f.viewPool.getState.mockReturnValue({ url, loading: false } as ViewState);
    const prepare = vi.spyOn(f.service, "prepareNetworkOperation");
    await f.service.showView(f.account.id, { x: 0, y: 0, width: 640, height: 480 });
    await f.service.checkStatus(f.account.id, { force: true });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenNthCalledWith(1, f.account.id, "view-navigate", url);
    expect(prepare).toHaveBeenNthCalledWith(2, f.account.id, "view-navigate", url);
    expect(f.viewPool.navigate).not.toHaveBeenCalled();
    expect(f.session.fetch).not.toHaveBeenCalled();
  });

  it("does not navigate away from a public homepage after a scan confirms login", async () => {
    const f = fixture("offline", true, undefined, "bilibili");
    f.viewPool.getState.mockReturnValue({ url: getPlatform("bilibili").routes.site } as ViewState);
    f.viewPool.getWebContents.mockReturnValue(Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => ({ kind: "online", source: "homepage", reason: "主页已登录" })),
    }) as unknown as WebContents);
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.viewPool.navigate).not.toHaveBeenCalled();
    expect(f.viewPool.ensure).not.toHaveBeenCalled();
  });
});

describe("identity checks and attempt feedback", () => {
  it("returns the refreshed homepage nickname, matching the last emitted sidebar update", async () => {
    const f = fixture("offline", true, undefined, "xiaohongshu");
    f.store.accounts.update(f.account.id, { displayName: "旧平台名" });
    f.viewPool.getState.mockReturnValue({ url: getPlatform("xiaohongshu").routes.site, instanceId: 1, navigationId: 1 } as ViewState);
    f.viewPool.getWebContents.mockReturnValue(Object.assign(new EventEmitter(), {
      isDestroyed: () => false, executeJavaScript: vi.fn(async () => ({ kind: "online", source: "homepage", reason: "self", displayName: "新平台名" })),
    }) as unknown as WebContents);
    const changed = vi.fn(); f.service.on("account-changed", changed);
    expect((await f.service.checkStatus(f.account.id, { force: true })).displayName).toBe("新平台名");
    expect(changed.mock.lastCall![0].displayName).toBe("新平台名");
  });
  it.each(["douyin", "kuaishou", "xiaohongshu", "bilibili"] as const)(
    "confirms an authenticated %s homepage without cookies, creator requests or profile overwrites",
    async (platformId) => {
      const f = fixture("offline", true, undefined, platformId);
      f.store.accounts.update(f.account.id, { displayName: "保存的创作者", externalId: "creator-id", handle: "saved-handle" });
      const avatarUrl = "https://p3.douyinpic.com/current-avatar.png";
      const evaluate = vi.fn(async () => ({ kind: "online", source: "homepage", reason: "主页已登录", avatarUrl }));
      f.viewPool.getWebContents.mockReturnValue(Object.assign(new EventEmitter(), {
        isDestroyed: () => false, executeJavaScript: evaluate,
      }) as unknown as WebContents);
      f.viewPool.getState.mockReturnValue({
        url: getPlatform(platformId).routes.site, loading: false, instanceId: 1, navigationId: 1,
      } as ViewState);
      f.viewPool.getIdentityEvidence.mockReturnValue({
        kind: "offline", key: "creator-unauthorized", sequence: 1, observedAt: Date.now(), reason: "管理页未登录",
      });
      f.session.cookies.get.mockRejectedValueOnce(new Error("cookie store unavailable"));
      const checked = await f.service.checkStatus(f.account.id, { force: true });
      expect(checked).toMatchObject({
        status: "online", displayName: "保存的创作者", externalId: "creator-id", handle: "saved-handle",
        checkInfo: { state: "confirmed", reason: "主页已登录" },
      });
      expect(evaluate).toHaveBeenCalledOnce();
      expect(f.session.cookies.get).not.toHaveBeenCalled();
      expect(f.session.fetch).not.toHaveBeenCalled();
      expect(f.probeResponse).not.toHaveBeenCalled();
      expect(f.fetchProfile).not.toHaveBeenCalled();
      expect(f.viewPool.navigate).not.toHaveBeenCalled();
      expect(f.mediaIntake.avatar).toHaveBeenCalledExactlyOnceWith(f.account.id, avatarUrl);
      expect(f.store.accounts.get(f.account.id)?.avatarUrl).toBeNull();
    },
  );

  it("preserves a confirmed homepage conclusion when a later DOM read is inconclusive", async () => {
    const f = fixture("offline");
    const evaluate = vi.fn()
      .mockResolvedValueOnce({ kind: "online", source: "homepage", reason: "主页已登录" })
      .mockResolvedValue({ kind: "unconfirmed", source: "homepage", reason: "主页正在加载", avatarUrl: "https://p3.douyinpic.com/stale.png" });
    f.viewPool.getWebContents.mockReturnValue(Object.assign(new EventEmitter(), {
      isDestroyed: () => false, executeJavaScript: evaluate,
    }) as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: getPlatform("douyin").routes.site, loading: false } as ViewState);
    const confirmed = await f.service.checkStatus(f.account.id, { force: true });
    vi.setSystemTime(Date.now() + 60_000);
    const unavailable = await f.service.checkStatus(f.account.id, { force: true });
    expect(unavailable.status).toBe("online");
    expect(unavailable.lastOnlineAt).toBe(confirmed.lastOnlineAt);
    expect(unavailable.checkInfo?.state).toBe("unconfirmed");
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(f.mediaIntake.avatar).not.toHaveBeenCalled();
  });

  it("marks an explicit homepage logout offline immediately and rechecks after cookie activity", async () => {
    const f = fixture("online");
    const evaluate = vi.fn()
      .mockResolvedValueOnce({ kind: "offline", source: "homepage", reason: "主页已退出登录" })
      .mockResolvedValue({ kind: "online", source: "homepage", reason: "主页已登录" });
    f.viewPool.getWebContents.mockReturnValue(Object.assign(new EventEmitter(), {
      isDestroyed: () => false, executeJavaScript: evaluate,
    }) as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: getPlatform("douyin").routes.site, loading: false } as ViewState);
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("offline");
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.store.accounts.get(f.account.id)?.status).toBe("offline");
    f.service.onActivity(f.account.id, "cookies");
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.store.accounts.get(f.account.id)).toMatchObject({ status: "online", checkInfo: { state: "confirmed" } });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(f.session.fetch).not.toHaveBeenCalled();
  });

  it.each(["navigation", "cookies"])("discards stale homepage evidence after %s and deduplicates the follow-up", async (change) => {
    const f = fixture("offline");
    const pending = deferred<{ kind: string; source: string; reason: string; avatarUrl: string }>();
    const evaluate = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ kind: "unconfirmed", source: "homepage", reason: "页面更新中" });
    f.viewPool.getWebContents.mockReturnValue(Object.assign(new EventEmitter(), {
      isDestroyed: () => false, executeJavaScript: evaluate,
    }) as unknown as WebContents);
    const state = { url: getPlatform("douyin").routes.site, loading: false, instanceId: 1, navigationId: 1 } as ViewState;
    f.viewPool.getState.mockReturnValue(state);
    const check = f.service.checkStatus(f.account.id, { force: true });
    if (change === "navigation") f.viewPool.getState.mockReturnValue({ ...state, navigationId: 2 });
    f.service.onActivity(f.account.id, change === "navigation" ? "navigated" : "cookies");
    f.service.onActivity(f.account.id, "loaded");
    expect(f.service.checkStatus(f.account.id, { force: true })).toBe(check);
    pending.resolve({ kind: "online", source: "homepage", reason: "旧页面已登录", avatarUrl: "https://p3.douyinpic.com/stale.png" });
    expect((await check).status).toBe("offline");
    await vi.advanceTimersByTimeAsync(1500);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(f.store.accounts.get(f.account.id)?.status).toBe("offline");
    expect(f.mediaIntake.avatar).not.toHaveBeenCalled();
  });

  it("rechecks one Baijiahao 401 without dropping account information, then confirms a second failure", async () => {
    const f = fixture("online", true, undefined, "baijiahao");
    const saved = f.store.accounts.update(f.account.id, {
      displayName: "保存的昵称", handle: "2623619080", externalId: "saved-uid",
    })!;
    const probe = vi.fn(async () => ({ status: 401, text: "", url: getPlatform("baijiahao").login.probe.url }));
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: probe });
    f.viewPool.getWebContents.mockReturnValue(wc as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({
      url: getPlatform("baijiahao").routes.home, loading: false, instanceId: 1, navigationId: 1,
    } as ViewState);
    vi.setSystemTime("2026-09-07T12:10:00.000Z");
    const first = await f.service.checkStatus(f.account.id, { force: true });
    expect(authFields(first)).toEqual(authFields(saved));
    expect(first.checkInfo?.state).toBe("unconfirmed");
    expect(f.notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(f.store.accounts.get(f.account.id)).toMatchObject({
      status: "offline", displayName: saved.displayName, handle: saved.handle, externalId: saved.externalId,
      checkInfo: { state: "confirmed" },
    });
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it("cancels Baijiahao's temporary negative conclusion after a successful recheck", async () => {
    const f = fixture("online", true, undefined, "baijiahao");
    const url = getPlatform("baijiahao").login.probe.url;
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 401, text: "", url })
      .mockResolvedValueOnce({ status: 200, text: '{"errno":0,"data":{"userId":"same-user"}}', url })
      .mockResolvedValueOnce({ status: 401, text: "", url });
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: probe });
    f.viewPool.getWebContents.mockReturnValue(wc as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: getPlatform("baijiahao").routes.home } as ViewState);
    expect((await f.service.checkStatus(f.account.id, { force: true })).checkInfo?.state).toBe("unconfirmed");
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.store.accounts.get(f.account.id)?.checkInfo?.state).toBe("confirmed");
    expect((await f.service.checkStatus(f.account.id, { force: true })).checkInfo?.state).toBe("unconfirmed");
    expect(f.store.accounts.get(f.account.id)?.status).toBe("online");
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("runs the negative recheck even when a successful probe happened less than 30 seconds ago", async () => {
    const f = fixture("online", true, undefined, "baijiahao");
    const url = getPlatform("baijiahao").login.probe.url;
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 200, text: '{"errno":0,"data":{"userId":"same-user"}}', url })
      .mockResolvedValue({ status: 401, text: "", url });
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: probe });
    f.viewPool.getWebContents.mockReturnValue(wc as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: getPlatform("baijiahao").routes.home } as ViewState);
    expect((await f.service.checkStatus(f.account.id, { force: true })).checkInfo?.state).toBe("confirmed");
    expect((await f.service.checkStatus(f.account.id, { force: true })).checkInfo?.state).toBe("unconfirmed");
    await vi.advanceTimersByTimeAsync(3000);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(f.store.accounts.get(f.account.id)?.status).toBe("offline");
  });

  it.each([
    ["douyin", "https://www.douyin.com/"],
    ["xiaohongshu", "https://www.xiaohongshu.com/explore"],
    ["kuaishou", "https://www.kuaishou.com/"],
    ["baijiahao", "https://www.baidu.com/"],
  ] as const)("does not issue a creator identity probe from the %s consumer homepage", async (platform, url) => {
    const f = fixture("online", true, undefined, platform);
    const probe = vi.fn(async () => ({ kind: "unconfirmed", source: "homepage", reason: "页面仍在加载" }));
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: probe });
    f.viewPool.getWebContents.mockReturnValue(wc as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url, loading: false } as ViewState);
    const checked = await f.service.checkStatus(f.account.id, { force: true });
    expect(authFields(checked)).toEqual(authFields(f.account));
    expect(checked.checkInfo?.state).toBe("unconfirmed");
    if (getPlatform(platform).routes.site) {
      expect(probe).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledWith(expect.not.stringContaining("fetch("), true);
    } else expect(probe).not.toHaveBeenCalled();
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it.each(["member", "api"])("does not use Bilibili %s identity to authorize its homepage", async (host) => {
    const f = fixture("online", true, undefined, "bilibili");
    const probe = vi.fn(async () => ({ status: 200, text: '{"code":0,"data":{"isLogin":true}}', url: biliProbeUrl }));
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: probe });
    f.viewPool.getWebContents.mockReturnValue(wc as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: `https://${host}.bilibili.com/`, loading: false } as ViewState);
    expect(await f.service.checkStatus(f.account.id, { force: true })).toMatchObject({ status: "unknown", checkInfo: { state: "unconfirmed" } });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["weixin_channels"] as const)(
    "requires two independent failures, then corrects %s with new successful evidence",
    async (platform) => {
      const f = fixture("online", true, undefined, platform);
      let sequence = 1;
      let kind: "online" | "offline" = "offline";
      f.viewPool.getIdentityEvidence.mockImplementation(() => ({
        kind,
        key: String(sequence),
        sequence,
        observedAt: Date.now(),
        reason: "sanitized identity verdict",
      }));
      const first = await f.service.checkStatus(f.account.id, { force: true });
      expect(first.status).toBe("online");
      expect(first.checkInfo?.state).toBe("unconfirmed");
      expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
      sequence++;
      const second = await f.service.checkStatus(f.account.id, { force: true });
      expect(second.status).toBe("offline");
      expect(second.checkInfo?.state).toBe("confirmed");
      sequence++;
      kind = "online";
      expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
    },
  );
  it("deduplicates refresh and limits the global pool to two checks", async () => {
    const f = fixture("online", true, undefined, "baijiahao");
    const two = f.service.create({ platformId: "baijiahao" }),
      three = f.service.create({ platformId: "baijiahao" });
    const blocker = deferred<never[]>();
    f.session.cookies.get.mockImplementation(() => blocker.promise);
    const first = f.service.checkStatus(f.account.id, { force: true });
    expect(f.service.checkStatus(f.account.id, { force: true })).toBe(first);
    const others = [
      f.service.checkStatus(two.id, { force: true }),
      f.service.checkStatus(three.id, { force: true }),
    ];
    expect(f.session.cookies.get).toHaveBeenCalledTimes(2);
    blocker.resolve([]);
    await Promise.all([first, ...others]);
    expect(f.session.cookies.get).toHaveBeenCalledTimes(3);
    expect(f.session.fetch).toHaveBeenCalledTimes(3);
  });
  it("reports a network failure without changing confirmed auth timestamps", async () => {
    const f = fixture("online", true, undefined, "baijiahao");
    f.session.fetch.mockRejectedValueOnce(new Error("synthetic timeout"));
    const checked = await f.service.checkStatus(f.account.id, { force: true });
    expect(authFields(checked)).toEqual(authFields(f.account));
    expect(checked.checkInfo?.state).toBe("network_error");
    expect(f.notify).not.toHaveBeenCalled();
  });
  it("rejects a probe result after same-URL page recreation", async () => {
    const f = fixture("offline");
    let instanceId = 1;
    f.viewPool.getState.mockImplementation(
      () => ({ url: "https://creator.douyin.com/creator-micro/home", instanceId }) as ViewState,
    );
    const pending = deferred<Response>();
    f.session.fetch.mockReturnValueOnce(pending.promise);
    const check = f.service.checkStatus(f.account.id, { force: true });
    await Promise.resolve();
    await Promise.resolve();
    instanceId++;
    pending.resolve(responseAt(Response.json({ status_code: 0 }), "https://creator.douyin.com/"));
    expect((await check).status).toBe("offline");
    expect(f.store.accounts.get(f.account.id)?.checkInfo?.state).toBe("unconfirmed");
  });
});

describe("homepage login authority lifecycle", () => {
  function homepage(f: ReturnType<typeof fixture>, kind: "online" | "offline" = "online") {
    const evaluate = vi.fn(async () => ({ kind: kind as "online" | "offline" | "unconfirmed", source: "homepage", reason: "主页当前登录结论" }));
    f.viewPool.getState.mockReturnValue({ url: getPlatform(f.account.platformId).routes.site!, loading: false, instanceId: 1, navigationId: 1 } as ViewState);
    f.viewPool.getWebContents.mockReturnValue(Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: evaluate }) as unknown as WebContents);
    return evaluate;
  }
  it.each(["douyin", "kuaishou", "xiaohongshu", "bilibili"] as const)("automatically confirms an unopened %s homepage during startup patrol", async platformId => {
    const f = fixture("unknown", true, undefined, platformId);
    f.viewPool.getState.mockReturnValue(null);
    f.viewPool.canCheckHomepage.mockReturnValue(true);
    f.viewPool.recheckHomepage.mockImplementation(async () => {
      homepage(f);
      f.viewPool.canCheckHomepage.mockReturnValue(false);
      return true;
    });
    f.service.startPatrol();
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.viewPool.recheckHomepage).toHaveBeenCalledExactlyOnceWith({ id: f.account.id, platformId });
    expect(f.service.get(f.account.id)).toMatchObject({ status: "online", checkInfo: { homepageConfirmation: { kind: "online" } } });
    expect(f.viewPool.finishHomepageCheck).toHaveBeenCalledExactlyOnceWith(f.account.id);
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(browser.wipe).not.toHaveBeenCalled();
  });
  it("throttles failed automatic homepage loads without dropping an earlier homepage confirmation", async () => {
    const f = fixture("offline");
    homepage(f);
    const confirmed = await f.service.checkStatus(f.account.id, { force: true });
    f.viewPool.getState.mockReturnValue(null);
    f.viewPool.canCheckHomepage.mockReturnValue(true);
    f.viewPool.recheckHomepage.mockRejectedValue(new Error("load failed"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const failed = await f.service.checkStatus(f.account.id, { force: true });
    expect(failed).toMatchObject({ status: "online", lastOnlineAt: confirmed.lastOnlineAt, lastCheckedAt: confirmed.lastCheckedAt, checkInfo: { state: "network_error" } });
    await f.service.checkStatus(f.account.id, { force: true });
    expect(f.viewPool.recheckHomepage).toHaveBeenCalledOnce();
    expect(f.viewPool.finishHomepageCheck).toHaveBeenCalledOnce();
  });
  it("leaves an active data collection alone, then checks when its retry is deferred", async () => {
    const f = fixture("unknown");
    f.viewPool.canCheckHomepage.mockReturnValue(true);
    const job = f.store.collectJobs.enqueue(f.account.id, "manual", false);
    await f.service.checkStatus(f.account.id, { force: true });
    expect(f.viewPool.recheckHomepage).not.toHaveBeenCalled();
    f.store.db.run("UPDATE cn_jobs SET not_before=? WHERE id=?", [Date.now() + 30 * 60_000, job.id]);
    f.viewPool.recheckHomepage.mockImplementation(async () => { homepage(f); return true; });
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
    expect(f.viewPool.recheckHomepage).toHaveBeenCalledOnce();
  });
  it("rejects a late automatic homepage result after network revocation and releases its temporary view", async () => {
    const f = fixture("unknown");
    const pending = deferred<boolean>();
    f.viewPool.canCheckHomepage.mockReturnValue(true);
    f.viewPool.recheckHomepage.mockReturnValue(pending.promise);
    const checking = f.service.checkStatus(f.account.id, { force: true });
    f.revoke();
    f.service.suspendNetworkAccount(f.account.id);
    homepage(f);
    pending.resolve(true);
    expect((await checking).status).toBe("unknown");
    expect(f.service.get(f.account.id).checkInfo?.homepageConfirmation).toBeFalsy();
    expect(f.viewPool.finishHomepageCheck).toHaveBeenCalledOnce();
  });
  it("never requests a fresh homepage navigation while its last real confirmation is still recent", async () => {
    const f = fixture("offline");
    homepage(f);
    await f.service.checkStatus(f.account.id, { force: true });
    f.viewPool.getState.mockReturnValue(null);
    f.viewPool.canCheckHomepage.mockReturnValue(true);
    f.service.onActivity(f.account.id, "cookies");
    await f.service.checkStatus(f.account.id, { force: true });
    expect(f.viewPool.recheckHomepage).not.toHaveBeenCalled();
    expect(f.service.get(f.account.id).status).toBe("online");
  });
  it("rereads an automatic homepage after cookie rotation during hydration before releasing it", async () => {
    const f = fixture("unknown");
    f.viewPool.canCheckHomepage.mockReturnValue(true);
    let evaluate: ReturnType<typeof homepage>;
    f.viewPool.recheckHomepage.mockImplementation(async () => {
      evaluate = homepage(f);
      evaluate.mockImplementationOnce(async () => {
        f.service.onActivity(f.account.id, "cookies");
        return { kind: "online", source: "homepage", reason: "已显示当前账号" };
      });
      return true;
    });
    const checking = f.service.checkStatus(f.account.id, { force: true });
    const checked = await checking;
    expect(checked.status).toBe("online");
    expect(checked.checkInfo?.homepageConfirmation?.kind).toBe("online");
    expect(evaluate!).toHaveBeenCalledTimes(2);
    expect(f.viewPool.finishHomepageCheck).toHaveBeenCalledOnce();
  });
  it("waits for loading to stop after automatic loadURL resolves instead of closing before DOM observation", async () => {
    const f = fixture("unknown");
    f.viewPool.canCheckHomepage.mockReturnValue(true);
    f.viewPool.recheckHomepage.mockImplementation(async () => {
      homepage(f);
      let reads = 0;
      f.viewPool.getState.mockImplementation(() => ({ url: getPlatform("douyin").routes.site!,
        loading: ++reads <= 2, instanceId: 1, navigationId: 1 } as ViewState));
      return true;
    });
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
    expect(f.viewPool.finishHomepageCheck).toHaveBeenCalledOnce();
  });
  it.each(["douyin", "kuaishou", "xiaohongshu", "bilibili"] as const)("%s retains homepage authority through ordinary cookie rotation and creator activity", async platformId => {
    const f = fixture("online", true, undefined, platformId);
    expect(f.service.list()[0].status).toBe("unknown");
    const evaluate = homepage(f);
    const confirmed = await f.service.checkStatus(f.account.id, { force: true });
    expect(confirmed.status).toBe("online");
    f.viewPool.getState.mockReturnValue({ url: getPlatform(platformId).routes.home, loading: false, instanceId: 1, navigationId: 2 } as ViewState);
    f.service.onActivity(f.account.id, "navigated");
    f.viewPool.getIdentityEvidence.mockReturnValue({ kind: "offline", key: "creator-offline", sequence: 1, observedAt: Date.now(), reason: "后台未登录" });
    const retained = await f.service.checkStatus(f.account.id, { force: true });
    expect(retained.status).toBe("online");
    expect(retained.lastOnlineAt).toBe(confirmed.lastOnlineAt);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(f.session.cookies.get).not.toHaveBeenCalled();
    f.service.onActivity(f.account.id, "cookies");
    expect(f.service.get(f.account.id).status).toBe("online");
    f.viewPool.getIdentityEvidence.mockReturnValue({ kind: "online", key: "creator-online", sequence: 2, observedAt: Date.now(), reason: "后台在线" });
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
    expect(f.service.get(f.account.id).lastOnlineAt).toBe(confirmed.lastOnlineAt);
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it("does not let creator identity overwrite a homepage logout", async () => {
    const f = fixture("online", true, undefined, "kuaishou");
    homepage(f, "offline");
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("offline");
    f.viewPool.getState.mockReturnValue({ url: getPlatform("kuaishou").routes.home, loading: false } as ViewState);
    f.viewPool.getIdentityEvidence.mockReturnValue({ kind: "online", key: "backend", sequence: 1, observedAt: Date.now(), reason: "后台在线" });
    f.service.onActivity(f.account.id, "identity");
    await vi.advanceTimersByTimeAsync(1500);
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("offline");
  });
  it("does not turn a recheck interval into a logout or refresh its confirmation time from creator checks", async () => {
    const f = fixture("offline");
    homepage(f);
    const confirmed = await f.service.checkStatus(f.account.id, { force: true });
    f.viewPool.getState.mockReturnValue({ url: getPlatform("douyin").routes.home } as ViewState);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.service.get(f.account.id).status).toBe("online");
    const retained = await f.service.checkStatus(f.account.id, { force: true });
    expect(retained.status).toBe("online");
    expect(retained.lastOnlineAt).toBe(confirmed.lastOnlineAt);
    expect(retained.checkInfo?.homepageConfirmation).toEqual(confirmed.checkInfo?.homepageConfirmation);
    expect(f.session.fetch).not.toHaveBeenCalled();
  });
  it("restores genuine homepage evidence across restart without updating its observation time", async () => {
    const f = fixture("offline");
    homepage(f);
    await f.service.checkStatus(f.account.id, { force: true });
    const lastOnlineAt = f.service.get(f.account.id).lastOnlineAt;
    const proof = f.service.get(f.account.id).checkInfo?.homepageConfirmation;
    f.service.dispose();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const next = new AccountService({ store: f.store, viewPool: f.viewPool as unknown as ViewPool, notify: f.notify });
    services.push(next);
    expect(next.get(f.account.id)).toMatchObject({ status: "online", lastOnlineAt, checkInfo: { homepageConfirmation: proof } });
    f.viewPool.getState.mockReturnValue({ url: getPlatform("douyin").routes.home, loading: false } as ViewState);
    expect(await next.checkStatus(f.account.id, { force: true })).toMatchObject({ status: "online", lastOnlineAt, checkInfo: { homepageConfirmation: proof } });
  });
  it("retains the last homepage conclusion while a new document is pending, then accepts its logout", async () => {
    const f = fixture("offline");
    const evaluate = homepage(f);
    await f.service.checkStatus(f.account.id, { force: true });
    f.viewPool.getState.mockReturnValue({ url: getPlatform("douyin").routes.site!, loading: true, instanceId: 1, navigationId: 2 } as ViewState);
    f.service.onActivity(f.account.id, "navigated");
    expect(f.service.get(f.account.id).status).toBe("online");
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
    expect(evaluate).toHaveBeenCalledOnce();
    f.viewPool.getState.mockReturnValue({ url: getPlatform("douyin").routes.site!, loading: false, instanceId: 1, navigationId: 2 } as ViewState);
    evaluate.mockResolvedValue({ kind: "offline", source: "homepage", reason: "主页已退出登录" });
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("offline");
    expect(f.service.get(f.account.id).checkInfo?.homepageConfirmation?.kind).toBe("offline");
  });
  it("clears durable homepage evidence on an explicit session reset", async () => {
    const f = fixture("offline");
    homepage(f);
    await f.service.checkStatus(f.account.id, { force: true });
    expect(f.service.get(f.account.id).checkInfo?.homepageConfirmation?.kind).toBe("online");
    await f.service.resetEnvironment(f.account.id);
    expect(f.service.get(f.account.id)).toMatchObject({ status: "offline", checkInfo: null });
    f.viewPool.getState.mockReturnValue({ url: getPlatform("douyin").routes.home, loading: false } as ViewState);
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("offline");
  });
  it("never refreshes a hidden Channels message page but permits passive identity checks", async () => {
    const f = fixture("online", true, undefined, "weixin_channels");
    f.viewPool.getState.mockReturnValue({ url: getPlatform("weixin_channels").routes.home, loading: false, visible: false, messageMode: true } as ViewState);
    f.viewPool.getIdentityEvidence.mockReturnValue({ kind: "online", key: "passive", sequence: 1, observedAt: Date.now(), reason: "已确认登录" });
    expect((await f.service.checkStatus(f.account.id, { force: true, refreshPage: true })).status).toBe("online");
    expect(f.viewPool.navigate).not.toHaveBeenCalled();
    expect(f.session.fetch).not.toHaveBeenCalled();
  });
  it("clears message protection on an explicit regular route", async () => {
    const f = fixture();
    await f.service.go(f.account.id, "home");
    expect(f.viewPool.setMessageMode).toHaveBeenCalledWith(f.account.id, false);
    expect(f.viewPool.setMessageMode.mock.invocationCallOrder[0]).toBeLessThan(f.viewPool.navigate.mock.invocationCallOrder[0]);
  });
});

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const uninstall of uninstallers.splice(0)) uninstall();
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AccountService network and authentication separation", () => {
  it("retains a recent confirmed Bilibili homepage conclusion on management pages without refreshing its timestamps", async () => {
    const f = fixture("online", true, undefined, "bilibili");
    expect(f.account.status).toBe("unknown");
    const evaluate = vi.fn(async () => ({ kind: "online", source: "homepage", reason: "主页已登录" }));
    f.viewPool.getWebContents.mockReturnValue(Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: evaluate }) as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: getPlatform("bilibili").routes.site, loading: false } as ViewState);
    vi.setSystemTime("2026-09-07T12:10:00.000Z");
    const confirmed = await f.service.checkStatus(f.account.id, { skipProbe: false });
    expect(confirmed.status).toBe("online");
    expect(evaluate).toHaveBeenCalledOnce();
    f.viewPool.getState.mockReturnValue({ url: getPlatform("bilibili").routes.home, loading: false } as ViewState);
    const writeStatus = vi.spyOn(f.store.accounts, "updateStatus");
    const online = vi.fn(),
      changed = vi.fn();
    f.service.on("account-online", online);
    f.service.on("account-changed", changed);
    vi.setSystemTime("2026-09-07T12:10:01.000Z");
    expect(await f.service.checkStatus(f.account.id)).toMatchObject(authFields(confirmed)!);
    expect(f.probeResponse).not.toHaveBeenCalled();
    vi.setSystemTime("2026-09-07T12:10:02.000Z");
    f.probeResponse.mockResolvedValueOnce(responseAt(Response.json({ code: -352 })));
    expect(await f.service.checkStatus(f.account.id, { skipProbe: false })).toMatchObject(
      authFields(confirmed)!,
    );
    expect(f.probeResponse).not.toHaveBeenCalled();
    vi.setSystemTime("2026-09-07T12:10:03.000Z");
    expect(await f.service.checkStatus(f.account.id)).toMatchObject(authFields(confirmed)!);
    f.service.onActivity(f.account.id, "navigated");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.probeResponse).not.toHaveBeenCalled();
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(confirmed)!);
    expect(writeStatus).not.toHaveBeenCalled();
    expect(online).not.toHaveBeenCalled();
    expect(
      changed.mock.calls.every(([account]) =>
        ["checking", "unconfirmed", "paused"].includes(account.checkInfo?.state),
      ),
    ).toBe(true);
    expect(f.fetchProfile).not.toHaveBeenCalled();
    expect(f.store.collectJobs.list(f.account.id)).toEqual([]);
  });
  it.each(["online", "offline", "unknown"] as const)(
    "does not consult main-process nav responses for a stored Bilibili %s status",
    async (status) => {
      const f = fixture(status, true, undefined, "bilibili");
      const online = vi.fn(),
        changed = vi.fn();
      f.service.on("account-online", online);
      f.service.on("account-changed", changed);
      const writeStatus = vi.spyOn(f.store.accounts, "updateStatus");
      vi.setSystemTime("2026-09-07T12:10:00.000Z");
      for (const [httpStatus, body] of [
        [200, "<!doctype html><html>challenge</html>"],
        [200, '{"code":-352}'],
        [200, "{broken"],
        [200, "{}"],
        [204, null],
      ] as const) {
        f.probeResponse.mockResolvedValueOnce(responseAt(new Response(body, { status: httpStatus })));
        expect(await f.service.checkStatus(f.account.id, { skipProbe: false })).toMatchObject(
          authFields(f.account)!,
        );
        expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
      }
      expect(f.probeResponse).not.toHaveBeenCalled();
      expect(f.session.fetch).not.toHaveBeenCalled();
      expect(writeStatus).not.toHaveBeenCalled();
      expect(online).not.toHaveBeenCalled();
      expect(
        changed.mock.calls.every(([account]) =>
          ["checking", "unconfirmed", "paused"].includes(account.checkInfo?.state),
        ),
      ).toBe(true);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.fetchProfile).not.toHaveBeenCalled();
      expect(f.store.collectJobs.list(f.account.id)).toEqual([]);
      expect(f.store.audit.list()).toEqual([]);
    },
  );
  it.each(["strict", "observe"] as const)(
    "does not consult redirected main-process Bilibili auth responses in %s mode",
    async (enforcement) => {
      const f = fixture("offline", true, undefined, "bilibili");
      if (enforcement === "observe") {
        uninstallers.push(installBusinessNetwork({ ...f.network, enforcement: "observe" }));
      }
      const online = vi.fn(),
        changed = vi.fn();
      f.service.on("account-online", online);
      f.service.on("account-changed", changed);
      const writeStatus = vi.spyOn(f.store.accounts, "updateStatus");
      vi.setSystemTime("2026-09-07T12:10:00.000Z");
      for (const [httpStatus, body] of [
        [200, '{"code":0,"data":{"isLogin":true}}'],
        [200, '{"code":-101,"data":{"isLogin":false}}'],
        [401, ""],
      ] as const) {
        f.probeResponse.mockResolvedValueOnce(
          responseAt(
            new Response(body, { status: httpStatus }),
            "https://passport.bilibili.com/fixture/final",
          ),
        );
        expect(await f.service.checkStatus(f.account.id, { skipProbe: false })).toMatchObject(
          authFields(f.account)!,
        );
        expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
      }
      expect(f.probeResponse).not.toHaveBeenCalled();
      expect(f.session.fetch).not.toHaveBeenCalled();
      expect(writeStatus).not.toHaveBeenCalled();
      expect(online).not.toHaveBeenCalled();
      expect(
        changed.mock.calls.every(([account]) =>
          ["checking", "unconfirmed", "paused"].includes(account.checkInfo?.state),
        ),
      ).toBe(true);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.fetchProfile).not.toHaveBeenCalled();
      expect(f.store.collectJobs.list(f.account.id)).toEqual([]);
      expect(f.store.audit.list()).toEqual([]);
    },
  );
  it("offers a committed profile image only to main-process media while persisting no signed URL", async () => {
    const f = fixture("online", true, undefined, "baijiahao");
    const source = "https://media.example.test/signed-path?signature=synthetic";
    f.fetchProfile.mockResolvedValueOnce({ avatarUrl: source, handle: "safe-handle" });
    const account = await f.service.refreshProfile(f.account.id);
    expect(account.avatarUrl).toBeNull();
    expect(account.handle).toBe("safe-handle");
    expect(account.status).toBe("online");
    expect(f.store.accounts.get(account.id)?.avatarUrl).toBeNull();
    expect(f.mediaIntake.avatar).toHaveBeenCalledExactlyOnceWith(account.id, source, { refresh: true });
  });

  it("offers the verified Channels identity avatar even when no collector refresh is run", async () => {
    const f = fixture("online", true, undefined, "weixin_channels");
    const avatarUrl = "https://wx.qlogo.cn/own/0?signature=synthetic";
    f.viewPool.getIdentityEvidence.mockReturnValue({
      kind: "online", key: "identity-avatar", sequence: 1, observedAt: Date.now(),
      reason: "平台网页已确认登录身份", subject: "self",
      profile: { externalId: "self", avatarUrl },
    });
    const result = await f.service.checkStatus(f.account.id, { force: true });
    expect(result.status).toBe("online");
    expect(f.mediaIntake.avatar).toHaveBeenCalledExactlyOnceWith(f.account.id, avatarUrl, { refresh: true });
    expect(result.avatarUrl).toBeNull();
    expect(f.store.accounts.get(f.account.id)?.avatarUrl).toBeNull();
    expect(JSON.stringify(f.store.audit.list())).not.toContain("signature");
    expect(f.fetchProfile).not.toHaveBeenCalled();
  });

  it("does not offer a profile image from a result received after revocation", async () => {
    const f = fixture("online", true);
    const pending = deferred<ProfileInfo>();
    f.fetchProfile.mockReturnValueOnce(pending.promise);
    const refresh = f.service.refreshProfile(f.account.id);
    f.revoke();
    pending.resolve({ avatarUrl: "https://media.example.test/private" });
    await refresh;
    expect(f.mediaIntake.avatar).not.toHaveBeenCalled();
    expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
  });
  it("does not make a local blank-page navigation fail during observation", () => {
    const f = fixture("online", false);
    const observe: BusinessNetworkController = {
      enforcement: "observe",
      check: () => ({ allowed: false, reason: "CHECKING" }),
      acquire: () => null,
    };
    uninstallers.push(installBusinessNetwork(observe));
    expect(() =>
      f.service.prepareNetworkOperation(f.account.id, "view-navigate", "about:blank"),
    ).not.toThrow();
    expect(f.session.fetch).not.toHaveBeenCalled();
  });

  it("declares the probe scope before any cookie access and returns old auth when the new scope closes permission", async () => {
    const f = fixture("online", true, undefined, "baijiahao");
    vi.mocked(f.network.prepareOperation!).mockImplementation(() => {
      f.revoke();
      return { ready: Promise.resolve(), contextId: "fixture", scopeVersion: "new-api-scope" };
    });
    await expect(f.service.checkStatus(f.account.id)).resolves.toMatchObject(authFields(f.account)!);
    expect(f.network.prepareOperation).toHaveBeenCalledWith(f.account.id, {
      operation: "check-status",
      activePageOrigin: null,
    });
    expect(browser.configure).not.toHaveBeenCalled();
    expect(f.session.cookies.get).not.toHaveBeenCalled();
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
  });

  it("declares a manual navigation target without retaining its path/query or opening a view when closed", async () => {
    const f = fixture("online", false);
    await expect(f.service.go(f.account.id, "site")).rejects.toThrow(/等待国内网络/);
    expect(f.network.prepareOperation).toHaveBeenCalledWith(f.account.id, {
      operation: "view-navigate",
      activePageOrigin: null,
      targetPageOrigin: { protocol: "https:", host: "www.douyin.com", port: 443 },
    });
    expect(f.viewPool.ensure).not.toHaveBeenCalled();
    expect(f.viewPool.navigate).not.toHaveBeenCalled();
  });

  it("blocks restore-time activity even in observe mode and resumes only after finish without inventing login", async () => {
    const rebuild = deferred<void>();
    const onSessionChange = vi.fn(() => rebuild.promise);
    const f = fixture("offline", false, onSessionChange, "baijiahao");
    const observe: BusinessNetworkController = {
      enforcement: "observe",
      check: vi.fn(() => ({ allowed: false, reason: "CHECKING" })),
      acquire: vi.fn(() => null),
    };
    uninstallers.push(installBusinessNetwork(observe));
    const online = vi.fn();
    f.service.on("account-online", online);
    // A cookie event queued just before restore and new events during its await
    // must not open a fresh partition or restart an authenticated probe.
    f.service.onActivity(f.account.id, "cookies");
    const preparing = f.service.prepareSessionChange(f.account.id, "restore");
    expect(onSessionChange).toHaveBeenCalledWith(f.account.id, "restore");
    f.service.onActivity(f.account.id, "loaded");
    await expect(f.service.checkStatus(f.account.id)).resolves.toMatchObject(authFields(f.account)!);
    await expect(f.service.refreshProfile(f.account.id)).resolves.toMatchObject(authFields(f.account)!);
    await expect(f.service.showView(f.account.id, { x: 0, y: 0, width: 100, height: 100 })).rejects.toThrow(
      /重建/,
    );
    expect(() => f.service.ensureView(f.account.id)).toThrow(/重建/);
    await expect(f.service.go(f.account.id, "home")).rejects.toThrow(/重建/);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(browser.configure).not.toHaveBeenCalled();
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(f.fetchProfile).not.toHaveBeenCalled();
    expect(f.viewPool.show).not.toHaveBeenCalled();
    expect(f.viewPool.ensure).not.toHaveBeenCalled();
    expect(f.viewPool.navigate).not.toHaveBeenCalled();
    expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
    expect(online).not.toHaveBeenCalled();
    rebuild.resolve();
    await preparing;
    await expect(f.service.checkStatus(f.account.id)).resolves.toMatchObject(authFields(f.account)!);
    expect(f.session.fetch).not.toHaveBeenCalled();

    f.service.finishSessionChange(f.account.id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(online).not.toHaveBeenCalled();
    expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
    // Finishing reconstruction grants no authentication result. Only this
    // explicit manual check and the real detector may establish online again.
    const result = await f.service.checkStatus(f.account.id);
    expect(result.status).toBe("online");
    expect(f.session.fetch).toHaveBeenCalledOnce();
    expect(online).toHaveBeenCalledOnce();
  });

  it.each<AccountStatus>(["unknown", "online", "offline", "needs_verification", "expiring", "network_error"])(
    "preserves %s and its true check timestamps while dormant, with no session/probe/profile work",
    async (status) => {
      const f = fixture(status, false, undefined, "baijiahao");
      const online = vi.fn();
      const changed = vi.fn();
      f.service.on("account-online", online);
      f.service.on("account-changed", changed);
      const writeStatus = vi.spyOn(f.store.accounts, "updateStatus");
      vi.setSystemTime("2026-09-07T12:10:00.000Z");
      expect(await f.service.checkStatus(f.account.id)).toMatchObject(authFields(f.account)!);
      expect(await f.service.refreshProfile(f.account.id)).toMatchObject(authFields(f.account)!);
      expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
      expect(browser.configure).not.toHaveBeenCalled();
      // Reading the existing page selection prepares anonymous proof scope; it does not create a
      // view, read cookies or run an authenticated probe while the gate is closed.
      expect(f.network.prepareOperation).toHaveBeenCalledWith(f.account.id, {
        operation: "check-status",
        activePageOrigin: null,
      });
      expect(f.network.prepareOperation).toHaveBeenCalledWith(f.account.id, {
        operation: "profile",
        activePageOrigin: null,
      });
      expect(f.session.cookies.get).not.toHaveBeenCalled();
      expect(f.session.fetch).not.toHaveBeenCalled();
      expect(f.fetchProfile).not.toHaveBeenCalled();
      expect(writeStatus).not.toHaveBeenCalled();
      expect(online).not.toHaveBeenCalled();
      expect(
        changed.mock.calls.every(([account]) =>
          ["checking", "unconfirmed", "paused"].includes(account.checkInfo?.state),
        ),
      ).toBe(true);
      expect(f.notify).not.toHaveBeenCalled();

      const check = vi.spyOn(f.service, "checkStatus");
      f.service.scheduleCheck(f.account.id);
      f.service.startPatrol();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(check).not.toHaveBeenCalled();
      expect(f.session.fetch).not.toHaveBeenCalled();
    },
  );

  it("uses the unified session factory and real login detector when a no-view probe is allowed", async () => {
    const f = fixture("offline", true, undefined, "baijiahao");
    const online = vi.fn();
    f.service.on("account-online", online);
    const result = await f.service.checkStatus(f.account.id);
    expect(browser.configure).toHaveBeenCalledWith(f.account.id, "baijiahao");
    expect(f.session.fetch).toHaveBeenCalledOnce();
    expect(result.status).toBe("online");
    expect(f.store.accounts.get(f.account.id)?.status).toBe("online");
    expect(online).toHaveBeenCalledOnce();
  });

  it.each(["account suspension", "revocation followed by a new allowed generation", "service disposal"])(
    "ignores a late successful check after %s without announcing login or writing status",
    async (transition) => {
      const f = fixture("offline", true, undefined, "baijiahao");
      const response = deferred<Response>();
      const requested = deferred<void>();
      f.session.fetch.mockImplementation(() => {
        requested.resolve();
        return response.promise;
      });
      const online = vi.fn();
      const changed = vi.fn();
      f.service.on("account-online", online);
      f.service.on("account-changed", changed);
      const writeStatus = vi.spyOn(f.store.accounts, "updateStatus");
      const pending = f.service.checkStatus(f.account.id);
      await requested.promise;
      if (transition === "account suspension") f.service.suspendNetworkAccount(f.account.id);
      else if (transition === "service disposal") f.service.dispose();
      else {
        f.revoke();
        f.reopen();
      }
      // Deliberately model a non-cooperative transport returning success after
      // abort; old business callbacks still cannot restore the account.
      response.resolve(Response.json({ errno: 0, data: { id: "self" } }));
      expect(await pending).toMatchObject(authFields(f.account)!);
      expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
      expect(writeStatus).not.toHaveBeenCalled();
      expect(online).not.toHaveBeenCalled();
      expect(
        changed.mock.calls.every(([account]) =>
          ["checking", "unconfirmed", "paused"].includes(account.checkInfo?.state),
        ),
      ).toBe(true);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.store.audit.list()).toEqual([]);
    },
  );

  it.each(["account suspension", "revocation followed by a new allowed generation", "service disposal"])(
    "ignores a late profile after %s",
    async (transition) => {
      const f = fixture("online");
      const response = deferred<ProfileInfo | null>();
      f.fetchProfile.mockReturnValue(response.promise);
      const changed = vi.fn();
      f.service.on("account-changed", changed);
      const write = vi.spyOn(f.store.accounts, "update");
      const pending = f.service.refreshProfile(f.account.id);
      expect(f.fetchProfile).toHaveBeenCalledOnce();
      if (transition === "account suspension") f.service.suspendNetworkAccount(f.account.id);
      else if (transition === "service disposal") f.service.dispose();
      else {
        f.revoke();
        f.reopen();
      }
      response.resolve({
        displayName: "Stale creator",
        avatarUrl: "https://example.test/stale.png",
        handle: "stale",
        externalId: "stale-id",
      });
      expect(await pending).toMatchObject(authFields(f.account)!);
      expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
      expect(write).not.toHaveBeenCalled();
      expect(
        changed.mock.calls.every(([account]) =>
          ["checking", "unconfirmed", "paused"].includes(account.checkInfo?.state),
        ),
      ).toBe(true);
    },
  );

  it("still applies a current profile result", async () => {
    const f = fixture("online");
    const result = await f.service.refreshProfile(f.account.id);
    expect(result.displayName).toBe("Fixture creator");
    expect(result.handle).toBe("fixture-handle");
    expect(f.store.accounts.get(f.account.id)?.displayName).toBe("Fixture creator");
  });

  it.each(["douyin", "kuaishou", "xiaohongshu", "bilibili", "baijiahao", "weixin_channels"] as const)(
    "syncs %s's renamed self profile without turning creator identity into homepage login", platform => {
      const f = fixture("offline", true, undefined, platform);
      f.store.accounts.update(f.account.id, { displayName: "旧昵称", externalId: "self" });
      f.viewPool.getState.mockReturnValue({ url: getPlatform(platform).routes.home, instanceId: 1, navigationId: 1 } as ViewState);
      const avatarUrl = "https://media.example.test/new.jpg";
      const evidence = { kind: "online" as const, subject: "self", key: "fresh-profile", sequence: 1, observedAt: Date.now(), reason: "self",
        profile: { externalId: "self", displayName: "新昵称", avatarUrl } };
      f.viewPool.getIdentityEvidence.mockReturnValue(evidence);
      const online = vi.fn(); f.service.on("account-online", online);
      f.service.onActivity(f.account.id, "identity");
      expect(f.service.get(f.account.id)).toMatchObject({ displayName: "新昵称", status: "offline", externalId: "self", avatarUrl: null });
      expect(f.mediaIntake.avatar).toHaveBeenCalledExactlyOnceWith(f.account.id, avatarUrl, { refresh: true });
      f.service.onActivity(f.account.id, "identity");
      expect(f.mediaIntake.avatar).toHaveBeenCalledTimes(1);
      expect(online).not.toHaveBeenCalled();
      expect(f.session.fetch).not.toHaveBeenCalled();
    },
  );

  it("does not restore an old name/avatar after a newer passive profile arrives during a scan", async () => {
    const f = fixture("online", true, undefined, "bilibili");
    f.viewPool.getState.mockReturnValue({ url: "https://www.bilibili.com/", instanceId: 1, navigationId: 1 } as ViewState);
    const reply = deferred<ProfileInfo | null>();
    f.fetchProfile.mockReturnValue(reply.promise);
    const pending = f.service.refreshProfile(f.account.id);
    f.service.syncProfile(f.account.id, { displayName: "刚改的新名", avatarUrl: "https://i0.hdslb.com/new.jpg" });
    reply.resolve({ displayName: "旧名", avatarUrl: "https://i0.hdslb.com/old.jpg" });
    expect((await pending).displayName).toBe("刚改的新名");
    expect(f.mediaIntake.avatar).toHaveBeenCalledExactlyOnceWith(f.account.id, "https://i0.hdslb.com/new.jpg", { refresh: true });
  });

  it("refreshes an unchanged avatar source even when the profile has no changed database fields", async () => {
    const f = fixture("online");
    f.fetchProfile.mockResolvedValue({ avatarUrl: "https://media.example.test/same.jpg" });
    await f.service.refreshProfile(f.account.id);
    await f.service.refreshProfile(f.account.id);
    expect(f.mediaIntake.avatar).toHaveBeenCalledTimes(2);
    expect(f.mediaIntake.avatar).toHaveBeenLastCalledWith(f.account.id, "https://media.example.test/same.jpg", { refresh: true });
  });

  it("observes only the visible homepage on the local profile interval and stops on disposal", async () => {
    const f = fixture("offline", true, undefined, "bilibili");
    f.viewPool.getState.mockReturnValue({ url: "https://www.bilibili.com/", visible: true } as ViewState);
    const check = vi.spyOn(f.service, "checkStatus").mockResolvedValue(f.account);
    f.service.startPatrol(); await vi.advanceTimersByTimeAsync(15_000);
    expect(check).toHaveBeenCalledWith(f.account.id, { skipProbe: true, silent: true, force: true });
    check.mockClear();
    f.viewPool.getState.mockReturnValue({ url: "https://www.bilibili.com/", visible: true, messageMode: true } as ViewState);
    await vi.advanceTimersByTimeAsync(15_000); expect(check).not.toHaveBeenCalled();
    f.service.dispose(); await vi.advanceTimersByTimeAsync(15_000); expect(check).not.toHaveBeenCalled();
  });

  it.each([
    { displayName: null, avatarUrl: null, handle: null, externalId: null },
    { displayName: "   ", avatarUrl: "   ", handle: "   ", externalId: "   " },
    { displayName: false, avatarUrl: "loading", handle: 0, externalId: {} },
  ])("retains saved identity fields after an empty or malformed profile scan: %j", async (reply) => {
    const f = fixture("online");
    const saved = f.store.accounts.update(f.account.id, {
      displayName: "我的账号", handle: "saved-handle", externalId: "saved-uid", avatarUrl: "https://example.test/saved.png",
    })!;
    f.fetchProfile.mockResolvedValue(reply as unknown as ProfileInfo);
    expect(await f.service.refreshProfile(f.account.id)).toEqual(saved);
    expect(f.store.accounts.get(f.account.id)).toEqual(saved);
    expect(f.mediaIntake.avatar).not.toHaveBeenCalled();
  });

  it("preserves a nickname edited while a profile scan is running", async () => {
    const f = fixture("online");
    const reply = deferred<ProfileInfo | null>();
    f.fetchProfile.mockReturnValue(reply.promise);
    const pending = f.service.refreshProfile(f.account.id);
    f.service.update(f.account.id, { displayName: "我刚修改的昵称" });
    reply.resolve({ displayName: "平台自动昵称", handle: " current-handle " });
    expect(await pending).toMatchObject({ displayName: "我刚修改的昵称", handle: "current-handle" });
  });

  it("ignores an older overlapping profile response after a newer scan completes", async () => {
    const f = fixture("online");
    const old = deferred<ProfileInfo | null>();
    f.fetchProfile.mockReturnValueOnce(old.promise);
    const pending = f.service.refreshProfile(f.account.id);
    f.fetchProfile.mockResolvedValueOnce({ handle: "new-handle", externalId: "new-uid" });
    await f.service.refreshProfile(f.account.id);
    old.resolve({ handle: "old-handle", externalId: "old-uid" });
    expect(await pending).toMatchObject({ handle: "new-handle", externalId: "new-uid" });
  });

  it.each([
    { url: "https://www.xiaohongshu.com/explore" },
    { url: "https://creator.xiaohongshu.com/login" },
    { url: "https://creator.xiaohongshu.com/new/home", loading: true },
  ])("skips creator profile scans in an unsuitable page context: %j", async (state) => {
    const f = fixture("online", true, undefined, "xiaohongshu");
    f.viewPool.getState.mockReturnValue(state as ViewState);
    expect(await f.service.refreshProfile(f.account.id)).toEqual(f.account);
    expect(f.fetchProfile).not.toHaveBeenCalled();
  });

  it.each(["navigation", "recreated page", "identity", "identity cleared", "identity appeared", "logged out"])(
    "ignores profile results after the account's %s changes",
    async (change) => {
      const f = fixture("online");
      const state = { url: getPlatform("douyin").routes.home, instanceId: 1, navigationId: 1 } as ViewState;
      f.viewPool.getState.mockReturnValue(state);
      f.viewPool.getIdentityEvidence.mockReturnValue(
        change === "identity appeared" ? null : { subject: "old-user" } as IdentityEvidence,
      );
      const reply = deferred<ProfileInfo | null>();
      f.fetchProfile.mockReturnValue(reply.promise);
      const pending = f.service.refreshProfile(f.account.id);
      if (change === "navigation") f.viewPool.getState.mockReturnValue({ ...state, navigationId: 2 });
      if (change === "recreated page") f.viewPool.getState.mockReturnValue({ ...state, instanceId: 2 });
      if (change === "identity") f.viewPool.getIdentityEvidence.mockReturnValue({ subject: "new-user" } as IdentityEvidence);
      if (change === "identity cleared") f.viewPool.getIdentityEvidence.mockReturnValue(null);
      if (change === "identity appeared") f.viewPool.getIdentityEvidence.mockReturnValue({ subject: "new-user" } as IdentityEvidence);
      if (change === "logged out") f.store.accounts.updateStatus(f.account.id, "offline", "logged out");
      const beforeReply = f.store.accounts.get(f.account.id);
      reply.resolve({ displayName: "Stale name", handle: "old-handle", externalId: "old-user" });
      expect(await pending).toEqual(beforeReply);
      expect(f.store.accounts.get(f.account.id)).toEqual(beforeReply);
    },
  );

  it("does not start the initial or periodic patrol after disposal", async () => {
    const f = fixture();
    const check = vi.spyOn(f.service, "checkStatus");
    f.service.startPatrol();
    f.service.scheduleCheck(f.account.id);
    f.service.dispose();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(check).not.toHaveBeenCalled();
    expect(browser.configure).not.toHaveBeenCalled();
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not continue a staggered patrol or commit its first result after disposal", async () => {
    const f = fixture();
    f.store.accounts.create({ platformId: "douyin" });
    const response = deferred<Response>();
    f.session.fetch.mockReturnValue(response.promise);
    const check = vi.spyOn(f.service, "checkStatus");
    f.service.startPatrol();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(check).toHaveBeenCalledOnce();
    f.service.dispose();
    response.resolve(Response.json({ status_code: 0 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(check).toHaveBeenCalledOnce();
    expect(f.store.accounts.get(f.account.id)).toMatchObject(authFields(f.account)!);
    expect(f.notify).not.toHaveBeenCalled();
  });
});
