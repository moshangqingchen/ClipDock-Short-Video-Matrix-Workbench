import { describe, expect, it } from "vitest";
import { createStore } from "@main/db";
import { partitionForAccount } from "@main/browser/partition";
import { GLOBAL_PLATFORM_IDS } from "@shared/platforms";
import type { Account, AccountCreateInput } from "@shared/types";

describe("AccountsRepository", () => {
  it("rejects international account creation even when callers bypass IPC types", () => {
    const store = createStore(":memory:");
    for (const platformId of GLOBAL_PLATFORM_IDS) {
      expect(() => store.accounts.create({ platformId } as unknown as AccountCreateInput)).toThrow(/国内/);
    }
    expect(store.accounts.count()).toBe(0);
    store.close();
  });

  it("rejects international restores and conflicting account identities without inserting rows", () => {
    const source = createStore(":memory:");
    const account = source.accounts.create({ platformId: "douyin" });
    const target = createStore(":memory:");
    expect(() =>
      target.accounts.upsertRaw({ ...account, platformId: "youtube" } as unknown as Account),
    ).toThrow(/国内/);
    expect(target.accounts.count()).toBe(0);
    target.accounts.upsertRaw({ ...account, partition: "persist:untrusted-shared-session" });
    expect(target.accounts.get(account.id)?.partition).toBe(partitionForAccount(account.id));
    expect(() => target.accounts.upsertRaw({ ...account, platformId: "bilibili" })).toThrow(/平台不一致/);
    expect(target.accounts.get(account.id)?.platformId).toBe("douyin");
    source.close();
    target.close();
  });

  it("rejects international rows already present in the domestic table", () => {
    const store = createStore(":memory:");
    const account = store.accounts.create({ platformId: "douyin" });
    store.db.run("UPDATE accounts SET platform_id = ? WHERE id = ?", ["youtube", account.id]);
    expect(() => store.accounts.get(account.id)).toThrow(/Corrupt domestic account/);
    expect(() => store.accounts.list()).toThrow(/Corrupt domestic account/);
    store.close();
  });

  it("creates accounts with a derived isolated partition and generated names", () => {
    const store = createStore(":memory:");
    const first = store.accounts.create({ platformId: "douyin" });
    const second = store.accounts.create({ platformId: "douyin" });
    expect(first.displayName).toBe("抖音账号 1");
    expect(second.displayName).toBe("抖音账号 2");
    expect(first.partition).toBe(partitionForAccount(first.id));
    expect(first.partition).not.toBe(second.partition);
    expect(first.status).toBe("unknown");
    store.close();
  });

  it("tracks status transitions and last online time", () => {
    const store = createStore(":memory:");
    const account = store.accounts.create({ platformId: "bilibili" });
    const online = store.accounts.updateStatus(account.id, "online", "ok", {
      sessionExpiresAt: "2027-01-01T00:00:00.000Z",
    })!;
    expect(online.lastOnlineAt).toBeTruthy();
    expect(online.sessionExpiresAt).toBe("2027-01-01T00:00:00.000Z");
    const offline = store.accounts.updateStatus(account.id, "offline", "gone")!;
    expect(offline.lastOnlineAt).toBe(online.lastOnlineAt);
    expect(offline.status).toBe("offline");
    store.close();
  });

  it("enforces the account cap", () => {
    const store = createStore(":memory:");
    for (let i = 0; i < 30; i += 1) store.accounts.create({ platformId: "douyin" });
    expect(() => store.accounts.create({ platformId: "douyin" })).toThrow(/30/);
    store.close();
  });

  it("cascades metrics and works on delete", () => {
    const store = createStore(":memory:");
    const account = store.accounts.create({ platformId: "douyin" });
    store.metrics.saveSnapshots([
      {
        accountId: account.id,
        platformId: "douyin",
        metric: "followers",
        value: 1,
        capturedAt: new Date().toISOString(),
        source: "session",
      },
    ]);
    store.metrics.upsertWorks([
      {
        id: `${account.id}:1`,
        accountId: account.id,
        platformId: "douyin",
        remoteId: "1",
        title: "t",
        plays: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        favorites: 0,
        fetchedAt: new Date().toISOString(),
      },
    ]);
    store.accounts.delete(account.id);
    expect(store.metrics.listSnapshots(account.id)).toHaveLength(0);
    expect(store.metrics.listWorks(account.id)).toHaveLength(0);
    store.close();
  });
});
