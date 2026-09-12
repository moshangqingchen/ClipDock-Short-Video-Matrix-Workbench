import { createHash } from "node:crypto";
import { request, createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAuthFlowManager,
  type OAuthCodeExchangeInput,
  type OAuthFlowHandle,
  type OAuthFlowOptions,
  type OAuthPlatformConfiguration,
} from "./oauth-flow";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
type Tokens = { accessToken: string };
const tokens = { accessToken: "synthetic-access-token-do-not-return" };
const profiles: OAuthPlatformConfiguration[] = [
  {
    platformId: "youtube",
    profile: "google-desktop-s256",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    clientId: "synthetic-client",
    scopes: ["scope.read", "scope.write"],
    redirectPort: 0,
    redirectPath: "/oauth/callback",
  },
  {
    platformId: "tiktok",
    profile: "tiktok-desktop-hex-s256",
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    clientId: "synthetic-client",
    scopes: ["user.info.basic", "video.upload"],
    redirectPort: 0,
    redirectPath: "/oauth/callback",
  },
  {
    platformId: "x",
    profile: "x-s256",
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    clientId: "synthetic-client",
    scopes: ["users.read", "tweet.read"],
    redirectPort: 0,
    redirectPath: "/oauth/callback",
  },
];
const managers: OAuthFlowManager<Tokens>[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(overrides: Partial<OAuthFlowOptions<Tokens>> = {}) {
  let generation = 0;
  const exchangeCode = vi.fn(async (_input: OAuthCodeExchangeInput) => tokens);
  const saveTokens = vi.fn();
  const manager = new OAuthFlowManager<Tokens>({
    profiles,
    exchangeCode,
    saveTokens,
    getGeneration: () => generation,
    timeoutMs: 2000,
    ...overrides,
  });
  managers.push(manager);
  return { manager, exchangeCode, saveTokens, changeGeneration: () => generation++ };
}
function callback(handle: OAuthFlowHandle, params: Record<string, string> = { code: "synthetic-code" }) {
  const url = new URL(handle.redirectUri);
  url.searchParams.set("state", new URL(handle.authorizationUrl).searchParams.get("state")!);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}
function send(url: URL, options: { method?: string; host?: string; path?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        url,
        {
          method: options.method ?? "GET",
          path: options.path ?? `${url.pathname}${url.search}`,
          headers: options.host ? { Host: options.host } : undefined,
          agent: false,
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (part) => {
            body += part;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode!, body, headers: response.headers }),
          );
          response.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

describe("OAuthFlowManager loopback transactions", () => {
  it.each(profiles)(
    "exchanges and synchronously saves $platformId with its explicit PKCE encoding",
    async (profile) => {
      const { manager, exchangeCode, saveTokens } = fixture();
      const handle = await manager.start({ platformId: profile.platformId, accountId: ACCOUNT });
      const auth = new URL(handle.authorizationUrl);
      expect(new URL(handle.redirectUri).hostname).toBe("127.0.0.1");
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(auth.searchParams.get(profile.platformId === "tiktok" ? "client_key" : "client_id")).toBe(
        profile.clientId,
      );
      expect(auth.searchParams.get("scope")).toBe(
        profile.scopes.join(profile.platformId === "tiktok" ? "," : " "),
      );
      const reply = await send(callback(handle));
      expect(reply.status).toBe(200);
      expect(reply.headers["cache-control"]).toBe("no-store");
      const result = await handle.completion;
      expect(result).toEqual({
        transactionId: handle.transactionId,
        platformId: profile.platformId,
        accountId: ACCOUNT,
        status: "authorized",
      });
      expect(exchangeCode).toHaveBeenCalledTimes(1);
      const input = exchangeCode.mock.calls[0][0];
      expect(input.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
      expect(auth.searchParams.get("code_challenge")).toBe(
        createHash("sha256")
          .update(input.codeVerifier)
          .digest(profile.platformId === "tiktok" ? "hex" : "base64url"),
      );
      expect(input).toMatchObject({
        platformId: profile.platformId,
        accountId: ACCOUNT,
        redirectUri: handle.redirectUri,
        code: "synthetic-code",
        generation: 0,
      });
      expect(saveTokens).toHaveBeenCalledTimes(1);
      expect(saveTokens.mock.calls[0][0]).toEqual(tokens);
      expect(JSON.stringify(result) + reply.body).not.toContain(tokens.accessToken);
      expect(JSON.stringify(result) + reply.body).not.toContain(input.codeVerifier);
      await manager.whenIdle();
      await expect(send(callback(handle))).rejects.toThrow();
    },
  );

  it("creates independent cryptographic state and verifier for each account and binds state to its listener", async () => {
    const { manager, exchangeCode } = fixture();
    const one = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    const two = await manager.start({ platformId: "x", accountId: SECOND });
    const wrong = callback(two, {
      state: new URL(one.authorizationUrl).searchParams.get("state")!,
      code: "wrong-account-code",
    });
    expect((await send(wrong)).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    await send(callback(one));
    await send(callback(two));
    expect((await one.completion).status).toBe("authorized");
    expect((await two.completion).status).toBe("authorized");
    expect(exchangeCode.mock.calls[0][0].codeVerifier).not.toBe(exchangeCode.mock.calls[1][0].codeVerifier);
  });

  it.each([
    {
      label: "wrong state",
      mutate: (url: URL) => url.searchParams.set("state", "x".repeat(43)),
      options: {},
    },
    {
      label: "duplicate state",
      mutate: (url: URL) => url.searchParams.append("state", url.searchParams.get("state")!),
      options: {},
    },
    {
      label: "wrong path",
      mutate: (url: URL) => {
        url.pathname = "/other/callback";
      },
      options: {},
    },
    { label: "DNS Host header", mutate: (_url: URL) => undefined, options: { host: "localhost" } },
    { label: "external Host header", mutate: (_url: URL) => undefined, options: { host: "evil.example" } },
    { label: "POST", mutate: (_url: URL) => undefined, options: { method: "POST" } },
  ])("rejects $label without consuming the valid transaction", async ({ mutate, options }) => {
    const { manager, exchangeCode } = fixture();
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    const invalid = callback(handle);
    mutate(invalid);
    expect((await send(invalid, options)).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    await send(callback(handle));
    expect((await handle.completion).status).toBe("authorized");
  });

  it.each(["missing-code", "duplicate-code", "code-and-error"])(
    "consumes a valid state but rejects malformed %s",
    async (kind) => {
      const { manager, exchangeCode, saveTokens } = fixture();
      const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
      const url = callback(handle, kind === "missing-code" ? {} : { code: "synthetic" });
      if (kind === "duplicate-code") url.searchParams.append("code", "second");
      if (kind === "code-and-error") url.searchParams.append("error", "provider-detail");
      await send(url);
      expect(await handle.completion).toMatchObject({
        status: "failed",
        errorCode: "OAUTH_CALLBACK_INVALID",
      });
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(saveTokens).not.toHaveBeenCalled();
    },
  );

  it("does not reflect provider error descriptions or URLs", async () => {
    const { manager, exchangeCode } = fixture();
    const handle = await manager.start({ platformId: "tiktok", accountId: ACCOUNT });
    const response = await send(
      callback(handle, {
        error: "secret-provider-error",
        error_description: "token=secret",
        error_uri: "https://secret.example",
      }),
    );
    const result = await handle.completion;
    expect(result).toMatchObject({ status: "failed", errorCode: "OAUTH_DENIED" });
    expect(JSON.stringify(result) + response.body).not.toMatch(/secret|token=/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("allows a callback only once while exchange is still in flight", async () => {
    const waiting = deferred<Tokens>();
    const entered = deferred<void>();
    const exchangeCode = vi.fn(async () => {
      entered.resolve();
      return waiting.promise;
    });
    const { manager } = fixture({ exchangeCode });
    const handle = await manager.start({ platformId: "x", accountId: ACCOUNT });
    await send(callback(handle));
    await entered.promise;
    await expect(send(callback(handle))).rejects.toThrow();
    expect(exchangeCode).toHaveBeenCalledTimes(1);
    waiting.resolve(tokens);
    expect((await handle.completion).status).toBe("authorized");
  });

  it.each(["throw", "reject"])("sanitizes a token exchange %s and does not save", async (mode) => {
    const exchangeCode = vi.fn(() => {
      if (mode === "throw") throw new Error("secret-body-code");
      return Promise.reject(new Error("secret-body-code"));
    });
    const { manager, saveTokens } = fixture({ exchangeCode });
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    await send(callback(handle));
    expect(await handle.completion).toMatchObject({ status: "failed", errorCode: "OAUTH_EXCHANGE_FAILED" });
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it("does not mark authorized when the synchronous vault transaction fails", async () => {
    const { manager } = fixture({
      saveTokens: () => {
        throw new Error("secret database detail");
      },
    });
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    await send(callback(handle));
    expect(await handle.completion).toMatchObject({ status: "failed", errorCode: "OAUTH_SAVE_FAILED" });
  });

  it("never treats a fulfilled thenable save as a synchronous commit", async () => {
    const { manager } = fixture({ saveTokens: () => Promise.resolve() });
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    await send(callback(handle));
    expect(await handle.completion).toMatchObject({ status: "failed", errorCode: "OAUTH_SAVE_FAILED" });
  });

  it("rejects raw path normalization aliases rather than broadening the registered redirect", async () => {
    const { manager, exchangeCode } = fixture();
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    const url = callback(handle);
    expect((await send(url, { path: `/different/../oauth/callback${url.search}` })).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    await send(url);
    expect((await handle.completion).status).toBe("authorized");
  });

  it("does not lose the original network signal when the caller mutates its request object", async () => {
    const { manager, exchangeCode } = fixture();
    const original = new AbortController();
    const input = { platformId: "youtube" as const, accountId: ACCOUNT, signal: original.signal };
    const started = manager.start(input);
    input.signal = new AbortController().signal;
    const handle = await started;
    original.abort();
    expect((await handle.completion).status).toBe("cancelled");
    await manager.whenIdle();
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects an accidental async save, retains its work until drained, and never reports authorized", async () => {
    const pending = deferred<void>();
    const entered = deferred<void>();
    const { manager } = fixture({
      saveTokens: () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    await send(callback(handle));
    await entered.promise;
    handle.cancel();
    expect((await handle.completion).status).toBe("cancelled");
    let idle = false;
    const drain = manager.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    pending.resolve();
    await drain;
  });

  it.each(["cancel", "signal", "invalidate", "generation", "dispose"])(
    "blocks late exchange results after %s and holds the account slot until actual drain",
    async (mode) => {
      const waiting = deferred<Tokens>();
      const entered = deferred<OAuthCodeExchangeInput>();
      const controller = new AbortController();
      const { manager, saveTokens, changeGeneration } = fixture({
        exchangeCode: async (input) => {
          entered.resolve(input);
          return waiting.promise;
        },
      });
      const handle = await manager.start({
        platformId: "youtube",
        accountId: ACCOUNT,
        signal: controller.signal,
      });
      await send(callback(handle));
      const input = await entered.promise;
      let disposing: Promise<void> | undefined;
      if (mode === "cancel") handle.cancel();
      if (mode === "signal") controller.abort(new Error("secret external reason"));
      if (mode === "invalidate") manager.invalidate();
      if (mode === "generation") changeGeneration();
      if (mode === "dispose") disposing = manager.dispose();
      if (mode !== "generation") expect(input.signal.aborted).toBe(true);
      let idle = false;
      const drain = manager.whenIdle().then(() => {
        idle = true;
      });
      await Promise.resolve();
      expect(idle).toBe(false);
      if (mode !== "dispose")
        await expect(manager.start({ platformId: "x", accountId: ACCOUNT })).rejects.toMatchObject({
          code: "OAUTH_BUSY",
        });
      waiting.resolve(tokens);
      await drain;
      await disposing;
      expect(await handle.completion).toMatchObject({
        status: mode === "cancel" || mode === "signal" ? "cancelled" : "failed",
      });
      expect(saveTokens).not.toHaveBeenCalled();
    },
  );

  it("timeout closes an unused listener and does not exchange", async () => {
    const { manager, exchangeCode } = fixture({ timeoutMs: 40 });
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    expect(await handle.completion).toMatchObject({ status: "expired", errorCode: "OAUTH_EXPIRED" });
    await manager.whenIdle();
    await expect(send(callback(handle))).rejects.toThrow();
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("timeout during exchange aborts but waits for the real callback before releasing its slot", async () => {
    const waiting = deferred<Tokens>();
    const entered = deferred<OAuthCodeExchangeInput>();
    const { manager, saveTokens } = fixture({
      timeoutMs: 80,
      exchangeCode: async (input) => {
        entered.resolve(input);
        return waiting.promise;
      },
    });
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    await send(callback(handle));
    const input = await entered.promise;
    expect((await handle.completion).status).toBe("expired");
    expect(input.signal.aborted).toBe(true);
    await expect(manager.start({ platformId: "youtube", accountId: ACCOUNT })).rejects.toMatchObject({
      code: "OAUTH_BUSY",
    });
    waiting.resolve(tokens);
    await manager.whenIdle();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it("detects revocation reentered from the generation getter before synchronous save", async () => {
    let revoke = false;
    const f = fixture({
      getGeneration: () => {
        if (revoke) f.manager.invalidate();
        return 0;
      },
      exchangeCode: async () => {
        revoke = true;
        return tokens;
      },
    });
    const manager = f.manager;
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    await send(callback(handle));
    expect(await handle.completion).toMatchObject({ status: "failed", errorCode: "OAUTH_REVOKED" });
    expect(f.saveTokens).not.toHaveBeenCalled();
  });

  it("cancellation during startup leaves no late listener", async () => {
    const { manager, exchangeCode } = fixture();
    const controller = new AbortController();
    const started = manager.start({ platformId: "youtube", accountId: ACCOUNT, signal: controller.signal });
    controller.abort();
    await expect(started).rejects.toMatchObject({ code: "OAUTH_CANCELLED" });
    await manager.whenIdle();
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("sanitizes address-in-use and releases the failed startup slot", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("fixture failed");
    const { manager } = fixture({ profiles: [{ ...profiles[0], redirectPort: address.port }] });
    try {
      await expect(manager.start({ platformId: "youtube", accountId: ACCOUNT })).rejects.toMatchObject({
        code: "OAUTH_UNAVAILABLE",
      });
      await manager.whenIdle();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("snapshots mutable configuration and enforces maximum pending transactions", async () => {
    const profile = { ...profiles[0], scopes: [...profiles[0].scopes] };
    const { manager } = fixture({ profiles: [profile], maxConcurrent: 1 });
    profile.authorizeUrl = "https://untrusted.example";
    profile.scopes.push("extra.scope");
    const handle = await manager.start({ platformId: "youtube", accountId: ACCOUNT });
    expect(new URL(handle.authorizationUrl).hostname).toBe("accounts.google.com");
    expect(new URL(handle.authorizationUrl).searchParams.get("scope")).toBe("scope.read scope.write");
    await expect(manager.start({ platformId: "youtube", accountId: SECOND })).rejects.toMatchObject({
      code: "OAUTH_BUSY",
    });
    handle.cancel();
  });

  it.each([
    { authorizeUrl: "http://accounts.google.com/o/oauth2/v2/auth" },
    { authorizeUrl: "https://accounts.google.com@evil.example/" },
    { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=bad" },
    { profile: "tiktok-desktop-hex-s256" },
    { redirectPath: "//evil.example" },
    { redirectPath: "/callback?foo=bar" },
    { redirectPort: -1 },
    { scopes: ["scope token=secret"] },
  ])("rejects unsafe/mismatched profile configuration %#", (patch) => {
    expect(() => fixture({ profiles: [{ ...profiles[0], ...patch } as OAuthPlatformConfiguration] })).toThrow(
      "OAUTH_CONFIG_INVALID",
    );
  });
});
