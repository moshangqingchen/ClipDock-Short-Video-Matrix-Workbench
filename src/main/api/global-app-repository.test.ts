import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { migrate } from "@main/db/database";
import { buildBackup, applyBackup } from "@main/security/backup";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAppRepository } from "./global-app-repository";
import type { GlobalAppConfigInput } from "@shared/global-apps";

const stores: Store[] = [];
function fixture() {
  const store = createStore(":memory:");
  stores.push(store);
  return {
    store,
    db: store.db,
    apps: new GlobalAppRepository(store.db),
    accounts: new GlobalAccountRepository(store.db),
  };
}
function credential(store: Store, ownerId: string, kind = "oauth_token") {
  const id = randomUUID();
  store.db.run(
    "INSERT INTO credentials (id,kind,owner_id,ciphertext,encryption_version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)",
    [id, kind, ownerId, Buffer.from("synthetic-private-value"), "2026-01-01", "2026-01-01"],
  );
  return id;
}
const youtube = {
  platformId: "youtube",
  clientId: "first.apps.googleusercontent.com",
  redirectPort: 0,
} as const;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

describe("GlobalAppRepository", () => {
  it("migrates public app columns once without changing prior accounts or encrypted credentials", () => {
    const { store, db, accounts, apps } = fixture();
    const cn = store.accounts.create({ platformId: "bilibili" });
    const global = accounts.create({ platformId: "x" });
    credential(store, global.id);
    const before = db.all("SELECT * FROM credentials");
    db.exec("DROP TABLE global_apps; DELETE FROM schema_migrations WHERE version = 6;");
    migrate(db);
    migrate(db);
    expect(db.all("PRAGMA table_info(global_apps)").map((row) => row.name)).toEqual([
      "id",
      "platform_id",
      "client_id",
      "redirect_port",
      "created_at",
      "updated_at",
    ]);
    expect(db.all("SELECT version FROM schema_migrations WHERE version = 6")).toHaveLength(1);
    expect(apps.list()).toEqual([]);
    expect(store.accounts.get(cn.id)).toEqual(cn);
    expect(accounts.get(global.id)).toEqual(global);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
  });

  it("keeps one stable app UUID per platform and unchanged normalized inputs do not revoke tokens", () => {
    const { apps, accounts, store, db } = fixture();
    expect(apps.get("youtube")).toBeNull();
    const app = apps.put(youtube);
    const account = accounts.create({ platformId: "youtube" });
    credential(store, account.id);
    const authorized = accounts.markAuthorized(account.id, { remoteId: "channel" });
    const before = db.all("SELECT * FROM credentials");
    const again = apps.put({ ...youtube, clientId: ` ${youtube.clientId} ` });
    expect(again).toEqual(app);
    expect(apps.list()).toEqual([app]);
    expect(accounts.get(account.id)).toEqual(authorized);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
    expect(Object.keys(app).sort()).toEqual(
      ["id", "platformId", "clientId", "redirectPort", "createdAt", "updatedAt"].sort(),
    );
    expect(() => apps.put({ ...youtube, clientSecret: "private" } as GlobalAppConfigInput)).toThrow(
      "GLOBAL_APP_INPUT_INVALID",
    );
  });

  it.each([{ clientId: "replacement.apps.googleusercontent.com" }, { redirectPort: 3455 }])(
    "revokes only the platform's tokens and existing authorization on a public change %j",
    (change) => {
      const { store, apps, accounts, db } = fixture();
      const app = apps.put(youtube);
      const authorized = accounts.create({ platformId: "youtube" });
      const unauthed = accounts.create({ platformId: "youtube" });
      const other = accounts.create({ platformId: "x" });
      accounts.markAuthorized(authorized.id, { remoteId: "channel" });
      const otherBefore = accounts.markAuthorized(other.id, { remoteId: "x-user" });
      credential(store, authorized.id);
      credential(store, unauthed.id);
      const survivors = [credential(store, other.id), credential(store, app.id, "clash_secret")];
      const next = apps.put({ ...youtube, ...change });
      expect(next.id).toBe(app.id);
      expect(next.createdAt).toBe(app.createdAt);
      expect(accounts.get(authorized.id)).toMatchObject({
        authStatus: "reauthorization_required",
        remoteId: "channel",
      });
      expect(accounts.get(unauthed.id)).toEqual(unauthed);
      expect(accounts.get(other.id)).toEqual(otherBefore);
      expect(
        db
          .all("SELECT id FROM credentials")
          .map((row) => row.id)
          .sort(),
      ).toEqual(survivors.sort());
    },
  );

  it("first configuration invalidates preexisting platform tokens whose application binding is unknown", () => {
    const { store, apps, accounts, db } = fixture();
    const account = accounts.create({ platformId: "youtube" });
    accounts.markAuthorized(account.id, { remoteId: "legacy-channel" });
    credential(store, account.id);
    apps.put(youtube);
    expect(db.all("SELECT * FROM credentials")).toEqual([]);
    expect(accounts.get(account.id)?.authStatus).toBe("reauthorization_required");
  });

  it("rolls public configuration and credentials back if authorization invalidation fails", () => {
    const { apps, accounts, store, db } = fixture();
    const app = apps.put(youtube);
    const account = accounts.create({ platformId: "youtube" });
    const authorized = accounts.markAuthorized(account.id, { remoteId: "channel" });
    credential(store, account.id);
    const before = db.all("SELECT * FROM credentials");
    db.exec(
      "CREATE TRIGGER stop_auth_change BEFORE UPDATE ON global_accounts BEGIN SELECT RAISE(ABORT, 'private-trigger-detail'); END;",
    );
    expect(() => apps.put({ ...youtube, clientId: "replacement" })).toThrow(/^GLOBAL_APP_SAVE_FAILED$/);
    expect(apps.get("youtube")).toEqual(app);
    expect(accounts.get(account.id)).toEqual(authorized);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
  });

  it("composes with an outer secret transaction that can roll all public and token changes back", () => {
    const { apps, accounts, store, db } = fixture();
    const app = apps.put(youtube);
    const account = accounts.create({ platformId: "youtube" });
    const authorized = accounts.markAuthorized(account.id, { remoteId: "channel" });
    credential(store, account.id);
    const before = db.all("SELECT * FROM credentials");
    expect(() =>
      db.transaction(() => {
        apps.put({ ...youtube, redirectPort: 3455 });
        throw new Error("synthetic vault unavailable");
      }),
    ).toThrow("synthetic vault unavailable");
    expect(apps.get("youtube")).toEqual(app);
    expect(accounts.get(account.id)).toEqual(authorized);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
  });

  it("lets a main secret change revoke platform grants without modifying public settings", () => {
    const { apps, accounts, store, db } = fixture();
    const app = apps.put(youtube);
    const account = accounts.create({ platformId: "youtube" });
    accounts.markAuthorized(account.id, { remoteId: "channel" });
    credential(store, account.id);
    apps.invalidatePlatformAuthorization("youtube");
    expect(apps.get("youtube")).toEqual(app);
    expect(accounts.get(account.id)?.authStatus).toBe("reauthorization_required");
    expect(db.all("SELECT * FROM credentials")).toEqual([]);
  });

  it.each(["credentials", "global_accounts"] as const)(
    "rolls back a configuration change when %s silently ignores its required invalidation",
    (table) => {
      const { apps, accounts, store, db } = fixture();
      const app = apps.put(youtube);
      const account = accounts.create({ platformId: "youtube" });
      const authorized = accounts.markAuthorized(account.id, { remoteId: "channel" });
      credential(store, account.id);
      const before = db.all("SELECT * FROM credentials");
      const event = table === "credentials" ? "DELETE" : "UPDATE";
      db.exec(
        `CREATE TRIGGER ignore_app_invalidation BEFORE ${event} ON ${table} BEGIN SELECT RAISE(IGNORE); END;`,
      );
      expect(() => apps.put({ ...youtube, clientId: "replacement" })).toThrow(/^GLOBAL_APP_SAVE_FAILED$/);
      expect(apps.get("youtube")).toEqual(app);
      expect(accounts.get(account.id)).toEqual(authorized);
      expect(db.all("SELECT * FROM credentials")).toEqual(before);
    },
  );

  it("does not report a successful configuration when the database silently ignores the write", () => {
    const { apps, db } = fixture();
    db.exec("CREATE TRIGGER ignore_app_insert BEFORE INSERT ON global_apps BEGIN SELECT RAISE(IGNORE); END;");
    expect(() => apps.put(youtube)).toThrow(/^GLOBAL_APP_SAVE_FAILED$/);
    expect(apps.get("youtube")).toBeNull();
  });

  it("does not export app configuration or credentials, and domestic replace leaves them untouched", () => {
    const { apps, store, db } = fixture();
    store.accounts.create({ platformId: "douyin" });
    const app = apps.put(youtube);
    credential(store, app.id, "clash_secret");
    const before = db.all("SELECT * FROM credentials");
    const read = vi.spyOn(db, "all");
    const payload = buildBackup(store, "test");
    expect(read.mock.calls.every(([sql]) => !/global_apps|credentials/i.test(sql))).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(app.clientId);
    expect(JSON.stringify(payload)).not.toContain(app.id);
    applyBackup(store, payload, "replace");
    expect(apps.get("youtube")).toEqual(app);
    expect(db.all("SELECT * FROM credentials")).toEqual(before);
  });

  it("enforces one app per valid platform and port constraints in SQLite and hides corrupt fields", () => {
    const { apps, db } = fixture();
    const app = apps.put({ platformId: "x", clientId: "valid", redirectPort: 3456 });
    expect(() => db.run("UPDATE global_apps SET redirect_port = 0 WHERE id = ?", [app.id])).toThrow();
    expect(() => db.run("UPDATE global_apps SET platform_id = 'douyin' WHERE id = ?", [app.id])).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO global_apps SELECT ?,platform_id,client_id,redirect_port,created_at,updated_at FROM global_apps",
        [randomUUID()],
      ),
    ).toThrow();
    db.run("UPDATE global_apps SET created_at = 'private-corrupt-detail' WHERE id = ?", [app.id]);
    expect(() => apps.list()).toThrow(/^GLOBAL_APP_DATA_INVALID$/);
    vi.spyOn(db, "all").mockImplementation(() => {
      throw new Error("private-db-detail");
    });
    expect(() => apps.list()).toThrow(/^GLOBAL_APP_READ_FAILED$/);
  });
});
