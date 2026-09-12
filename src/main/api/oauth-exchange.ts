import { globalAccountIdSchema } from "@shared/global-accounts";
import {
  GLOBAL_APP_PROFILES,
  globalAppConfigurationSchema,
  type GlobalAppConfiguration,
} from "@shared/global-apps";
import type { GlobalPlatformId } from "@shared/platforms";
import type { GlobalTokenEnvelope } from "./global-token-store";
import type { OAuthCodeExchangeInput } from "./oauth-flow";
import type { ProxyTransport, ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";

export type OAuthExchangeErrorCode =
  | "OAUTH_EXCHANGE_INPUT_INVALID"
  | "OAUTH_EXCHANGE_REVOKED"
  | "OAUTH_EXCHANGE_SECRET_UNAVAILABLE"
  | "OAUTH_EXCHANGE_REQUEST_FAILED"
  | "OAUTH_EXCHANGE_RESPONSE_INVALID"
  | "OAUTH_EXCHANGE_SCOPE_MISSING"
  | "OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED"
  | "OAUTH_EXCHANGE_TOKEN_EXPIRED";

/** No provider errors, response bodies, URLs, codes or credential values are attached. */
export class OAuthExchangeError extends Error {
  constructor(readonly code: OAuthExchangeErrorCode) {
    super(code);
    this.name = "OAuthExchangeError";
  }
}

export interface OAuthCodeExchangerOptions {
  readonly transport: Pick<ProxyTransport, "request">;
  /** Synchronous main-only Vault read, using this exact app ID; null means genuinely not configured. */
  readonly readClientSecret: (app: Readonly<GlobalAppConfiguration>) => string | null;
  readonly now?: () => number;
}

const ENDPOINTS = Object.freeze({
  youtube: {
    token: "https://oauth2.googleapis.com/token",
    identity: "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=2",
  },
  tiktok: {
    token: "https://open.tiktokapis.com/v2/oauth/token/",
    identity: "https://open.tiktokapis.com/v2/user/info/?fields=open_id",
  },
  x: { token: "https://api.x.com/2/oauth2/token", identity: "https://api.x.com/2/users/me" },
});
const MAX_RESPONSE_BYTES = 64 * 1024;
const tokenString = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{1,16384}$/.test(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._~-]{1,256}$/.test(value);
function fail(code: OAuthExchangeErrorCode): never {
  throw new OAuthExchangeError(code);
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function json(response: ProxyTransportResponse): Record<string, unknown> {
  if (
    response.status !== 200 ||
    !Buffer.isBuffer(response.body) ||
    response.body.length === 0 ||
    response.body.length > MAX_RESPONSE_BYTES
  )
    fail("OAUTH_EXCHANGE_RESPONSE_INVALID");
  const types = Object.entries(response.headers).filter(([key]) => key.toLowerCase() === "content-type");
  if (
    types.length !== 1 ||
    typeof types[0][1] !== "string" ||
    !/^application\/json(?:\s*;|\s*$)/i.test(types[0][1])
  )
    fail("OAUTH_EXCHANGE_RESPONSE_INVALID");
  try {
    // Fatal UTF-8 decoding prevents a malformed identifier from being silently repaired.
    const parsed = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)));
    if (parsed) return parsed;
  } catch {
    /* fixed error below */
  }
  return fail("OAUTH_EXCHANGE_RESPONSE_INVALID");
}
function grantedScopes(value: unknown, platformId: GlobalPlatformId): string[] {
  if (typeof value !== "string" || value.length > 16_384) fail("OAUTH_EXCHANGE_SCOPE_MISSING");
  const scopes = value.split(platformId === "tiktok" ? "," : " ");
  if (
    scopes.length === 0 ||
    scopes.length > 64 ||
    scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope)) ||
    new Set(scopes).size !== scopes.length ||
    GLOBAL_APP_PROFILES[platformId].scopes.some((required) => !scopes.includes(required))
  )
    fail("OAUTH_EXCHANGE_SCOPE_MISSING");
  return scopes;
}
function remoteIdentity(
  platformId: GlobalPlatformId,
  body: Record<string, unknown>,
  openId: unknown,
): string {
  let id: unknown;
  if (platformId === "tiktok") {
    const error = object(body.error);
    id = object(object(body.data)?.user)?.open_id;
    if (error?.code !== "ok" || !identifier(openId) || id !== openId)
      fail("OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED");
  } else {
    if (
      body.error !== undefined ||
      (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length))
    )
      fail("OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED");
    if (platformId === "youtube") {
      if (!Array.isArray(body.items) || body.items.length !== 1 || body.nextPageToken !== undefined)
        fail("OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED");
      id = object(body.items[0])?.id;
      if (typeof id !== "string" || !/^UC[A-Za-z0-9_-]{22}$/.test(id))
        fail("OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED");
    } else {
      id = object(body.data)?.id;
      if (typeof id !== "string" || !/^[1-9][0-9]{0,31}$/.test(id))
        fail("OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED");
    }
  }
  if (!identifier(id)) fail("OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED");
  return id;
}

/** Main only. Exactly one code exchange and one identity GET, solely through the injected proxy.
 * This produces an uncommitted envelope; GlobalTokenStore still binds the account and transaction.
 */
export class OAuthCodeExchanger {
  private readonly transport: Pick<ProxyTransport, "request">;
  private readonly readClientSecret: OAuthCodeExchangerOptions["readClientSecret"];
  private readonly now: () => number;

  constructor(options: OAuthCodeExchangerOptions) {
    if (typeof options?.transport?.request !== "function" || typeof options.readClientSecret !== "function")
      fail("OAUTH_EXCHANGE_INPUT_INVALID");
    this.transport = options.transport;
    this.readClientSecret = options.readClientSecret;
    this.now = options.now ?? Date.now;
  }

  async exchange(input: OAuthCodeExchangeInput, app: GlobalAppConfiguration): Promise<GlobalTokenEnvelope> {
    try {
      return await this.run(input, app);
    } catch (error) {
      if (error instanceof OAuthExchangeError) throw error;
      throw new OAuthExchangeError("OAUTH_EXCHANGE_RESPONSE_INVALID");
    }
  }

  private async run(
    input: OAuthCodeExchangeInput,
    app: GlobalAppConfiguration,
  ): Promise<GlobalTokenEnvelope> {
    const parsed = globalAppConfigurationSchema.safeParse(app);
    if (!parsed.success || !input || !globalAccountIdSchema.safeParse(input.accountId).success)
      fail("OAUTH_EXCHANGE_INPUT_INVALID");
    const config = Object.freeze(parsed.data);
    // Snapshot values before any external dependency or await; never reread mutable caller input.
    const context = Object.freeze({ ...input });
    if (
      context.platformId !== config.platformId ||
      context.clientId !== config.clientId ||
      typeof context.assertCurrent !== "function" ||
      !context.signal ||
      typeof context.signal.addEventListener !== "function" ||
      !Number.isSafeInteger(context.generation) ||
      context.generation < 0 ||
      typeof context.code !== "string" ||
      !/^[\x21-\x7e]{1,4096}$/.test(context.code) ||
      typeof context.codeVerifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(context.codeVerifier) ||
      typeof context.redirectUri !== "string"
    )
      fail("OAUTH_EXCHANGE_INPUT_INVALID");
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/.exec(context.redirectUri);
    const port = match ? Number(match[1]) : 0;
    if (port < 1024 || port > 65_535 || (config.redirectPort !== 0 && config.redirectPort !== port))
      fail("OAUTH_EXCHANGE_INPUT_INVALID");
    const current = () => {
      try {
        if (context.signal.aborted) throw new Error();
        context.assertCurrent();
        if (context.signal.aborted) throw new Error();
      } catch {
        fail("OAUTH_EXCHANGE_REVOKED");
      }
    };
    const clock = () => {
      const value = this.now();
      if (!Number.isSafeInteger(value) || value < 0) fail("OAUTH_EXCHANGE_TOKEN_EXPIRED");
      return value;
    };
    current();
    let secret: string | null = null;
    if (config.platformId !== "x") {
      try {
        secret = this.readClientSecret(config);
      } catch {
        current();
        fail("OAUTH_EXCHANGE_SECRET_UNAVAILABLE");
      }
      current();
      if (secret !== null && (typeof secret !== "string" || secret.length > 65_536 || !secret.trim()))
        fail("OAUTH_EXCHANGE_SECRET_UNAVAILABLE");
      if (config.platformId === "tiktok" && secret === null) fail("OAUTH_EXCHANGE_SECRET_UNAVAILABLE");
    }
    const request = async (value: Omit<ProxyTransportRequest, "platformId" | "signal">) => {
      current();
      let response: ProxyTransportResponse;
      try {
        response = await this.transport.request({
          ...value,
          platformId: config.platformId,
          signal: context.signal,
        });
      } catch {
        current();
        fail("OAUTH_EXCHANGE_REQUEST_FAILED");
      }
      current();
      return json(response);
    };
    const form = new URLSearchParams({
      [config.platformId === "tiktok" ? "client_key" : "client_id"]: context.clientId,
      code: context.code,
      code_verifier: context.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: context.redirectUri,
    });
    if (secret !== null) form.set("client_secret", secret);
    const tokenStartedAt = clock();
    const token = await request({
      url: ENDPOINTS[config.platformId].token,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
      body: form.toString(),
    });
    if (
      token.error !== undefined ||
      token.errors !== undefined ||
      !tokenString(token.access_token) ||
      typeof token.token_type !== "string" ||
      token.token_type.toLowerCase() !== "bearer" ||
      (token.refresh_token !== undefined && !tokenString(token.refresh_token)) ||
      typeof token.expires_in !== "number" ||
      !Number.isSafeInteger(token.expires_in) ||
      token.expires_in <= 0
    )
      fail("OAUTH_EXCHANGE_RESPONSE_INVALID");
    const expiresAt = tokenStartedAt + token.expires_in * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt > 8_640_000_000_000_000 || expiresAt <= clock())
      fail("OAUTH_EXCHANGE_TOKEN_EXPIRED");
    const refreshSeconds =
      config.platformId === "tiktok"
        ? token.refresh_expires_in
        : config.platformId === "youtube"
          ? token.refresh_token_expires_in
          : undefined;
    let refreshExpiresAt: number | undefined;
    if (
      refreshSeconds !== undefined ||
      (config.platformId === "tiktok" && token.refresh_token !== undefined)
    ) {
      if (
        !tokenString(token.refresh_token) ||
        typeof refreshSeconds !== "number" ||
        !Number.isSafeInteger(refreshSeconds) ||
        refreshSeconds <= 0
      )
        fail("OAUTH_EXCHANGE_RESPONSE_INVALID");
      refreshExpiresAt = tokenStartedAt + refreshSeconds * 1000;
      if (
        !Number.isSafeInteger(refreshExpiresAt) ||
        refreshExpiresAt > 8_640_000_000_000_000 ||
        refreshExpiresAt <= clock()
      )
        fail("OAUTH_EXCHANGE_TOKEN_EXPIRED");
    }
    const scopes = grantedScopes(token.scope, config.platformId);
    if (config.platformId === "tiktok" && !identifier(token.open_id))
      fail("OAUTH_EXCHANGE_IDENTITY_UNCONFIRMED");
    const identity = await request({
      url: ENDPOINTS[config.platformId].identity,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
    });
    const remoteId = remoteIdentity(config.platformId, identity, token.open_id);
    const finalNow = clock();
    current();
    if (finalNow < tokenStartedAt || expiresAt <= finalNow) fail("OAUTH_EXCHANGE_TOKEN_EXPIRED");
    return {
      version: 1,
      accountId: context.accountId,
      platformId: config.platformId,
      remoteId,
      tokenType: "Bearer",
      accessToken: token.access_token,
      ...(tokenString(token.refresh_token) ? { refreshToken: token.refresh_token } : {}),
      ...(refreshExpiresAt !== undefined
        ? { refreshExpiresAt: new Date(refreshExpiresAt).toISOString() }
        : {}),
      expiresAt: new Date(expiresAt).toISOString(),
      scopes,
    };
  }
}
