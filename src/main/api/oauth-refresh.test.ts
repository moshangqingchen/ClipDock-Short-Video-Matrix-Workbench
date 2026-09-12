import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_APP_PROFILES, type GlobalAppConfiguration } from "@shared/global-apps";
import type { GlobalPlatformId } from "@shared/platforms";
import type { GlobalTokenEnvelope } from "./global-token-store";
import type { ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";
import { OAuthRefreshError, OAuthTokenRefresher, type OAuthTokenRefreshInput } from "./oauth-refresh";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const stamp = Date.parse("2026-09-08T08:00:00.000Z");
const response = (body: unknown, status = 200): ProxyTransportResponse => ({
  status,
  headers: { "content-type": "application/json; charset=UTF-8" },
  body: Buffer.from(JSON.stringify(body)),
});
function fixture(platformId: GlobalPlatformId = "youtube") {
  let now = stamp,
    live = true;
  const abort = new AbortController();
  const token: GlobalTokenEnvelope = {
    version: 1,
    accountId: randomUUID(),
    platformId,
    remoteId:
      platformId === "youtube"
        ? `UC${"a".repeat(22)}`
        : platformId === "x"
          ? "123456789"
          : "synthetic-open-id",
    tokenType: "Bearer",
    accessToken: "synthetic-old-access",
    refreshToken: "synthetic+old/refresh%2F&?",
    scopes: [...GLOBAL_APP_PROFILES[platformId].scopes],
    // Access expiry is deliberately in the past: this module refreshes an existing grant.
    expiresAt: new Date(stamp - 1000).toISOString(),
    ...(platformId === "tiktok" ? { refreshExpiresAt: new Date(stamp + 86_400_000).toISOString() } : {}),
  };
  const app: GlobalAppConfiguration = {
    id: randomUUID(),
    platformId,
    clientId: "original-client",
    redirectPort: platformId === "youtube" ? 0 : 3456,
    createdAt: new Date(stamp).toISOString(),
    updatedAt: new Date(stamp).toISOString(),
  };
  const input: OAuthTokenRefreshInput = {
    token,
    app,
    signal: abort.signal,
    assertCurrent: vi.fn(() => {
      if (!live) throw new Error("PRIVATE_REVOKED_MESSAGE");
    }),
  };
  const grant: Record<string, unknown> = {
    access_token: "synthetic-new-access",
    token_type: "bearer",
    expires_in: 3600,
    scope: token.scopes.join(platformId === "tiktok" ? "," : " "),
    ...(platformId === "tiktok"
      ? { open_id: token.remoteId, refresh_token: "rotated-refresh", refresh_expires_in: 604800 }
      : {}),
  };
  const request = vi.fn<(value: ProxyTransportRequest) => Promise<ProxyTransportResponse>>(async () =>
    response(grant),
  );
  const readClientSecret = vi.fn((_app: Readonly<GlobalAppConfiguration>) =>
    platformId === "tiktok" ? "synthetic+secret&%" : null,
  );
  const refresher = new OAuthTokenRefresher({ transport: { request }, readClientSecret, now: () => now });
  return {
    input,
    token,
    app,
    grant,
    request,
    readClientSecret,
    refresher,
    abort,
    revoke: () => {
      live = false;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("main-only official refresh through the injected proxy", () => {
  it.each(["youtube", "tiktok", "x"] as const)(
    "refreshes %s with one fixed POST and unchanged account identity",
    async (platformId) => {
      const f = fixture(platformId),
        original = structuredClone(f.token);
      const defaultFetch = vi.fn(() => {
        throw new Error("NO_DEFAULT_FETCH");
      });
      vi.stubGlobal("fetch", defaultFetch);
      const result = await f.refresher.refresh(f.input);
      expect(result).toMatchObject({
        version: 1,
        accountId: original.accountId,
        platformId,
        remoteId: original.remoteId,
        tokenType: "Bearer",
        accessToken: "synthetic-new-access",
        scopes: original.scopes,
        expiresAt: new Date(stamp + 3_600_000).toISOString(),
      });
      expect(f.token).toEqual(original);
      expect(f.request).toHaveBeenCalledTimes(1);
      const call = f.request.mock.calls[0][0];
      expect(call).toMatchObject({
        platformId,
        method: "POST",
        signal: f.abort.signal,
        url: {
          youtube: "https://oauth2.googleapis.com/token",
          tiktok: "https://open.tiktokapis.com/v2/oauth/token/",
          x: "https://api.x.com/2/oauth2/token",
        }[platformId],
      });
      const form = new URLSearchParams(String(call.body));
      expect(form.get("refresh_token")).toBe(original.refreshToken);
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get(platformId === "tiktok" ? "client_key" : "client_id")).toBe(f.app.clientId);
      for (const name of ["code", "code_verifier", "redirect_uri", "scope", "access_token"])
        expect(form.has(name)).toBe(false);
      expect(call.headers).not.toHaveProperty("Authorization");
      expect(call.headers).not.toHaveProperty("Cookie");
      expect(defaultFetch).not.toHaveBeenCalled();
      if (platformId === "x") {
        expect(f.readClientSecret).not.toHaveBeenCalled();
        expect(form.has("client_secret")).toBe(false);
      }
      if (platformId === "tiktok")
        expect(result).toMatchObject({
          refreshToken: "rotated-refresh",
          refreshExpiresAt: new Date(stamp + 604_800_000).toISOString(),
        });
    },
  );

  it.each(["youtube", "x"] as const)(
    "preserves %s refresh and original deadline when absent from the response",
    async (platformId) => {
      const f = fixture(platformId);
      f.token.refreshExpiresAt = new Date(stamp + 86_400_000).toISOString();
      const result = await f.refresher.refresh(f.input);
      expect(result.refreshToken).toBe(f.token.refreshToken);
      expect(result.refreshExpiresAt).toBe(f.token.refreshExpiresAt);
    },
  );
  it.each(["youtube", "x"] as const)(
    "uses %s rotated refresh without inventing a new missing refresh expiry",
    async (platformId) => {
      const f = fixture(platformId);
      f.token.refreshExpiresAt = new Date(stamp + 86_400_000).toISOString();
      f.grant.refresh_token = "new-rotated-refresh";
      const result = await f.refresher.refresh(f.input);
      expect(result.refreshToken).toBe("new-rotated-refresh");
      expect(result.refreshExpiresAt).toBe(f.token.refreshExpiresAt);
    },
  );
  it("preserves Google's explicit time-limited refresh lifetime from the original request start", async () => {
    const f = fixture();
    f.grant.refresh_token_expires_in = 7200;
    f.request.mockImplementation(async () => {
      f.setNow(stamp + 2500);
      return response(f.grant);
    });
    const result = await f.refresher.refresh(f.input);
    expect(result.expiresAt).toBe(new Date(stamp + 3_600_000).toISOString());
    expect(result.refreshExpiresAt).toBe(new Date(stamp + 7_200_000).toISOString());
  });
  it("includes an optional Google client secret but never reads an X secret", async () => {
    const f = fixture();
    f.readClientSecret.mockReturnValue("google-secret+&%");
    await f.refresher.refresh(f.input);
    expect(new URLSearchParams(String(f.request.mock.calls[0][0].body)).get("client_secret")).toBe(
      "google-secret+&%",
    );
  });
  it.each(["missing-token", "expired", "missing-tiktok-expiry"])(
    "does not send when refresh is %s",
    async (mode) => {
      const f = fixture(mode === "missing-tiktok-expiry" ? "tiktok" : "youtube");
      if (mode === "missing-token") delete f.token.refreshToken;
      if (mode === "expired") f.token.refreshExpiresAt = new Date(stamp).toISOString();
      if (mode === "missing-tiktok-expiry") delete f.token.refreshExpiresAt;
      await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({
        code: "OAUTH_REFRESH_REAUTH_REQUIRED",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("rechecks a known refresh expiry after the secret callback", async () => {
    const f = fixture("tiktok");
    f.token.refreshExpiresAt = new Date(stamp + 1000).toISOString();
    f.readClientSecret.mockImplementation(() => {
      f.setNow(stamp + 1000);
      return "secret";
    });
    await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({
      code: "OAUTH_REFRESH_REAUTH_REQUIRED",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["missing", "throws", "empty"])("refuses a %s required TikTok secret", async (mode) => {
    const f = fixture("tiktok");
    f.readClientSecret.mockImplementation(() => {
      if (mode === "throws") throw new Error("SECRET_ERROR");
      return mode === "missing" ? null : "";
    });
    await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({
      code: "OAUTH_REFRESH_SECRET_UNAVAILABLE",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("allows a narrower grant that still covers the current profile", async () => {
    const f = fixture();
    f.token.scopes.push("https://www.googleapis.com/auth/youtube.upload");
    expect((await f.refresher.refresh(f.input)).scopes).toEqual(GLOBAL_APP_PROFILES.youtube.scopes);
  });
  it.each(["youtube", "x"] as const)(
    "only inherits already granted %s scopes when the response omits scope",
    async (platformId) => {
      const f = fixture(platformId);
      delete f.grant.scope;
      expect((await f.refresher.refresh(f.input)).scopes).toEqual(f.token.scopes);
    },
  );
  it.each(["expansion", "missing-required", "duplicate", "empty", "tiktok-missing"])(
    "rejects %s scopes",
    async (mode) => {
      const f = fixture(mode === "tiktok-missing" ? "tiktok" : "youtube");
      if (mode === "expansion") f.grant.scope += " https://www.googleapis.com/auth/youtube.upload";
      if (mode === "missing-required") f.grant.scope = "read.unrelated";
      if (mode === "duplicate") f.grant.scope += ` ${f.grant.scope}`;
      if (mode === "empty") f.grant.scope = "";
      if (mode === "tiktok-missing") delete f.grant.scope;
      await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({
        code: "OAUTH_REFRESH_SCOPE_MISSING",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("does not accept a TikTok refresh response for another remote identity", async () => {
    const f = fixture("tiktok");
    f.grant.open_id = "another-user";
    await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({
      code: "OAUTH_REFRESH_IDENTITY_MISMATCH",
    });
    expect(f.token.remoteId).toBe("synthetic-open-id");
  });
  it.each(["refresh_token", "refresh_expires_in"])("requires TikTok refresh response %s", async (field) => {
    const f = fixture("tiktok");
    delete f.grant[field];
    await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({
      code: "OAUTH_REFRESH_RESPONSE_INVALID",
    });
  });
  it.each([
    [400, { error: "invalid_grant" }, "OAUTH_REFRESH_REAUTH_REQUIRED"],
    [401, { error: "invalid_client" }, "OAUTH_REFRESH_SECRET_UNAVAILABLE"],
    [429, { message: "raw-detail" }, "OAUTH_REFRESH_RATE_LIMITED"],
    [503, { error: "anything" }, "OAUTH_REFRESH_NETWORK_UNAVAILABLE"],
    [400, { error: "temporarily_unavailable" }, "OAUTH_REFRESH_NETWORK_UNAVAILABLE"],
    [403, { message: "challenge" }, "OAUTH_REFRESH_RESPONSE_INVALID"],
  ] as const)(
    "classifies HTTP %s without exposing provider details or retrying",
    async (status, body, code) => {
      const f = fixture();
      f.request.mockResolvedValue(response({ ...body, error_description: "RAW_SECRET_DETAIL" }, status));
      const error = await f.refresher.refresh(f.input).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(OAuthRefreshError);
      expect(error).toMatchObject({ code, message: code });
      expect(JSON.stringify(error)).not.toMatch(/RAW_SECRET|raw-detail|synthetic|oauth2/);
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("classifies a transport failure without retaining its secret error", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("TOKEN_SECRET_URL"));
    await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({
      code: "OAUTH_REFRESH_NETWORK_UNAVAILABLE",
      message: "OAUTH_REFRESH_NETWORK_UNAVAILABLE",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["before", "secret", "response", "reject"])(
    "refuses revocation at %s without publishing a refreshed token",
    async (stage) => {
      const f = fixture();
      if (stage === "before") f.abort.abort();
      if (stage === "secret")
        f.readClientSecret.mockImplementation(() => {
          f.revoke();
          return null;
        });
      if (stage === "response")
        f.request.mockImplementation(async () => {
          f.revoke();
          return response(f.grant);
        });
      if (stage === "reject")
        f.request.mockImplementation(async () => {
          f.abort.abort();
          throw new Error("SECRET");
        });
      await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({ code: "OAUTH_REFRESH_REVOKED" });
      expect(f.request).toHaveBeenCalledTimes(stage === "before" || stage === "secret" ? 0 : 1);
    },
  );
  it("snapshots caller identity, refresh and app metadata before the dependency runs", async () => {
    const f = fixture(),
      original = structuredClone(f.token),
      originalApp = structuredClone(f.app);
    f.readClientSecret.mockImplementation((app) => {
      expect(Object.isFrozen(app)).toBe(true);
      f.token.accountId = randomUUID();
      f.token.remoteId = "mutated-user";
      f.token.refreshToken = "mutated-refresh";
      f.token.scopes.length = 0;
      f.app.clientId = "mutated-client";
      return null;
    });
    const result = await f.refresher.refresh(f.input);
    expect(result.accountId).toBe(original.accountId);
    expect(result.remoteId).toBe(original.remoteId);
    expect(result.refreshToken).toBe(original.refreshToken);
    const form = new URLSearchParams(String(f.request.mock.calls[0][0].body));
    expect(form.get("client_id")).toBe(originalApp.clientId);
    expect(form.get("refresh_token")).toBe(original.refreshToken);
  });
  it.each([
    "zero-ttl",
    "string-ttl",
    "overflow",
    "expired-body",
    "wrong-type",
    "invalid-refresh",
    "bad-json",
    "bad-utf8",
    "oversize",
    "wrong-mime",
  ])("rejects %s without replacing the original token", async (mode) => {
    const f = fixture(),
      original = structuredClone(f.token);
    if (mode === "zero-ttl") f.grant.expires_in = 0;
    if (mode === "string-ttl") f.grant.expires_in = "3600";
    if (mode === "overflow") f.grant.expires_in = Number.MAX_SAFE_INTEGER;
    if (mode === "wrong-type") f.grant.token_type = "DPoP";
    if (mode === "invalid-refresh") f.grant.refresh_token = "bad\nrefresh";
    const value = response(f.grant);
    if (mode === "bad-json") value.body = Buffer.from("not-json");
    if (mode === "bad-utf8") value.body = Buffer.from([0xff]);
    if (mode === "oversize") value.body = Buffer.alloc(65537);
    if (mode === "wrong-mime") value.headers = { "content-type": "text/html" };
    f.request.mockImplementation(async () => {
      if (mode === "expired-body") f.setNow(stamp + 3_600_000);
      return value;
    });
    await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({
      code: "OAUTH_REFRESH_RESPONSE_INVALID",
    });
    expect(f.token).toEqual(original);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("refuses a mismatched app before any secret or transport access", async () => {
    const f = fixture();
    f.app.platformId = "x";
    f.app.redirectPort = 3456;
    await expect(f.refresher.refresh(f.input)).rejects.toMatchObject({ code: "OAUTH_REFRESH_INPUT_INVALID" });
    expect(f.readClientSecret).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });
});
