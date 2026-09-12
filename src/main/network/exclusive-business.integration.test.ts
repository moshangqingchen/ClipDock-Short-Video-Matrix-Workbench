import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie, Session } from "electron";
import { CN_PLATFORM_IDS, getPlatform, type CnPlatformId } from "@shared/platforms";
import type { Account, AccountStatus, CollectJob } from "@shared/types";
import { IPC } from "@shared/ipc";
import { createStore } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import type { CollectorContext, CollectorRegistry, CollectorResult } from "@main/data/collectors";
import { CollectScheduler } from "@main/data/scheduler";
import { AccountService } from "@main/services/account-service";
import type { AssetService } from "@main/services/asset-service";
import { PublishService } from "@main/services/publish-service";
import { registerMetricsHandlers } from "@main/ipc/handlers/metrics";
import { registerPublishHandlers } from "@main/ipc/handlers/publish";
import type { IpcRegistrar } from "@main/ipc/register";
import { ExclusiveNetworkSwitch, type ProxySwitchObservation } from "./exclusive-switch";
import { NetworkRuntime, type NetworkSession } from "./runtime";
import { beginBusinessOperation, installBusinessNetwork, NetworkDormantError } from "./business-access";

// Native surfaces only: the monitor, account state, business gate and both services remain real.
vi.mock("electron", () => ({
  app: { userAgentFallback: "Chrome/150" },
  dialog: {},
  net: {},
  session: {
    fromPartition: () => {
      throw new Error("unexpected unregistered Session");
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class NativeSessionFixture extends EventEmitter {
  setProxy = vi.fn<NetworkSession["setProxy"]>().mockResolvedValue(undefined);
  closeAllConnections = vi.fn<NetworkSession["closeAllConnections"]>().mockResolvedValue(undefined);
  clearHostResolverCache = vi.fn<NetworkSession["clearHostResolverCache"]>().mockResolvedValue(undefined);
  clearStorageData = vi.fn<NetworkSession["clearStorageData"]>().mockResolvedValue(undefined);
  cookies = { get: vi.fn(async () => [] as Cookie[]) };
}
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T06:00:00.000Z"));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function settle() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

async function fixture(rows: readonly { platform: CnPlatformId; status?: AccountStatus }[]) {
  const store = createStore(":memory:");
  const records = rows.map(({ platform, status = "online" }) => {
    const created = store.accounts.create({ platformId: platform });
    return store.accounts.updateStatus(created.id, status, "original auth conclusion")!;
  });
  let proxy: ProxySwitchObservation["state"] = "active";
  const anonymousProbe = vi.fn(async () => ({
    state: "reachable" as const,
    country: "CN",
    asn: 4837,
    maskedIp: "1.2.*.*",
    checkedAt: new Date().toISOString(),
    routeVerified: false,
  }));
  const monitor = new ExclusiveNetworkSwitch({
    readNetwork: () => ({ available: true, hash: "controlled-windows-network" }),
    readProxy: async () => ({
      state: proxy,
      startedAtMono: performance.now(),
      completedAtMono: performance.now(),
    }),
    probeDomestic: anonymousProbe,
  });
  const runtime = new NetworkRuntime({
    enforcement: "strict",
    networkReadiness: () => true,
    exclusiveAccess: { read: () => monitor.read(), acquire: () => monitor.acquire() },
  });
  const uninstall = installBusinessNetwork(runtime);
  const views = new Map(
    records.map((account) => {
      const session = new NativeSessionFixture();
      let url = "about:blank";
      const commands: Record<string, object> = {
        "DOM.getDocument": { root: { nodeId: 1 } },
        "DOM.querySelectorAll": { nodeIds: [2] },
        "DOM.getAttributes": { attributes: ["type", "file", "accept", "video/mp4"] },
        "DOM.setFileInputFiles": {},
      };
      const debug = {
        once: vi.fn(),
        isAttached: vi.fn(() => false),
        attach: vi.fn(() => debug.isAttached.mockReturnValue(true)),
        detach: vi.fn(),
        sendCommand: vi.fn(async (method: string, _params?: object): Promise<object> => commands[method]),
      };
      const wc = Object.assign(new EventEmitter(), {
        id: viewsId++,
        getURL: () => url,
        isDestroyed: () => false,
        isLoading: () => false,
        debugger: debug,
        executeJavaScript: vi.fn(async (_script: string): Promise<unknown> => ({
          status: 200,
          text: '{"code":0,"data":{"isLogin":true}}',
          url: getPlatform(account.platformId).login.probe.url,
        })),
      });
      return [
        account.id,
        {
          session,
          wc,
          debug,
          setUrl: (next: string) => {
            url = next;
          },
        },
      ] as const;
    }),
  );
  const ensure = vi.fn(({ id }: { id: string }) => ({
    visible: false,
    view: { webContents: views.get(id)!.wc },
  }));
  const navigate = vi.fn(async (id: string, url: string) => {
    views.get(id)!.setUrl(url);
  });
  const suspendView = vi.fn(async (id: string) => {
    const view = views.get(id)!;
    view.setUrl("about:blank");
    view.wc.emit("destroyed");
  });
  const pool = {
    ensure,
    navigate,
    suspendNetworkAccount: suspendView,
    getState: (id: string) => ({ accountId: id, url: views.get(id)!.wc.getURL(), loading: false }),
    getSession: (id: string) => ({ session: views.get(id)!.session as unknown as Session }),
    getWebContents: (id: string) => views.get(id)!.wc,
  } as unknown as ViewPool;
  const notify = vi.fn();
  const accounts = new AccountService({ store, viewPool: pool, notify });
  const online = vi.fn();
  accounts.on("account-online", online);
  const checkStatus = vi.spyOn(accounts, "checkStatus");
  const replies = new Map<string, () => Promise<CollectorResult>>();
  const outstanding: (() => void)[] = [];
  const signals = new Map<string, AbortSignal>();
  const payload = (account: Account): CollectorResult => ({
    profile: { displayName: "late collector name", handle: "late-handle" },
    metrics: [
      {
        accountId: account.id,
        platformId: account.platformId,
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
  });
  const collect = vi.fn(async ({ account }: CollectorContext) => {
    const operation = beginBusinessOperation(account.id, getPlatform(account.platformId).routes.home);
    signals.set(account.id, operation.signal);
    try {
      return await (replies.get(account.id)?.() ?? Promise.resolve(payload(account)));
    } finally {
      operation.release();
    }
  });
  const collectors: CollectorRegistry = {
    get: (platformId) => ({
      platformId,
      workingUrl: getPlatform(platformId).routes.home,
      collect,
      fetchProfile: async () => null,
    }),
    list: () => [],
  };
  const media = { avatar: vi.fn(), covers: vi.fn() };
  const scheduler = new CollectScheduler({ store, pool, accounts, collectors, notify, mediaIntake: media });
  runtime.setSuspendHandler(async (id) => {
    accounts.suspendNetworkAccount(id);
    scheduler.suspendNetworkAccount(id);
    await suspendView(id);
  });
  runtime.on("state", () => {
    for (const state of runtime.getAccountStates())
      if (state.state === "allowed") scheduler.resumeNetworkAccount(state.accountId);
  });
  monitor.on("state", () => runtime.syncExclusiveAccess());
  const ready = async () => {
    await Promise.all(
      records.map(
        (account) =>
          runtime.registerSession(
            views.get(account.id)!.session as unknown as NetworkSession,
            account.id,
            account.platformId,
          ).ready,
      ),
    );
    await settle();
  };
  await ready();
  scheduler.start();
  accounts.on("account-online", (account: Account) => {
    scheduler.resumeNetworkAccount(account.id);
    scheduler.enqueue(account.id, "login");
  });
  monitor.start();
  await monitor.refresh();
  await ready();
  const assets = { get: vi.fn(() => ({ filePath: "C:\\clipdock-test\\synthetic.mp4" })) };
  const publishing = new PublishService({ store, pool, accounts, assets: assets as unknown as AssetService });
  type Handler = (event: unknown, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    handleValidated: (channel: string, schema: { parse(value: unknown): unknown }, handler: Handler) =>
      handlers.set(channel, (event, value) => handler(event, schema.parse(value))),
    send: vi.fn(),
  } as unknown as IpcRegistrar;
  registerMetricsHandlers(ipc, { store, accounts, scheduler });
  registerPublishHandlers(ipc, publishing);
  cleanups.push(async () => {
    scheduler.stop();
    accounts.dispose();
    monitor.stop();
    for (const finish of outstanding) finish();
    await settle();
    await monitor.dispose();
    await runtime.dispose();
    uninstall();
    store.close();
  });
  return {
    records,
    store,
    monitor,
    runtime,
    scheduler,
    publishing,
    accounts,
    checkStatus,
    online,
    collect,
    signals,
    views,
    ensure,
    navigate,
    assets,
    notify,
    media,
    anonymousProbe,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args),
    async proxyOn() {
      proxy = "active";
      await monitor.refresh();
      await ready();
    },
    async firstDomesticRound() {
      proxy = "inactive";
      await monitor.refresh();
      await ready();
    },
    async allow() {
      proxy = "inactive";
      await monitor.refresh();
      await ready();
      await vi.advanceTimersByTimeAsync(10_000);
      await monitor.refresh();
      await ready();
      expect(monitor.read().state).toBe("domestic");
    },
    holdCollection(account: Account) {
      const held = deferred<CollectorResult>();
      replies.set(account.id, () => held.promise);
      outstanding.push(() => held.resolve(payload(account)));
      return { ...held, payload: payload(account) };
    },
  };
}
let viewsId = 1;

describe("exclusive network policy across real business services", () => {
  it.each(CN_PLATFORM_IDS)(
    "%s returns immediate manual task IDs and coalesces timer/keepalive without network",
    async (platform) => {
      const f = await fixture([{ platform }]);
      const account = f.records[0];
      const original = f.store.accounts.get(account.id)!;
      const jobs = f.call(IPC.metricsCollectNow, account.id) as CollectJob[];
      expect(jobs).not.toBeInstanceOf(Promise);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ state: "waiting-network", accountId: account.id });
      for (const trigger of ["scheduled", "keepalive", "login", "manual"] as const)
        expect(f.scheduler.enqueue(account.id, trigger).id).toBe(jobs[0].id);
      f.accounts.startPatrol();
      await vi.advanceTimersByTimeAsync(180_000);
      await f.accounts.checkStatus(account.id);
      expect(f.store.collectJobs.list(account.id, true)).toHaveLength(1);
      expect(f.ensure).not.toHaveBeenCalled();
      expect(f.navigate).not.toHaveBeenCalled();
      expect(f.collect).not.toHaveBeenCalled();
      expect(f.views.get(account.id)!.wc.executeJavaScript).not.toHaveBeenCalled();
      expect(f.views.get(account.id)!.session.cookies.get).not.toHaveBeenCalled();
      expect(f.store.metrics.listRuns(account.id)).toEqual([]);
      expect(f.store.accounts.get(account.id)).toMatchObject({
        status: original.status,
        lastCheckedAt: original.lastCheckedAt,
      });
      expect(f.online).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.anonymousProbe).not.toHaveBeenCalled();
    },
  );

  it("waits for two real CN rounds, then resumes only online/expiring queued accounts", async () => {
    const f = await fixture(CN_PLATFORM_IDS.map((platform) => ({ platform })));
    const jobs = f.records.map((account) => f.scheduler.enqueue(account.id, "manual"));
    const statuses: AccountStatus[] = [
      "online",
      "expiring",
      "offline",
      "needs_verification",
      "unknown",
      "network_error",
    ];
    f.records.forEach((account, i) =>
      f.store.accounts.updateStatus(account.id, statuses[i], "auth unchanged by switch"),
    );
    await f.firstDomesticRound();
    expect(f.anonymousProbe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.ensure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.anonymousProbe).toHaveBeenCalledTimes(2);
    expect(f.monitor.read().state).toBe("domestic");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.collect.mock.calls.map(([ctx]) => ctx.account.id).sort()).toEqual(
      f.records
        .slice(0, 2)
        .map((a) => a.id)
        .sort(),
    );
    expect(f.store.collectJobs.get(jobs[0].id)?.state).toBe("done");
    expect(f.store.collectJobs.get(jobs[1].id)?.state).toBe("done");
    jobs.slice(2).forEach((job) => expect(f.store.collectJobs.get(job.id)?.state).toBe("waiting-network"));
    f.records.forEach((account, i) => expect(f.store.accounts.get(account.id)?.status).toBe(statuses[i]));
    expect(f.online).not.toHaveBeenCalled();
  });

  it.each(["scheduled", "keepalive"] as const)(
    "real %s timers create one waiting job without a manual button or page activity",
    async (trigger) => {
      const f = await fixture([{ platform: "weixin_channels" }]);
      const account = f.records[0];
      f.scheduler.applySettings(
        f.store.settings.patch({ collectEnabled: trigger === "scheduled", keepaliveEnabled: true }),
      );
      // Retain an old real database authentication timestamp, making the keepalive interval due.
      f.store.db.run("UPDATE accounts SET last_checked_at = ? WHERE id = ?", [
        "2020-01-01T00:00:00.000Z",
        account.id,
      ]);
      expect(f.store.collectJobs.list(account.id)).toEqual([]);
      await vi.advanceTimersByTimeAsync(180_000);
      const jobs = f.store.collectJobs.list(account.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].state).toBe("waiting-network");
      if (trigger === "keepalive") expect(jobs[0].trigger).toBe("keepalive");
      expect(f.ensure).not.toHaveBeenCalled();
      expect(f.navigate).not.toHaveBeenCalled();
      expect(f.collect).not.toHaveBeenCalled();
      expect(f.checkStatus).not.toHaveBeenCalled();
      expect(f.views.get(account.id)!.session.cookies.get).not.toHaveBeenCalled();
    },
  );

  it.each(["late-success", "late-logged-out", "late-error"] as const)(
    "discards %s collection after proxy-on without metrics/auth writes or requeue",
    async (outcome) => {
      const f = await fixture([{ platform: "douyin" }]);
      const account = f.records[0],
        original = f.store.accounts.get(account.id)!;
      const held = f.holdCollection(account);
      await f.allow();
      const job = f.scheduler.enqueue(account.id, "manual");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.collect).toHaveBeenCalledOnce();
      await f.proxyOn();
      expect(f.signals.get(account.id)?.aborted).toBe(true);
      if (outcome === "late-error") held.reject(new Error("network failure after revocation"));
      else held.resolve({ ...held.payload, loggedOut: outcome === "late-logged-out" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.store.collectJobs.get(job.id)?.state).toBe("waiting-network");
      expect(f.store.collectJobs.list(account.id, true)).toHaveLength(1);
      expect(f.store.metrics.listSnapshots(account.id)).toEqual([]);
      expect(f.store.metrics.listRuns(account.id)).toEqual([]);
      expect(f.store.accounts.get(account.id)).toMatchObject({
        status: original.status,
        lastCheckedAt: original.lastCheckedAt,
        displayName: original.displayName,
        handle: original.handle,
      });
      expect(f.checkStatus).not.toHaveBeenCalled();
      expect(f.online).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.media.covers).not.toHaveBeenCalled();
      expect(f.collect).toHaveBeenCalledOnce();
    },
  );

  it("a late successful page login response cannot mark an offline account online or create a login job", async () => {
    const f = await fixture([{ platform: "bilibili", status: "offline" }]);
    const account = f.records[0],
      original = f.store.accounts.get(account.id)!;
    await f.allow();
    const view = f.views.get(account.id)!;
    view.setUrl(getPlatform(account.platformId).routes.home);
    const response = deferred<unknown>();
    view.wc.executeJavaScript.mockReturnValueOnce(response.promise);
    const checking = f.accounts.checkStatus(account.id);
    await settle();
    expect(view.wc.executeJavaScript).toHaveBeenCalledOnce();
    await f.proxyOn();
    response.resolve({
      status: 200,
      text: '{"code":0,"data":{"isLogin":true}}',
      url: getPlatform("bilibili").login.probe.url,
    });
    await checking;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.store.accounts.get(account.id)).toMatchObject({
      status: "offline",
      lastCheckedAt: original.lastCheckedAt,
      lastOnlineAt: original.lastOnlineAt,
    });
    expect(f.online).not.toHaveBeenCalled();
    expect(f.store.collectJobs.list(account.id)).toEqual([]);
    expect(f.navigate).not.toHaveBeenCalled();
  });

  it("keeps a cancelled waiting job terminal after its old collector returns and the network later recovers", async () => {
    const f = await fixture([{ platform: "xiaohongshu" }]);
    const account = f.records[0],
      held = f.holdCollection(account);
    await f.allow();
    const job = f.scheduler.enqueue(account.id, "manual");
    await vi.advanceTimersByTimeAsync(1_000);
    await f.proxyOn();
    f.call(IPC.metricsCancelJob, job.id);
    held.resolve(held.payload);
    await settle();
    await f.allow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.store.collectJobs.get(job.id)?.state).toBe("cancelled");
    expect(f.store.collectJobs.list(account.id)).toHaveLength(1);
    expect(f.store.collectJobs.list(account.id, true)).toEqual([]);
    expect(f.collect).toHaveBeenCalledOnce();
    expect(f.store.metrics.listSnapshots(account.id)).toEqual([]);
    expect(f.online).not.toHaveBeenCalled();
  });

  it.each(CN_PLATFORM_IDS)(
    "%s rejects closed upload/attachment IPC without touching files or navigating, and never replays them",
    async (platform) => {
      const f = await fixture([{ platform }]);
      const account = f.records[0],
        view = f.views.get(account.id)!;
      const assetId = "9d77b603-c0fb-4a9b-8a49-2fcc12bbdc89";
      await expect(f.call(IPC.publishOpenUpload, account.id)).rejects.toBeInstanceOf(NetworkDormantError);
      await expect(f.call(IPC.publishAttachFiles, account.id, [assetId])).rejects.toBeInstanceOf(
        NetworkDormantError,
      );
      expect(f.assets.get).not.toHaveBeenCalled();
      expect(view.debug.sendCommand).not.toHaveBeenCalled();
      expect(f.ensure).not.toHaveBeenCalled();
      expect(f.navigate).not.toHaveBeenCalled();
      await f.allow();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.navigate).not.toHaveBeenCalled();
      expect(view.debug.sendCommand).not.toHaveBeenCalled();
      expect(f.store.publish.list(account.id)).toEqual([]);
      expect(f.store.collectJobs.list(account.id)).toEqual([]);
    },
  );

  it("interrupts a real attachment flow before setFileInputFiles and requires a new manual request after recovery", async () => {
    const f = await fixture([{ platform: "bilibili" }]);
    const account = f.records[0],
      view = f.views.get(account.id)!;
    const originalExists = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(
      (file) => file === "C:\\clipdock-test\\synthetic.mp4" || originalExists(file),
    );
    await f.allow();
    await f.publishing.openUpload(account.id);
    const selected = deferred<object>();
    const previous = view.debug.sendCommand.getMockImplementation()!;
    view.debug.sendCommand.mockImplementation((method, params) =>
      method === "DOM.querySelectorAll" ? selected.promise : previous(method, params),
    );
    const attached = f.publishing.attachFiles(account.id, ["fixture-asset"]);
    const rejected = expect(attached).rejects.toBeInstanceOf(NetworkDormantError);
    await settle();
    expect(view.debug.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "DOM.getDocument",
      "DOM.querySelectorAll",
    ]);
    await f.proxyOn();
    selected.resolve({ nodeIds: [2] });
    await rejected;
    expect(view.debug.sendCommand.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(
      false,
    );
    const calls = view.debug.sendCommand.mock.calls.length,
      navigations = f.navigate.mock.calls.length;
    await f.allow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(view.debug.sendCommand).toHaveBeenCalledTimes(calls);
    expect(f.navigate).toHaveBeenCalledTimes(navigations);
    expect(f.store.publish.list(account.id)).toEqual([]);
    view.debug.sendCommand.mockImplementation(previous);
    await f.publishing.openUpload(account.id);
    await expect(f.publishing.attachFiles(account.id, ["fixture-asset"])).resolves.toEqual({ attached: 1 });
    expect(
      view.debug.sendCommand.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles"),
    ).toHaveLength(1);
    expect(f.store.publish.list(account.id)).toEqual([]); // Attachment is not a platform publish confirmation.
  });
});
