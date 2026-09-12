import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { migrate } from "@main/db/database";
import { buildBackup, applyBackup } from "@main/security/backup";
import { CN_PLATFORM_IDS } from "@shared/platforms";
import type { GlobalAccountCreateInput } from "@shared/global-accounts";
import { GlobalAccountRepository, MAX_GLOBAL_ACCOUNTS } from "./global-account-repository";

const stores: Store[] = [];
function fixture() {
  const store = createStore(":memory:");
  stores.push(store);
  return { store, db: store.db, repository: new GlobalAccountRepository(store.db) };
}

function credential(store: Store, owner: string, kind = "oauth_token") {
  const id = randomUUID();
  store.db.run(
    "INSERT INTO credentials (id,kind,owner_id,ciphertext,encryption_version,created_at,updated_at) VALUES (?,?,?, ?,1,?,?)",
    [id, kind, owner, Buffer.from("synthetic-private-credential"), "2026-01-01", "2026-01-01"],
  );
  return id;
}

/** Reconstruct the previous schema in an isolated in-memory database. */
function removeNamespaceMigration(store: Store) {
  store.db.exec(`
    DROP TRIGGER IF EXISTS accounts_global_id_insert;
    DROP TRIGGER IF EXISTS accounts_global_id_update;
    DROP TRIGGER IF EXISTS global_accounts_domestic_id_insert;
    DROP TRIGGER IF EXISTS global_accounts_domestic_id_update;
    DELETE FROM schema_migrations WHERE version = 5;
  `);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

describe("GlobalAccountRepository", () => {
  it("rejects a silently ignored account INSERT instead of returning a nonexistent UUID", () => {
    const { repository, db } = fixture();
    db.exec("CREATE TRIGGER ignore_create BEFORE INSERT ON global_accounts BEGIN SELECT RAISE(IGNORE); END");
    expect(() => repository.create({ platformId: "youtube" })).toThrow("GLOBAL_ACCOUNT_SAVE_FAILED");
    expect(db.all("SELECT * FROM global_accounts")).toEqual([]);
  });

  it.each([
    "UPDATE global_accounts SET display_name = 'unexpected-name' WHERE id = NEW.id;",
    "DELETE FROM global_accounts WHERE id = NEW.id;",
  ])("requires the actual inserted account to match its returned identity %#", (body) => {
    const { repository, db } = fixture();
    db.exec(`CREATE TRIGGER change_created AFTER INSERT ON global_accounts BEGIN ${body} END`);
    expect(() => repository.create({ platformId: "x", displayName: "original-name" })).toThrow(
      "GLOBAL_ACCOUNT_SAVE_FAILED",
    );
    expect(db.all("SELECT * FROM global_accounts")).toEqual([]);
  });

  it("cannot delete an account while its token DELETE was silently ignored", () => {
    const { store, repository, db } = fixture();
    const account = repository.create({ platformId: "youtube" });
    credential(store, account.id);
    const before = db.all("SELECT * FROM credentials");
    db.exec(
      "CREATE TRIGGER ignore_token_delete BEFORE DELETE ON credentials WHEN OLD.kind = 'oauth_token' BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(() => repository.delete(account.id)).toThrow("GLOBAL_ACCOUNT_DELETE_FAILED");
    expect(repository.get(account.id)).toEqual(account);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
  });

  it("checks token absence after account deletion triggers finish", () => {
    const { store, repository, db } = fixture();
    const account = repository.create({ platformId: "youtube" });
    credential(store, account.id);
    const before = db.all("SELECT * FROM credentials");
    db.exec(`CREATE TRIGGER recreate_token AFTER DELETE ON global_accounts BEGIN
      INSERT INTO credentials (id,kind,owner_id,ciphertext,encryption_version,created_at,updated_at)
      VALUES ('replacement-token','oauth_token',OLD.id,X'01',1,OLD.created_at,OLD.updated_at); END`);
    expect(() => repository.delete(account.id)).toThrow("GLOBAL_ACCOUNT_DELETE_FAILED");
    expect(repository.get(account.id)).toEqual(account);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
  });

  it("checks account absence even when a successful DELETE trigger reinserts the old row", () => {
    const { store, repository, db } = fixture();
    const account = repository.create({ platformId: "youtube" });
    credential(store, account.id);
    const before = db.all("SELECT * FROM credentials");
    db.exec(`CREATE TRIGGER recreate_account AFTER DELETE ON global_accounts BEGIN
      INSERT INTO global_accounts (id,platform_id,display_name,remote_id,auth_status,created_at,updated_at)
      VALUES (OLD.id,OLD.platform_id,OLD.display_name,OLD.remote_id,OLD.auth_status,OLD.created_at,OLD.updated_at); END`);
    expect(() => repository.delete(account.id)).toThrow("GLOBAL_ACCOUNT_DELETE_FAILED");
    expect(repository.get(account.id)).toEqual(account);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
  });

  it.each(["markAuthorized", "requireReauthorization"] as const)(
    "requires a real %s UPDATE even if previous fields already match",
    (method) => {
      const { repository, db } = fixture();
      const account = repository.create({ platformId: "youtube" });
      repository.markAuthorized(account.id, { remoteId: "synthetic-remote" });
      if (method === "requireReauthorization") repository.requireReauthorization(account.id);
      const before = repository.get(account.id);
      db.exec(
        "CREATE TRIGGER ignore_authorization_update BEFORE UPDATE ON global_accounts BEGIN SELECT RAISE(IGNORE); END",
      );
      expect(() =>
        method === "markAuthorized"
          ? repository.markAuthorized(account.id, { remoteId: "synthetic-remote" })
          : repository.requireReauthorization(account.id),
      ).toThrow("GLOBAL_ACCOUNT_SAVE_FAILED");
      expect(repository.get(account.id)).toEqual(before);
    },
  );

  it("deletes an existing account without requiring a token that was never configured", () => {
    const { repository } = fixture();
    const account = repository.create({ platformId: "tiktok" });
    expect(repository.delete(account.id)).toBe(true);
    expect(repository.get(account.id)).toBeUndefined();
  });

  it("migrates an existing v3 database once without touching domestic records or credentials", () => {
    const { store, db } = fixture();
    const domestic = store.accounts.create({ platformId: "douyin" });
    credential(store, domestic.id);
    const secretBefore = db.all("SELECT * FROM credentials");
    removeNamespaceMigration(store);
    db.exec("DROP TABLE global_accounts; DELETE FROM schema_migrations WHERE version = 4;");
    migrate(db);
    migrate(db);
    expect(db.all("SELECT version FROM schema_migrations WHERE version = 4")).toHaveLength(1);
    expect(db.all("PRAGMA table_info(global_accounts)").map((column) => column.name)).toEqual([
      "id",
      "platform_id",
      "display_name",
      "remote_id",
      "auth_status",
      "created_at",
      "updated_at",
    ]);
    expect(store.accounts.get(domestic.id)).toEqual(domestic);
    expect(db.all("SELECT * FROM credentials")).toEqual(secretBefore);
  });

  it("creates separate unauthorized accounts with no partition or network state", () => {
    const { store, repository } = fixture();
    const first = repository.create({ platformId: "youtube" });
    const second = repository.create({ platformId: "youtube", displayName: "  Channel  " });
    expect(first).toMatchObject({ displayName: "YouTube账号 1", remoteId: null, authStatus: "unauthorized" });
    expect(second.displayName).toBe("Channel");
    expect(first.id).not.toBe(second.id);
    expect(repository.list()).toHaveLength(2);
    expect(store.accounts.list()).toEqual([]);
    expect(Object.keys(first).sort()).toEqual(
      [
        "id",
        "platformId",
        "displayName",
        "remoteId",
        "authStatus",
        "createdAt",
        "updatedAt",
        "note",
        "browserEngine",
      ].sort(),
    );
    first.displayName = "not saved";
    expect(repository.get(first.id)?.displayName).toBe("YouTube账号 1");
  });

  it("rejects domestic ids and authority injection even when IPC is bypassed", () => {
    const { repository, db } = fixture();
    for (const platformId of CN_PLATFORM_IDS)
      expect(() => repository.create({ platformId } as unknown as GlobalAccountCreateInput)).toThrow(
        "GLOBAL_ACCOUNT_INPUT_INVALID",
      );
    expect(() =>
      repository.create({ platformId: "x", authStatus: "authorized" } as GlobalAccountCreateInput),
    ).toThrow("GLOBAL_ACCOUNT_INPUT_INVALID");
    expect(db.all("SELECT id FROM global_accounts")).toEqual([]);
  });

  it("only explicit main authorization changes identity and keeps original creation metadata", () => {
    const { store, repository } = fixture();
    vi.useFakeTimers();
    vi.setSystemTime("2026-01-01T00:00:00.000Z");
    const account = repository.create({ platformId: "tiktok" });
    credential(store, account.id);
    expect(repository.requireReauthorization(account.id)).toEqual(account);
    vi.setSystemTime("2026-01-02T00:00:00.000Z");
    const authorized = repository.markAuthorized(account.id, { remoteId: "provider-identity" })!;
    expect(authorized).toMatchObject({
      remoteId: "provider-identity",
      authStatus: "authorized",
      createdAt: account.createdAt,
    });
    expect(authorized.updatedAt).not.toBe(account.updatedAt);
    expect(() =>
      repository.markAuthorized(account.id, { remoteId: "", token: "secret" } as { remoteId: string }),
    ).toThrow("GLOBAL_ACCOUNT_INPUT_INVALID");
    expect(repository.get(account.id)).toEqual(authorized);
    expect(repository.requireReauthorization(account.id)).toMatchObject({
      remoteId: "provider-identity",
      authStatus: "reauthorization_required",
    });
    expect(repository.markAuthorized(randomUUID(), { remoteId: "absent" })).toBeUndefined();
    expect(repository.list()).toHaveLength(1);
  });

  it("enforces global platform and authorization semantics at the SQL boundary", () => {
    const { repository, db } = fixture();
    const account = repository.create({ platformId: "x" });
    expect(() =>
      db.run("UPDATE global_accounts SET platform_id = 'douyin' WHERE id = ?", [account.id]),
    ).toThrow();
    expect(() =>
      db.run("UPDATE global_accounts SET auth_status = 'allowed' WHERE id = ?", [account.id]),
    ).toThrow();
    expect(() =>
      db.run("UPDATE global_accounts SET auth_status = 'authorized' WHERE id = ?", [account.id]),
    ).toThrow();
    expect(repository.get(account.id)).toEqual(account);
  });

  it("deletes only the international account and its oauth token, preserving other kinds and owners", () => {
    const { store, repository, db } = fixture();
    const account = repository.create({ platformId: "youtube" });
    const other = repository.create({ platformId: "x" });
    const domestic = store.accounts.create({ platformId: "bilibili" });
    credential(store, account.id);
    const survivors = [
      credential(store, account.id, "proxy_password"),
      credential(store, other.id),
      credential(store, domestic.id),
    ];
    expect(repository.delete(account.id)).toBe(true);
    expect(repository.delete(account.id)).toBe(false);
    expect(
      db
        .all("SELECT id FROM credentials")
        .map((row) => row.id)
        .sort(),
    ).toEqual(survivors.sort());
    expect(repository.get(other.id)).toEqual(other);
    expect(store.accounts.get(domestic.id)).toEqual(domestic);
  });

  it("rolls token deletion back if account removal fails and hides the database error", () => {
    const { store, repository, db } = fixture();
    const account = repository.create({ platformId: "x" });
    credential(store, account.id);
    const credentialsBefore = db.all("SELECT * FROM credentials");
    db.exec(
      "CREATE TRIGGER reject_global_delete BEFORE DELETE ON global_accounts BEGIN SELECT RAISE(ABORT, 'private-db-error'); END;",
    );
    expect(() => repository.delete(account.id)).toThrow(/^GLOBAL_ACCOUNT_DELETE_FAILED$/);
    expect(repository.get(account.id)).toEqual(account);
    expect(db.all("SELECT * FROM credentials")).toEqual(credentialsBefore);
  });

  it("bounds account creation independently of the domestic account limit", () => {
    const { repository, store } = fixture();
    for (let i = 0; i < MAX_GLOBAL_ACCOUNTS; i++) repository.create({ platformId: "x" });
    expect(() => repository.create({ platformId: "youtube" })).toThrow("GLOBAL_ACCOUNT_LIMIT_REACHED");
    expect(repository.list()).toHaveLength(MAX_GLOBAL_ACCOUNTS);
    expect(store.accounts.create({ platformId: "bilibili" }).status).toBe("unknown");
  });

  it("does not commit token removal when a database trigger silently prevents deleting the account", () => {
    const { store, repository, db } = fixture();
    const account = repository.create({ platformId: "youtube" });
    credential(store, account.id);
    const before = db.all("SELECT * FROM credentials");
    db.exec(
      "CREATE TRIGGER ignore_global_delete BEFORE DELETE ON global_accounts BEGIN SELECT RAISE(IGNORE); END;",
    );
    expect(() => repository.delete(account.id)).toThrow(/^GLOBAL_ACCOUNT_DELETE_FAILED$/);
    expect(repository.get(account.id)).toEqual(account);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
  });

  it("exports global metadata separately without exporting credentials", () => {
    const { repository, store, db } = fixture();
    const domestic = store.accounts.create({ platformId: "weixin_channels" });
    const global = repository.create({ platformId: "youtube", displayName: "Private global name" });
    credential(store, global.id);
    const queries = vi.spyOn(db, "all");
    const backup = buildBackup(store, "test");
    expect(queries.mock.calls.every(([sql]) => !/credentials/i.test(sql))).toBe(true);
    expect(backup.accounts.map((account) => account.id)).toEqual([domestic.id]);
    const encoded = JSON.stringify(backup);
    expect(backup.global?.accounts[0]).toMatchObject({ id: global.id, displayName: global.displayName });
    for (const secret of ["synthetic-private-credential", "oauth_token"])
      expect(encoded).not.toContain(secret);
    applyBackup(store, backup, "replace");
    expect(repository.get(global.id)).toEqual(global);
    expect(db.all("SELECT id FROM credentials")).toHaveLength(1);
  });

  it("rejects malformed persisted data with a fixed error and no row contents", () => {
    const { repository, db } = fixture();
    const account = repository.create({ platformId: "x" });
    db.run("UPDATE global_accounts SET created_at = ? WHERE id = ?", ["private-corrupt-value", account.id]);
    expect(() => repository.list()).toThrow(/^GLOBAL_ACCOUNT_DATA_INVALID$/);
    expect(() => repository.get("private-not-an-id")).toThrow(/^GLOBAL_ACCOUNT_INPUT_INVALID$/);
    vi.spyOn(db, "all").mockImplementation(() => {
      throw new Error("private-query-diagnostic");
    });
    expect(() => repository.list()).toThrow(/^GLOBAL_ACCOUNT_READ_FAILED$/);
  });

  it.each(["merge", "replace"] as const)(
    "rejects a domestic backup claiming a global UUID during %s and rolls the whole restore back",
    (mode) => {
      const target = fixture();
      const domestic = target.store.accounts.create({ platformId: "douyin" });
      const global = target.repository.create({ platformId: "youtube" });
      credential(target.store, global.id);
      const tokenBefore = target.db.all("SELECT * FROM credentials");
      const source = fixture();
      const incoming = source.store.accounts.create({ platformId: "bilibili" });
      source.db.run("UPDATE accounts SET id = ? WHERE id = ?", [global.id, incoming.id]);
      const backup = buildBackup(source.store, "fixture");
      expect(() => applyBackup(target.store, backup, mode)).toThrow("ACCOUNT_ID_NAMESPACE_CONFLICT");
      // showView first calls accounts.get: the global UUID cannot become a domestic lookup.
      expect(target.store.accounts.get(global.id)).toBeUndefined();
      expect(target.store.accounts.list()).toEqual([domestic]);
      expect(target.repository.get(global.id)).toEqual(global);
      expect(target.db.all("SELECT * FROM credentials")).toEqual(tokenBefore);
    },
  );

  it("rejects direct insertions of a UUID already owned by the other account table", () => {
    const { store, repository, db } = fixture();
    const domestic = store.accounts.create({ platformId: "douyin" });
    const global = repository.create({ platformId: "x" });
    expect(() => store.accounts.upsertRaw({ ...domestic, id: global.id.toUpperCase() })).toThrow(
      "ACCOUNT_ID_NAMESPACE_CONFLICT",
    );
    expect(() =>
      db.run(
        "INSERT INTO global_accounts (id,platform_id,display_name,created_at,updated_at) VALUES (?,'youtube','fixture',?,?)",
        [domestic.id, domestic.createdAt, domestic.updatedAt],
      ),
    ).toThrow("ACCOUNT_ID_NAMESPACE_CONFLICT");
    expect(store.accounts.list()).toEqual([domestic]);
    expect(repository.list()).toEqual([global]);
  });

  it.each(["accounts", "global_accounts"] as const)(
    "rejects ID UPDATE into the other table, including uppercase UUID aliases: %s",
    (table) => {
      const { store, repository, db } = fixture();
      const domestic = store.accounts.create({ platformId: "kuaishou" });
      const global = repository.create({ platformId: "tiktok" });
      const [from, occupied] = table === "accounts" ? [domestic.id, global.id] : [global.id, domestic.id];
      expect(() => db.run(`UPDATE ${table} SET id = ? WHERE id = ?`, [occupied.toUpperCase(), from])).toThrow(
        "ACCOUNT_ID_NAMESPACE_CONFLICT",
      );
      expect(store.accounts.get(domestic.id)).toEqual(domestic);
      expect(repository.get(global.id)).toEqual(global);
    },
  );

  it("installs namespace triggers on v4 without changing either account or credential records", () => {
    const { store, repository, db } = fixture();
    const domestic = store.accounts.create({ platformId: "weixin_channels" });
    const global = repository.create({ platformId: "youtube" });
    credential(store, global.id);
    removeNamespaceMigration(store);
    const before = db.all("SELECT * FROM credentials");
    migrate(db);
    migrate(db);
    expect(db.all("SELECT version FROM schema_migrations WHERE version = 5")).toHaveLength(1);
    expect(
      db.all(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('accounts_global_id_insert','accounts_global_id_update','global_accounts_domestic_id_insert','global_accounts_domestic_id_update')",
      ),
    ).toHaveLength(4);
    expect(store.accounts.get(domestic.id)).toEqual(domestic);
    expect(repository.get(global.id)).toEqual(global);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
  });

  it("refuses a legacy collision migration without deleting data or installing partial guards", () => {
    const { store, db } = fixture();
    const domestic = store.accounts.create({ platformId: "bilibili" });
    removeNamespaceMigration(store);
    const previousTriggers = db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    db.run(
      "INSERT INTO global_accounts (id,platform_id,display_name,created_at,updated_at) VALUES (?,'youtube','fixture',?,?)",
      [domestic.id.toUpperCase(), domestic.createdAt, domestic.updatedAt],
    );
    credential(store, domestic.id);
    const before = [
      db.all("SELECT * FROM accounts"),
      db.all("SELECT * FROM global_accounts"),
      db.all("SELECT * FROM credentials"),
    ];
    expect(() => migrate(db)).toThrow();
    expect([
      db.all("SELECT * FROM accounts"),
      db.all("SELECT * FROM global_accounts"),
      db.all("SELECT * FROM credentials"),
    ]).toEqual(before);
    expect(db.all("SELECT version FROM schema_migrations WHERE version = 5")).toEqual([]);
    expect(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).toEqual(
      previousTriggers,
    );
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'account_namespace_migration_guard'")).toEqual(
      [],
    );
  });
});
