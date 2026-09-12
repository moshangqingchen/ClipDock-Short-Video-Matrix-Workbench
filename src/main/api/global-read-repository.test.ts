import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import type { GlobalReadSnapshot } from "@shared/global-read";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalReadRepository } from "./global-read-repository";

const stores: Store[] = [];
function fixture() {
  const store = createStore(":memory:");
  stores.push(store);
  const accounts = new GlobalAccountRepository(store.db);
  const account = accounts.create({ platformId: "youtube", displayName: "synthetic account" });
  accounts.markAuthorized(account.id, { remoteId: "UC_synthetic" });
  const snapshot: GlobalReadSnapshot = {
    accountId: account.id,
    platformId: account.platformId,
    remoteId: "UC_synthetic",
    fetchedAt: "2026-09-08T08:00:00.000Z",
    profile: { displayName: "synthetic profile", username: null },
    totals: { followers: "0", following: null, works: "1", views: "9007199254740993123", likes: null },
    works: [
      {
        id: "video_1",
        kind: "video",
        title: "synthetic work",
        publishedAt: null,
        views: null,
        likes: "0",
        comments: null,
        reposts: null,
      },
    ],
    hasMoreWorks: null,
    capabilities: { readProfile: "ready", readMetrics: "scope_required", listWorks: "ready" },
  };
  return { db: store.db, accounts, account, snapshot, repo: new GlobalReadRepository(store.db) };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

describe("bounded local global read snapshots", () => {
  it("stores actual null/zero and lossless large counts, and only returns detached public fields", () => {
    const f = fixture();
    const guard = vi.fn();
    const saved = f.repo.save(f.snapshot, guard);
    expect(guard).toHaveBeenCalledTimes(4);
    expect(saved).toEqual(f.snapshot);
    saved.profile.displayName = "caller mutation";
    expect(f.repo.get(f.account.id)).toEqual(f.snapshot);
    expect(f.db.all("PRAGMA table_info(global_read_snapshots)").map((row) => row.name)).toEqual([
      "account_id",
      "platform_id",
      "remote_id",
      "fetched_at",
      "snapshot_json",
    ]);
    expect(f.db.get("SELECT COUNT(*) AS n FROM credentials")?.n).toBe(0);
    const audit = f.db.get(
      "SELECT action, account_id, details_json, created_at FROM audit_events WHERE action='GlobalRead'",
    );
    expect(audit).toEqual({
      action: "GlobalRead",
      account_id: f.account.id,
      created_at: f.snapshot.fetchedAt,
      details_json: JSON.stringify({
        platformId: "youtube",
        workCount: 1,
        capabilities: f.snapshot.capabilities,
      }),
    });
    expect(audit?.details_json).not.toMatch(/synthetic profile|synthetic work|remoteId|url|token/i);
  });

  it("upserts one snapshot and never mutates account authorization or previous capture times", () => {
    const f = fixture();
    const before = f.accounts.get(f.account.id);
    f.repo.save(f.snapshot, () => undefined);
    const newer = { ...f.snapshot, fetchedAt: "2026-09-08T09:00:00.000Z", works: [] };
    expect(f.repo.save(newer, () => undefined)).toEqual(newer);
    expect(f.accounts.get(f.account.id)).toEqual(before);
    expect(f.db.get("SELECT COUNT(*) AS n FROM global_read_snapshots")?.n).toBe(1);
  });

  it.each(["unauthorized", "reauthorization_required"] as const)(
    "does not expose saved data after auth becomes %s",
    (status) => {
      const f = fixture();
      f.repo.save(f.snapshot, () => undefined);
      f.db.run("UPDATE global_accounts SET auth_status = ? WHERE id = ?", [status, f.account.id]);
      expect(f.repo.get(f.account.id)).toBeNull();
      expect(() => f.repo.save(f.snapshot, () => undefined)).toThrow("GLOBAL_READ_UNAUTHORIZED");
    },
  );

  it.each(["platform", "remote"])("ignores old snapshot after the account %s identity changes", (field) => {
    const f = fixture();
    f.repo.save(f.snapshot, () => undefined);
    f.db.run(
      field === "platform"
        ? "UPDATE global_accounts SET platform_id='x' WHERE id=?"
        : "UPDATE global_accounts SET remote_id='another' WHERE id=?",
      [f.account.id],
    );
    expect(f.repo.get(f.account.id)).toBeNull();
    expect(() => f.repo.save(f.snapshot, () => undefined)).toThrow("GLOBAL_READ_IDENTITY_MISMATCH");
  });

  it("returns null for missing account/snapshot and rejects missing identity on save", () => {
    const f = fixture();
    expect(f.repo.get(f.account.id)).toBeNull();
    expect(f.repo.get(randomUUID())).toBeNull();
    expect(() => f.repo.save({ ...f.snapshot, accountId: randomUUID() }, () => undefined)).toThrow(
      "GLOBAL_READ_UNAUTHORIZED",
    );
  });

  it.each(["token", "cookie", "remoteUrl", "rawResponse"])(
    "rejects extra %s fields instead of storing or returning secrets",
    (field) => {
      const f = fixture();
      const bad = { ...f.snapshot, [field]: "private-secret https://private.invalid/?token=x" };
      expect(() => f.repo.save(bad, () => undefined)).toThrow("GLOBAL_READ_INPUT_INVALID");
      expect(f.repo.get(f.account.id)).toBeNull();
      f.repo.save(f.snapshot, () => undefined);
      f.db.run("UPDATE global_read_snapshots SET snapshot_json=? WHERE account_id=?", [
        JSON.stringify(bad),
        f.account.id,
      ]);
      expect(() => f.repo.get(f.account.id)).toThrow("GLOBAL_READ_RESPONSE_INVALID");
    },
  );

  it("enforces work/count bounds and strict nested fields", () => {
    const f = fixture();
    for (const input of [
      { ...f.snapshot, works: Array.from({ length: 21 }, () => f.snapshot.works[0]) },
      { ...f.snapshot, totals: { ...f.snapshot.totals, followers: 0 } },
      { ...f.snapshot, profile: { ...f.snapshot.profile, avatarUrl: "https://private.invalid/" } },
    ])
      expect(() => f.repo.save(input as GlobalReadSnapshot, () => undefined)).toThrow(
        "GLOBAL_READ_INPUT_INVALID",
      );
  });

  it.each([1, 2, 3, 4])(
    "revocation at guard %i preserves the old snapshot with a real SQLite rollback",
    (at) => {
      const f = fixture();
      f.repo.save(f.snapshot, () => undefined);
      let calls = 0;
      expect(() =>
        f.repo.save({ ...f.snapshot, fetchedAt: "2026-09-08T10:00:00.000Z" }, () => {
          if (++calls === at) throw new Error("GLOBAL_READ_WAITING_PROXY");
        }),
      ).toThrow("GLOBAL_READ_WAITING_PROXY");
      expect(f.repo.get(f.account.id)).toEqual(f.snapshot);
    },
  );

  it.each(["INSERT", "UPDATE"])(
    "does not accept a silently ignored %s even if the previous snapshot looks identical",
    (operation) => {
      const f = fixture();
      if (operation === "UPDATE") f.repo.save(f.snapshot, () => undefined);
      f.db.exec(
        `CREATE TRIGGER ignore_save BEFORE ${operation} ON global_read_snapshots BEGIN SELECT RAISE(IGNORE); END`,
      );
      expect(() => f.repo.save(f.snapshot, () => undefined)).toThrow("GLOBAL_READ_SAVE_FAILED");
      expect(f.repo.get(f.account.id)).toEqual(operation === "UPDATE" ? f.snapshot : null);
    },
  );

  it("verifies the saved row after triggers and rolls back unexpected replacement", () => {
    const f = fixture();
    f.repo.save(f.snapshot, () => undefined);
    f.db.exec(
      "CREATE TRIGGER corrupt AFTER UPDATE ON global_read_snapshots BEGIN UPDATE global_read_snapshots SET fetched_at='unexpected' WHERE account_id=NEW.account_id; END",
    );
    expect(() =>
      f.repo.save({ ...f.snapshot, fetchedAt: "2026-09-08T10:00:00.000Z" }, () => undefined),
    ).toThrow("GLOBAL_READ_SAVE_FAILED");
    expect(f.repo.get(f.account.id)).toEqual(f.snapshot);
  });

  it("rechecks identity after an external final guard modifies the account and rolls back both", () => {
    const f = fixture();
    const before = f.accounts.get(f.account.id);
    let calls = 0;
    expect(() =>
      f.repo.save(f.snapshot, () => {
        if (++calls === 4)
          f.db.run("UPDATE global_accounts SET remote_id='changed' WHERE id=?", [f.account.id]);
      }),
    ).toThrow("GLOBAL_READ_IDENTITY_MISMATCH");
    expect(f.accounts.get(f.account.id)).toEqual(before);
    expect(f.repo.get(f.account.id)).toBeNull();
  });

  it("detaches the submitted object before guard reentry", () => {
    const f = fixture();
    const original = structuredClone(f.snapshot);
    expect(
      f.repo.save(f.snapshot, () => {
        f.snapshot.profile.displayName = "changed by callback";
      }),
    ).toEqual(original);
  });

  it("composes with a caller transaction and its rollback", () => {
    const f = fixture();
    expect(() =>
      f.db.transaction(() => {
        f.repo.save(f.snapshot, () => undefined);
        throw new Error("outer rollback");
      }),
    ).toThrow("outer rollback");
    expect(f.repo.get(f.account.id)).toBeNull();
  });

  it("removes only the chosen snapshot, is idempotent and enforces the account cascade", () => {
    const f = fixture();
    f.repo.save(f.snapshot, () => undefined);
    const second = f.accounts.create({ platformId: "youtube" });
    f.accounts.markAuthorized(second.id, { remoteId: "UC_second" });
    const other = { ...f.snapshot, accountId: second.id, remoteId: "UC_second" };
    f.repo.save(other, () => undefined);
    f.repo.remove(f.account.id);
    f.repo.remove(f.account.id);
    expect(f.repo.get(f.account.id)).toBeNull();
    expect(f.repo.get(second.id)).toEqual(other);
    f.accounts.delete(second.id);
    expect(f.db.all("SELECT * FROM global_read_snapshots")).toEqual([]);
  });

  it("rolls back a silently ignored remove", () => {
    const f = fixture();
    f.repo.save(f.snapshot, () => undefined);
    f.db.exec(
      "CREATE TRIGGER ignore_remove BEFORE DELETE ON global_read_snapshots BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(() => f.repo.remove(f.account.id)).toThrow("GLOBAL_READ_SAVE_FAILED");
    expect(f.repo.get(f.account.id)).toEqual(f.snapshot);
  });

  it.each(["IGNORE", "ABORT, 'private-secret'"])(
    "rolls back the replacement snapshot when audit INSERT raises %s",
    (action) => {
      const f = fixture();
      f.repo.save(f.snapshot, () => undefined);
      const originalAudit = f.db.all("SELECT * FROM audit_events");
      f.db.exec(
        `CREATE TRIGGER block_audit BEFORE INSERT ON audit_events WHEN NEW.action='GlobalRead' BEGIN SELECT RAISE(${action}); END`,
      );
      expect(() =>
        f.repo.save({ ...f.snapshot, fetchedAt: "2026-09-08T10:00:00.000Z" }, () => undefined),
      ).toThrow("GLOBAL_READ_SAVE_FAILED");
      expect(f.repo.get(f.account.id)).toEqual(f.snapshot);
      expect(f.db.all("SELECT * FROM audit_events")).toEqual(originalAudit);
    },
  );

  it("requires the audit and snapshot to survive audit triggers unchanged", () => {
    const f = fixture();
    f.repo.save(f.snapshot, () => undefined);
    f.db.exec(
      "CREATE TRIGGER alter_after_audit AFTER INSERT ON audit_events WHEN NEW.action='GlobalRead' BEGIN UPDATE global_read_snapshots SET remote_id='wrong' WHERE account_id=NEW.account_id; END",
    );
    expect(() =>
      f.repo.save({ ...f.snapshot, fetchedAt: "2026-09-08T10:00:00.000Z" }, () => undefined),
    ).toThrow("GLOBAL_READ_SAVE_FAILED");
    expect(f.repo.get(f.account.id)).toEqual(f.snapshot);
    expect(f.db.get("SELECT COUNT(*) AS n FROM audit_events WHERE action='GlobalRead'")?.n).toBe(1);
  });

  it("does not commit when the final guard removes the just-recorded audit", () => {
    const f = fixture();
    let checks = 0;
    expect(() =>
      f.repo.save(f.snapshot, () => {
        if (++checks === 4) f.db.run("DELETE FROM audit_events WHERE action='GlobalRead'");
      }),
    ).toThrow("GLOBAL_READ_SAVE_FAILED");
    expect(f.repo.get(f.account.id)).toBeNull();
  });

  it("returns fixed errors for invalid IDs, guard failures and database failures", () => {
    const f = fixture();
    expect(() => f.repo.get("private-secret")).toThrow("GLOBAL_READ_INPUT_INVALID");
    expect(() => f.repo.remove("private-secret")).toThrow("GLOBAL_READ_INPUT_INVALID");
    expect(() =>
      f.repo.save(f.snapshot, () => {
        throw new Error("private-secret");
      }),
    ).toThrow("GLOBAL_READ_CANCELLED");
    vi.spyOn(f.db, "get").mockImplementation(() => {
      throw new Error("private-secret");
    });
    expect(() => f.repo.get(f.account.id)).toThrow("GLOBAL_READ_UNAVAILABLE");
  });
});
