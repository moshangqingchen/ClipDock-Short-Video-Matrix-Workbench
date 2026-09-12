import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import { openDatabase, migrate, type Database } from "@main/db/database";
import {
  CREDENTIAL_IPC,
  credentialRefSchema,
  credentialWriteSchema,
  type CredentialRef,
} from "@shared/credentials";
import { registerCredentialHandlers } from "@main/ipc/handlers/credentials";
import type { IpcRegistrar } from "@main/ipc/register";
import { CredentialVault, type CredentialEncryptionProvider } from "./credential-vault";

const electronStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn((_secret: string): Buffer => Buffer.from([1, 2, 3])),
  decryptString: vi.fn((_ciphertext: Buffer): string => "system-secret"),
}));

vi.mock("electron", () => ({ safeStorage: electronStorage }));

const databases: Database[] = [];
const clash: CredentialRef = { kind: "clash_secret", ownerId: "default" };

function database(): Database {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

/** Independent authenticated cipher stands in for machine-bound safeStorage in unit tests. */
function encryptionProvider(): CredentialEncryptionProvider {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((secret: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    }),
    decryptString: vi.fn((encrypted: Buffer) => {
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString("utf8");
    }),
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.clearAllMocks();
  electronStorage.isEncryptionAvailable.mockReturnValue(false);
});

describe("CredentialVault", () => {
  it("stores only ciphertext and returns public metadata while main can resolve the secret", () => {
    const db = database();
    const vault = new CredentialVault(db, encryptionProvider());
    const secret = "test-only-clash-secret-do-not-return";
    const metadata = vault.set({ ...clash, secret });
    const row = db.get<{ ciphertext: Uint8Array; encryption_version: number }>(
      "SELECT ciphertext, encryption_version FROM credentials",
    )!;

    expect(Buffer.from(row.ciphertext).includes(Buffer.from(secret))).toBe(false);
    expect(row.encryption_version).toBe(1);
    expect(metadata).toMatchObject({ ...clash, hasCredential: true, available: true, state: "available" });
    expect(JSON.stringify(metadata)).not.toContain(secret);
    expect(metadata).not.toHaveProperty("ciphertext");
    expect(metadata).not.toHaveProperty("secret");
    expect(vault.get(clash)).toBe(secret);
    expect(vault.has(clash)).toBe(true);
  });

  it("isolates kinds and owners, and replaces only the selected credential", () => {
    const db = database();
    const vault = new CredentialVault(db, encryptionProvider());
    const proxy: CredentialRef = { kind: "proxy_password", ownerId: "default" };
    const oauth: CredentialRef = { kind: "oauth_token", ownerId: randomUUID() };
    const otherClash: CredentialRef = { kind: "clash_secret", ownerId: randomUUID() };
    vault.set({ ...clash, secret: "first" });
    const firstRow = db.get("SELECT id, created_at FROM credentials WHERE kind = ? AND owner_id = ?", [
      clash.kind,
      clash.ownerId,
    ]);
    vault.set({ ...proxy, secret: "proxy-password" });
    vault.set({ ...oauth, secret: '{"access_token":"main-only"}' });
    vault.set({ ...otherClash, secret: "other-owner" });
    vault.set({ ...clash, secret: "updated" });

    expect(vault.get(clash)).toBe("updated");
    expect(vault.get(proxy)).toBe("proxy-password");
    expect(vault.get(oauth)).toBe('{"access_token":"main-only"}');
    expect(vault.get(otherClash)).toBe("other-owner");
    expect(db.all("SELECT id FROM credentials")).toHaveLength(4);
    expect(
      db.get("SELECT id, created_at FROM credentials WHERE kind = ? AND owner_id = ?", [
        clash.kind,
        clash.ownerId,
      ]),
    ).toEqual(firstRow);
  });

  it("refuses saving when encryption is unavailable and preserves previous ciphertext", () => {
    const db = database();
    const provider = encryptionProvider();
    const vault = new CredentialVault(db, provider);
    vault.set({ ...clash, secret: "saved-before-portable-move" });
    const before = db.get("SELECT * FROM credentials");
    vi.mocked(provider.isEncryptionAvailable).mockReturnValue(false);

    expect(() => vault.set({ ...clash, secret: "must-not-be-persisted" })).toThrow(
      "CREDENTIAL_ENCRYPTION_UNAVAILABLE",
    );
    expect(db.get("SELECT * FROM credentials")).toEqual(before);
    expect(vault.meta(clash)).toMatchObject({
      hasCredential: true,
      available: false,
      encryptionAvailable: false,
      state: "encryption_unavailable",
    });
    expect(vault.has(clash)).toBe(true);
    expect(() => vault.get(clash)).toThrow("CREDENTIAL_ENCRYPTION_UNAVAILABLE");
  });

  it("does not persist a new credential or raw error when encryption fails", () => {
    const db = database();
    const provider = encryptionProvider();
    const vault = new CredentialVault(db, provider);
    vault.set({ ...clash, secret: "original" });
    const before = db.get("SELECT * FROM credentials");
    vi.mocked(provider.encryptString).mockImplementation(() => {
      throw new Error("provider leaked secret replacement-value");
    });

    expect(() => vault.set({ ...clash, secret: "replacement-value" })).toThrow(
      /^CREDENTIAL_ENCRYPTION_FAILED$/,
    );
    expect(db.get("SELECT * FROM credentials")).toEqual(before);
  });

  it("reports unreadable portable credentials without deleting or silently replacing them", () => {
    const db = database();
    new CredentialVault(db, encryptionProvider()).set({ ...clash, secret: "machine-a-secret" });
    const before = db.get("SELECT * FROM credentials");
    const onOtherMachine = new CredentialVault(db, encryptionProvider());

    expect(onOtherMachine.meta(clash)).toMatchObject({
      hasCredential: true,
      available: false,
      encryptionAvailable: true,
      state: "decryption_failed",
    });
    expect(() => onOtherMachine.get(clash)).toThrow(/^CREDENTIAL_DECRYPTION_FAILED$/);
    expect(db.get("SELECT * FROM credentials")).toEqual(before);
    expect(onOtherMachine.set({ ...clash, secret: "explicitly-reentered" }).available).toBe(true);
    expect(onOtherMachine.get(clash)).toBe("explicitly-reentered");
  });

  it("rejects unsupported encryption versions without attempting to decrypt or changing data", () => {
    const db = database();
    const provider = encryptionProvider();
    const vault = new CredentialVault(db, provider);
    vault.set({ ...clash, secret: "original" });
    db.run("UPDATE credentials SET encryption_version = 999");
    const before = db.get("SELECT * FROM credentials");
    vi.mocked(provider.decryptString).mockClear();

    expect(vault.meta(clash)).toMatchObject({ state: "unsupported_version", available: false });
    expect(() => vault.get(clash)).toThrow("CREDENTIAL_VERSION_UNSUPPORTED");
    expect(provider.decryptString).not.toHaveBeenCalled();
    expect(db.get("SELECT * FROM credentials")).toEqual(before);
  });

  it("can explicitly delete unreadable credentials without encryption being available", () => {
    const db = database();
    const provider = encryptionProvider();
    const vault = new CredentialVault(db, provider);
    vault.set({ ...clash, secret: "delete-me" });
    vi.mocked(provider.isEncryptionAvailable).mockReturnValue(false);

    expect(vault.delete(clash)).toMatchObject({ state: "missing", hasCredential: false, available: false });
    expect(vault.has(clash)).toBe(false);
    expect(vault.get(clash)).toBeNull();
  });

  it("validates references and writes in main, rejecting unknown fields and empty values", () => {
    const db = database();
    const vault = new CredentialVault(db, encryptionProvider());

    expect(() => vault.set({ ...clash, secret: "" })).toThrow("CREDENTIAL_INPUT_INVALID");
    expect(() => vault.set({ ...clash, ownerId: "https://user:secret@controller", secret: "value" })).toThrow(
      "CREDENTIAL_INPUT_INVALID",
    );
    expect(() => vault.meta({ ...clash, secret: "unexpected" } as CredentialRef)).toThrow(
      "CREDENTIAL_INPUT_INVALID",
    );
    expect(db.all("SELECT * FROM credentials")).toHaveLength(0);
  });

  it("uses Electron safeStorage by default and fails closed on its availability check", () => {
    const db = database();
    const vault = new CredentialVault(db);
    expect(() => vault.set({ ...clash, secret: "system-secret" })).toThrow(
      "CREDENTIAL_ENCRYPTION_UNAVAILABLE",
    );
    expect(electronStorage.encryptString).not.toHaveBeenCalled();
    electronStorage.isEncryptionAvailable.mockReturnValue(true);
    expect(vault.set({ ...clash, secret: "system-secret" }).available).toBe(true);
    expect(electronStorage.encryptString).toHaveBeenCalledWith("system-secret");
    expect(electronStorage.decryptString).toHaveBeenCalled();
  });

  it("adds migration 2 without replacing existing account data and rejects plaintext SQL storage", () => {
    const db = database();
    db.exec("DROP TABLE credentials; DELETE FROM schema_migrations WHERE version = 2;");
    db.run(
      "INSERT INTO accounts (id, platform_id, display_name, partition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["existing-account", "douyin", "existing", "persist:existing", "2026-01-01", "2026-01-01"],
    );
    migrate(db);
    migrate(db);

    expect(db.get("SELECT name FROM schema_migrations WHERE version = 2")?.name).toBe("credential-vault");
    expect(db.get("SELECT display_name FROM accounts WHERE id = ?", ["existing-account"])?.display_name).toBe(
      "existing",
    );
    expect(() =>
      db.run(
        "INSERT INTO credentials (id, kind, owner_id, ciphertext, encryption_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [randomUUID(), "clash_secret", "default", "plaintext-is-not-a-blob", 1, "now", "now"],
      ),
    ).toThrow();
  });
});

describe("credential IPC boundary", () => {
  it("exposes metadata, network-secret writes and delete only; OAuth writes stay in main", () => {
    const vault = new CredentialVault(database(), encryptionProvider());
    const rawGet = vi.spyOn(vault, "get");
    const handlers = new Map<string, { schema: z.ZodType; invoke: (event: never, input: any) => unknown }>();
    const ipc: IpcRegistrar = {
      handle: vi.fn(),
      handleValidated: (channel, schema, invoke) => {
        handlers.set(channel, { schema, invoke });
      },
      send: vi.fn(),
      dispose: vi.fn(),
    };
    registerCredentialHandlers(ipc, vault);
    const invoke = (channel: string, input: unknown) => {
      const handler = handlers.get(channel)!;
      return handler.invoke({} as never, handler.schema.parse(input));
    };

    expect([...handlers.keys()].sort()).toEqual(Object.values(CREDENTIAL_IPC).sort());
    expect(handlers.has("credentials:get")).toBe(false);
    expect(invoke(CREDENTIAL_IPC.credentialSet, { ...clash, secret: "do-not-return-me" })).toMatchObject({
      hasCredential: true,
      available: true,
    });
    expect(JSON.stringify(invoke(CREDENTIAL_IPC.credentialMeta, clash))).not.toContain("do-not-return-me");
    expect(() =>
      invoke(CREDENTIAL_IPC.credentialSet, { kind: "oauth_token", ownerId: randomUUID(), secret: "token" }),
    ).toThrow();
    for (const kind of ["oauth_token", "oauth_client_secret"] as const) {
      const ownerId = randomUUID();
      expect(() => invoke(CREDENTIAL_IPC.credentialSet, { kind, ownerId, secret: "synthetic" })).toThrow();
      expect(() => invoke(CREDENTIAL_IPC.credentialDelete, { kind, ownerId })).toThrow();
      expect(invoke(CREDENTIAL_IPC.credentialMeta, { kind, ownerId })).toMatchObject({ state: "missing" });
    }
    expect(invoke(CREDENTIAL_IPC.credentialDelete, clash)).toMatchObject({ hasCredential: false });
    expect(rawGet).not.toHaveBeenCalled();
    expect(credentialWriteSchema.safeParse({ ...clash, secret: "ok", proxyUrl: "extra" }).success).toBe(
      false,
    );
    expect(credentialRefSchema.safeParse({ ...clash, secret: "unexpected" }).success).toBe(false);
  });
});
