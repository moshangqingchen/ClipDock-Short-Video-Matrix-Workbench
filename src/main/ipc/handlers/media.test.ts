import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import type { AccountService } from "@main/services/account-service";
import type { CollectScheduler } from "@main/data/scheduler";
import { createMediaProjection, type MediaProjection } from "@main/services/media-projection";
import { IPC } from "@shared/ipc";
import type { IpcRegistrar } from "../register";
import { registerAccountHandlers } from "./accounts";
import { registerMetricsHandlers } from "./metrics";

const remote = "https://images.example.test/secret-path/picture.png?signature=synthetic-secret";
const local = "sv-asset://remote/86cd4ebf-007c-4b24-8b0a-6b84097f304a";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture(media?: MediaProjection) {
  const store = createStore(":memory:");
  stores.push(store);
  const created = store.accounts.create({ platformId: "bilibili", displayName: "测试账号" });
  const account = store.accounts.update(created.id, { avatarUrl: remote })!;
  const now = new Date().toISOString();
  store.metrics.upsertWorks([
    {
      id: `${account.id}:one`,
      accountId: account.id,
      platformId: account.platformId,
      remoteId: "one",
      title: "测试作品",
      coverUrl: remote,
      plays: 3,
      likes: 1,
      comments: 0,
      shares: 0,
      favorites: 0,
      fetchedAt: now,
    },
  ]);
  store.metrics.saveSnapshots([
    {
      accountId: account.id,
      platformId: account.platformId,
      metric: "followers",
      value: 42,
      capturedAt: now,
      source: "session",
    },
  ]);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    handleValidated: (
      channel: string,
      schema: { parse(value: unknown): unknown },
      fn: (...args: unknown[]) => unknown,
    ) => handlers.set(channel, (event, raw) => fn(event, schema.parse(raw))),
    send: vi.fn(),
  } as unknown as IpcRegistrar;
  const accounts = {
    list: () => store.accounts.list(),
    create: vi.fn(() => account),
    update: vi.fn(() => account),
    resetEnvironment: vi.fn(async () => account),
    checkStatus: vi.fn(async () => account),
    refreshProfile: vi.fn(async () => account),
  };
  const scheduler = { onJobChange: vi.fn() };
  registerAccountHandlers(ipc, accounts as unknown as AccountService, media);
  registerMetricsHandlers(ipc, {
    store,
    accounts: accounts as unknown as AccountService,
    scheduler: scheduler as unknown as CollectScheduler,
    media,
  });
  return {
    store,
    account,
    accounts,
    invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args),
  };
}

describe("registered IPC media boundary", () => {
  it("defaults every account-returning handler to strict local-only projection", async () => {
    const f = fixture();
    const calls: [string, ...unknown[]][] = [
      [IPC.accountList],
      [IPC.accountCreate, { platformId: "bilibili" }],
      [IPC.accountUpdate, f.account.id, { displayName: "新名称" }],
      [IPC.accountResetEnvironment, f.account.id],
      [IPC.accountCheckStatus, f.account.id],
      [IPC.accountRefreshProfile, f.account.id],
    ];
    for (const [channel, ...args] of calls) {
      const result = await f.invoke(channel, ...args);
      const row = (Array.isArray(result) ? result[0] : result) as { avatarUrl: unknown };
      expect(row.avatarUrl).toBeNull();
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    }
    expect(f.store.accounts.get(f.account.id)?.avatarUrl).toBe(remote);
  });

  it("projects real ReadModel platform/overview nesting and repository work results", async () => {
    const f = fixture();
    const platform = (await f.invoke(IPC.metricsPlatform, "bilibili", 30)) as {
      accounts: { avatarUrl: unknown }[];
    };
    const overview = (await f.invoke(IPC.metricsOverview, 30)) as {
      platforms: { accounts: { avatarUrl: unknown }[] }[];
    };
    const works = (await f.invoke(IPC.worksList, f.account.id, 50)) as { coverUrl: unknown }[];
    expect(platform.accounts[0].avatarUrl).toBeNull();
    expect(overview.platforms.flatMap((row) => row.accounts).every((row) => row.avatarUrl === null)).toBe(
      true,
    );
    expect(works[0].coverUrl).toBeNull();
    expect(JSON.stringify({ platform, overview, works })).not.toContain(remote);
  });

  it("projects ready local cache references through every image-bearing handler", async () => {
    const preview = vi.fn(() => ({ url: local }));
    const f = fixture(createMediaProjection({ enforcement: "strict", preview }));
    for (const [channel, ...args] of [
      [IPC.accountList],
      [IPC.metricsPlatform, "bilibili", 30],
      [IPC.metricsOverview, 30],
      [IPC.worksList, f.account.id],
      [IPC.accountRefreshProfile, f.account.id],
    ] as [string, ...unknown[]][]) {
      const serialized = JSON.stringify(await f.invoke(channel, ...args));
      expect(serialized).toContain(local);
      expect(serialized).not.toContain(remote);
    }
    expect(preview).toHaveBeenCalledWith({ accountId: f.account.id, kind: "avatar" });
    expect(preview).toHaveBeenCalledWith({
      accountId: f.account.id,
      kind: "cover",
      workId: `${f.account.id}:one`,
    });
  });

  it("does not pass renderer media nominations to AccountService.update", async () => {
    const f = fixture();
    for (const avatarUrl of [remote, local, null])
      await expect(f.invoke(IPC.accountUpdate, f.account.id, { avatarUrl })).rejects.toThrow();
    expect(f.accounts.update).not.toHaveBeenCalled();
  });

  it("retains current observe display only when its projection is explicitly installed", async () => {
    const f = fixture(createMediaProjection({ enforcement: "observe" }));
    expect(JSON.stringify(await f.invoke(IPC.accountList))).toContain(remote);
    expect(JSON.stringify(await f.invoke(IPC.metricsOverview))).toContain(remote);
    expect(JSON.stringify(await f.invoke(IPC.worksList, f.account.id))).toContain(remote);
  });
});
