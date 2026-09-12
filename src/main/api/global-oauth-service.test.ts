import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { request, Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { GLOBAL_APP_PROFILES } from "@shared/global-apps";
import type { GlobalPlatformId } from "@shared/platforms";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAppRepository } from "./global-app-repository";
import { GlobalAppService } from "./global-app-service";
import {
  GlobalOAuthService,
  type GlobalOAuthEligibility,
  type GlobalOAuthServiceOptions,
  type GlobalOAuthState,
} from "./global-oauth-service";
import { GlobalTokenStore, type GlobalTokenEnvelope } from "./global-token-store";
import { GlobalAuthorizationStore } from "./global-authorization-store";
import { OAuthCodeExchanger } from "./oauth-exchange";
import type { ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";
import type { OAuthCodeExchangeInput } from "./oauth-flow";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const stores: Store[] = [];
const services: GlobalOAuthService[] = [];
const drains: (() => void)[] = [];
beforeEach(() => vi.restoreAllMocks());
afterEach(async () => {
  for (const settle of drains.splice(0)) settle();
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function tokenFor(
  input:
    Pick<OAuthCodeExchangeInput, "accountId" | "platformId"> | { id: string; platformId: GlobalPlatformId },
): GlobalTokenEnvelope {
  return {
    version: 1,
    accountId: "accountId" in input ? input.accountId : input.id,
    platformId: input.platformId,
    remoteId: "synthetic-remote-identity",
    tokenType: "Bearer",
    accessToken: "private-synthetic-access",
    refreshToken: "private-synthetic-refresh",
    scopes: [...GLOBAL_APP_PROFILES[input.platformId].scopes],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}
function fixture(
  overrides: Partial<GlobalOAuthServiceOptions> = {},
  config: { configured?: boolean; platformId?: GlobalPlatformId; secret?: string } = {},
) {
  const store = createStore(":memory:");
  stores.push(store);
  const key = randomBytes(32);
  let encryptionAvailable = true;
  const encryption: CredentialEncryptionProvider = {
    isEncryptionAvailable: () => encryptionAvailable,
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
  const accounts = new GlobalAccountRepository(store.db);
  const platformId = config.platformId ?? "youtube";
  const account = accounts.create({ platformId, displayName: "本机授权测试账号" });
  const appService = new GlobalAppService(store.db, encryption);
  const apps = new GlobalAppRepository(store.db);
  if (config.configured !== false)
    appService.configure({
      platformId,
      clientId: `synthetic-${platformId}-client`,
      redirectPort: platformId === "youtube" ? 0 : 3467,
      ...(config.secret ? { clientSecret: config.secret } : {}),
    });
  const eligibilityAbort = new AbortController();
  let eligible = true;
  const lease: GlobalOAuthEligibility = {
    generation: 1,
    signal: eligibilityAbort.signal,
    isCurrent: vi.fn(() => eligible),
    release: vi.fn(),
  };
  const acquireEligibility = vi.fn(async () => lease);
  const exchangeCode = vi.fn(async (input: OAuthCodeExchangeInput) => tokenFor(input));
  const urls: string[] = [];
  const openAuthorizationUrl = vi.fn(async (url: string) => {
    urls.push(url);
  });
  const states: GlobalOAuthState[] = [];
  const onChanged = vi.fn((state: GlobalOAuthState) => {
    states.push(state);
  });
  const service = new GlobalOAuthService({
    db: store.db,
    encryption,
    acquireEligibility,
    exchangeCode,
    openAuthorizationUrl,
    onChanged,
    timeoutMs: 2000,
    ...overrides,
  });
  services.push(service);
  return {
    service,
    store,
    account,
    accounts,
    apps,
    appService,
    encryption,
    lease,
    acquireEligibility,
    exchangeCode,
    openAuthorizationUrl,
    onChanged,
    urls,
    states,
    vault: new CredentialVault(store.db, encryption),
    tokens: new GlobalTokenStore(store.db, encryption),
    disableEncryption: () => {
      encryptionAvailable = false;
    },
    revoke: () => {
      eligible = false;
      eligibilityAbort.abort(new Error("private eligibility detail"));
    },
  };
}
function callback(authorizationUrl: string) {
  const auth = new URL(authorizationUrl);
  const url = new URL(auth.searchParams.get("redirect_uri")!);
  url.searchParams.set("state", auth.searchParams.get("state")!);
  url.searchParams.set("code", "private-synthetic-code");
  return url;
}
function sendCallback(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
function noToken(f: ReturnType<typeof fixture>) {
  expect(f.store.db.all("SELECT * FROM credentials WHERE kind = 'oauth_token'")).toEqual([]);
}
async function isStillBusy(service: GlobalOAuthService) {
  let idle = false;
  const promise = service.whenIdle().then(() => {
    idle = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(idle).toBe(false);
  return { promise };
}

describe("GlobalOAuthService real local composition", () => {
  it("requests basic plus video.upload only on an explicit TikTok draft authorization", async () => {
    const f = fixture({}, { platformId: "tiktok", secret: "synthetic-app-secret" });
    f.exchangeCode.mockImplementation(async (input) => ({
      ...tokenFor(input),
      scopes: ["user.info.basic", "video.upload"],
    }));
    const state = await f.service.startDraft(f.account.id);
    expect(state.phase).toBe("awaiting_user");
    expect(new URL(f.urls[0]).searchParams.get("scope")).toBe("user.info.basic,video.upload");
    expect(await sendCallback(callback(f.urls[0]))).toBe(200);
    await f.service.whenIdle();
    expect(f.service.state(f.account.id).phase).toBe("authorized");
    expect(f.tokens.read(f.account.id)?.scopes).toContain("video.upload");
  });
  it("does not claim draft authorization if the user grants only the basic scope", async () => {
    const f = fixture({}, { platformId: "tiktok", secret: "synthetic-app-secret" });
    await f.service.startDraft(f.account.id);
    await sendCallback(callback(f.urls[0]));
    await f.service.whenIdle();
    expect(f.service.state(f.account.id).phase).toBe("failed");
    noToken(f);
  });
  it("does not request TikTok draft permission for another platform", async () => {
    const f = fixture();
    await expect(f.service.startDraft(f.account.id)).rejects.toMatchObject({
      code: "GLOBAL_OAUTH_INVALID_ACCOUNT",
    });
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
  });
  it("requests YouTube upload consent explicitly and saves only the returned scope", async () => {
    const f = fixture();
    f.exchangeCode.mockImplementation(async (input) => ({
      ...tokenFor(input),
      scopes: [
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/youtube.upload",
      ],
    }));
    await f.service.startUpload(f.account.id);
    expect(new URL(f.urls[0]).searchParams.get("scope")?.split(" ")).toEqual([
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.upload",
    ]);
    await sendCallback(callback(f.urls[0]));
    await f.service.whenIdle();
    expect(f.service.state(f.account.id).phase).toBe("authorized");
    expect(f.tokens.read(f.account.id)?.scopes).toContain("https://www.googleapis.com/auth/youtube.upload");
  });
  it("refuses an incomplete YouTube upload grant without saving a successful authorization", async () => {
    const f = fixture();
    await f.service.startUpload(f.account.id);
    await sendCallback(callback(f.urls[0]));
    await f.service.whenIdle();
    expect(f.service.state(f.account.id).phase).toBe("failed");
    noToken(f);
  });
  it("does not use YouTube upload consent for TikTok", async () => {
    const f = fixture({}, { platformId: "tiktok", secret: "synthetic-app-secret" });
    await expect(f.service.startUpload(f.account.id)).rejects.toMatchObject({
      code: "GLOBAL_OAUTH_INVALID_ACCOUNT",
    });
    expect(f.acquireEligibility).not.toHaveBeenCalled();
  });
  it("does not start implicit authorization in the constructor or state getter", () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const f = fixture();
    expect(f.service.state(f.account.id)).toEqual({
      accountId: f.account.id,
      platformId: "youtube",
      transactionId: null,
      phase: "idle",
      errorCode: null,
    });
    expect(listen).not.toHaveBeenCalled();
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("rejects malformed construction dependencies with one fixed error and no side effects", () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const f = fixture();
    const valid: GlobalOAuthServiceOptions = {
      db: f.store.db,
      encryption: f.encryption,
      acquireEligibility: f.acquireEligibility,
      exchangeCode: f.exchangeCode,
      openAuthorizationUrl: f.openAuthorizationUrl,
    };
    const malformed: unknown[] = [
      undefined,
      null,
      { ...valid, db: undefined },
      { ...valid, db: { get: null, run: vi.fn(), transaction: vi.fn() } },
      { ...valid, db: { get: vi.fn(), run: null, transaction: vi.fn() } },
      { ...valid, db: { get: vi.fn(), run: vi.fn(), transaction: null } },
      { ...valid, acquireEligibility: null },
      { ...valid, exchangeCode: "private-invalid-dependency" },
      { ...valid, openAuthorizationUrl: undefined },
      { ...valid, encryption: null },
      { ...valid, encryption: { ...f.encryption, decryptString: undefined } },
    ];
    for (const input of malformed)
      expect(() => new GlobalOAuthService(input as GlobalOAuthServiceOptions)).toThrowError(
        expect.objectContaining({
          name: "GlobalOAuthServiceError",
          code: "GLOBAL_OAUTH_UNAVAILABLE",
          message: "GLOBAL_OAUTH_UNAVAILABLE",
        }),
      );
    expect(listen).not.toHaveBeenCalled();
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    expect(f.exchangeCode).not.toHaveBeenCalled();
    expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
  });

  it.each(["fingerprint", "storage"] as const)(
    "redacts a private database error during initial %s without reserving or starting authorization",
    async (stage) => {
      const listen = vi.spyOn(Server.prototype, "listen");
      const f = fixture();
      const read = f.store.db.get.bind(f.store.db);
      let injected = 0;
      vi.spyOn(f.store.db, "get").mockImplementation((sql, params) => {
        const query = stage === "fingerprint" ? "SELECT id, ciphertext," : "SELECT ciphertext,";
        if (sql.startsWith(query)) {
          injected += 1;
          throw new Error("private-secret database detail https://private.example/?token=private-secret");
        }
        return read(sql, params);
      });
      let failure: unknown;
      try {
        await f.service.start(f.account.id);
      } catch (error) {
        failure = error;
      }
      expect(injected).toBe(1);
      expect(failure).toMatchObject({
        name: "GlobalOAuthServiceError",
        code: "GLOBAL_OAUTH_UNAVAILABLE",
        message: "GLOBAL_OAUTH_UNAVAILABLE",
      });
      expect(String(failure)).not.toMatch(/private-secret|private\.example|database detail/);
      expect(JSON.stringify(failure)).not.toContain("private-secret");
      await f.service.whenIdle();
      expect(f.service.state(f.account.id).phase).toBe("idle");
      expect(f.states).toEqual([]);
      expect(listen).not.toHaveBeenCalled();
      expect(f.acquireEligibility).not.toHaveBeenCalled();
      expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
      noToken(f);
    },
  );

  it.each(["missing-app", "encryption", "missing-tiktok-secret", "unreadable-google-secret"])(
    "fails %s before eligibility, binding, browser or exchange",
    async (failure) => {
      const listen = vi.spyOn(Server.prototype, "listen");
      const f = fixture(
        {},
        failure === "missing-app" || failure === "missing-tiktok-secret"
          ? { configured: false, platformId: failure === "missing-tiktok-secret" ? "tiktok" : "youtube" }
          : failure === "unreadable-google-secret"
            ? { secret: "synthetic-app-secret" }
            : {},
      );
      if (failure === "encryption") f.disableEncryption();
      if (failure === "missing-tiktok-secret")
        f.apps.put({ platformId: "tiktok", clientId: "synthetic-tiktok-client", redirectPort: 3467 });
      if (failure === "unreadable-google-secret")
        f.store.db.run("UPDATE credentials SET ciphertext = ? WHERE kind = 'oauth_client_secret'", [
          Buffer.from("unreadable"),
        ]);
      const expected =
        failure === "missing-app"
          ? "GLOBAL_OAUTH_NOT_CONFIGURED"
          : failure === "encryption"
            ? "GLOBAL_OAUTH_ENCRYPTION_UNAVAILABLE"
            : "GLOBAL_OAUTH_SECRET_UNAVAILABLE";
      await expect(f.service.start(f.account.id)).rejects.toMatchObject({ code: expected });
      expect(listen).not.toHaveBeenCalled();
      expect(f.acquireEligibility).not.toHaveBeenCalled();
      expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
      expect(f.exchangeCode).not.toHaveBeenCalled();
      noToken(f);
    },
  );

  it("cannot bind a listener or open the browser when proxy eligibility is unavailable", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const f = fixture({ acquireEligibility: async () => null });
    expect(await f.service.start(f.account.id)).toMatchObject({
      phase: "failed",
      errorCode: "GLOBAL_OAUTH_PROXY_UNVERIFIED",
    });
    await f.service.whenIdle();
    expect(listen).not.toHaveBeenCalled();
    expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
    expect(f.exchangeCode).not.toHaveBeenCalled();
    noToken(f);
  });

  it("opens only a main-process URL, returns safe awaiting state, and commits a real encrypted token after callback", async () => {
    const f = fixture();
    const state = await f.service.start(f.account.id);
    expect(state).toMatchObject({
      phase: "awaiting_user",
      accountId: f.account.id,
      transactionId: expect.any(String),
    });
    expect(f.openAuthorizationUrl).toHaveBeenCalledTimes(1);
    expect(f.exchangeCode).not.toHaveBeenCalled();
    const url = callback(f.urls[0]);
    expect(url.hostname).toBe("127.0.0.1");
    expect(await sendCallback(url)).toBe(200);
    await f.service.whenIdle();
    expect(f.service.state(f.account.id)).toMatchObject({ phase: "authorized", errorCode: null });
    expect(f.tokens.read(f.account.id)).toEqual(await f.exchangeCode.mock.results[0].value);
    const cipher = f.store.db.get<{ ciphertext: Uint8Array }>(
      "SELECT ciphertext FROM credentials WHERE kind = 'oauth_token'",
    )!.ciphertext;
    expect(Buffer.from(cipher).includes(Buffer.from("private-synthetic-access"))).toBe(false);
    expect(f.accounts.get(f.account.id)?.authStatus).toBe("authorized");
    expect(f.lease.release).toHaveBeenCalledTimes(1);
    const publicData = JSON.stringify({ state, final: f.service.state(f.account.id), states: f.states });
    for (const field of ["authorizationUrl", "redirectUri", "codeVerifier", "accessToken", "refreshToken"])
      expect(publicData).not.toContain(field);
    expect(publicData).not.toMatch(/private-synthetic|https?:\/\//);
    expect(publicData).not.toContain(new URL(f.urls[0]).searchParams.get("state")!);
    await expect(sendCallback(url)).rejects.toThrow();
  });

  it("composes the real code exchanger, loopback manager and token transaction with two controlled official responses", async () => {
    const channelId = `UC${"a".repeat(22)}`;
    const response = (body: unknown): ProxyTransportResponse => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(body)),
    });
    const transportRequest = vi
      .fn<(input: ProxyTransportRequest) => Promise<ProxyTransportResponse>>()
      .mockResolvedValueOnce(
        response({
          access_token: "main-only-api-access",
          refresh_token: "main-only-api-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: GLOBAL_APP_PROFILES.youtube.scopes.join(" "),
        }),
      )
      .mockResolvedValueOnce(response({ items: [{ id: channelId }] }));
    const f = fixture(
      { exchangeCode: (input, app) => exchanger.exchange(input, app) },
      { secret: "main-only-client-secret" },
    );
    const exchanger = new OAuthCodeExchanger({
      transport: { request: transportRequest },
      readClientSecret: (app) => f.vault.get({ kind: "oauth_client_secret", ownerId: app.id }),
    });
    const start = await f.service.start(f.account.id);
    await sendCallback(callback(f.urls[0]));
    await f.service.whenIdle();
    expect(transportRequest).toHaveBeenCalledTimes(2);
    const [tokenRequest, identityRequest] = transportRequest.mock.calls.map(([input]) => input);
    expect(tokenRequest).toMatchObject({
      platformId: "youtube",
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
    });
    expect(identityRequest).toMatchObject({
      platformId: "youtube",
      url: "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=2",
      method: "GET",
      headers: { Authorization: "Bearer main-only-api-access" },
    });
    expect(tokenRequest.headers).not.toHaveProperty("Authorization");
    const form = new URLSearchParams(String(tokenRequest.body));
    expect(form.get("code")).toBe("private-synthetic-code");
    expect(form.get("client_secret")).toBe("main-only-client-secret");
    expect(form.get("redirect_uri")).toBe(new URL(f.urls[0]).searchParams.get("redirect_uri"));
    expect(f.tokens.read(f.account.id)).toMatchObject({
      accountId: f.account.id,
      platformId: "youtube",
      remoteId: channelId,
      accessToken: "main-only-api-access",
      refreshToken: "main-only-api-refresh",
      scopes: [...GLOBAL_APP_PROFILES.youtube.scopes],
    });
    expect(f.accounts.get(f.account.id)).toMatchObject({ remoteId: channelId, authStatus: "authorized" });
    const projection = JSON.stringify({ start, final: f.service.state(f.account.id), events: f.states });
    expect(projection).not.toMatch(/main-only|private-synthetic-code|https?:\/\//);
    expect(projection).not.toContain(new URL(f.urls[0]).searchParams.get("state")!);
    expect(projection).not.toContain(form.get("code_verifier")!);
  });

  it.each([
    "client-id",
    "port",
    "secret-ciphertext",
    "encryption",
    "delete-account",
    "cancel",
    "account-revoke",
    "platform-revoke",
    "eligibility-revoke",
  ])("does not save a late exchange after %s", async (change) => {
    const entered = deferred<OAuthCodeExchangeInput>();
    const result = deferred<GlobalTokenEnvelope>();
    const f = fixture(
      {
        exchangeCode: async (input) => {
          entered.resolve(input);
          return result.promise;
        },
      },
      { secret: "initial-app-secret" },
    );
    drains.push(() => result.resolve(tokenFor(f.account)));
    await f.service.start(f.account.id);
    await sendCallback(callback(f.urls[0]));
    const input = await entered.promise;
    if (change === "client-id")
      f.appService.configure({ platformId: "youtube", clientId: "new-client", redirectPort: 0 });
    if (change === "port")
      f.appService.configure({
        platformId: "youtube",
        clientId: "synthetic-youtube-client",
        redirectPort: 4567,
      });
    if (change === "secret-ciphertext")
      f.vault.set({
        kind: "oauth_client_secret",
        ownerId: f.apps.get("youtube")!.id,
        secret: "replacement-app-secret",
      });
    if (change === "encryption") f.disableEncryption();
    if (change === "delete-account") f.accounts.delete(f.account.id);
    if (change === "cancel") f.service.cancel(f.account.id);
    if (change === "account-revoke") f.service.invalidateAccount(f.account.id);
    if (change === "platform-revoke") f.service.invalidatePlatform("youtube");
    if (change === "eligibility-revoke") f.revoke();
    const busy = await isStillBusy(f.service);
    expect(f.lease.release).not.toHaveBeenCalled();
    result.resolve(tokenFor(input));
    await busy.promise;
    noToken(f);
    expect(f.accounts.get(f.account.id)?.authStatus).not.toBe("authorized");
    expect(f.lease.release).toHaveBeenCalledTimes(1);
    expect(input.signal.aborted).toBe(true);
  });

  it("rejects a duplicate transaction until the cancelled exchange actually settles", async () => {
    const entered = deferred<void>();
    const result = deferred<GlobalTokenEnvelope>();
    const f = fixture({
      exchangeCode: async () => {
        entered.resolve();
        return result.promise;
      },
    });
    drains.push(() => result.resolve(tokenFor(f.account)));
    await f.service.start(f.account.id);
    await sendCallback(callback(f.urls[0]));
    await entered.promise;
    f.service.cancel(f.account.id);
    await expect(f.service.start(f.account.id)).rejects.toMatchObject({ code: "GLOBAL_OAUTH_BUSY" });
    const busy = await isStillBusy(f.service);
    result.resolve(tokenFor(f.account));
    await busy.promise;
    expect(await f.service.start(f.account.id)).toMatchObject({ phase: "awaiting_user" });
    f.service.cancel(f.account.id);
  });

  it("reserves four service slots before pending eligibility, including cancelled work awaiting drain", async () => {
    const pending = deferred<GlobalOAuthEligibility | null>();
    const acquire = vi.fn(() => pending.promise);
    const f = fixture({ acquireEligibility: acquire });
    drains.push(() => pending.resolve(null));
    const ids = [
      f.account.id,
      ...Array.from({ length: 4 }, () => f.accounts.create({ platformId: "youtube" }).id),
    ];
    const work = ids.slice(0, 4).map((id) => f.service.start(id));
    expect(acquire).toHaveBeenCalledTimes(4);
    await expect(f.service.start(ids[4])).rejects.toMatchObject({ code: "GLOBAL_OAUTH_BUSY" });
    ids.slice(0, 4).forEach((id) => f.service.cancel(id));
    await expect(f.service.start(ids[4])).rejects.toMatchObject({ code: "GLOBAL_OAUTH_BUSY" });
    pending.resolve(null);
    await Promise.all(work);
    await f.service.whenIdle();
    expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
  });

  it.each(["starting", "awaiting_user", "exchanging"] as const)(
    "stops work if onChanged synchronously cancels at %s",
    async (phase) => {
      const listen = vi.spyOn(Server.prototype, "listen");
      const f = fixture({
        onChanged: (state) => {
          if (state.phase === phase) f.service.cancel(state.accountId);
        },
      });
      const service = f.service;
      await service.start(f.account.id);
      if (phase === "exchanging") await sendCallback(callback(f.urls[0]));
      await service.whenIdle();
      expect(service.state(f.account.id).phase).toBe("cancelled");
      expect(f.exchangeCode).not.toHaveBeenCalled();
      noToken(f);
      if (phase !== "exchanging") expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
      if (phase === "starting") {
        expect(listen).not.toHaveBeenCalled();
        expect(f.acquireEligibility).not.toHaveBeenCalled();
      }
    },
  );

  it("isolates observer exceptions without hiding a valid successful authorization", async () => {
    const f = fixture({
      onChanged: () => {
        throw new Error("private-observer-message");
      },
    });
    await f.service.start(f.account.id);
    await sendCallback(callback(f.urls[0]));
    await f.service.whenIdle();
    expect(f.service.state(f.account.id).phase).toBe("authorized");
    expect(f.tokens.read(f.account.id)?.accessToken).toBe("private-synthetic-access");
  });

  it("stops before calling exchange when its observer changes the application configuration", async () => {
    const f = fixture({
      onChanged: (state) => {
        if (state.phase === "exchanging")
          f.appService.configure({
            platformId: "youtube",
            clientId: "replacement-google-client",
            redirectPort: 0,
          });
      },
    });
    await f.service.start(f.account.id);
    await sendCallback(callback(f.urls[0]));
    await f.service.whenIdle();
    expect(f.service.state(f.account.id).phase).toBe("failed");
    expect(f.exchangeCode).not.toHaveBeenCalled();
    noToken(f);
  });

  it("reserves real drain before publishing starting to a synchronously reentrant observer", async () => {
    const pending = deferred<GlobalOAuthEligibility | null>();
    drains.push(() => pending.resolve(null));
    let idle = false;
    let observerDrain: Promise<void> | undefined;
    const f = fixture({
      acquireEligibility: () => pending.promise,
      onChanged: (state) => {
        if (state.phase === "starting")
          observerDrain = f.service.whenIdle().then(() => {
            idle = true;
          });
      },
    });
    const started = f.service.start(f.account.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(idle).toBe(false);
    f.service.cancel(f.account.id);
    pending.resolve(null);
    await started;
    await observerDrain;
    expect(idle).toBe(true);
  });

  it.each(["starting", "awaiting_user"] as const)(
    "enforces the original deadline when a synchronous %s observer passes it before timers run",
    async (phase) => {
      let now = 100;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const listen = vi.spyOn(Server.prototype, "listen");
      const f = fixture({
        timeoutMs: 2000,
        onChanged: (state) => {
          if (state.phase === phase) now = 2100;
        },
      });
      expect(await f.service.start(f.account.id)).toMatchObject({
        phase: "expired",
        errorCode: "GLOBAL_OAUTH_EXPIRED",
      });
      await f.service.whenIdle();
      expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
      expect(f.exchangeCode).not.toHaveBeenCalled();
      noToken(f);
      if (phase === "starting") {
        expect(f.acquireEligibility).not.toHaveBeenCalled();
        expect(listen).not.toHaveBeenCalled();
      } else {
        expect(listen).toHaveBeenCalledTimes(1);
        expect(f.lease.release).toHaveBeenCalledTimes(1);
        const server = listen.mock.instances[0];
        expect(server.listening).toBe(false);
      }
    },
  );

  it.each(["acquire", "isCurrent"] as const)(
    "rechecks the total deadline after the external %s callback advances time",
    async (callbackStage) => {
      let now = 100;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const listen = vi.spyOn(Server.prototype, "listen");
      const f = fixture({ timeoutMs: 2000 });
      const current = vi.spyOn(f.lease, "isCurrent");
      if (callbackStage === "acquire")
        f.acquireEligibility.mockImplementation(async () => {
          now = 2100;
          return f.lease;
        });
      else
        current.mockImplementation(() => {
          now = 2100;
          return true;
        });
      expect(await f.service.start(f.account.id)).toMatchObject({
        phase: "expired",
        errorCode: "GLOBAL_OAUTH_EXPIRED",
      });
      await f.service.whenIdle();
      expect(f.acquireEligibility).toHaveBeenCalledTimes(1);
      expect(current).toHaveBeenCalledTimes(callbackStage === "acquire" ? 0 : 1);
      expect(listen).not.toHaveBeenCalled();
      expect(f.openAuthorizationUrl).not.toHaveBeenCalled();
      expect(f.exchangeCode).not.toHaveBeenCalled();
      expect(f.lease.release).toHaveBeenCalledTimes(1);
      noToken(f);
    },
  );

  it.each(["eligibility", "browser", "exchange"])(
    "uses one total deadline while keeping late %s work reserved until actual settlement",
    async (stage) => {
      const pending = deferred<void>();
      const entered = deferred<void>();
      const eligibilityAbort = new AbortController();
      const lease = {
        generation: 1,
        signal: eligibilityAbort.signal,
        isCurrent: () => true,
        release: vi.fn(),
      };
      let acquiredSignal: AbortSignal | undefined;
      let exchangeInput: OAuthCodeExchangeInput | undefined;
      drains.push(() => pending.resolve());
      const overrides: Partial<GlobalOAuthServiceOptions> = { timeoutMs: 100 };
      if (stage === "eligibility")
        overrides.acquireEligibility = async (_platform, signal) => {
          acquiredSignal = signal;
          entered.resolve();
          await pending.promise;
          return lease;
        };
      if (stage === "browser")
        overrides.openAuthorizationUrl = async () => {
          entered.resolve();
          await pending.promise;
        };
      if (stage === "exchange")
        overrides.exchangeCode = async (input) => {
          exchangeInput = input;
          entered.resolve();
          await pending.promise;
          return tokenFor(input);
        };
      const listen = vi.spyOn(Server.prototype, "listen");
      const f = fixture(overrides);
      const start = f.service.start(f.account.id);
      if (stage === "exchange") {
        await start;
        await sendCallback(callback(f.urls[0]));
      }
      await entered.promise;
      await vi.waitFor(() => expect(f.service.state(f.account.id).errorCode).toBe("GLOBAL_OAUTH_EXPIRED"), {
        timeout: 1500,
        interval: 10,
      });
      await expect(f.service.start(f.account.id)).rejects.toMatchObject({ code: "GLOBAL_OAUTH_BUSY" });
      const busy = await isStillBusy(f.service);
      if (stage === "eligibility") {
        expect(listen).not.toHaveBeenCalled();
        expect(acquiredSignal?.aborted).toBe(true);
      }
      if (stage === "exchange") expect(exchangeInput?.signal.aborted).toBe(true);
      expect(f.lease.release).not.toHaveBeenCalled();
      expect(lease.release).not.toHaveBeenCalled();
      pending.resolve();
      await start;
      await busy.promise;
      noToken(f);
      expect(f.service.state(f.account.id).errorCode).toBe("GLOBAL_OAUTH_EXPIRED");
      expect(stage === "eligibility" ? lease.release : f.lease.release).toHaveBeenCalledTimes(1);
    },
  );

  it("expires an awaiting-user listener and cannot consume a later callback", async () => {
    const f = fixture({ timeoutMs: 100 });
    await f.service.start(f.account.id);
    const url = callback(f.urls[0]);
    await vi.waitFor(() => expect(f.service.state(f.account.id).errorCode).toBe("GLOBAL_OAUTH_EXPIRED"), {
      timeout: 1500,
      interval: 10,
    });
    await f.service.whenIdle();
    await expect(sendCallback(url)).rejects.toThrow();
    expect(f.exchangeCode).not.toHaveBeenCalled();
    noToken(f);
  });

  it("keeps browser handoff work reserved through cancellation instead of disposing its dependency early", async () => {
    const browser = deferred<void>();
    const opened = deferred<string>();
    const f = fixture({
      openAuthorizationUrl: (url) => {
        opened.resolve(url);
        return browser.promise;
      },
    });
    drains.push(() => browser.resolve());
    const start = f.service.start(f.account.id);
    const url = await opened.promise;
    f.service.cancel(f.account.id);
    await expect(f.service.start(f.account.id)).rejects.toMatchObject({ code: "GLOBAL_OAUTH_BUSY" });
    const busy = await isStillBusy(f.service);
    expect(f.lease.release).not.toHaveBeenCalled();
    browser.resolve();
    expect(await start).toMatchObject({ phase: "cancelled" });
    await busy.promise;
    await expect(sendCallback(callback(url))).rejects.toThrow();
  });

  it("does not revive an authorized projection after local disconnect while browser handoff still drains", async () => {
    const browser = deferred<void>();
    const opened = deferred<string>();
    drains.push(() => browser.resolve());
    const f = fixture({
      openAuthorizationUrl: (url) => {
        opened.resolve(url);
        return browser.promise;
      },
    });
    const start = f.service.start(f.account.id);
    const url = await opened.promise;
    await sendCallback(callback(url));
    await vi.waitFor(() => expect(f.service.state(f.account.id).phase).toBe("authorized"));
    expect(f.tokens.read(f.account.id)?.accessToken).toBe("private-synthetic-access");
    f.service.invalidateAccount(f.account.id);
    new GlobalAuthorizationStore(f.store.db).disconnect(f.account.id);
    expect(f.service.state(f.account.id).phase).toBe("idle");
    const busy = await isStillBusy(f.service);
    browser.resolve();
    expect(await start).toMatchObject({ phase: "idle" });
    await busy.promise;
    expect(f.service.state(f.account.id).phase).toBe("idle");
    expect(f.accounts.get(f.account.id)).toMatchObject({ authStatus: "unauthorized", remoteId: null });
    noToken(f);
  });

  it("does not continue when browser opening rejects, and only exposes a fixed failure", async () => {
    const f = fixture({
      openAuthorizationUrl: async () => {
        throw new Error("https://private-url/?state=private-state");
      },
    });
    expect(await f.service.start(f.account.id)).toMatchObject({
      phase: "failed",
      errorCode: "GLOBAL_OAUTH_FAILED",
    });
    await f.service.whenIdle();
    noToken(f);
    expect(f.lease.release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.service.state(f.account.id))).not.toContain("private-state");
  });

  it("reports a failed vault commit without marking the service or account authorized", async () => {
    const f = fixture();
    await f.service.start(f.account.id);
    f.store.db.exec(
      "CREATE TRIGGER ignore_oauth_token BEFORE INSERT ON credentials WHEN NEW.kind = 'oauth_token' BEGIN SELECT RAISE(IGNORE); END",
    );
    await sendCallback(callback(f.urls[0]));
    await f.service.whenIdle();
    expect(f.service.state(f.account.id)).toMatchObject({ phase: "failed" });
    expect(f.accounts.get(f.account.id)?.authStatus).toBe("unauthorized");
    noToken(f);
  });

  it("rejects invalid and deleted account IDs before any authorization work", async () => {
    const f = fixture();
    for (const id of ["youtube", "default", randomUUID()])
      await expect(f.service.start(id)).rejects.toMatchObject({ code: "GLOBAL_OAUTH_INVALID_ACCOUNT" });
    f.accounts.delete(f.account.id);
    await expect(f.service.start(f.account.id)).rejects.toMatchObject({
      code: "GLOBAL_OAUTH_INVALID_ACCOUNT",
    });
    expect(f.acquireEligibility).not.toHaveBeenCalled();
  });
});
