import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import { CREDENTIAL_IPC } from "@shared/credentials";
import { openDatabase, type Database } from "@main/db/database";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { GlobalAppService } from "@main/api/global-app-service";
import type { IpcRegistrar } from "../register";
import { registerCredentialHandlers } from "./credentials";
import { registerGlobalAppHandlers } from "./global-apps";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const databases: Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = openDatabase(":memory:");
  databases.push(db);
  // Simulated OS encrypted storage; real authenticated cipher/rollback is exercised by service tests.
  const ciphertexts = new Map<string, string>();
  const encryption: CredentialEncryptionProvider = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      const bytes = randomBytes(32);
      ciphertexts.set(bytes.toString("hex"), text);
      return bytes;
    },
    decryptString: (bytes) => {
      const value = ciphertexts.get(bytes.toString("hex"));
      if (!value) throw new Error();
      return value;
    },
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    handleValidated: (
      channel: string,
      schema: { parse(input: unknown): unknown },
      handler: (...args: unknown[]) => unknown,
    ) => handlers.set(channel, (_event, input) => handler(null, schema.parse(input))),
  } as unknown as IpcRegistrar;
  const service = new GlobalAppService(db, encryption);
  registerGlobalAppHandlers(ipc, service);
  return {
    db,
    handlers,
    ipc,
    service,
    vault: new CredentialVault(db, encryption),
    run: (channel: string, input?: unknown) => handlers.get(channel)!(null, input),
  };
}

describe("write-only global application IPC", () => {
  it("revokes platform flows before changing configuration or clearing its secret", () => {
    const f = fixture(),
      calls: string[] = [];
    const configure = vi.spyOn(f.service, "configure");
    const clear = vi.spyOn(f.service, "clearSecret");
    registerGlobalAppHandlers(f.ipc, f.service, (platform) => {
      expect(configure).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      calls.push(platform);
    });
    f.run(IPC.globalAppsConfigure, { platformId: "youtube", clientId: "local-client", redirectPort: 0 });
    configure.mockClear();
    f.run(IPC.globalAppsClearSecret, "youtube");
    expect(calls).toEqual(["youtube", "youtube"]);
  });

  it("does not mutate app configuration if synchronous revocation fails", () => {
    const f = fixture();
    registerGlobalAppHandlers(f.ipc, f.service, () => {
      throw new Error("revocation unavailable");
    });
    expect(() =>
      f.run(IPC.globalAppsConfigure, { platformId: "youtube", clientId: "local-client", redirectPort: 0 }),
    ).toThrow();
    expect(f.db.all("SELECT * FROM global_apps")).toHaveLength(0);
  });

  it("registers only list/configure/clearSecret, without OAuth, Session or plaintext read operations", () => {
    const f = fixture();
    expect([...f.handlers.keys()]).toEqual([
      IPC.globalAppsList,
      IPC.globalAppsConfigure,
      IPC.globalAppsClearSecret,
    ]);
    expect(f.run(IPC.globalAppsList)).toHaveLength(3);
    expect(f.handlers.has("global-apps:get-secret")).toBe(false);
    expect(f.db.all("SELECT * FROM accounts")).toEqual([]);
    expect(f.db.all("SELECT * FROM global_accounts")).toEqual([]);
  });

  it("returns metadata after setting or clearing a TikTok secret and does not return ciphertext", () => {
    const f = fixture(),
      secret = "synthetic-write-only-secret";
    const saved = f.run(IPC.globalAppsConfigure, {
      platformId: "tiktok",
      clientId: "my-client",
      redirectPort: 3455,
      clientSecret: secret,
    });
    expect(saved).toMatchObject({
      configured: true,
      clientSecret: { state: "available", hasCredential: true },
    });
    expect(JSON.stringify({ saved, list: f.run(IPC.globalAppsList) })).not.toContain(secret);
    expect(saved).not.toHaveProperty("ciphertext");
    expect(f.run(IPC.globalAppsClearSecret, "tiktok")).toMatchObject({
      configured: true,
      clientSecret: { state: "missing", hasCredential: false },
    });
  });

  it.each([
    { platformId: "bilibili", clientId: "x", redirectPort: 3455 },
    { platformId: "x", clientId: "x", redirectPort: 3456, clientSecret: "secret" },
    { platformId: "youtube", clientId: "x", redirectPort: 0, authorizeUrl: "https://untrusted.test/" },
    { platformId: "youtube", clientId: "x", redirectPort: 0, scopes: ["unreviewed"] },
    { platformId: "youtube", clientId: "x", redirectPort: 0, token: "secret" },
    { platformId: "youtube", clientId: "x", redirectPort: 0, partition: "persist:foreign" },
    { platformId: "tiktok", clientId: "x", redirectPort: 0, clientSecret: "secret" },
  ])("rejects unapproved inputs at the real shared schema boundary: %j", (input) => {
    const f = fixture(),
      configure = vi.spyOn(f.service, "configure");
    expect(() => f.run(IPC.globalAppsConfigure, input)).toThrow();
    expect(configure).not.toHaveBeenCalled();
    expect(f.db.all("SELECT * FROM global_apps")).toEqual([]);
    expect(f.db.all("SELECT * FROM credentials")).toEqual([]);
  });

  it("generic credential IPC cannot bypass the application service to mutate its secret", () => {
    const f = fixture();
    registerCredentialHandlers(f.ipc, f.vault);
    const saved = f.service.configure({
      platformId: "youtube",
      clientId: "client",
      redirectPort: 0,
      clientSecret: "original",
    });
    const ref = { kind: "oauth_client_secret", ownerId: saved.id };
    expect(() => f.run(CREDENTIAL_IPC.credentialSet, { ...ref, secret: "replace" })).toThrow();
    expect(() => f.run(CREDENTIAL_IPC.credentialDelete, ref)).toThrow();
    expect(f.run(CREDENTIAL_IPC.credentialMeta, ref)).toMatchObject({ state: "available" });
    expect(f.vault.get({ kind: "oauth_client_secret", ownerId: saved.id! })).toBe("original");
    expect(() => f.run(IPC.globalAppsClearSecret, saved.id)).toThrow();
    expect(() => f.run(IPC.globalAppsClearSecret, { platformId: "youtube", ownerId: saved.id })).toThrow();
  });
});
