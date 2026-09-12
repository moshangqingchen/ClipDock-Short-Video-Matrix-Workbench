import {
  GLOBAL_APP_PROFILES,
  globalAppConfigurationSchema,
  type GlobalAppConfiguration,
} from "@shared/global-apps";
import { globalTokenEnvelopeSchema, type GlobalTokenEnvelope } from "./global-token-store";
import type { ProxyTransport, ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";

export type OAuthRefreshErrorCode =
  | "OAUTH_REFRESH_INPUT_INVALID"
  | "OAUTH_REFRESH_REVOKED"
  | "OAUTH_REFRESH_SECRET_UNAVAILABLE"
  | "OAUTH_REFRESH_REAUTH_REQUIRED"
  | "OAUTH_REFRESH_RATE_LIMITED"
  | "OAUTH_REFRESH_NETWORK_UNAVAILABLE"
  | "OAUTH_REFRESH_RESPONSE_INVALID"
  | "OAUTH_REFRESH_SCOPE_MISSING"
  | "OAUTH_REFRESH_IDENTITY_MISMATCH";

/** Fixed codes only: never retain provider bodies, URLs or credential-bearing errors. */
export class OAuthRefreshError extends Error {
  constructor(readonly code: OAuthRefreshErrorCode) {
    super(code);
    this.name = "OAuthRefreshError";
  }
}

export interface OAuthTokenRefreshInput {
  token: GlobalTokenEnvelope;
  app: GlobalAppConfiguration;
  signal: AbortSignal;
  assertCurrent(): void;
}
export interface OAuthTokenRefresherOptions {
  transport: Pick<ProxyTransport, "request">;
  readClientSecret(app: Readonly<GlobalAppConfiguration>): string | null;
  /** Epoch milliseconds; access/refresh expiry is persisted as absolute ISO time. */
  now?(): number;
}

const ENDPOINTS = Object.freeze({
  youtube: "https://oauth2.googleapis.com/token",
  tiktok: "https://open.tiktokapis.com/v2/oauth/token/",
  x: "https://api.x.com/2/oauth2/token",
});
const MAX_RESPONSE_BYTES = 64 * 1024;
const secretString = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{1,16384}$/.test(value);
const scopeString = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(value);
function fail(code: OAuthRefreshErrorCode): never {
  throw new OAuthRefreshError(code);
}
function json(response: ProxyTransportResponse): Record<string, unknown> {
  if (response.status === 429) fail("OAUTH_REFRESH_RATE_LIMITED");
  if (response.status >= 500 && response.status <= 599) fail("OAUTH_REFRESH_NETWORK_UNAVAILABLE");
  if (
    !Buffer.isBuffer(response.body) ||
    response.body.length === 0 ||
    response.body.length > MAX_RESPONSE_BYTES
  )
    fail("OAUTH_REFRESH_RESPONSE_INVALID");
  const types = Object.entries(response.headers).filter(([key]) => key.toLowerCase() === "content-type");
  if (
    types.length !== 1 ||
    typeof types[0][1] !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(types[0][1])
  )
    fail("OAUTH_REFRESH_RESPONSE_INVALID");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  } catch {
    fail("OAUTH_REFRESH_RESPONSE_INVALID");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body))
    fail("OAUTH_REFRESH_RESPONSE_INVALID");
  const value = body as Record<string, unknown>;
  // Only provider-defined OAuth error names classify a grant/client failure. An arbitrary
  // 401/403 or HTML challenge does not prove that the user's refresh token was revoked.
  if (value.error !== undefined) {
    if (value.error === "invalid_grant" || value.error === "invalid_token")
      fail("OAUTH_REFRESH_REAUTH_REQUIRED");
    if (value.error === "invalid_client" || value.error === "unauthorized_client")
      fail("OAUTH_REFRESH_SECRET_UNAVAILABLE");
    if (value.error === "temporarily_unavailable" || value.error === "server_error")
      fail("OAUTH_REFRESH_NETWORK_UNAVAILABLE");
    fail("OAUTH_REFRESH_RESPONSE_INVALID");
  }
  if (response.status !== 200 || value.errors !== undefined) fail("OAUTH_REFRESH_RESPONSE_INVALID");
  return value;
}
function expiry(seconds: unknown, startedAt: number, now: number): number {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0)
    fail("OAUTH_REFRESH_RESPONSE_INVALID");
  const until = startedAt + seconds * 1000;
  if (!Number.isSafeInteger(until) || until > 8_640_000_000_000_000 || until <= now)
    fail("OAUTH_REFRESH_RESPONSE_INVALID");
  return until;
}
function scopes(body: Record<string, unknown>, token: GlobalTokenEnvelope): string[] {
  let granted: string[];
  if (body.scope === undefined && token.platformId !== "tiktok") {
    // RFC 6749 sections 5.1/6: omitted scope means unchanged; never infer new authority.
    granted = [...token.scopes];
  } else {
    if (typeof body.scope !== "string" || body.scope.length > 16_384) fail("OAUTH_REFRESH_SCOPE_MISSING");
    granted = body.scope.split(token.platformId === "tiktok" ? "," : " ");
  }
  if (
    !granted.length ||
    granted.length > 64 ||
    granted.some((scope) => !scopeString(scope) || !token.scopes.includes(scope)) ||
    new Set(granted).size !== granted.length ||
    GLOBAL_APP_PROFILES[token.platformId].scopes.some((required) => !granted.includes(required))
  )
    fail("OAUTH_REFRESH_SCOPE_MISSING");
  return granted;
}

/** One fixed refresh POST, solely through the injected proxy. The caller owns serialization,
 * live app/account binding, eligibility, durable rotation and any future retry policy. */
export class OAuthTokenRefresher {
  private readonly request: ProxyTransport["request"];
  private readonly readClientSecret: OAuthTokenRefresherOptions["readClientSecret"];
  private readonly now: () => number;

  constructor(options: OAuthTokenRefresherOptions) {
    if (
      typeof options?.transport?.request !== "function" ||
      typeof options.readClientSecret !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    )
      fail("OAUTH_REFRESH_INPUT_INVALID");
    this.request = options.transport.request.bind(options.transport);
    this.readClientSecret = options.readClientSecret;
    this.now = options.now ?? Date.now;
  }

  async refresh(input: OAuthTokenRefreshInput): Promise<GlobalTokenEnvelope> {
    try {
      return await this.run(input);
    } catch (error) {
      if (error instanceof OAuthRefreshError) throw error;
      throw new OAuthRefreshError("OAUTH_REFRESH_RESPONSE_INVALID");
    }
  }

  private async run(input: OAuthTokenRefreshInput): Promise<GlobalTokenEnvelope> {
    const appResult = globalAppConfigurationSchema.safeParse(input?.app);
    const tokenResult = globalTokenEnvelopeSchema.safeParse(input?.token);
    if (
      !appResult.success ||
      !tokenResult.success ||
      appResult.data.platformId !== tokenResult.data.platformId ||
      typeof input.assertCurrent !== "function" ||
      !input.signal ||
      typeof input.signal.aborted !== "boolean" ||
      typeof input.signal.addEventListener !== "function"
    )
      fail("OAUTH_REFRESH_INPUT_INVALID");
    // Parse/copy before invoking main dependencies; renderer/caller objects are never consulted again.
    const app = Object.freeze(appResult.data),
      token = tokenResult.data;
    const signal = input.signal,
      assertCurrent = input.assertCurrent.bind(input);
    const current = () => {
      try {
        if (signal.aborted) throw new Error();
        assertCurrent();
        if (signal.aborted) throw new Error();
      } catch {
        fail("OAUTH_REFRESH_REVOKED");
      }
    };
    const clock = () => {
      const value = this.now();
      current();
      if (!Number.isSafeInteger(value) || value < 0) fail("OAUTH_REFRESH_RESPONSE_INVALID");
      return value;
    };
    current();
    const beganAt = clock();
    const oldRefreshExpiry =
      token.refreshExpiresAt === undefined ? undefined : Date.parse(token.refreshExpiresAt);
    if (
      !secretString(token.refreshToken) ||
      (oldRefreshExpiry !== undefined && oldRefreshExpiry <= beganAt) ||
      (token.platformId === "tiktok" && oldRefreshExpiry === undefined)
    )
      fail("OAUTH_REFRESH_REAUTH_REQUIRED");
    if (GLOBAL_APP_PROFILES[token.platformId].scopes.some((required) => !token.scopes.includes(required)))
      fail("OAUTH_REFRESH_SCOPE_MISSING");
    let secret: string | null = null;
    if (token.platformId !== "x") {
      try {
        secret = this.readClientSecret(app);
      } catch {
        current();
        fail("OAUTH_REFRESH_SECRET_UNAVAILABLE");
      }
      current();
      if (
        (secret !== null && (typeof secret !== "string" || secret.length > 65_536 || !secret.trim())) ||
        (token.platformId === "tiktok" && secret === null)
      )
        fail("OAUTH_REFRESH_SECRET_UNAVAILABLE");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      [token.platformId === "tiktok" ? "client_key" : "client_id"]: app.clientId,
    });
    if (secret !== null) form.set("client_secret", secret);
    const startedAt = clock();
    if (startedAt < beganAt || (oldRefreshExpiry !== undefined && oldRefreshExpiry <= startedAt))
      fail("OAUTH_REFRESH_REAUTH_REQUIRED");
    const request: ProxyTransportRequest = {
      platformId: token.platformId,
      url: ENDPOINTS[token.platformId],
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
      body: form.toString(),
    };
    let response: ProxyTransportResponse;
    current();
    try {
      response = await this.request(request);
    } catch {
      current();
      fail("OAUTH_REFRESH_NETWORK_UNAVAILABLE");
    }
    current();
    const finishedAt = clock();
    if (finishedAt < startedAt) fail("OAUTH_REFRESH_RESPONSE_INVALID");
    const body = json(response);
    if (
      !secretString(body.access_token) ||
      typeof body.token_type !== "string" ||
      body.token_type.toLowerCase() !== "bearer" ||
      (body.refresh_token !== undefined && !secretString(body.refresh_token))
    )
      fail("OAUTH_REFRESH_RESPONSE_INVALID");
    const expiresAt = expiry(body.expires_in, startedAt, finishedAt);
    const granted = scopes(body, token);
    let refreshExpiresAt = oldRefreshExpiry;
    if (token.platformId === "tiktok") {
      if (body.open_id !== token.remoteId) fail("OAUTH_REFRESH_IDENTITY_MISMATCH");
      if (!secretString(body.refresh_token)) fail("OAUTH_REFRESH_RESPONSE_INVALID");
      refreshExpiresAt = expiry(body.refresh_expires_in, startedAt, finishedAt);
    } else if (token.platformId === "youtube" && body.refresh_token_expires_in !== undefined) {
      refreshExpiresAt = expiry(body.refresh_token_expires_in, startedAt, finishedAt);
    }
    if (refreshExpiresAt !== undefined && refreshExpiresAt <= finishedAt)
      fail("OAUTH_REFRESH_REAUTH_REQUIRED");
    const result: GlobalTokenEnvelope = {
      version: 1,
      accountId: token.accountId,
      platformId: token.platformId,
      remoteId: token.remoteId,
      tokenType: "Bearer",
      accessToken: body.access_token,
      refreshToken: secretString(body.refresh_token) ? body.refresh_token : token.refreshToken,
      scopes: granted,
      expiresAt: new Date(expiresAt).toISOString(),
      ...(refreshExpiresAt === undefined
        ? {}
        : { refreshExpiresAt: new Date(refreshExpiresAt).toISOString() }),
    };
    const end = clock();
    if (end < finishedAt || end >= expiresAt) fail("OAUTH_REFRESH_RESPONSE_INVALID");
    if (refreshExpiresAt !== undefined && end >= refreshExpiresAt) fail("OAUTH_REFRESH_REAUTH_REQUIRED");
    current();
    return result;
  }
}
