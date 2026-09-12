import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createStore, type Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import type { AccountService } from "@main/services/account-service";
import {
  beginBusinessOperation,
  installBusinessNetwork,
  NetworkDormantError,
} from "@main/network/business-access";
import type { CollectorRegistry, CollectorResult } from "./collectors";
import { CollectScheduler } from "./scheduler";
import { registerMetricsHandlers } from "@main/ipc/handlers/metrics";
import type { IpcRegistrar } from "@main/ipc/register";
import { IPC } from "@shared/ipc";
import { getPlatform, type PlatformId } from "@shared/platforms";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let store: Store, scheduler: CollectScheduler, uninstall: () => void;
let allowed: boolean, generation: number;
let leases: AbortController[];
beforeEach(() => {
  vi.useFakeTimers();
  store = createStore(":memory:");
  allowed = false;
  generation = 1;
  leases = [];
  uninstall = installBusinessNetwork({
    enforcement: "strict",
    check: () => ({ allowed, reason: allowed ? "READY" : "CHECKING" }),
    acquire: () => {
      if (!allowed) return null;
      const abort = new AbortController(),
        version = generation;
      leases.push(abort);
      return {
        signal: abort.signal,
        isCurrent: () => version === generation && !abort.signal.aborted,
        release: () => abort.abort(),
      };
    },
  });
});
afterEach(async () => {
  scheduler?.stop();
  await Promise.resolve();
  uninstall();
  store.close();
  vi.useRealTimers();
});
function setup(platformId: PlatformId = "douyin", needsMediaRefresh?: (accountId: string) => boolean) {
  const raw = store.accounts.create({ platformId });
  const account = store.accounts.updateStatus(raw.id, "online", "已登录")!;
  let url = "about:blank";
  let navigationId = 0;
  const wc = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => false,
    isLoading: () => false,
  });
  const entry = { visible: false, view: { webContents: wc } };
  const ensure = vi.fn(() => entry);
  const setPage = (next: string, visible = entry.visible) => {
    url = next;
    navigationId++;
    entry.visible = visible;
  };
  const navigate = vi.fn(async (_id: string, next: string) => {
    setPage(next);
  });
  const result = deferred<CollectorResult>();
  const collect = vi.fn(() => result.promise);
  const update = vi.fn((id: string, patch: Parameters<typeof store.accounts.update>[1]) =>
    store.accounts.update(id, patch),
  );
  const checkStatus = vi.fn(async () => store.accounts.get(account.id)!);
  const prepareNetworkOperation = vi.fn();
  const accounts = {
    list: () => store.accounts.list(),
    update,
    checkStatus,
    prepareNetworkOperation,
  } as unknown as AccountService;
  const getState = vi.fn(() => ({ instanceId: 1, navigationId, url, visible: entry.visible }));
  const getIdentityEvidence = vi.fn(() => null as { key: string; kind?: "online"; subject?: string; profile?: { externalId: string } } | null);
  const pool = { ensure, navigate, getState, getIdentityEvidence } as unknown as ViewPool;
  const collectors = {
    get: () => ({ workingUrl: getPlatform(platformId).routes.home, collect }),
    list: () => [],
  } as unknown as CollectorRegistry;
  const notify = vi.fn();
  const mediaIntake = { avatar: vi.fn(), covers: vi.fn() };
  scheduler = new CollectScheduler({ store, accounts, pool, collectors, notify, mediaIntake, needsMediaRefresh });
  scheduler.start();
  const payload: CollectorResult = {
    profile: { displayName: "迟到昵称" },
    metrics: [
      {
        accountId: account.id,
        platformId,
        metric: "followers",
        value: 12,
        capturedAt: new Date().toISOString(),
        source: "session",
      },
    ],
    works: [],
    warnings: [],
    loggedOut: false,
    rateLimited: false,
  };
  return {
    account,
    result,
    payload,
    ensure,
    navigate,
    collect,
    checkStatus,
    update,
    notify,
    accounts,
    prepareNetworkOperation,
    mediaIntake,
    setPage,
    wc,
    getState,
    getIdentityEvidence,
    pool,
  };
}
const revoke = () => {
  allowed = false;
  generation++;
  for (const lease of leases) lease.abort();
};

describe("CollectScheduler network queue", () => {
  it("refreshes a stale Channels console and collects only after fresh identity arrives", async () => {
    allowed=true;
    const s=setup("weixin_channels");
    const address=getPlatform("weixin_channels").routes.home;
    s.setPage(address,true);
    s.navigate.mockImplementation(async (_id,next)=>{
      s.setPage(next,true);
      s.getIdentityEvidence.mockReturnValue({key:"fresh",kind:"online",subject:"self",profile:{externalId:"self"}});
    });
    const job=scheduler.enqueue(s.account.id,"manual");
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.navigate).toHaveBeenCalledExactlyOnceWith(s.account.id,address);
    expect(s.collect).toHaveBeenCalledWith(expect.objectContaining({identityProfile:{externalId:"self"}}));
    s.result.resolve(s.payload);await vi.advanceTimersByTimeAsync(0);
    expect(store.collectJobs.get(job.id)?.state).toBe("done");
    expect(store.metrics.listRuns(s.account.id)[0].status).toBe("success");
  });
  it.each([false,true])("accepts same-subject refresh but rejects a real subject change (%s)",async changed=>{
    allowed=true;const s=setup("kuaishou");
    s.setPage(getPlatform("kuaishou").routes.home,true);
    let subject="self";
    s.pool.getIdentitySubject=()=>subject;
    s.getIdentityEvidence.mockReturnValue({key:"first",kind:"online",subject,profile:{externalId:subject}});
    scheduler.enqueue(s.account.id,"manual");await vi.advanceTimersByTimeAsync(1000);
    expect(s.collect).toHaveBeenCalledOnce();
    if(changed)subject="other";
    s.getIdentityEvidence.mockReturnValue({key:"refreshed",kind:"online",subject,profile:{externalId:subject}});
    s.result.resolve(s.payload);await vi.advanceTimersByTimeAsync(0);
    expect(store.metrics.listRuns(s.account.id)[0].status).toBe(changed?"skipped":"success");
  });
  it("reports SQLite corruption instead of suggesting a blind retry",async()=>{
    allowed=true;const s=setup();
    s.collect.mockRejectedValueOnce(Object.assign(new Error("private details"),{errcode:11}));
    scheduler.enqueue(s.account.id,"manual");await vi.advanceTimersByTimeAsync(1000);
    expect(store.metrics.listRuns(s.account.id)[0].message).toBe("本地采集数据库损坏，数据无法保存，需要修复数据库");
  });
  it("refreshes missing image sources once without waiting for the regular data interval", async () => {
    allowed = true;
    const missing = vi.fn(() => true);
    const s = setup("douyin", missing);
    scheduler.applySettings({ ...store.settings.get(), collectEnabled: false, keepaliveEnabled: false });
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(s.collect).toHaveBeenCalledOnce();
    expect(s.mediaIntake.covers).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(s.collect).toHaveBeenCalledOnce();
  });

  it("defers the missing-image refresh while a public homepage is visible", async () => {
    allowed = true;
    const s = setup("douyin", () => true);
    scheduler.applySettings({ ...store.settings.get(), collectEnabled: false, keepaliveEnabled: false });
    s.setPage(getPlatform("douyin").routes.site!, true);
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(45_100);
    expect(s.collect).not.toHaveBeenCalled();
    expect(s.prepareNetworkOperation).not.toHaveBeenCalled();
    s.setPage(getPlatform("douyin").routes.site!, false);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(s.collect).toHaveBeenCalledOnce();
  });

  it.each(["douyin", "kuaishou", "xiaohongshu", "bilibili"] as const)(
    "does not collect %s profiles or navigate while its public homepage is visible",
    async (platformId) => {
      allowed = true;
      const s = setup(platformId);
      s.setPage(getPlatform(platformId).routes.site!, true);
      const job = scheduler.enqueue(s.account.id, "scheduled");
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.navigate).not.toHaveBeenCalled();
      expect(s.collect).not.toHaveBeenCalled();
      expect(s.update).not.toHaveBeenCalled();
      expect(s.checkStatus).not.toHaveBeenCalled();
      expect(s.prepareNetworkOperation).not.toHaveBeenCalled();
      expect(s.ensure).not.toHaveBeenCalled();
      expect(store.accounts.get(s.account.id)?.status).toBe("online");
      expect(store.metrics.listSnapshots()).toEqual([]);
      expect(store.collectJobs.get(job.id)?.state).toBe("done");
      expect(store.metrics.listRuns(s.account.id)).toMatchObject([{ status: "skipped" }]);
    },
  );
  it.each(["login", "scheduled", "keepalive"] as const)(
    "records a %s homepage skip before declaring any creator scope",
    async (trigger) => {
      allowed = true;
      const s = setup("xiaohongshu");
      s.setPage(getPlatform("xiaohongshu").routes.site!, true);
      const job = scheduler.enqueue(s.account.id, trigger);
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.prepareNetworkOperation).not.toHaveBeenCalled();
      expect(leases).toHaveLength(0);
      expect(s.ensure).not.toHaveBeenCalled();
      expect(s.navigate).not.toHaveBeenCalled();
      expect(s.collect).not.toHaveBeenCalled();
      expect(s.checkStatus).not.toHaveBeenCalled();
      expect(store.collectJobs.get(job.id)?.state).toBe("done");
      expect(store.metrics.listRuns(s.account.id)).toMatchObject([{ status: "skipped", trigger }]);
    },
  );
  it("skips an automatic queued job after switching to the homepage before the queue starts", async () => {
    allowed = true;
    const s = setup();
    s.setPage(getPlatform("douyin").routes.home, true);
    const job = scheduler.enqueue(s.account.id, "scheduled");
    s.prepareNetworkOperation.mockClear();
    s.setPage(getPlatform("douyin").routes.site!, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.prepareNetworkOperation).not.toHaveBeenCalled();
    expect(s.ensure).not.toHaveBeenCalled();
    expect(store.collectJobs.get(job.id)?.state).toBe("done");
    expect(store.metrics.listRuns(s.account.id)).toMatchObject([{ status: "skipped" }]);
  });
  it("completes waiting automatic homepage work on recovery without declaring creator scope", () => {
    const s = setup();
    const job = scheduler.enqueue(s.account.id, "keepalive");
    expect(job.state).toBe("waiting-network");
    s.prepareNetworkOperation.mockClear();
    s.setPage(getPlatform("douyin").routes.site!, true);
    scheduler.resumeNetworkAccount(s.account.id);
    expect(s.prepareNetworkOperation).not.toHaveBeenCalled();
    expect(s.ensure).not.toHaveBeenCalled();
    expect(store.collectJobs.get(job.id)?.state).toBe("done");
    expect(store.metrics.listRuns(s.account.id)).toMatchObject([{ status: "skipped" }]);
  });
  it("preserves the manual job's existing behavior when automatic homepage work joins it", async () => {
    const s = setup();
    const manual = scheduler.enqueue(s.account.id, "manual");
    s.setPage(getPlatform("douyin").routes.site!, true);
    scheduler.enqueue(s.account.id, "scheduled");
    allowed = true;
    scheduler.resumeNetworkAccount(s.account.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.prepareNetworkOperation).toHaveBeenCalledWith(s.account.id, "collect");
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.collect).not.toHaveBeenCalled();
    expect(store.collectJobs.get(manual.id)).toMatchObject({ state: "done", trigger: "manual" });
    expect(store.metrics.listRuns(s.account.id)).toMatchObject([{ status: "skipped", trigger: "manual" }]);
  });
  it("moves a hidden public homepage to its creator origin before collecting", async () => {
    allowed = true;
    const s = setup("xiaohongshu");
    s.setPage(getPlatform("xiaohongshu").routes.site!, false);
    const job = scheduler.enqueue(s.account.id, "scheduled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.navigate).toHaveBeenCalledExactlyOnceWith(s.account.id, getPlatform("xiaohongshu").routes.home);
    expect(s.collect).toHaveBeenCalledOnce();
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.collectJobs.get(job.id)?.state).toBe("done");
    expect(store.metrics.listSnapshots(s.account.id)).toHaveLength(1);
  });
  it("keeps saved identity fields and a newly edited nickname when a scan returns placeholders", async () => {
    allowed = true;
    const s = setup();
    const job = scheduler.enqueue(s.account.id, "manual");
    await vi.advanceTimersByTimeAsync(1000);
    store.accounts.update(s.account.id, {
      displayName: "我的账号备注",
      handle: "saved-handle",
      externalId: "saved-id",
    });
    s.payload.profile = { displayName: "扫描昵称", handle: "   ", externalId: "0", avatarUrl: "   " };
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.collectJobs.get(job.id)?.state).toBe("done");
    expect(store.accounts.get(s.account.id)).toMatchObject({
      displayName: "我的账号备注",
      handle: "saved-handle",
      externalId: "saved-id",
      status: "online",
    });
    expect(s.update).not.toHaveBeenCalled();
  });
  it.each([false, true])("preserves an in-progress login page (visible=%s)", async (visible) => {
    allowed = true;
    const s = setup("xiaohongshu");
    s.setPage(getPlatform("xiaohongshu").routes.login, visible);
    scheduler.enqueue(s.account.id, "scheduled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.collect).not.toHaveBeenCalled();
    expect(store.accounts.get(s.account.id)?.status).toBe("online");
  });
  it.each(["page", "round-trip", "identity"] as const)(
    "discards collected profile/metrics after a %s change without marking the account offline",
    async (change) => {
      allowed = true;
      const s = setup();
      const job = scheduler.enqueue(s.account.id, "manual");
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.collect).toHaveBeenCalledOnce();
      if (change === "identity") s.getIdentityEvidence.mockReturnValue({ key: "new-identity" });
      else {
        s.setPage(getPlatform("douyin").routes.site!, true);
        if (change === "round-trip") s.setPage(getPlatform("douyin").routes.home, true);
      }
      s.result.resolve({ ...s.payload, loggedOut: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.collectJobs.get(job.id)?.state).toBe("done");
      expect(store.metrics.listRuns(s.account.id)).toMatchObject([{ status: "skipped" }]);
      expect(store.metrics.listSnapshots()).toEqual([]);
      expect(s.update).not.toHaveBeenCalled();
      expect(s.checkStatus).not.toHaveBeenCalled();
      expect(s.mediaIntake.avatar).not.toHaveBeenCalled();
      expect(store.accounts.get(s.account.id)?.status).toBe("online");
    },
  );
  it("keeps accounts alive with a lightweight check and no page navigation or full collection", async () => {
    allowed = true;
    const s = setup();
    const job = scheduler.enqueue(s.account.id, "keepalive");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.checkStatus).toHaveBeenCalledOnce();
    expect(s.ensure).not.toHaveBeenCalled();
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.collect).not.toHaveBeenCalled();
    expect(store.collectJobs.get(job.id)?.state).toBe("done");
  });
  it("does not inspect a collector target or create work on idle startup and repeated network recovery", () => {
    const check = vi.fn(() => ({ allowed: false, reason: "UNKNOWN_TARGET" as const }));
    uninstall();
    uninstall = installBusinessNetwork({ enforcement: "strict", check, acquire: () => null });
    const s = setup();
    scheduler.suspendNetworkAccount(s.account.id);
    scheduler.resumeNetworkAccount(s.account.id);
    scheduler.resumeNetworkAccount(s.account.id);
    expect(check).not.toHaveBeenCalled();
    expect(s.prepareNetworkOperation).not.toHaveBeenCalled();
    expect(store.collectJobs.list(s.account.id)).toEqual([]);
    expect(s.ensure).not.toHaveBeenCalled();
    expect(s.collect).not.toHaveBeenCalled();
  });
  it.each(["keepalive", "manual", "scheduled", "login"] as const)(
    "declares the actual %s job before checking its target and keeps it waiting on rejection",
    (trigger) => {
      const s = setup();
      scheduler.suspendNetworkAccount(s.account.id);
      const job = scheduler.enqueue(s.account.id, trigger);
      const check = vi.fn(() => ({ allowed: false, reason: "CHECKING" as const }));
      uninstall();
      uninstall = installBusinessNetwork({ enforcement: "strict", check, acquire: () => null });
      const order: string[] = [];
      s.prepareNetworkOperation.mockImplementation(() => {
        order.push("declare");
      });
      check.mockImplementation(() => {
        order.push("check");
        return { allowed: false, reason: "CHECKING" };
      });
      scheduler.resumeNetworkAccount(s.account.id);
      expect(order).toEqual(["declare", "check"]);
      expect(s.prepareNetworkOperation).toHaveBeenCalledExactlyOnceWith(
        s.account.id,
        trigger === "keepalive" ? "keepalive" : "collect",
      );
      expect(store.collectJobs.get(job.id)?.state).toBe("waiting-network");
      expect(store.collectJobs.list(s.account.id)).toHaveLength(1);
      expect(s.ensure).not.toHaveBeenCalled();
      expect(s.collect).not.toHaveBeenCalled();
    },
  );
  it("does not query a collector target when its operation declaration is still dormant", () => {
    const s = setup();
    scheduler.suspendNetworkAccount(s.account.id);
    const job = scheduler.enqueue(s.account.id, "keepalive");
    const check = vi.fn(() => ({ allowed: true, reason: "READY" as const }));
    uninstall();
    uninstall = installBusinessNetwork({ enforcement: "strict", check, acquire: () => null });
    s.prepareNetworkOperation.mockImplementation(() => {
      throw new NetworkDormantError("CATALOG_UNVERIFIED");
    });
    scheduler.resumeNetworkAccount(s.account.id);
    expect(check).not.toHaveBeenCalled();
    expect(store.collectJobs.get(job.id)?.state).toBe("waiting-network");
    expect(s.ensure).not.toHaveBeenCalled();
  });
  it("does not declare or inspect collection targets for an offline account with waiting work", () => {
    const s = setup();
    scheduler.suspendNetworkAccount(s.account.id);
    const job = scheduler.enqueue(s.account.id, "manual");
    store.accounts.updateStatus(s.account.id, "offline", "登录失效");
    const check = vi.fn(() => ({ allowed: true, reason: "READY" as const }));
    uninstall();
    uninstall = installBusinessNetwork({ enforcement: "strict", check, acquire: () => null });
    scheduler.resumeNetworkAccount(s.account.id);
    expect(check).not.toHaveBeenCalled();
    expect(s.prepareNetworkOperation).not.toHaveBeenCalled();
    expect(store.collectJobs.get(job.id)?.state).toBe("waiting-network");
    expect(store.accounts.get(s.account.id)?.status).toBe("offline");
    expect(s.ensure).not.toHaveBeenCalled();
    expect(store.collectJobs.list(s.account.id)).toHaveLength(1);
  });
  it("commits collection data without remote image URLs before offering optional previews", async () => {
    allowed = true;
    const s = setup();
    const source = "https://media.example.test/private?signature=synthetic";
    s.payload.profile = { avatarUrl: source };
    s.payload.works = [
      {
        id: "fixture-work",
        accountId: s.account.id,
        platformId: "douyin",
        remoteId: "remote-work",
        title: "safe-title",
        coverUrl: source,
        plays: 1,
        likes: 2,
        comments: 3,
        shares: 4,
        favorites: 5,
        fetchedAt: new Date().toISOString(),
      },
    ];
    s.mediaIntake.covers.mockImplementation(() => {
      expect(store.metrics.listWorks(s.account.id)[0].coverUrl).toBeNull();
      expect(store.accounts.get(s.account.id)?.avatarUrl).toBeNull();
    });
    const job = scheduler.enqueue(s.account.id, "manual");
    await vi.advanceTimersByTimeAsync(1000);
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.collectJobs.get(job.id)?.state).toBe("done");
    expect(s.mediaIntake.avatar).toHaveBeenCalledExactlyOnceWith(s.account.id, source);
    expect(s.mediaIntake.covers).toHaveBeenCalledExactlyOnceWith(s.account.id, s.payload.works);
    expect(store.accounts.get(s.account.id)?.status).toBe("online");
  });
  it("returns a durable ID immediately and dormant manual/timer/keepalive calls never touch views or probes", async () => {
    const s = setup();
    const job = scheduler.enqueue(s.account.id, "manual");
    expect(job.state).toBe("waiting-network");
    expect(job).not.toBeInstanceOf(Promise);
    for (const trigger of ["keepalive", "scheduled", "login"] as const)
      expect(scheduler.enqueue(s.account.id, trigger).id).toBe(job.id);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(store.collectJobs.list(s.account.id, true)).toHaveLength(1);
    expect(s.ensure).not.toHaveBeenCalled();
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.checkStatus).not.toHaveBeenCalled();
    expect(s.collect).not.toHaveBeenCalled();
    expect(store.metrics.listRuns(s.account.id)).toEqual([]);
    expect(s.notify).not.toHaveBeenCalled();
  });
  it("drops a collector result after revocation without failed runs, profile writes or offline notifications", async () => {
    allowed = true;
    const s = setup();
    const job = scheduler.enqueue(s.account.id, "manual");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.collect).toHaveBeenCalledTimes(1);
    expect(scheduler.enqueue(s.account.id, "scheduled").id).toBe(job.id);
    revoke();
    scheduler.suspendNetworkAccount(s.account.id);
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.collectJobs.get(job.id)?.state).toBe("waiting-network");
    expect(store.metrics.listSnapshots(s.account.id)).toEqual([]);
    expect(store.metrics.listRuns(s.account.id)).toEqual([]);
    expect(s.update).not.toHaveBeenCalled();
    expect(s.checkStatus).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
    expect(store.accounts.get(s.account.id)?.status).toBe("online");
    expect(s.mediaIntake.avatar).not.toHaveBeenCalled();
    expect(s.mediaIntake.covers).not.toHaveBeenCalled();
  });
  it("keeps cancellation terminal when an already running collector resolves", async () => {
    allowed = true;
    const s = setup();
    const job = scheduler.enqueue(s.account.id, "manual");
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.cancelJob(job.id);
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.collectJobs.get(job.id)?.state).toBe("cancelled");
    expect(store.metrics.listSnapshots()).toEqual([]);
    expect(store.metrics.listRuns(s.account.id)).toEqual([]);
  });
  it("passes task cancellation into nested request operations without revoking another account", async () => {
    allowed = true;
    const s = setup();
    const aborted = vi.fn();
    s.collect.mockImplementation(() => {
      const operation = beginBusinessOperation(s.account.id, "https://creator.douyin.com/creator-micro/home");
      return new Promise<CollectorResult>((_resolve, reject) => {
        operation.signal.addEventListener(
          "abort",
          () => {
            aborted();
            try {
              operation.assertCurrent();
            } catch (error) {
              reject(error);
            } finally {
              operation.release();
            }
          },
          { once: true },
        );
      });
    });
    const job = scheduler.enqueue(s.account.id, "manual");
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.cancelJob(job.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(allowed).toBe(true);
    expect(store.collectJobs.get(job.id)?.state).toBe("cancelled");
    expect(store.metrics.listSnapshots()).toEqual([]);
    expect(store.metrics.listRuns(s.account.id)).toEqual([]);
  });
  it("restores a waiting online account exactly once but leaves offline accounts dormant", async () => {
    const s = setup();
    const job = scheduler.enqueue(s.account.id, "manual");
    store.accounts.updateStatus(s.account.id, "offline", "失效");
    allowed = true;
    scheduler.resumeNetworkAccount(s.account.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.ensure).not.toHaveBeenCalled();
    expect(store.collectJobs.get(job.id)?.state).toBe("waiting-network");
    store.accounts.updateStatus(s.account.id, "online", "确认登录");
    scheduler.resumeNetworkAccount(s.account.id);
    scheduler.resumeNetworkAccount(s.account.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.collect).toHaveBeenCalledTimes(1);
    s.result.resolve({ ...s.payload, profile: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.collectJobs.get(job.id)).toMatchObject({ state: "done", attempts: 1 });
    expect(store.metrics.listSnapshots()).toHaveLength(1);
    expect(store.metrics.listRuns(s.account.id)).toHaveLength(1);
  });
  it("rechecks the lease after navigation and never starts collection after suspension", async () => {
    allowed = true;
    const s = setup();
    const navigation = deferred<void>();
    s.navigate.mockImplementation(() => navigation.promise);
    const job = scheduler.enqueue(s.account.id, "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.navigate).toHaveBeenCalledTimes(1);
    revoke();
    scheduler.suspendNetworkAccount(s.account.id);
    navigation.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.collect).not.toHaveBeenCalled();
    expect(store.collectJobs.get(job.id)?.state).toBe("waiting-network");
  });
  it("commits metrics and the terminal job together, rolling back partial data on write failure", async () => {
    allowed = true;
    const s = setup();
    vi.spyOn(store.metrics, "upsertWorks").mockImplementationOnce(() => {
      throw new Error("database write failed");
    });
    const job = scheduler.enqueue(s.account.id, "manual");
    await vi.advanceTimersByTimeAsync(1000);
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.metrics.listSnapshots()).toEqual([]);
    expect(store.collectJobs.get(job.id)?.state).toBe("failed");
    expect(store.metrics.listRuns(s.account.id)).toMatchObject([{ status: "failed", metricsWritten: 0 }]);
    expect(s.update).not.toHaveBeenCalled();
  });
  it("cancels jobs before account deletion and ignores the late collector without recreating the account", async () => {
    allowed = true;
    const s = setup();
    const job = scheduler.enqueue(s.account.id, "login");
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.suspendForAccountChange(s.account.id);
    expect(store.collectJobs.get(job.id)?.state).toBe("cancelled");
    store.accounts.delete(s.account.id);
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.resumeNetworkAccount(s.account.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.accounts.list()).toEqual([]);
    expect(store.collectJobs.list()).toEqual([]);
    expect(s.collect).toHaveBeenCalledTimes(1);
    expect(s.update).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });
  it("account reset cancellation also works in observation mode and does not restore old jobs", async () => {
    uninstall();
    uninstall = installBusinessNetwork({
      enforcement: "observe",
      check: () => ({ allowed: true, reason: "READY" }),
      acquire: () => null,
    });
    const s = setup();
    const job = scheduler.enqueue(s.account.id, "manual");
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.suspendForAccountChange(s.account.id);
    store.accounts.updateStatus(s.account.id, "unknown", "环境已重置");
    s.result.resolve(s.payload);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.resumeNetworkAccount(s.account.id);
    expect(store.collectJobs.get(job.id)?.state).toBe("cancelled");
    expect(store.metrics.listSnapshots()).toEqual([]);
    store.accounts.updateStatus(s.account.id, "online", "重新登录");
    scheduler.resumeNetworkAccount(s.account.id);
    expect(scheduler.enqueue(s.account.id, "login").id).not.toBe(job.id);
  });
  it("metrics IPC accepts a waiting task without awaiting completion, validates cancel IDs", () => {
    const s = setup();
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
      send: vi.fn(),
    } as unknown as IpcRegistrar;
    registerMetricsHandlers(ipc, { store, scheduler, accounts: s.accounts });
    const accepted = handlers.get(IPC.metricsCollectNow)!(null, s.account.id);
    expect(accepted).not.toBeInstanceOf(Promise);
    expect(accepted).toMatchObject([{ state: "waiting-network", accountId: s.account.id }]);
    expect(() => handlers.get(IPC.metricsCancelJob)!(null, "not-a-uuid")).toThrow();
  });
});
