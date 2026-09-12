import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAuthorizationStore } from "./global-authorization-store";
import { GlobalTokenStore, type GlobalTokenEnvelope } from "./global-token-store";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.db.close());
  vi.restoreAllMocks();
});

function fixture() {
  const store = createStore(":memory:");
  stores.push(store);
  const accounts = new GlobalAccountRepository(store.db);
  const account = accounts.create({ platformId: "youtube", displayName: "保留的频道记录" });
  const key = randomBytes(32);
  const encryption: CredentialEncryptionProvider = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: (bytes) => {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  const token: GlobalTokenEnvelope = {
    version: 1,
    accountId: account.id,
    platformId: account.platformId,
    remoteId: "synthetic-remote-channel",
    tokenType: "Bearer",
    accessToken: "synthetic-private-access",
    refreshToken: "synthetic-private-refresh",
    scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const tokens = new GlobalTokenStore(store.db, encryption);
  const authorization = new GlobalAuthorizationStore(store.db);
  const context = { accountId: account.id, platformId: account.platformId, assertCurrent: () => undefined };
  return {
    store,
    accounts,
    account,
    encryption,
    token,
    tokens,
    authorization,
    context,
    vault: new CredentialVault(store.db, encryption),
  };
}
function snapshot(f: ReturnType<typeof fixture>) {
  return {
    accounts: f.store.db.all("SELECT * FROM global_accounts ORDER BY id"),
    credentials: f.store.db.all("SELECT * FROM credentials ORDER BY id"),
    audit: f.store.db.all("SELECT * FROM audit_events ORDER BY id"),
  };
}

describe("local international authorization disconnect", () => {
  it("atomically removes the grant and remote identity while retaining the partition-free account", () => {
    const f = fixture();
    const authorized = f.tokens.commitAuthorization(f.token, f.context);
    const result = f.authorization.disconnect(f.account.id);
    expect(result).toMatchObject({
      ...f.account,
      updatedAt: expect.any(String),
      remoteId: null,
      authStatus: "unauthorized",
    });
    expect(result.id).toBe(authorized.id);
    expect(result).not.toHaveProperty("partition");
    expect(f.tokens.read(f.account.id)).toBeNull();
    expect(f.vault.has({ kind: "oauth_token", ownerId: f.account.id })).toBe(false);
    expect(f.store.db.get("SELECT COUNT(*) AS n FROM accounts")?.n).toBe(0);
    const audit = f.store.db.all("SELECT * FROM audit_events");
    const last = JSON.parse(String(audit.at(-1)?.details_json));
    expect(last).toEqual({ event: "local_disconnected", platformId: "youtube", remoteRevoked: false });
    expect(JSON.stringify({ result, audit })).not.toMatch(
      /synthetic-private-access|synthetic-private-refresh/,
    );
  });

  it("does not remove another account's token, app secret or proxy credential", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const other = f.accounts.create({ platformId: "youtube", displayName: "另一个频道" });
    const otherToken = { ...f.token, accountId: other.id, remoteId: "other-remote-channel" };
    f.tokens.commitAuthorization(otherToken, { ...f.context, accountId: other.id });
    f.vault.set({ kind: "oauth_client_secret", ownerId: randomUUID(), secret: "app-secret" });
    f.vault.set({ kind: "proxy_password", ownerId: "default", secret: "proxy-secret" });
    const before = f.store.db.all("SELECT * FROM credentials WHERE owner_id != ? ORDER BY id", [
      f.account.id,
    ]);
    f.authorization.disconnect(f.account.id);
    expect(
      f.store.db.all("SELECT * FROM credentials WHERE owner_id != ? ORDER BY id", [f.account.id]),
    ).toEqual(before);
    expect(f.tokens.read(other.id)).toEqual(otherToken);
    expect(f.accounts.get(other.id)?.authStatus).toBe("authorized");
  });

  it("is idempotent for an existing unconfigured account but still rejects a deleted account", () => {
    const f = fixture();
    expect(f.authorization.disconnect(f.account.id).authStatus).toBe("unauthorized");
    expect(f.authorization.disconnect(f.account.id).remoteId).toBeNull();
    f.accounts.delete(f.account.id);
    const before = snapshot(f);
    expect(() => f.authorization.disconnect(f.account.id)).toThrow("GLOBAL_AUTHORIZATION_ACCOUNT_NOT_FOUND");
    expect(snapshot(f)).toEqual(before);
  });

  it("clears reauthorization-required identity and intentionally discarded unreadable ciphertext without decrypting", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    f.accounts.requireReauthorization(f.account.id);
    f.store.db.run(
      "UPDATE credentials SET encryption_version = 999, ciphertext = ? WHERE kind = 'oauth_token' AND owner_id = ?",
      [Buffer.from("unreadable-blob"), f.account.id],
    );
    const decrypt = vi.spyOn(f.encryption, "decryptString");
    expect(f.authorization.disconnect(f.account.id)).toMatchObject({
      authStatus: "unauthorized",
      remoteId: null,
    });
    expect(decrypt).not.toHaveBeenCalled();
    expect(f.store.db.all("SELECT * FROM credentials")).toEqual([]);
  });

  it.each([
    "default",
    "youtube",
    "not-uuid",
    "11111111-1111-4111-8111-111111111111' OR 1=1 --",
    "",
    null,
    {},
  ])("rejects invalid owner input before touching SQLite %#", (input) => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const before = snapshot(f);
    expect(() => f.authorization.disconnect(input as string)).toThrow(
      "GLOBAL_AUTHORIZATION_INVALID_ACCOUNT_ID",
    );
    expect(snapshot(f)).toEqual(before);
  });

  it("does not use a nonexistent global UUID as an orphan credential deletion command", () => {
    const f = fixture();
    const orphan = randomUUID();
    f.vault.set({ kind: "oauth_token", ownerId: orphan, secret: "orphaned-token" });
    const before = snapshot(f);
    expect(() => f.authorization.disconnect(orphan)).toThrow("GLOBAL_AUTHORIZATION_ACCOUNT_NOT_FOUND");
    expect(snapshot(f)).toEqual(before);
  });

  it.each([
    {
      label: "DELETE exception",
      sql: "CREATE TRIGGER fail_disconnect BEFORE DELETE ON credentials WHEN OLD.kind = 'oauth_token' BEGIN SELECT RAISE(ABORT, 'secret failure details'); END",
    },
    {
      label: "DELETE silent ignore",
      sql: "CREATE TRIGGER fail_disconnect BEFORE DELETE ON credentials WHEN OLD.kind = 'oauth_token' BEGIN SELECT RAISE(IGNORE); END",
    },
    {
      label: "UPDATE exception",
      sql: "CREATE TRIGGER fail_disconnect BEFORE UPDATE ON global_accounts BEGIN SELECT RAISE(ABORT, 'private server detail'); END",
    },
    {
      label: "UPDATE silent ignore",
      sql: "CREATE TRIGGER fail_disconnect BEFORE UPDATE ON global_accounts BEGIN SELECT RAISE(IGNORE); END",
    },
    {
      label: "audit exception",
      sql: "CREATE TRIGGER fail_disconnect BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'private audit detail'); END",
    },
    {
      label: "audit silent ignore",
      sql: "CREATE TRIGGER fail_disconnect BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END",
    },
    {
      label: "unexpected account rename",
      sql: "CREATE TRIGGER fail_disconnect AFTER UPDATE ON global_accounts BEGIN UPDATE global_accounts SET display_name = 'unexpected name' WHERE id = NEW.id; END",
    },
  ])("rolls back actual SQL token/account/audit mutations on $label", ({ sql }) => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const before = snapshot(f);
    f.store.db.exec(sql);
    expect(() => f.authorization.disconnect(f.account.id)).toThrow("GLOBAL_AUTHORIZATION_DISCONNECT_FAILED");
    expect(snapshot(f)).toEqual(before);
    expect(f.tokens.read(f.account.id)).toEqual(f.token);
  });

  it("rejects silent UPDATE ignore even when the original account is already unauthorized", () => {
    const f = fixture();
    const before = snapshot(f);
    f.store.db.exec(
      "CREATE TRIGGER ignore_noop BEFORE UPDATE ON global_accounts BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(() => f.authorization.disconnect(f.account.id)).toThrow("GLOBAL_AUTHORIZATION_DISCONNECT_FAILED");
    expect(snapshot(f)).toEqual(before);
  });

  it("checks token absence after audit triggers, not only just after DELETE", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const before = snapshot(f);
    f.store.db.exec(`CREATE TRIGGER recreate_token AFTER INSERT ON audit_events
      WHEN NEW.details_json LIKE '%local_disconnected%' BEGIN
      INSERT INTO credentials (id,kind,owner_id,ciphertext,encryption_version,created_at,updated_at)
      VALUES ('replacement-token-row','oauth_token',NEW.account_id,X'01',1,NEW.created_at,NEW.created_at); END`);
    expect(() => f.authorization.disconnect(f.account.id)).toThrow("GLOBAL_AUTHORIZATION_DISCONNECT_FAILED");
    expect(snapshot(f)).toEqual(before);
  });

  it("participates in an outer synchronous transaction and restores all three tables on outer rollback", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const before = snapshot(f);
    expect(() =>
      f.store.db.transaction(() => {
        f.authorization.disconnect(f.account.id);
        expect(f.tokens.read(f.account.id)).toBeNull();
        throw new Error("outer rollback");
      }),
    ).toThrow("outer rollback");
    expect(snapshot(f)).toEqual(before);
    expect(f.tokens.read(f.account.id)).toEqual(f.token);
  });

  it("allows a later separately authorized identity only after the old local binding is removed", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    f.authorization.disconnect(f.account.id);
    const replacement = { ...f.token, remoteId: "new-consented-channel" };
    expect(f.tokens.commitAuthorization(replacement, f.context)).toMatchObject({
      id: f.account.id,
      remoteId: replacement.remoteId,
      authStatus: "authorized",
    });
  });
});
