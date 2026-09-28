import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "@main/db";
import { partitionForAccount } from "@main/browser/partition";
import { GLOBAL_PLATFORM_IDS } from "@shared/platforms";
import type { Account, AccountCheckInfo, AccountCreateInput } from "@shared/types";

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

  it("can change bookkeeping status without manufacturing a new confirmation time", () => {
    const store = createStore(":memory:");
    try {
      const account = store.accounts.create({ platformId: "douyin" });
      const neverConfirmed = store.accounts.updateStatus(account.id, "unknown", "等待首次主页确认", {
        online: false, preserveCheckedAt: true,
      });
      expect(neverConfirmed).toMatchObject({ status: "unknown", lastCheckedAt: null, lastOnlineAt: null });
      const observedAt = "2020-01-01T01:02:03.000Z";
      store.db.run("UPDATE accounts SET status = 'online', last_checked_at = ?, last_online_at = ? WHERE id = ?", [
        observedAt, observedAt, account.id,
      ]);
      const invalidated = store.accounts.updateStatus(account.id, "unknown", "缺少本地主页记录，等待复核", {
        online: false, preserveCheckedAt: true,
      });
      expect(invalidated).toMatchObject({
        status: "unknown", statusMessage: "缺少本地主页记录，等待复核",
        lastCheckedAt: observedAt, lastOnlineAt: observedAt,
      });
      const confirmed = store.accounts.updateStatus(account.id, "offline", "主页明确显示未登录")!;
      expect(confirmed.lastCheckedAt).not.toBe(observedAt);
      expect(confirmed.lastCheckedAt).not.toBeNull();
      expect(confirmed.lastOnlineAt).toBe(observedAt);
    } finally { store.close(); }
  });

  it("persists a homepage observation across attempts and reopening the database without renewing it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipdock-homepage-evidence-"));
    const file = path.join(dir, "accounts.sqlite");
    let store: ReturnType<typeof createStore> | undefined;
    try {
      store = createStore(file);
      const account = store.accounts.create({ platformId: "douyin" });
      const established = store.accounts.updateStatus(account.id, "online", "主页已确认")!;
      const homepageConfirmation = { kind: "online" as const, observedAt: Date.now() - 60_000 };
      store.accounts.updateCheckInfo(account.id, {
        state: "confirmed", reason: "主页已登录", attemptedAt: new Date(homepageConfirmation.observedAt).toISOString(),
        homepageConfirmation,
      });
      for (const state of ["checking", "unconfirmed", "paused", "network_error"] as const) {
        const updated = store.accounts.updateCheckInfo(account.id, {
          state, reason: "本次检查未得到新结论", attemptedAt: new Date().toISOString(),
        })!;
        expect(updated.checkInfo).toMatchObject({ state, homepageConfirmation });
        expect(updated.lastCheckedAt).toBe(established.lastCheckedAt);
        expect(updated.lastOnlineAt).toBe(established.lastOnlineAt);
        expect(updated.status).toBe("online");
      }
      store.close();
      store = undefined;
      store = createStore(file);
      expect(store.accounts.get(account.id)?.checkInfo).toMatchObject({ state: "network_error", homepageConfirmation });
    } finally {
      store?.close();
      // Only these fixture files are removed; never recursively delete a computed directory.
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
      fs.rmdirSync(dir);
    }
  });

  it("replaces an explicit homepage verdict and clears it only when null or the environment is reset", () => {
    const store = createStore(":memory:");
    try {
      const account = store.accounts.create({ platformId: "kuaishou" });
      const info: AccountCheckInfo = { state: "confirmed", reason: "主页观察", attemptedAt: new Date().toISOString() };
      store.accounts.updateCheckInfo(account.id, { ...info,
        homepageConfirmation: { kind: "online", observedAt: Date.now() - 1000 } });
      const offline = { kind: "offline" as const, observedAt: Date.now() };
      expect(store.accounts.updateCheckInfo(account.id, { ...info, homepageConfirmation: offline })?.checkInfo)
        .toMatchObject({ homepageConfirmation: offline });
      expect(store.accounts.updateCheckInfo(account.id, { ...info, homepageConfirmation: null })?.checkInfo)
        .toMatchObject({ homepageConfirmation: null });
      expect(store.accounts.updateCheckInfo(account.id, info)?.checkInfo?.homepageConfirmation).toBeNull();
      store.accounts.updateCheckInfo(account.id, { ...info, homepageConfirmation: offline });
      expect(store.accounts.clearSessionState(account.id)).toMatchObject({ status: "offline", checkInfo: null });
      expect(store.accounts.updateCheckInfo(account.id, info)?.checkInfo?.homepageConfirmation).toBeUndefined();
    } finally { store.close(); }
  });

  it.each([
    "online",
    [],
    { kind: "online" },
    { kind: "unknown", observedAt: 1 },
    { kind: "online", observedAt: "1" },
    { kind: "online", observedAt: -1 },
    { kind: "online", observedAt: 1.5 },
    { kind: "online", observedAt: null },
    { kind: "online", observedAt: Number.MAX_SAFE_INTEGER },
  ])("does not trust malformed persisted homepage evidence: %j", (homepageConfirmation) => {
    const store = createStore(":memory:");
    try {
      const account = store.accounts.create({ platformId: "bilibili" });
      const info = { state: "unconfirmed", reason: "等待复核", attemptedAt: new Date().toISOString() };
      store.db.run("UPDATE accounts SET check_info_json = ? WHERE id = ?", [JSON.stringify({ ...info, homepageConfirmation }), account.id]);
      expect(store.accounts.get(account.id)?.checkInfo).toEqual({ ...info, homepageConfirmation: null });
    } finally { store.close(); }
  });

  it("projects only homepage verdict fields and refuses an invalid write without discarding the saved verdict", () => {
    const store = createStore(":memory:");
    try {
      const account = store.accounts.create({ platformId: "xiaohongshu" });
      const info: AccountCheckInfo = {
        state: "confirmed", reason: "主页已确认", attemptedAt: new Date().toISOString(),
        homepageConfirmation: { kind: "online", observedAt: Date.now() - 1000 },
      };
      store.db.run("UPDATE accounts SET check_info_json = ? WHERE id = ?", [JSON.stringify({
        ...info, extra: "must-not-project", homepageConfirmation: { ...info.homepageConfirmation, token: "synthetic-must-not-project" },
      }), account.id]);
      expect(store.accounts.get(account.id)?.checkInfo).toEqual(info);
      expect(() => store.accounts.updateCheckInfo(account.id, { ...info,
        homepageConfirmation: { kind: "online", observedAt: Date.now() + 60_000 } })).toThrow("主页登录证据无效");
      expect(store.accounts.get(account.id)?.checkInfo).toEqual(info);
      store.accounts.updateCheckInfo(account.id, { ...info, state: "checking", homepageConfirmation: undefined });
      expect(store.db.get<{ check_info_json: string }>("SELECT check_info_json FROM accounts WHERE id = ?", [account.id])?.check_info_json)
        .not.toContain("must-not-project");
    } finally { store.close(); }
  });

  it("never infers homepage evidence from historical status or imports it through backup metadata", () => {
    const store = createStore(":memory:");
    try {
      const account = store.accounts.create({ platformId: "douyin" });
      store.accounts.updateStatus(account.id, "online", "主页已显示当前登录账号");
      const info: AccountCheckInfo = { state: "confirmed", reason: "主页已登录", attemptedAt: new Date().toISOString() };
      expect(store.accounts.updateCheckInfo(account.id, info)?.checkInfo?.homepageConfirmation).toBeUndefined();
      const injected: AccountCheckInfo = { ...info, homepageConfirmation: { kind: "online", observedAt: Date.now() } };
      store.accounts.upsertRaw({ ...account, checkInfo: injected });
      expect(store.accounts.get(account.id)?.checkInfo?.homepageConfirmation).toBeUndefined();
      store.accounts.upsertRaw({ ...account, id: "restored-copy", checkInfo: injected, status: "online" });
      expect(store.accounts.get("restored-copy")).toMatchObject({ status: "unknown", checkInfo: null });
      const local = { kind: "offline" as const, observedAt: Date.now() - 1000 };
      store.accounts.updateCheckInfo(account.id, { ...info, homepageConfirmation: local });
      store.accounts.upsertRaw({ ...account, checkInfo: injected });
      expect(store.accounts.get(account.id)?.checkInfo?.homepageConfirmation).toEqual(local);
    } finally { store.close(); }
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
