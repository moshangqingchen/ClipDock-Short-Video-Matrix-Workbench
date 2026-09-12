import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { migrate } from "@main/db/database";
import { MIGRATIONS } from "@main/db/migrations";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { buildBackup } from "@main/security/backup";
import type { GlobalPlatformId } from "@shared/platforms";
import type { GlobalAppConfigureInput } from "@shared/global-apps";
import { GlobalAppRepository } from "./global-app-repository";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAppService } from "./global-app-service";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = createStore(":memory:");
  stores.push(store);
  const key = randomBytes(32);
  const encryption: CredentialEncryptionProvider = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((text) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    }),
    decryptString: vi.fn((bytes) => {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    }),
  };
  const accounts = new GlobalAccountRepository(store.db),
    vault = new CredentialVault(store.db, encryption);
  return {
    store,
    encryption,
    accounts,
    vault,
    apps: new GlobalAppRepository(store.db),
    service: new GlobalAppService(store.db, encryption),
    authorized(platformId: GlobalPlatformId) {
      const account = accounts.create({ platformId });
      accounts.markAuthorized(account.id, { remoteId: `synthetic-${platformId}` });
      vault.set({ kind: "oauth_token", ownerId: account.id, secret: `synthetic-token-${account.id}` });
      return account;
    },
    rows: () => ({
      apps: store.db.all("SELECT * FROM global_apps ORDER BY id"),
      credentials: store.db.all("SELECT * FROM credentials ORDER BY id"),
      accounts: store.db.all("SELECT * FROM global_accounts ORDER BY id"),
    }),
  };
}
const youtube = { platformId: "youtube", clientId: "synthetic.google.client", redirectPort: 0 } as const;
const tiktok = { platformId: "tiktok", clientId: "synthetic-tiktok", redirectPort: 3455 } as const;
const x = { platformId: "x", clientId: "synthetic-x", redirectPort: 3456 } as const;

describe("local global application service", () => {
  it("returns three unconfigured metadata cards without creating any account or secret", () => {
    const f = fixture();
    const cards = f.service.list();
    expect(cards.map((card) => card.platformId).sort()).toEqual(["tiktok", "x", "youtube"]);
    expect(cards.every((card) => !card.configured && card.id === null && card.clientSecret === null)).toBe(
      true,
    );
    expect(f.rows()).toEqual({ apps: [], accounts: [], credentials: [] });
    expect(f.store.db.all("SELECT * FROM accounts")).toEqual([]);
  });

  it("YouTube's optional secret and X's public native configuration work without encrypted storage", () => {
    const f = fixture(),
      service = new GlobalAppService(f.store.db);
    expect(service.configure(youtube)).toMatchObject({
      configured: true,
      clientSecret: { state: "missing" },
    });
    expect(service.configure(x)).toMatchObject({ configured: true, clientSecret: null });
    expect(f.store.db.all("SELECT * FROM credentials")).toEqual([]);
  });

  it("requires a complete TikTok secret and rolls back first-time public configuration and token invalidation", () => {
    const f = fixture();
    f.authorized("tiktok");
    const before = f.rows();
    expect(() => f.service.configure(tiktok)).toThrow("GLOBAL_APP_SECRET_REQUIRED");
    expect(f.rows()).toEqual(before);
  });

  it("persists secret ciphertext by app UUID and exposes only metadata, including in backup", () => {
    const f = fixture(),
      secret = "synthetic-client-secret-only-in-vault";
    const dto = f.service.configure({ ...tiktok, clientSecret: secret });
    expect(dto).toMatchObject({
      configured: true,
      clientSecret: { kind: "oauth_client_secret", ownerId: dto.id, available: true, state: "available" },
    });
    expect(dto.id).toMatch(/^[0-9a-f-]{36}$/);
    const row = f.store.db.get<{ owner_id: string; ciphertext: Uint8Array }>(
      "SELECT owner_id,ciphertext FROM credentials",
    )!;
    expect(row.owner_id).toBe(dto.id);
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(secret))).toBe(false);
    expect(f.vault.get({ kind: "oauth_client_secret", ownerId: dto.id! })).toBe(secret);
    expect(
      JSON.stringify({
        dto,
        list: f.service.list(),
        backup: buildBackup(f.store, "test"),
        audit: f.store.db.all("SELECT * FROM audit_events"),
      }),
    ).not.toContain(secret);
    expect(f.store.db.all("SELECT * FROM global_accounts")).toEqual([]);
    expect(f.apps.get("tiktok")).not.toHaveProperty("clientSecret");
  });

  it("same-client omission preserves ciphertext; changing only port revokes platform tokens", () => {
    const f = fixture(),
      configured = f.service.configure({ ...tiktok, clientSecret: "synthetic-old" });
    const account = f.authorized("tiktok"),
      other = f.authorized("youtube");
    const cipher = f.store.db.get("SELECT * FROM credentials WHERE kind='oauth_client_secret'");
    const result = f.service.configure({ ...tiktok, redirectPort: 4001 });
    expect(result.id).toBe(configured.id);
    expect(f.store.db.get("SELECT * FROM credentials WHERE kind='oauth_client_secret'")).toEqual(cipher);
    expect(f.vault.get({ kind: "oauth_token", ownerId: account.id })).toBeNull();
    expect(f.accounts.get(account.id)?.authStatus).toBe("reauthorization_required");
    expect(f.accounts.get(account.id)?.remoteId).toBe("synthetic-tiktok");
    expect(f.vault.has({ kind: "oauth_token", ownerId: other.id })).toBe(true);
    expect(f.accounts.get(other.id)?.authStatus).toBe("authorized");
  });

  it("unchanged public settings with an omitted secret are a no-op, without revoking authorization", () => {
    const f = fixture();
    f.service.configure({ ...tiktok, clientSecret: "synthetic" });
    f.authorized("tiktok");
    const before = f.rows();
    f.service.configure({ ...tiktok, clientId: " synthetic-tiktok " });
    expect(f.rows()).toEqual(before);
  });

  it("replacing only the secret invalidates all platform grants but not unrelated platforms or never-authorized status", () => {
    const f = fixture();
    f.service.configure({ ...youtube, clientSecret: "old-client-secret" });
    const first = f.authorized("youtube"),
      second = f.authorized("youtube"),
      unrelated = f.authorized("x");
    const never = f.accounts.create({ platformId: "youtube" });
    f.service.configure({ ...youtube, clientSecret: "new-client-secret" });
    for (const account of [first, second]) {
      expect(f.accounts.get(account.id)?.authStatus).toBe("reauthorization_required");
      expect(f.vault.has({ kind: "oauth_token", ownerId: account.id })).toBe(false);
    }
    expect(f.accounts.get(never.id)?.authStatus).toBe("unauthorized");
    expect(f.accounts.get(unrelated.id)?.authStatus).toBe("authorized");
    expect(f.vault.has({ kind: "oauth_token", ownerId: unrelated.id })).toBe(true);
  });

  it("changing client ID without a new optional secret removes the previous application's secret", () => {
    const f = fixture();
    const original = f.service.configure({ ...youtube, clientSecret: "old-secret" });
    f.authorized("youtube");
    const updated = f.service.configure({ ...youtube, clientId: "other.google.client" });
    expect(updated.id).toBe(original.id);
    expect(updated.clientSecret).toMatchObject({ state: "missing", hasCredential: false });
    expect(f.store.db.all("SELECT * FROM credentials")).toEqual([]);
  });

  it("changing TikTok client ID without a replacement secret cannot reuse the old credential and rolls back", () => {
    const f = fixture();
    f.service.configure({ ...tiktok, clientSecret: "old-secret" });
    f.authorized("tiktok");
    const before = f.rows();
    expect(() => f.service.configure({ ...tiktok, clientId: "other-tiktok-client" })).toThrow(
      "GLOBAL_APP_SECRET_REQUIRED",
    );
    expect(f.rows()).toEqual(before);
    expect(
      f.service.configure({ ...tiktok, clientId: "other-tiktok-client", clientSecret: "new-secret" }),
    ).toMatchObject({ clientId: "other-tiktok-client", clientSecret: { available: true } });
  });

  it.each(["unavailable", "encrypt-failed", "decrypt-failed"])(
    "%s while replacing a secret preserves public configuration, prior ciphertext and all grants",
    (mode) => {
      const f = fixture();
      f.service.configure({ ...tiktok, clientSecret: "old-secret" });
      f.authorized("tiktok");
      const before = f.rows();
      if (mode === "unavailable") vi.mocked(f.encryption.isEncryptionAvailable).mockReturnValue(false);
      if (mode === "encrypt-failed")
        vi.mocked(f.encryption.encryptString).mockImplementation(() => {
          throw new Error("provider-private-value");
        });
      if (mode === "decrypt-failed")
        vi.mocked(f.encryption.decryptString).mockImplementation(() => {
          throw new Error("provider-private-value");
        });
      const error = (() => {
        try {
          f.service.configure({ ...tiktok, clientId: "replacement", clientSecret: "new-secret" });
        } catch (value) {
          return value as Error;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain("provider-private-value");
      expect(f.rows()).toEqual(before);
      if (mode !== "encrypt-failed")
        expect(f.service.get("tiktok").clientSecret?.state).toBe(
          mode === "unavailable" ? "encryption_unavailable" : "decryption_failed",
        );
    },
  );

  it("an unreadable portable-migration secret remains stored and cannot satisfy TikTok completion", () => {
    const f = fixture();
    f.service.configure({ ...tiktok, clientSecret: "other-windows-user-secret" });
    vi.mocked(f.encryption.decryptString).mockImplementation(() => {
      throw new Error("cannot decrypt");
    });
    const before = f.rows();
    expect(f.service.get("tiktok").clientSecret).toMatchObject({
      state: "decryption_failed",
      hasCredential: true,
      available: false,
    });
    expect(() => f.service.configure({ ...tiktok, redirectPort: 4444 })).toThrow(
      "GLOBAL_APP_SECRET_UNAVAILABLE",
    );
    expect(f.rows()).toEqual(before);
  });

  it("explicit clear deletes an unreadable secret and platform tokens while preserving public settings", () => {
    const f = fixture();
    const original = f.service.configure({ ...tiktok, clientSecret: "old-secret" });
    const account = f.authorized("tiktok");
    vi.mocked(f.encryption.isEncryptionAvailable).mockReturnValue(false);
    const result = f.service.clearSecret("tiktok");
    expect(result).toMatchObject({
      id: original.id,
      configured: true,
      clientId: tiktok.clientId,
      clientSecret: { state: "missing", hasCredential: false },
    });
    expect(f.accounts.get(account.id)?.authStatus).toBe("reauthorization_required");
    expect(f.store.db.all("SELECT * FROM credentials")).toEqual([]);
  });

  it.each(["configure", "clear"])(
    "a later SQL failure during %s rolls back both secret and authorization changes",
    (action) => {
      const f = fixture();
      f.service.configure({ ...youtube, clientSecret: "old-secret" });
      f.authorized("youtube");
      const before = f.rows();
      f.store.db.exec(
        "CREATE TRIGGER synthetic_fail_auth BEFORE UPDATE ON global_accounts BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQL_VALUE'); END;",
      );
      const work = () =>
        action === "configure"
          ? f.service.configure({ ...youtube, clientSecret: "new-secret" })
          : f.service.clearSecret("youtube");
      expect(work).toThrow("GLOBAL_APP_SAVE_FAILED");
      expect(f.rows()).toEqual(before);
    },
  );

  it.each(["replace", "clear", "new-client"])(
    "silent SQLite %s credential rejection cannot report success or revoke tokens alone",
    (action) => {
      const f = fixture();
      f.service.configure({ ...youtube, clientSecret: "old-secret" });
      f.authorized("youtube");
      const before = f.rows();
      const operation = action === "replace" ? "UPDATE" : "DELETE";
      f.store.db.exec(
        `CREATE TRIGGER synthetic_ignore_secret BEFORE ${operation} ON credentials WHEN OLD.kind='oauth_client_secret' BEGIN SELECT RAISE(IGNORE); END;`,
      );
      const work = () =>
        action === "clear"
          ? f.service.clearSecret("youtube")
          : f.service.configure(
              action === "replace"
                ? { ...youtube, clientSecret: "new-secret" }
                : { ...youtube, clientId: "other-client" },
            );
      expect(work).toThrow();
      expect(f.rows()).toEqual(before);
    },
  );

  it("rejects X secret, empty secret, foreign platforms and privileged configuration fields without mutation", () => {
    const f = fixture();
    for (const input of [
      { ...x, clientSecret: "not-for-x" },
      { ...youtube, clientSecret: "" },
      { ...youtube, clientSecret: "  " },
      { ...youtube, platformId: "bilibili" },
      { ...youtube, authorizeUrl: "https://untrusted.test" },
      { ...youtube, scopes: ["write-anything"] },
      { ...youtube, clientSecret: null },
      { ...youtube, token: "do-not-accept" },
    ]) {
      expect(() => f.service.configure(input as GlobalAppConfigureInput)).toThrow("GLOBAL_APP_INPUT_INVALID");
    }
    expect(() => f.service.clearSecret("x")).toThrow("GLOBAL_APP_SECRET_UNSUPPORTED");
    expect(() => f.service.clearSecret("youtube")).toThrow("GLOBAL_APP_NOT_CONFIGURED");
    expect(f.rows()).toEqual({ apps: [], accounts: [], credentials: [] });
  });
});

describe("credential migration 7", () => {
  it("preserves preexisting encrypted rows exactly and widens only the supported credential kind constraint", () => {
    const f = fixture(),
      id = randomUUID();
    // Restore a pre-v7 fixture, including removing later schema that refers to credentials.
    f.store.db.exec(
      "DROP TABLE global_upload_jobs; DROP TABLE credentials; DELETE FROM schema_migrations WHERE version IN (7,10);",
    );
    f.store.db.exec(MIGRATIONS.find((migration) => migration.version === 2)!.sql);
    const blob = randomBytes(40);
    f.store.db.run("INSERT INTO credentials VALUES (?,?,?,?,?,?,?)", [
      id,
      "oauth_token",
      randomUUID(),
      blob,
      9,
      "original-created",
      "original-updated",
    ]);
    const before = f.store.db.all("SELECT * FROM credentials");
    migrate(f.store.db);
    migrate(f.store.db);
    expect(f.store.db.all("SELECT * FROM credentials")).toEqual(before);
    expect(f.store.db.get("SELECT name FROM schema_migrations WHERE version=7")?.name).toBe(
      "oauth-application-secret-vault",
    );
    expect(() =>
      f.vault.set({ kind: "oauth_client_secret", ownerId: randomUUID(), secret: "new-secret" }),
    ).not.toThrow();
    expect(() =>
      f.store.db.run("INSERT INTO credentials VALUES (?,?,?,?,?,?,?)", [
        randomUUID(),
        "invented_kind",
        "default",
        blob,
        1,
        "now",
        "now",
      ]),
    ).toThrow();
    expect(() =>
      f.store.db.run("INSERT INTO credentials VALUES (?,?,?,?,?,?,?)", [
        randomUUID(),
        "oauth_client_secret",
        randomUUID(),
        "plaintext",
        1,
        "now",
        "now",
      ]),
    ).toThrow();
  });
});
