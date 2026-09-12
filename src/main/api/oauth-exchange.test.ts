import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_APP_PROFILES, type GlobalAppConfiguration } from "@shared/global-apps";
import type { GlobalPlatformId } from "@shared/platforms";
import type { OAuthCodeExchangeInput } from "./oauth-flow";
import type { ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";
import { OAuthCodeExchanger, OAuthExchangeError } from "./oauth-exchange";

const channelId = `UC${"a".repeat(22)}`;
const stamp = Date.parse("2026-09-08T06:00:00.000Z");
function response(body: unknown, status = 200): ProxyTransportResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify(body)),
  };
}
function fixture(platformId: GlobalPlatformId = "youtube") {
  let now = stamp,
    live = true;
  const controller = new AbortController();
  const app: GlobalAppConfiguration = {
    id: randomUUID(),
    platformId,
    clientId: "original-client",
    redirectPort: platformId === "youtube" ? 0 : 3456,
    createdAt: new Date(stamp).toISOString(),
    updatedAt: new Date(stamp).toISOString(),
  };
  const context: OAuthCodeExchangeInput = {
    transactionId: randomUUID(),
    accountId: randomUUID(),
    platformId,
    clientId: app.clientId,
    redirectUri: "http://127.0.0.1:3456/oauth/callback",
    generation: 2,
    signal: controller.signal,
    assertCurrent: vi.fn(() => {
      if (!live) throw new Error("PRIVATE_REVOKED_DETAIL");
    }),
    code: "already-decoded+code/%2F?value=synthetic",
    codeVerifier: "v".repeat(86),
  };
  const grant: Record<string, unknown> = {
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    scope: GLOBAL_APP_PROFILES[platformId].scopes.join(platformId === "tiktok" ? "," : " "),
    ...(platformId === "tiktok" ? { open_id: "synthetic-open-id", refresh_expires_in: 86400 } : {}),
  };
  const identity: Record<string, unknown> =
    platformId === "youtube"
      ? { items: [{ id: channelId }] }
      : platformId === "tiktok"
        ? {
            data: { user: { open_id: "synthetic-open-id" } },
            error: { code: "ok", message: "", log_id: "not-returned" },
          }
        : { data: { id: "1234567890123456789", name: "not-returned" } };
  const request = vi
    .fn<(input: ProxyTransportRequest) => Promise<ProxyTransportResponse>>()
    .mockImplementationOnce(async () => response(grant))
    .mockImplementationOnce(async () => response(identity));
  const readClientSecret = vi.fn((_app: Readonly<GlobalAppConfiguration>) =>
    platformId === "tiktok" ? "synthetic-secret&+%" : null,
  );
  const exchanger = new OAuthCodeExchanger({ transport: { request }, readClientSecret, now: () => now });
  return {
    app,
    context,
    grant,
    identity,
    request,
    readClientSecret,
    exchanger,
    controller,
    revoke: () => {
      live = false;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("official authorization code exchange via the explicit proxy", () => {
  it("preserves Google's explicit refresh expiry from the original request start", async () => {
    const f = fixture();
    f.grant.refresh_token_expires_in = 86400;
    const result = await f.exchanger.exchange(f.context, f.app);
    expect(result.refreshExpiresAt).toBe(new Date(stamp + 86400_000).toISOString());
  });

  it("refuses a new TikTok refresh grant without a known valid refresh deadline before identity HTTP", async () => {
    const f = fixture("tiktok");
    delete f.grant.refresh_expires_in;
    await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_RESPONSE_INVALID");
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each(["youtube", "tiktok", "x"] as const)(
    "confirms %s identity with two fixed requests and returns only the token envelope",
    async (platformId) => {
      const f = fixture(platformId);
      const forbiddenFetch = vi.fn(() => {
        throw new Error("NO_DEFAULT_FETCH");
      });
      vi.stubGlobal("fetch", forbiddenFetch);
      const token = await f.exchanger.exchange(f.context, f.app);
      expect(token).toEqual({
        version: 1,
        accountId: f.context.accountId,
        platformId,
        remoteId:
          platformId === "youtube"
            ? channelId
            : platformId === "tiktok"
              ? "synthetic-open-id"
              : "1234567890123456789",
        tokenType: "Bearer",
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        ...(platformId === "tiktok" ? { refreshExpiresAt: new Date(stamp + 86400_000).toISOString() } : {}),
        scopes: [...GLOBAL_APP_PROFILES[platformId].scopes],
        expiresAt: new Date(stamp + 3_600_000).toISOString(),
      });
      expect(f.request).toHaveBeenCalledTimes(2);
      const [first, second] = f.request.mock.calls.map(([call]) => call);
      expect(first).toMatchObject({ platformId, method: "POST", signal: f.context.signal });
      const form = new URLSearchParams(String(first.body));
      expect(form.get("code")).toBe(f.context.code); // No second URL decode; form encoding is lossless.
      expect(form.get("code_verifier")).toBe(f.context.codeVerifier);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("redirect_uri")).toBe(f.context.redirectUri);
      expect(form.get(platformId === "tiktok" ? "client_key" : "client_id")).toBe(f.app.clientId);
      expect(first.headers).not.toHaveProperty("Authorization");
      expect(second).toMatchObject({
        platformId,
        method: "GET",
        signal: f.context.signal,
        headers: { Authorization: "Bearer synthetic-access" },
      });
      for (const call of [first, second]) {
        expect(call.url).not.toContain("synthetic");
        expect(call.headers).not.toHaveProperty("Cookie");
        expect(call.headers).not.toHaveProperty("Proxy-Authorization");
      }
      if (platformId === "youtube") {
        expect(first.url).toBe("https://oauth2.googleapis.com/token");
        expect(second.url).toBe(
          "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=2",
        );
        expect(form.has("client_secret")).toBe(false);
      } else if (platformId === "tiktok") {
        expect(first.url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
        expect(second.url).toBe("https://open.tiktokapis.com/v2/user/info/?fields=open_id");
        expect(form.get("client_secret")).toBe("synthetic-secret&+%");
      } else {
        expect(first.url).toBe("https://api.x.com/2/oauth2/token");
        expect(second.url).toBe("https://api.x.com/2/users/me");
        expect(form.has("client_secret")).toBe(false);
        expect(f.readClientSecret).not.toHaveBeenCalled();
      }
      expect(forbiddenFetch).not.toHaveBeenCalled();
    },
  );

  it("supports Google's optional app secret and an absent refresh token without inventing one", async () => {
    const f = fixture();
    f.readClientSecret.mockReturnValue("optional-secret");
    delete f.grant.refresh_token;
    const token = await f.exchanger.exchange(f.context, f.app);
    expect(token).not.toHaveProperty("refreshToken");
    expect(new URLSearchParams(String(f.request.mock.calls[0][0].body)).get("client_secret")).toBe(
      "optional-secret",
    );
    expect(f.readClientSecret).toHaveBeenCalledWith(f.app);
    expect(Object.isFrozen(f.readClientSecret.mock.calls[0][0])).toBe(true);
  });

  it.each([null, "", " "])("rejects missing or empty TikTok secret before any HTTP: %s", async (secret) => {
    const f = fixture("tiktok");
    f.readClientSecret.mockReturnValue(secret);
    await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_SECRET_UNAVAILABLE");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not silently omit an unreadable optional Google secret", async () => {
    const f = fixture();
    f.readClientSecret.mockImplementation(() => {
      throw new Error("SECRET_PROVIDER_PRIVATE");
    });
    await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_SECRET_UNAVAILABLE");
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    { platformId: "x" },
    { clientId: "different-client" },
    { accountId: "invalid" },
    { redirectUri: "http://localhost:3456/oauth/callback" },
    { redirectUri: "http://127.0.0.1:3456/oauth/callback?code=private" },
    { redirectUri: "http://user@127.0.0.1:3456/oauth/callback" },
    { redirectUri: "http://127.0.0.1:80/oauth/callback" },
    { codeVerifier: "short" },
    { code: "bad\r\nvalue" },
  ])("rejects mismatched or malformed input before reading a secret: %j", async (patch) => {
    const f = fixture();
    await expect(
      f.exchanger.exchange({ ...f.context, ...patch } as OAuthCodeExchangeInput, f.app),
    ).rejects.toThrow("OAUTH_EXCHANGE_INPUT_INVALID");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.readClientSecret).not.toHaveBeenCalled();
  });

  it("requires the registered fixed port for TikTok and X", async () => {
    for (const platformId of ["tiktok", "x"] as const) {
      const f = fixture(platformId);
      await expect(
        f.exchanger.exchange({ ...f.context, redirectUri: "http://127.0.0.1:3457/oauth/callback" }, f.app),
      ).rejects.toThrow("OAUTH_EXCHANGE_INPUT_INVALID");
      expect(f.request).not.toHaveBeenCalled();
    }
  });

  it.each(["youtube", "tiktok", "x"] as const)(
    "does not fetch identity when %s grant omits required scope",
    async (platformId) => {
      const f = fixture(platformId);
      f.grant.scope = "unrelated.read";
      await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_SCOPE_MISSING");
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, "", "users.read users.read", "users.read\ttweet.read offline.access"])(
    "does not infer missing or malformed granted scopes: %s",
    async (scope) => {
      const f = fixture("x");
      f.grant.scope = scope;
      await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_SCOPE_MISSING");
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { expires_in: undefined },
    { expires_in: "3600" },
    { expires_in: 0 },
    { expires_in: -1 },
    { expires_in: 0.5 },
    { token_type: "DPoP" },
    { access_token: "bad\r\nvalue" },
    { refresh_token: null },
    { error: "PRIVATE_PROVIDER_ERROR" },
  ])("rejects invalid token contract %j", async (patch) => {
    const f = fixture();
    Object.assign(f.grant, patch);
    await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_RESPONSE_INVALID");
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each([204, 302, 400, 401, 403, 429, 500])(
    "does not retry HTTP %s or forward its body",
    async (status) => {
      const f = fixture();
      f.request.mockReset().mockResolvedValue(response({ error_description: "PRIVATE_DIAGNOSTIC" }, status));
      let failure: unknown;
      try {
        await f.exchanger.exchange(f.context, f.app);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OAuthExchangeError);
      expect(String(failure)).toBe("OAuthExchangeError: OAUTH_EXCHANGE_RESPONSE_INVALID");
      expect(failure).not.toHaveProperty("cause");
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["html", "bad-json", "too-large", "bad-utf8", "array"])(
    "rejects a non-conforming response: %s",
    async (kind) => {
      const f = fixture();
      const value = response(f.grant);
      if (kind === "html") value.headers = { "content-type": "text/html" };
      if (kind === "bad-json") value.body = Buffer.from("{private");
      if (kind === "too-large") value.body = Buffer.alloc(65_537, 32);
      if (kind === "bad-utf8") value.body = Buffer.from([0xff, 0xfe]);
      if (kind === "array") value.body = Buffer.from("[]");
      f.request.mockReset().mockResolvedValue(value);
      await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_RESPONSE_INVALID");
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { items: [] },
    { items: [{ id: channelId }, { id: channelId }] },
    { items: [{ id: channelId }], nextPageToken: "another" },
    { items: [{ id: "not-a-channel" }] },
    { items: [{ id: channelId }], error: { code: 403 } },
  ])("does not pick an arbitrary or invalid YouTube identity: %j", async (body) => {
    const f = fixture();
    f.request.mockReset().mockResolvedValueOnce(response(f.grant)).mockResolvedValueOnce(response(body));
    await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow(
      "OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED",
    );
  });

  it.each(["different-id", "error", "missing-error"])(
    "does not confirm TikTok identity from token alone: %s",
    async (kind) => {
      const f = fixture("tiktok");
      if (kind === "different-id") f.identity.data = { user: { open_id: "different" } };
      if (kind === "error") f.identity.error = { code: "access_token_invalid", message: "PRIVATE" };
      if (kind === "missing-error") delete f.identity.error;
      await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow(
        "OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED",
      );
    },
  );

  it.each([{ data: {} }, { data: { id: 123 } }, { data: { id: "123" }, errors: [{ detail: "PRIVATE" }] }])(
    "rejects partial or missing X identity: %j",
    async (identity) => {
      const f = fixture("x");
      Object.assign(f.identity, identity);
      await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow(
        "OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED",
      );
    },
  );

  it("derives expiry from before token HTTP, never extends it by time spent confirming identity", async () => {
    const f = fixture();
    f.request
      .mockReset()
      .mockImplementationOnce(async () => {
        f.setNow(stamp + 5000);
        return response(f.grant);
      })
      .mockImplementationOnce(async () => {
        f.setNow(stamp + 10_000);
        return response(f.identity);
      });
    expect((await f.exchanger.exchange(f.context, f.app)).expiresAt).toBe(
      new Date(stamp + 3_600_000).toISOString(),
    );
  });

  it("does not send an expired access token to identity or return one that expired in flight", async () => {
    for (const atIdentity of [false, true]) {
      const f = fixture();
      f.grant.expires_in = 1;
      f.request
        .mockReset()
        .mockImplementationOnce(async () => {
          if (!atIdentity) f.setNow(stamp + 1000);
          return response(f.grant);
        })
        .mockImplementationOnce(async () => {
          f.setNow(stamp + 1000);
          return response(f.identity);
        });
      await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_TOKEN_EXPIRED");
      expect(f.request).toHaveBeenCalledTimes(atIdentity ? 2 : 1);
    }
  });

  it.each(["initial", "secret-read", "token-await", "identity-await", "abort"])(
    "does not publish or continue after revocation at %s",
    async (point) => {
      const f = fixture();
      if (point === "initial") f.revoke();
      if (point === "secret-read")
        f.readClientSecret.mockImplementation(() => {
          f.revoke();
          return "secret";
        });
      if (point === "token-await" || point === "abort")
        f.request.mockReset().mockImplementation(async () => {
          if (point === "abort") f.controller.abort("PRIVATE_ABORT_DETAIL");
          else f.revoke();
          return response(f.grant);
        });
      if (point === "identity-await")
        f.request
          .mockReset()
          .mockResolvedValueOnce(response(f.grant))
          .mockImplementationOnce(async () => {
            f.revoke();
            return response(f.identity);
          });
      await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_REVOKED");
      expect(f.request).toHaveBeenCalledTimes(
        point === "initial" || point === "secret-read" ? 0 : point === "identity-await" ? 2 : 1,
      );
    },
  );

  it("passes cancellation to the real transport contract and does not rescue a late success", async () => {
    const f = fixture();
    let release!: (result: ProxyTransportResponse) => void;
    f.request.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.exchanger.exchange(f.context, f.app);
    const assertion = expect(pending).rejects.toThrow("OAUTH_EXCHANGE_REVOKED");
    f.controller.abort();
    expect(f.request.mock.calls[0][0].signal?.aborted).toBe(true);
    release(response(f.grant));
    await assertion;
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("snapshots transaction and public configuration before yielding", async () => {
    const f = fixture();
    const originalId = f.context.accountId;
    f.request
      .mockReset()
      .mockImplementationOnce(async () => {
        Object.assign(f.context, { accountId: randomUUID(), clientId: "replacement", platformId: "x" });
        Object.assign(f.app, { platformId: "x", clientId: "replacement" });
        return response(f.grant);
      })
      .mockResolvedValueOnce(response(f.identity));
    expect(await f.exchanger.exchange(f.context, f.app)).toMatchObject({
      accountId: originalId,
      platformId: "youtube",
    });
    expect(f.request.mock.calls[1][0].platformId).toBe("youtube");
  });

  it("keeps transport failure diagnostics fixed and makes no retry or direct fallback", async () => {
    const f = fixture();
    f.request.mockReset().mockRejectedValue(new Error("PRIVATE_TOKEN_URL_secret=do-not-log"));
    await expect(f.exchanger.exchange(f.context, f.app)).rejects.toThrow("OAUTH_EXCHANGE_REQUEST_FAILED");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
