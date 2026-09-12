import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { buildBackup } from "@main/security/backup";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { GLOBAL_APP_PROFILES } from "@shared/global-apps";
import type { GlobalReadData } from "@shared/global-read";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAppRepository } from "./global-app-repository";
import { GlobalAuthorizationStore } from "./global-authorization-store";
import type { GlobalOAuthEligibility } from "./global-oauth-service";
import { GlobalTokenStore, type GlobalTokenEnvelope } from "./global-token-store";
import { GlobalReadService, type GlobalReadServiceOptions } from "./global-read-service";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const stores: Store[] = [];
const services: GlobalReadService[] = [];
const unblock: (() => void)[] = [];
afterEach(async () => {
  unblock.splice(0).forEach((done) => done());
  for (const service of services.splice(0)) await service.dispose();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(options: { authorized?: boolean; noRefresh?: boolean } = {}) {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-09-08T09:00:00Z"));
  const store = createStore(":memory:");
  stores.push(store);
  const key = randomBytes(32);
  let onEncrypt = () => undefined as void;
  const encryption: CredentialEncryptionProvider = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      onEncrypt();
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: (bytes) => {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  const accounts = new GlobalAccountRepository(store.db),
    apps = new GlobalAppRepository(store.db);
  const app = apps.put({ platformId: "youtube", clientId: "synthetic-client", redirectPort: 0 });
  const account = accounts.create({ platformId: "youtube", displayName: "Local account" });
  const vault = new CredentialVault(store.db, encryption),
    tokens = new GlobalTokenStore(store.db, encryption);
  const context = { accountId: account.id, platformId: account.platformId, assertCurrent: () => undefined };
  let token: GlobalTokenEnvelope = {
    version: 1,
    accountId: account.id,
    platformId: "youtube",
    remoteId: `UC${"a".repeat(22)}`,
    accessToken: "synthetic-access-private",
    tokenType: "Bearer",
    ...(options.noRefresh ? {} : { refreshToken: "synthetic-refresh-private" }),
    scopes: [...GLOBAL_APP_PROFILES.youtube.scopes],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  if (options.authorized !== false) tokens.commitAuthorization(token, context);
  const data: GlobalReadData = {
    remoteId: token.remoteId,
    profile: { displayName: "Public channel", username: "public-handle" },
    totals: { followers: "9007199254740993123", following: null, works: "100", views: "100000", likes: null },
    works: Array.from({ length: 20 }, (_, i) => ({
      id: `public-video-${i}`,
      kind: "video",
      title: `Video ${i}`,
      publishedAt: new Date().toISOString(),
      views: `${i}`,
      likes: null,
      comments: "0",
      reposts: null,
    })),
    hasMoreWorks: true,
    capabilities: { readProfile: "ready", readMetrics: "ready", listWorks: "ready" },
  };
  const leases: {
    lease: GlobalOAuthEligibility;
    abort: AbortController;
    release: ReturnType<typeof vi.fn>;
  }[] = [];
  const acquireEligibility = vi.fn<GlobalReadServiceOptions["acquireEligibility"]>(async () => {
    const abort = new AbortController(),
      release = vi.fn();
    const lease: GlobalOAuthEligibility = {
      generation: 1,
      signal: abort.signal,
      release,
      isCurrent: () => !abort.signal.aborted,
    };
    leases.push({ lease, abort, release });
    return lease;
  });
  const read = vi.fn<GlobalReadServiceOptions["read"]>(async () => structuredClone(data));
  const refreshToken = vi.fn<GlobalReadServiceOptions["refreshToken"]>(async (input) => ({
    ...input.token,
    accessToken: "refreshed-access-private",
    refreshToken: "rotated-refresh-private",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }));
  const service = new GlobalReadService({ db: store.db, encryption, acquireEligibility, read, refreshToken });
  services.push(service);
  const expire = () => {
    token = { ...token, expiresAt: new Date(Date.now() - 1000).toISOString() };
    vault.set({ kind: "oauth_token", ownerId: account.id, secret: JSON.stringify(token) });
    return token;
  };
  return {
    store,
    accounts,
    apps,
    app,
    account,
    tokens,
    vault,
    service,
    data,
    read,
    refreshToken,
    acquireEligibility,
    leases,
    expire,
    context,
    get token() {
      return token;
    },
    setOnEncrypt: (fn: () => void) => {
      onEncrypt = fn;
    },
  };
}

describe("GlobalReadService with real SQLite and encrypted grant storage", () => {
  it("persists one safe twenty-work snapshot and preserves auth, credentials and domestic data", async () => {
    const f = fixture(),
      beforeAccount = f.accounts.get(f.account.id),
      beforeToken = f.tokens.read(f.account.id);
    expect(f.service.get(f.account.id)).toBeNull();
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    const saved = await f.service.refresh(f.account.id);
    expect(saved).toMatchObject({ accountId: f.account.id, platformId: "youtube", ...f.data });
    expect(saved.works).toHaveLength(20);
    expect(f.service.get(f.account.id)).toEqual(saved);
    expect(f.accounts.get(f.account.id)).toEqual(beforeAccount);
    expect(f.tokens.read(f.account.id)).toEqual(beforeToken);
    expect(f.store.accounts.list()).toEqual([]);
    expect(f.refreshToken).not.toHaveBeenCalled();
    expect(f.leases[0].release).toHaveBeenCalledTimes(1);
    const exposed = JSON.stringify({
      saved,
      rows: f.store.db.all("SELECT * FROM global_read_snapshots"),
      audit: f.store.audit.list(),
      backup: buildBackup(f.store, "test"),
    });
    expect(exposed).not.toMatch(
      /synthetic-access-private|synthetic-refresh-private|authorization|partition|https:\/\/.*token/,
    );
  });
  it("rejects unauthorized accounts without acquiring network eligibility or calling either API dependency", async () => {
    const f = fixture({ authorized: false });
    await expect(f.service.refresh(f.account.id)).rejects.toMatchObject({ code: "GLOBAL_READ_UNAUTHORIZED" });
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.refreshToken).not.toHaveBeenCalled();
  });
  it("returns waiting-proxy without a read or refresh when current eligibility is unavailable", async () => {
    const f = fixture();
    f.acquireEligibility.mockResolvedValue(null);
    await expect(f.service.refresh(f.account.id)).rejects.toMatchObject({
      code: "GLOBAL_READ_WAITING_PROXY",
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.refreshToken).not.toHaveBeenCalled();
  });
  it("refreshes an expired grant, commits rotation by CAS, then reads with the new access token", async () => {
    const f = fixture(),
      old = f.expire();
    const result = await f.service.refresh(f.account.id);
    expect(result.works).toHaveLength(20);
    expect(f.refreshToken.mock.calls[0][0].token).toEqual(old);
    expect(f.read.mock.calls[0][0].token.accessToken).toBe("refreshed-access-private");
    expect(f.tokens.read(f.account.id)?.refreshToken).toBe("rotated-refresh-private");
    const events = f.store.db
      .all<{ details_json: string }>("SELECT details_json FROM audit_events WHERE action = 'OAuthEvent'")
      .map((row) => JSON.parse(row.details_json).event);
    expect(events).toEqual(["authorized", "refreshed"]);
  });
  it("an expired access token with no refresh token never reaches the read dependency", async () => {
    const f = fixture({ noRefresh: true });
    f.expire();
    await expect(f.service.refresh(f.account.id)).rejects.toMatchObject({ code: "GLOBAL_READ_REAUTHORIZE" });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.refreshToken).not.toHaveBeenCalled();
  });
  it("does not overwrite a token replaced while refresh was pending", async () => {
    const f = fixture(),
      held = deferred<GlobalTokenEnvelope>();
    f.expire();
    unblock.push(() => held.resolve(f.token));
    f.refreshToken.mockImplementation(() => held.promise);
    const pending = f.service.refresh(f.account.id);
    const rejected = expect(pending).rejects.toMatchObject({ code: "GLOBAL_READ_CANCELLED" });
    await flush();
    const replacement = {
      ...f.token,
      accessToken: "separately-saved-access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    f.tokens.commitAuthorization(replacement, f.context);
    held.resolve({ ...replacement, accessToken: "late-rotation" });
    await rejected;
    await f.service.whenIdle();
    expect(f.tokens.read(f.account.id)).toEqual(replacement);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.service.get(f.account.id)).toBeNull();
  });
  it.each(["app", "secret", "disconnect", "delete", "token", "network"])(
    "rejects a late snapshot after %s changed",
    async (change) => {
      const f = fixture(),
        held = deferred<GlobalReadData>();
      unblock.push(() => held.resolve(f.data));
      f.read.mockImplementation(() => held.promise);
      const pending = f.service.refresh(f.account.id);
      const rejected = expect(pending).rejects.toMatchObject({
        code: change === "network" ? "GLOBAL_READ_WAITING_PROXY" : "GLOBAL_READ_CANCELLED",
      });
      await flush();
      if (change === "app") f.apps.put({ platformId: "youtube", clientId: "new-client", redirectPort: 0 });
      if (change === "secret")
        f.vault.set({ kind: "oauth_client_secret", ownerId: f.app.id, secret: "replacement-secret" });
      if (change === "disconnect") new GlobalAuthorizationStore(f.store.db).disconnect(f.account.id);
      if (change === "delete") f.accounts.delete(f.account.id);
      if (change === "token")
        f.tokens.commitAuthorization({ ...f.token, accessToken: "separate-new-access" }, f.context);
      if (change === "network") f.leases[0].abort.abort();
      held.resolve(f.data);
      await rejected;
      await f.service.whenIdle();
      expect(f.store.db.all("SELECT * FROM global_read_snapshots")).toEqual([]);
    },
  );
  it("returns cancellation immediately while retaining the actual work and account slot until its late dependency settles", async () => {
    const f = fixture(),
      held = deferred<GlobalReadData>();
    unblock.push(() => held.resolve(f.data));
    f.read.mockImplementationOnce(() => held.promise);
    const pending = f.service.refresh(f.account.id);
    const rejected = expect(pending).rejects.toMatchObject({ code: "GLOBAL_READ_CANCELLED" });
    await flush();
    f.service.cancel(f.account.id);
    await rejected;
    expect(f.read.mock.calls[0][0].signal.aborted).toBe(true);
    await expect(f.service.refresh(f.account.id)).rejects.toMatchObject({ code: "GLOBAL_READ_BUSY" });
    let idle = false;
    const drain = f.service.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    expect(f.leases[0].release).not.toHaveBeenCalled();
    held.resolve(f.data);
    await drain;
    expect(f.service.get(f.account.id)).toBeNull();
    expect(f.leases[0].release).toHaveBeenCalledTimes(1);
    await expect(f.service.refresh(f.account.id)).resolves.toMatchObject({ accountId: f.account.id });
  });
  it("dispose revokes and waits for a late eligibility provider without starting a read", async () => {
    const f = fixture(),
      held = deferred<GlobalOAuthEligibility | null>();
    unblock.push(() => held.resolve(null));
    f.acquireEligibility.mockImplementation(() => held.promise);
    const pending = f.service.refresh(f.account.id);
    const rejected = expect(pending).rejects.toMatchObject({ code: "GLOBAL_READ_WAITING_PROXY" });
    await flush();
    let disposed = false;
    const drain = f.service.dispose().then(() => {
      disposed = true;
    });
    await rejected;
    await flush();
    expect(disposed).toBe(false);
    const release = vi.fn();
    held.resolve({ generation: 1, signal: new AbortController().signal, isCurrent: () => true, release });
    await drain;
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["GLOBAL_READ_REAUTHORIZE", "GLOBAL_READ_FORBIDDEN", "GLOBAL_READ_RATE_LIMITED"])(
    "does not rewrite auth/status/timestamps after an adapter reports %s",
    async (code) => {
      const f = fixture();
      await f.service.refresh(f.account.id);
      const account = f.accounts.get(f.account.id),
        token = f.tokens.read(f.account.id),
        saved = f.service.get(f.account.id);
      f.read.mockRejectedValue(new Error(code));
      vi.setSystemTime(Date.now() + 1000);
      await expect(f.service.refresh(f.account.id)).rejects.toMatchObject({ code });
      expect(f.accounts.get(f.account.id)).toEqual(account);
      expect(f.tokens.read(f.account.id)).toEqual(token);
      expect(f.service.get(f.account.id)).toEqual(saved);
    },
  );
  it("rolls back the real snapshot upsert if its network lease is revoked after SQLite writes", async () => {
    const f = fixture();
    const original = await f.service.refresh(f.account.id);
    f.data.profile.displayName = "Must not replace";
    const run = f.store.db.run.bind(f.store.db);
    vi.spyOn(f.store.db, "run").mockImplementation((sql, params) => {
      const result = run(sql, params);
      if (sql.includes("INSERT INTO global_read_snapshots")) f.leases.at(-1)!.abort.abort();
      return result;
    });
    await expect(f.service.refresh(f.account.id)).rejects.toMatchObject({
      code: "GLOBAL_READ_WAITING_PROXY",
    });
    expect(f.service.get(f.account.id)).toEqual(original);
  });
  it("rolls back refresh token rotation if encryption triggers revocation, with zero subsequent reads", async () => {
    const f = fixture();
    const original = f.expire();
    f.setOnEncrypt(() => f.leases.at(-1)!.abort.abort());
    await expect(f.service.refresh(f.account.id)).rejects.toMatchObject({
      code: "GLOBAL_READ_WAITING_PROXY",
    });
    expect(f.tokens.read(f.account.id)).toEqual(original);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.store.db.all("SELECT * FROM global_read_snapshots")).toEqual([]);
  });
  it.each(["wrong-owner", "too-many", "raw-secret-field"])(
    "refuses unsafe or mismatched snapshot %s",
    async (mode) => {
      const f = fixture();
      if (mode === "wrong-owner") f.data.remoteId = "other-channel";
      if (mode === "too-many") f.data.works.push({ ...f.data.works[0], id: "twenty-first" });
      if (mode === "raw-secret-field") Object.assign(f.data, { accessToken: "private-raw-token" });
      await expect(f.service.refresh(f.account.id)).rejects.toMatchObject({
        code: mode === "wrong-owner" ? "GLOBAL_READ_IDENTITY_MISMATCH" : "GLOBAL_READ_RESPONSE_INVALID",
      });
      expect(f.service.get(f.account.id)).toBeNull();
    },
  );
});
