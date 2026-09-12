import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { buildBackup } from "@main/security/backup";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalTokenStore, type GlobalTokenEnvelope } from "./global-token-store";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.db.close()));
function fixture() {
  const store = createStore(":memory:");
  stores.push(store);
  const accounts = new GlobalAccountRepository(store.db);
  const account = accounts.create({ platformId: "youtube" });
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
  const tokens = new GlobalTokenStore(store.db, encryption);
  const token: GlobalTokenEnvelope = {
    version: 1,
    accountId: account.id,
    platformId: "youtube",
    remoteId: "synthetic-channel",
    tokenType: "Bearer",
    accessToken: "synthetic-access-value",
    refreshToken: "synthetic-refresh-value",
    scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return {
    store,
    accounts,
    account,
    tokens,
    token,
    encryption,
    vault: new CredentialVault(store.db, encryption),
    context: { accountId: account.id, platformId: account.platformId, assertCurrent: () => undefined },
  };
}
describe("atomic international authorization storage", () => {
  it("rotates a matching grant with a refresh audit and preserves its explicit refresh deadline", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const next = {
      ...f.token,
      accessToken: "new-access",
      refreshToken: "rotated-refresh",
      refreshExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    };
    f.tokens.commitRefresh(next, f.token, f.context);
    expect(f.tokens.read(f.account.id)).toEqual(next);
    const last = f.store.db.get<{ details_json: string }>(
      "SELECT details_json FROM audit_events ORDER BY id DESC LIMIT 1",
    )!;
    expect(JSON.parse(last.details_json)).toEqual({
      event: "refreshed",
      platformId: "youtube",
      scopeCount: 1,
    });
    expect(last.details_json).not.toContain(next.refreshToken);
  });

  it("does not let a delayed refresh overwrite a newer authorization", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const newer = { ...f.token, accessToken: "newer-grant" };
    f.tokens.commitAuthorization(newer, f.context);
    expect(() =>
      f.tokens.commitRefresh({ ...f.token, accessToken: "late-refresh" }, f.token, f.context),
    ).toThrow("GLOBAL_TOKEN_STALE");
    expect(f.tokens.read(f.account.id)).toEqual(newer);
    expect(f.store.db.all("SELECT * FROM audit_events")).toHaveLength(2);
  });

  it("keeps old v1 grants readable and refuses a refresh expiry without a refresh token", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    expect(f.tokens.read(f.account.id)).not.toHaveProperty("refreshExpiresAt");
    expect(() =>
      f.tokens.commitAuthorization(
        { ...f.token, refreshToken: undefined, refreshExpiresAt: f.token.expiresAt },
        f.context,
      ),
    ).toThrow("GLOBAL_TOKEN_INVALID");
    expect(f.tokens.read(f.account.id)).toEqual(f.token);
  });

  it("rolls back rotation when its distinct refresh audit is ignored", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    f.store.db.exec(
      "CREATE TRIGGER ignore_refresh_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(() =>
      f.tokens.commitRefresh({ ...f.token, accessToken: "ignored-rotation" }, f.token, f.context),
    ).toThrow("GLOBAL_TOKEN_SAVE_FAILED");
    expect(f.tokens.read(f.account.id)).toEqual(f.token);
  });

  const snapshot = (f: ReturnType<typeof fixture>) => ({
    accounts: f.store.db.all("SELECT * FROM global_accounts ORDER BY id"),
    credentials: f.store.db.all("SELECT * FROM credentials ORDER BY id"),
    audit: f.store.db.all("SELECT * FROM audit_events ORDER BY id"),
  });

  it("commits ciphertext, identity and safe audit together without exposing tokens to DTO or backup", () => {
    const f = fixture();
    const dto = f.tokens.commitAuthorization(f.token, f.context);
    expect(dto).toMatchObject({ authStatus: "authorized", remoteId: "synthetic-channel" });
    expect(f.tokens.read(dto.id)).toEqual(f.token);
    const row = f.store.db.get<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM credentials")!;
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(f.token.accessToken))).toBe(false);
    const exposed = JSON.stringify({
      dto,
      backup: buildBackup(f.store, "1.0.0"),
      audit: f.store.db.all("SELECT * FROM audit_events"),
    });
    expect(exposed).not.toContain(f.token.accessToken);
    expect(exposed).not.toContain(f.token.refreshToken);
    expect(f.store.db.get<{ n: number }>("SELECT count(*) AS n FROM accounts")?.n).toBe(0);
  });
  it("cannot mark authorized when system encryption is unavailable", () => {
    const f = fixture();
    const tokens = new GlobalTokenStore(f.store.db, { ...f.encryption, isEncryptionAvailable: () => false });
    expect(() => tokens.commitAuthorization(f.token, f.context)).toThrow("GLOBAL_TOKEN_SAVE_FAILED");
    expect(f.accounts.get(f.account.id)?.authStatus).toBe("unauthorized");
    expect(f.vault.has({ kind: "oauth_token", ownerId: f.account.id })).toBe(false);
  });
  it("rolls back token and identity if authority changes during encryption", () => {
    const f = fixture();
    let current = true;
    const tokens = new GlobalTokenStore(f.store.db, {
      ...f.encryption,
      encryptString: (text) => {
        current = false;
        return f.encryption.encryptString(text);
      },
    });
    expect(() =>
      tokens.commitAuthorization(f.token, {
        ...f.context,
        assertCurrent: () => {
          if (!current) throw new Error("revoked");
        },
      }),
    ).toThrow("GLOBAL_TOKEN_STALE");
    expect(f.accounts.get(f.account.id)?.authStatus).toBe("unauthorized");
    expect(f.vault.has({ kind: "oauth_token", ownerId: f.account.id })).toBe(false);
    expect(f.store.db.all("SELECT * FROM audit_events")).toEqual([]);
  });
  it("rolls back a token replacement when the identity update fails", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    f.store.db.exec(
      "CREATE TRIGGER reject_global_update BEFORE UPDATE ON global_accounts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    expect(() =>
      f.tokens.commitAuthorization({ ...f.token, accessToken: "new-synthetic-value" }, f.context),
    ).toThrow("GLOBAL_TOKEN_SAVE_FAILED");
    expect(f.tokens.read(f.account.id)).toEqual(f.token);
  });
  it("does not authorize when the first credential INSERT is silently ignored", () => {
    const f = fixture();
    const before = snapshot(f);
    f.store.db.exec(
      "CREATE TRIGGER ignore_token_insert BEFORE INSERT ON credentials WHEN NEW.kind = 'oauth_token' BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(() => f.tokens.commitAuthorization(f.token, f.context)).toThrow("GLOBAL_TOKEN_SAVE_FAILED");
    expect(snapshot(f)).toEqual(before);
    expect(f.tokens.read(f.account.id)).toBeNull();
  });
  it.each(["INSERT", "UPDATE"])(
    "does not report replacement success after credential %s is silently ignored",
    (event) => {
      const f = fixture();
      f.tokens.commitAuthorization(f.token, f.context);
      const before = snapshot(f);
      f.store.db.exec(
        `CREATE TRIGGER ignore_token_write BEFORE ${event} ON credentials WHEN NEW.kind = 'oauth_token' BEGIN SELECT RAISE(IGNORE); END`,
      );
      expect(() =>
        f.tokens.commitAuthorization(
          { ...f.token, accessToken: "replacement-that-must-not-be-pretended" },
          f.context,
        ),
      ).toThrow("GLOBAL_TOKEN_SAVE_FAILED");
      expect(snapshot(f)).toEqual(before);
      expect(f.tokens.read(f.account.id)).toEqual(f.token);
    },
  );
  it("rejects ignored account UPDATE even when the old identity and status already match", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const before = snapshot(f);
    f.store.db.exec(
      "CREATE TRIGGER ignore_authorize BEFORE UPDATE ON global_accounts BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(() => f.tokens.commitAuthorization({ ...f.token, accessToken: "new-token" }, f.context)).toThrow(
      "GLOBAL_TOKEN_SAVE_FAILED",
    );
    expect(snapshot(f)).toEqual(before);
    expect(f.tokens.read(f.account.id)).toEqual(f.token);
  });
  it.each(["ABORT", "IGNORE"])(
    "rolls back ciphertext and account when authorization audit raises %s",
    (action) => {
      const f = fixture();
      f.tokens.commitAuthorization(f.token, f.context);
      const before = snapshot(f);
      f.store.db.exec(
        `CREATE TRIGGER reject_authorized_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(${action === "ABORT" ? "ABORT, 'private audit details'" : "IGNORE"}); END`,
      );
      expect(() => f.tokens.commitAuthorization({ ...f.token, accessToken: "new-token" }, f.context)).toThrow(
        "GLOBAL_TOKEN_SAVE_FAILED",
      );
      expect(snapshot(f)).toEqual(before);
    },
  );
  it("checks final credential presence after subsequent audit triggers", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const before = snapshot(f);
    f.store.db.exec(
      "CREATE TRIGGER remove_grant_after_audit AFTER INSERT ON audit_events BEGIN DELETE FROM credentials WHERE kind = 'oauth_token' AND owner_id = NEW.account_id; END",
    );
    expect(() => f.tokens.commitAuthorization({ ...f.token, accessToken: "new-token" }, f.context)).toThrow(
      "GLOBAL_TOKEN_SAVE_FAILED",
    );
    expect(snapshot(f)).toEqual(before);
  });
  it("rolls back unexpected account metadata changes instead of returning a corrupted authorization DTO", () => {
    const f = fixture();
    const before = snapshot(f);
    f.store.db.exec(
      "CREATE TRIGGER rename_during_authorization AFTER UPDATE ON global_accounts BEGIN UPDATE global_accounts SET display_name = 'unexpected name' WHERE id = NEW.id; END",
    );
    expect(() => f.tokens.commitAuthorization(f.token, f.context)).toThrow("GLOBAL_TOKEN_SAVE_FAILED");
    expect(snapshot(f)).toEqual(before);
  });
  it("rejects cross-platform grants and replay into a deleted account", () => {
    const f = fixture();
    expect(() => f.tokens.commitAuthorization({ ...f.token, platformId: "x" }, f.context)).toThrow(
      "GLOBAL_TOKEN_ACCOUNT_MISMATCH",
    );
    f.accounts.delete(f.account.id);
    expect(() => f.tokens.commitAuthorization(f.token, f.context)).toThrow("GLOBAL_TOKEN_ACCOUNT_MISMATCH");
    expect(f.store.db.all("SELECT * FROM credentials")).toEqual([]);
  });
  it("binds an authorization transaction to its account even when another account uses the same platform", () => {
    const f = fixture();
    const other = f.accounts.create({ platformId: "youtube" });
    expect(() => f.tokens.commitAuthorization({ ...f.token, accountId: other.id }, f.context)).toThrow(
      "GLOBAL_TOKEN_ACCOUNT_MISMATCH",
    );
    expect(f.accounts.get(other.id)?.authStatus).toBe("unauthorized");
    expect(f.store.db.all("SELECT * FROM credentials")).toEqual([]);
  });
  it("does not silently replace an account's established remote identity during reauthorization", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    expect(() =>
      f.tokens.commitAuthorization({ ...f.token, remoteId: "different-channel" }, f.context),
    ).toThrow("GLOBAL_TOKEN_ACCOUNT_MISMATCH");
    expect(f.tokens.read(f.account.id)).toEqual(f.token);
  });
  it("preserves unreadable ciphertext after a portable move and never returns it as a token", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const before = f.store.db.get<{ ciphertext: Uint8Array }>(
      "SELECT ciphertext FROM credentials",
    )!.ciphertext;
    const moved = new GlobalTokenStore(f.store.db, {
      ...f.encryption,
      decryptString: () => {
        throw new Error("provider secret diagnostic");
      },
    });
    expect(() => moved.read(f.account.id)).toThrow("GLOBAL_TOKEN_READ_FAILED");
    expect(
      f.store.db.get<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM credentials")!.ciphertext,
    ).toEqual(before);
    expect(f.accounts.get(f.account.id)?.authStatus).toBe("authorized");
  });
  it("rejects a swapped encrypted owner envelope and blocks reauthorization-required reads", () => {
    const f = fixture();
    f.tokens.commitAuthorization(f.token, f.context);
    const other = f.accounts.create({ platformId: "youtube" });
    f.accounts.markAuthorized(other.id, { remoteId: f.token.remoteId });
    f.vault.set({ kind: "oauth_token", ownerId: other.id, secret: JSON.stringify(f.token) });
    expect(() => f.tokens.read(other.id)).toThrow("GLOBAL_TOKEN_ACCOUNT_MISMATCH");
    f.accounts.requireReauthorization(f.account.id);
    expect(f.tokens.read(f.account.id)).toBeNull();
  });
  it.each([
    { accessToken: "token\r\ninjection" },
    { scopes: ["scope", "scope"] },
    { expiresAt: "2020-01-01T00:00:00.000Z" },
    { idToken: "unexpected" },
  ])("rejects invalid envelopes before encryption %j", (patch) => {
    const f = fixture();
    expect(() => f.tokens.commitAuthorization({ ...f.token, ...patch }, f.context)).toThrow(
      "GLOBAL_TOKEN_INVALID",
    );
    expect(f.store.db.all("SELECT * FROM credentials")).toEqual([]);
  });
});
