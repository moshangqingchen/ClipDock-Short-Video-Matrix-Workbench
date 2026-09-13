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
    expect(f.viewPool.navigate).toHaveBeenCalledExactlyOnceWith(f.account.id, getPlatform("weixin_channels").routes.home);
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
    { url: "https://channels.weixin.qq.com/login.html", visible: true },
    { url: "https://channels.weixin.qq.com/platform", visible: true },
    { url: "https://captcha.qq.com/verify", visible: false },
  ])("does not replace an active page or hidden editor during background refresh: $url", async page => {
    const f = fixture("online", true, undefined, "weixin_channels");
    f.viewPool.getState.mockReturnValue({ ...page, loading: false } as ViewState);
    await f.service.checkStatus(f.account.id, { force: true, refreshPage: true });
    expect(f.viewPool.navigate).not.toHaveBeenCalled();
    expect(browser.wipe).not.toHaveBeenCalled();
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
          : [{ name: "sessionid", value: "synthetic-local-fixture", domain: ".douyin.com" }],
      ),
    },
    fetch: vi.fn<(_url: string, _init?: RequestInit) => Promise<Response>>(async (url) =>
      responseAt(
        Response.json(platformId === "bilibili" ? { code: 0, data: { isLogin: true } } : { status_code: 0 }),
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
    account,
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
    expect(prepare).toHaveBeenCalledWith(f.account.id, "check-status", undefined);
    expect(f.viewPool.show).toHaveBeenCalledWith(
      { id: f.account.id, platformId: "douyin" }, bounds, false,
    );
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

  it("keeps the confirmed homepage login and its timestamps when a later observation is unavailable", async () => {
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
    expect(authFields(unavailable)).toEqual(authFields(confirmed));
    expect(unavailable.checkInfo?.state).toBe("unconfirmed");
    expect(f.session.fetch).not.toHaveBeenCalled();
    expect(f.mediaIntake.avatar).not.toHaveBeenCalled();
  });

  it("rechecks homepage logout before marking offline and handles re-login immediately after cookie activity", async () => {
    const f = fixture("online");
    const evaluate = vi.fn()
      .mockResolvedValueOnce({ kind: "offline", source: "homepage", reason: "主页已退出登录" })
      .mockResolvedValueOnce({ kind: "offline", source: "homepage", reason: "主页已退出登录" })
      .mockResolvedValue({ kind: "online", source: "homepage", reason: "主页已登录" });
    f.viewPool.getWebContents.mockReturnValue(Object.assign(new EventEmitter(), {
      isDestroyed: () => false, executeJavaScript: evaluate,
    }) as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: getPlatform("douyin").routes.site, loading: false } as ViewState);
    expect((await f.service.checkStatus(f.account.id, { force: true })).status).toBe("online");
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.store.accounts.get(f.account.id)?.status).toBe("offline");
    f.service.onActivity(f.account.id, "cookies");
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.store.accounts.get(f.account.id)).toMatchObject({ status: "online", checkInfo: { state: "confirmed" } });
    expect(evaluate).toHaveBeenCalledTimes(3);
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

  it("rechecks one Xiaohongshu 401 without dropping account information, then confirms a second failure", async () => {
    const f = fixture("online", true, undefined, "xiaohongshu");
    const saved = f.store.accounts.update(f.account.id, {
      displayName: "保存的昵称", handle: "2623619080", externalId: "saved-uid",
    })!;
    const probe = vi.fn(async () => ({ status: 401, text: "", url: getPlatform("xiaohongshu").login.probe.url }));
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: probe });
    f.viewPool.getWebContents.mockReturnValue(wc as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({
      url: getPlatform("xiaohongshu").routes.home, loading: false, instanceId: 1, navigationId: 1,
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

  it("cancels Xiaohongshu's temporary negative conclusion after a successful recheck", async () => {
    const f = fixture("online", true, undefined, "xiaohongshu");
    const url = getPlatform("xiaohongshu").login.probe.url;
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 401, text: "", url })
      .mockResolvedValueOnce({ status: 200, text: '{"code":0,"data":{"userId":"same-user"}}', url })
      .mockResolvedValueOnce({ status: 401, text: "", url });
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: probe });
    f.viewPool.getWebContents.mockReturnValue(wc as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: getPlatform("xiaohongshu").routes.home } as ViewState);
    expect((await f.service.checkStatus(f.account.id, { force: true })).checkInfo?.state).toBe("unconfirmed");
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.store.accounts.get(f.account.id)?.checkInfo?.state).toBe("confirmed");
    expect((await f.service.checkStatus(f.account.id, { force: true })).checkInfo?.state).toBe("unconfirmed");
    expect(f.store.accounts.get(f.account.id)?.status).toBe("online");
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("runs the negative recheck even when a successful probe happened less than 30 seconds ago", async () => {
    const f = fixture("online", true, undefined, "xiaohongshu");
    const url = getPlatform("xiaohongshu").login.probe.url;
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 200, text: '{"code":0,"data":{"userId":"same-user"}}', url })
      .mockResolvedValue({ status: 401, text: "", url });
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: probe });
    f.viewPool.getWebContents.mockReturnValue(wc as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: getPlatform("xiaohongshu").routes.home } as ViewState);
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

  it.each(["member", "api"])("allows Bilibili nav checks from its %s creator/API page context", async (host) => {
    const f = fixture("online", true, undefined, "bilibili");
    const probe = vi.fn(async () => ({ status: 200, text: '{"code":0,"data":{"isLogin":true}}', url: biliProbeUrl }));
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: probe });
    f.viewPool.getWebContents.mockReturnValue(wc as unknown as WebContents);
    f.viewPool.getState.mockReturnValue({ url: `https://${host}.bilibili.com/`, loading: false } as ViewState);
    expect((await f.service.checkStatus(f.account.id, { force: true })).checkInfo?.state).toBe("confirmed");
    expect(probe).toHaveBeenCalledOnce();
  });

  it.each(["kuaishou", "weixin_channels"] as const)(
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
    const f = fixture("online");
    const two = f.service.create({ platformId: "douyin" }),
      three = f.service.create({ platformId: "douyin" });
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
    const f = fixture("online");
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

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const uninstall of uninstallers.splice(0)) uninstall();
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AccountService network and authentication separation", () => {
  it("keeps a real Bilibili verdict's timestamps during throttled checks before and after a forced challenge", async () => {
    const f = fixture("online", true, undefined, "bilibili");
    vi.setSystemTime("2026-09-07T12:10:00.000Z");
    const confirmed = await f.service.checkStatus(f.account.id, { skipProbe: false });
    expect(confirmed.status).toBe("online");
    expect(f.probeResponse).toHaveBeenCalledOnce();
    const writeStatus = vi.spyOn(f.store.accounts, "updateStatus");
    const online = vi.fn(),
      changed = vi.fn();
    f.service.on("account-online", online);
    f.service.on("account-changed", changed);
    vi.setSystemTime("2026-09-07T12:10:01.000Z");
    expect(await f.service.checkStatus(f.account.id)).toMatchObject(authFields(confirmed)!);
    expect(f.probeResponse).toHaveBeenCalledOnce();
    vi.setSystemTime("2026-09-07T12:10:02.000Z");
    f.probeResponse.mockResolvedValueOnce(responseAt(Response.json({ code: -352 })));
    expect(await f.service.checkStatus(f.account.id, { skipProbe: false })).toMatchObject(
      authFields(confirmed)!,
    );
    expect(f.probeResponse).toHaveBeenCalledTimes(2);
    vi.setSystemTime("2026-09-07T12:10:03.000Z");
    expect(await f.service.checkStatus(f.account.id)).toMatchObject(authFields(confirmed)!);
    f.service.onActivity(f.account.id, "cookies");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.probeResponse).toHaveBeenCalledTimes(2);
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
    "retains Bilibili %s and all authentic timestamps after challenge/empty/malformed nav replies",
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
      expect(f.probeResponse).toHaveBeenCalledTimes(5);
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
    "does not commit Bilibili auth or timestamps from a redirected response outside the configured origin in %s mode",
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
      expect(f.probeResponse).toHaveBeenCalledTimes(3);
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
    const f = fixture("online", true);
    const source = "https://media.example.test/signed-path?signature=synthetic";
    f.fetchProfile.mockResolvedValueOnce({ avatarUrl: source, handle: "safe-handle" });
    const account = await f.service.refreshProfile(f.account.id);
    expect(account.avatarUrl).toBeNull();
    expect(account.handle).toBe("safe-handle");
    expect(account.status).toBe("online");
    expect(f.store.accounts.get(account.id)?.avatarUrl).toBeNull();
    expect(f.mediaIntake.avatar).toHaveBeenCalledExactlyOnceWith(account.id, source);
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
    expect(f.mediaIntake.avatar).toHaveBeenCalledExactlyOnceWith(f.account.id, avatarUrl);
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
    const f = fixture("online", true);
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
    const f = fixture("offline", false, onSessionChange);
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
      const f = fixture(status, false);
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
    const f = fixture();
    const online = vi.fn();
    f.service.on("account-online", online);
    const result = await f.service.checkStatus(f.account.id);
    expect(browser.configure).toHaveBeenCalledWith(f.account.id, "douyin");
    expect(f.session.fetch).toHaveBeenCalledOnce();
    expect(result.status).toBe("online");
    expect(f.store.accounts.get(f.account.id)?.status).toBe("online");
    expect(online).toHaveBeenCalledOnce();
  });

  it.each(["account suspension", "revocation followed by a new allowed generation", "service disposal"])(
    "ignores a late successful check after %s without announcing login or writing status",
    async (transition) => {
      const f = fixture();
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
      response.resolve(Response.json({ status_code: 0 }));
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
