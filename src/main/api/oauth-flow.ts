import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { GlobalPlatformId } from "@shared/platforms";

export type OAuthPkceProfile = "google-desktop-s256" | "tiktok-desktop-hex-s256" | "x-s256";

export interface OAuthPlatformConfiguration {
  readonly platformId: GlobalPlatformId;
  readonly profile: OAuthPkceProfile;
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** Zero requests an ephemeral loopback port; the provider must permit that redirect registration. */
  readonly redirectPort: number;
  readonly redirectPath: string;
}

export type OAuthFlowErrorCode =
  | "OAUTH_CONFIG_INVALID"
  | "OAUTH_BUSY"
  | "OAUTH_UNAVAILABLE"
  | "OAUTH_CANCELLED"
  | "OAUTH_EXPIRED"
  | "OAUTH_REVOKED"
  | "OAUTH_DENIED"
  | "OAUTH_CALLBACK_INVALID"
  | "OAUTH_EXCHANGE_FAILED"
  | "OAUTH_SAVE_FAILED";

/** Provider messages, callback URLs, authorization codes and tokens never cross this boundary. */
export class OAuthFlowError extends Error {
  constructor(readonly code: OAuthFlowErrorCode) {
    super(code);
    this.name = "OAuthFlowError";
  }
}

export interface OAuthTransactionContext {
  readonly transactionId: string;
  readonly platformId: GlobalPlatformId;
  readonly accountId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

export interface OAuthCodeExchangeInput extends OAuthTransactionContext {
  readonly code: string;
  readonly codeVerifier: string;
}

export type OAuthFlowResult = Readonly<
  {
    transactionId: string;
    platformId: GlobalPlatformId;
    accountId: string;
  } & (
    { status: "authorized" } | { status: "cancelled" | "expired" | "failed"; errorCode: OAuthFlowErrorCode }
  )
>;

/** Main-process handle. In particular, authorizationUrl contains state and is not a log/IPC DTO. */
export interface OAuthFlowHandle {
  readonly transactionId: string;
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly completion: Promise<OAuthFlowResult>;
  readonly cancel: () => void;
}

export interface OAuthFlowOptions<Tokens extends object> {
  readonly profiles: readonly OAuthPlatformConfiguration[];
  /** Required explicit transport injection; there is deliberately no fetch or browser fallback. */
  readonly exchangeCode: (input: OAuthCodeExchangeInput) => Promise<Tokens>;
  /**
   * Synchronous vault/database transaction only. Do async preparation in exchangeCode, then
   * commit here without yielding. An accidentally returned thenable fails the flow, but this
   * manager cannot roll back side effects performed by a contract-violating callback.
   */
  readonly saveTokens: (tokens: Tokens, context: OAuthTransactionContext) => void;
  readonly getGeneration: () => number;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve,
  };
}

const PROFILE: Record<
  GlobalPlatformId,
  Readonly<{
    id: OAuthPkceProfile;
    endpoint: string;
    clientParameter: "client_id" | "client_key";
    encoding: "base64url" | "hex";
    scopeSeparator: string;
  }>
> = {
  youtube: {
    id: "google-desktop-s256",
    endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    clientParameter: "client_id",
    encoding: "base64url",
    scopeSeparator: " ",
  },
  // Google desktop S256 and X S256 follow RFC 7636's unpadded base64url transform:
  // https://developers.google.com/identity/protocols/oauth2/native-app#step1-code-verifier
  // https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
  // TikTok's desktop contract explicitly uses SHA256 hex, despite the S256 method name.
  // https://developers.tiktok.com/doc/login-kit-desktop/
  tiktok: {
    id: "tiktok-desktop-hex-s256",
    endpoint: "https://www.tiktok.com/v2/auth/authorize/",
    clientParameter: "client_key",
    encoding: "hex",
    scopeSeparator: ",",
  },
  x: {
    id: "x-s256",
    endpoint: "https://x.com/i/oauth2/authorize",
    clientParameter: "client_id",
    encoding: "base64url",
    scopeSeparator: " ",
  },
};

function configuration(input: OAuthPlatformConfiguration): OAuthPlatformConfiguration {
  const contract = input && PROFILE[input.platformId];
  if (
    !contract ||
    input.profile !== contract.id ||
    input.authorizeUrl !== contract.endpoint ||
    typeof input.clientId !== "string" ||
    !/^[A-Za-z0-9._~-]{1,512}$/.test(input.clientId) ||
    !Array.isArray(input.scopes) ||
    input.scopes.length < 1 ||
    input.scopes.length > 64 ||
    input.scopes.some((scope) => typeof scope !== "string" || !/^[A-Za-z0-9:/._~-]{1,256}$/.test(scope)) ||
    new Set(input.scopes).size !== input.scopes.length ||
    !Number.isInteger(input.redirectPort) ||
    input.redirectPort < 0 ||
    input.redirectPort > 65535 ||
    typeof input.redirectPath !== "string" ||
    !/^\/[A-Za-z0-9/_-]{1,128}$/.test(input.redirectPath) ||
    input.redirectPath.includes("//")
  )
    throw new OAuthFlowError("OAUTH_CONFIG_INVALID");
  return Object.freeze({ ...input, scopes: Object.freeze([...input.scopes]) });
}

type CallbackResult = { code: string } | { errorCode: OAuthFlowErrorCode };
interface Transaction {
  readonly id: string;
  readonly platformId: GlobalPlatformId;
  readonly accountId: string;
  readonly profile: OAuthPlatformConfiguration;
  readonly generation: number;
  readonly revision: number;
  readonly controller: AbortController;
  readonly state: string;
  verifier: string;
  readonly deadline: number;
  readonly ready: Deferred<OAuthFlowHandle | OAuthFlowError>;
  readonly result: Deferred<OAuthFlowResult>;
  readonly callback: Deferred<CallbackResult>;
  readonly initialized: Deferred<void>;
  readonly server: Server;
  readonly sockets: Set<Socket>;
  redirectUri: string;
  consumed: boolean;
  terminal: boolean;
  reason: OAuthFlowErrorCode | null;
  closing: Promise<void> | null;
  timeout: ReturnType<typeof setTimeout> | null;
  removeAbort: () => void;
}

/** One single-use listener per transaction, bound only to literal IPv4 loopback. */
export class OAuthFlowManager<Tokens extends object> {
  private readonly profiles = new Map<GlobalPlatformId, OAuthPlatformConfiguration>();
  private readonly transactions = new Map<string, Transaction>();
  private readonly work = new Set<Promise<void>>();
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private revision = 0;
  private disposed = false;

  constructor(private readonly options: OAuthFlowOptions<Tokens>) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    if (
      !Array.isArray(options.profiles) ||
      options.profiles.length < 1 ||
      options.profiles.length > 3 ||
      typeof options.exchangeCode !== "function" ||
      typeof options.saveTokens !== "function" ||
      typeof options.getGeneration !== "function" ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 10 * 60_000 ||
      !Number.isInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      this.maxConcurrent > 16
    )
      throw new OAuthFlowError("OAUTH_CONFIG_INVALID");
    for (const input of options.profiles) {
      const profile = configuration(input);
      if (this.profiles.has(profile.platformId)) throw new OAuthFlowError("OAUTH_CONFIG_INVALID");
      this.profiles.set(profile.platformId, profile);
    }
  }

  async start(
    input: Readonly<{ platformId: GlobalPlatformId; accountId: string; signal?: AbortSignal }>,
  ): Promise<OAuthFlowHandle> {
    const externalSignal = input.signal;
    if (this.disposed) throw new OAuthFlowError("OAUTH_UNAVAILABLE");
    const profile = this.profiles.get(input.platformId);
    if (
      !profile ||
      typeof input.accountId !== "string" ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.accountId)
    )
      throw new OAuthFlowError("OAUTH_CONFIG_INVALID");
    if (externalSignal?.aborted) throw new OAuthFlowError("OAUTH_CANCELLED");
    if (
      this.transactions.size >= this.maxConcurrent ||
      [...this.transactions.values()].some((t) => t.accountId === input.accountId)
    )
      throw new OAuthFlowError("OAUTH_BUSY");
    const revision = this.revision;
    let generation: number;
    try {
      generation = this.options.getGeneration();
    } catch {
      throw new OAuthFlowError("OAUTH_REVOKED");
    }
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      this.disposed ||
      revision !== this.revision ||
      externalSignal?.aborted
    )
      throw new OAuthFlowError("OAUTH_REVOKED");
    const server = createServer({ maxHeaderSize: 8192, requestTimeout: 2000, headersTimeout: 2000 });
    const tx: Transaction = {
      id: randomUUID(),
      platformId: input.platformId,
      accountId: input.accountId,
      profile,
      generation,
      revision,
      controller: new AbortController(),
      state: randomBytes(32).toString("base64url"),
      verifier: randomBytes(64).toString("base64url"),
      deadline: performance.now() + this.timeoutMs,
      ready: deferred(),
      result: deferred(),
      callback: deferred(),
      initialized: deferred(),
      server,
      sockets: new Set(),
      redirectUri: "",
      consumed: false,
      terminal: false,
      reason: null,
      closing: null,
      timeout: null,
      removeAbort: () => undefined,
    };
    this.transactions.set(tx.id, tx);
    server.maxConnections = 8;
    server.on("connection", (socket) => {
      tx.sockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => tx.sockets.delete(socket));
      socket.setTimeout(2000, () => socket.destroy());
      if (tx.terminal || tx.controller.signal.aborted) socket.destroy();
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("request", (request, response) => this.receive(tx, request, response));
    const abort = () => this.terminate(tx, "OAUTH_CANCELLED");
    externalSignal?.addEventListener("abort", abort, { once: true });
    tx.removeAbort = () => externalSignal?.removeEventListener("abort", abort);
    tx.timeout = setTimeout(() => this.terminate(tx, "OAUTH_EXPIRED"), this.timeoutMs);
    const work = this.drive(tx);
    this.work.add(work);
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work),
    );
    const ready = await tx.ready.promise;
    if (ready instanceof OAuthFlowError) throw ready;
    return ready;
  }

  /** Revocation is synchronous; asynchronous exchange work retains its slot until it really settles. */
  invalidate(): void {
    this.revision++;
    for (const tx of this.transactions.values()) this.terminate(tx, "OAUTH_REVOKED");
  }

  async whenIdle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await this.whenIdle();
  }

  private assertCurrent(tx: Transaction): void {
    if (tx.reason) throw new OAuthFlowError(tx.reason);
    if (this.disposed || tx.controller.signal.aborted || tx.revision !== this.revision)
      throw new OAuthFlowError("OAUTH_REVOKED");
    if (performance.now() >= tx.deadline) throw new OAuthFlowError("OAUTH_EXPIRED");
    let generation: number;
    try {
      generation = this.options.getGeneration();
    } catch {
      throw new OAuthFlowError("OAUTH_REVOKED");
    }
    // A generation getter may synchronously revoke the transaction; check again after it returns.
    if (
      generation !== tx.generation ||
      this.disposed ||
      tx.controller.signal.aborted ||
      tx.revision !== this.revision
    )
      throw new OAuthFlowError(tx.reason ?? "OAUTH_REVOKED");
    if (performance.now() >= tx.deadline) throw new OAuthFlowError("OAUTH_EXPIRED");
  }

  private context(tx: Transaction): OAuthTransactionContext {
    return Object.freeze({
      transactionId: tx.id,
      platformId: tx.platformId,
      accountId: tx.accountId,
      clientId: tx.profile.clientId,
      redirectUri: tx.redirectUri,
      generation: tx.generation,
      signal: tx.controller.signal,
      assertCurrent: () => this.assertCurrent(tx),
    });
  }

  private finish(tx: Transaction, errorCode?: OAuthFlowErrorCode): void {
    if (tx.terminal) return;
    tx.terminal = true;
    const identity = { transactionId: tx.id, platformId: tx.platformId, accountId: tx.accountId };
    tx.result.resolve(
      Object.freeze(
        errorCode
          ? {
              ...identity,
              status:
                errorCode === "OAUTH_CANCELLED"
                  ? "cancelled"
                  : errorCode === "OAUTH_EXPIRED"
                    ? "expired"
                    : "failed",
              errorCode,
            }
          : { ...identity, status: "authorized" },
      ),
    );
  }

  private terminate(tx: Transaction, reason: OAuthFlowErrorCode): void {
    if (tx.terminal) return;
    tx.reason = reason;
    tx.controller.abort(new OAuthFlowError(reason));
    tx.callback.resolve({ errorCode: reason });
    this.finish(tx, reason);
    void this.closeListener(tx);
  }

  private closeListener(tx: Transaction): Promise<void> {
    if (tx.closing) return tx.closing;
    tx.closing = (async () => {
      await tx.initialized.promise;
      await new Promise<void>((resolve) => {
        tx.server.close(() => resolve());
        tx.server.closeAllConnections();
        for (const socket of tx.sockets) socket.destroy();
      });
      // server.close covers its connections; wait explicitly for the owned socket close events too.
      await Promise.all(
        [...tx.sockets].map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.closed) resolve();
              else socket.once("close", resolve);
            }),
        ),
      );
    })();
    return tx.closing;
  }

  private receive(tx: Transaction, request: IncomingMessage, response: ServerResponse): void {
    const reply = (status: number, text: string, after?: () => void) => {
      response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        Connection: "close",
      });
      response.end(text, after);
    };
    if (tx.consumed || tx.terminal) return reply(410, "Authorization request is no longer pending.");
    try {
      this.assertCurrent(tx);
    } catch (error) {
      this.terminate(tx, error instanceof OAuthFlowError ? error.code : "OAUTH_REVOKED");
      return;
    }
    const raw = request.url ?? "";
    if (
      request.method !== "GET" ||
      request.socket.remoteAddress !== "127.0.0.1" ||
      request.headers.host !== new URL(tx.redirectUri).host ||
      !raw.startsWith("/") ||
      raw.startsWith("//") ||
      raw.length > 8192
    )
      return reply(400, "Invalid authorization callback.");
    let url: URL;
    try {
      url = new URL(raw, tx.redirectUri);
    } catch {
      return reply(400, "Invalid authorization callback.");
    }
    if (
      raw.split("?", 1)[0] !== tx.profile.redirectPath ||
      url.origin !== new URL(tx.redirectUri).origin ||
      url.pathname !== tx.profile.redirectPath ||
      url.hash
    )
      return reply(400, "Invalid authorization callback.");
    const params = url.searchParams;
    const state = params.get("state") ?? "";
    if (
      params.getAll("state").length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(tx.state))
    )
      return reply(400, "Invalid authorization callback.");
    const codes = params.getAll("code");
    const errors = params.getAll("error");
    const validCode =
      codes.length === 1 &&
      codes[0].length > 0 &&
      codes[0].length <= 4096 &&
      ![...codes[0]].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
    tx.consumed = true;
    const result: CallbackResult =
      errors.length === 1 && !codes.length
        ? { errorCode: "OAUTH_DENIED" }
        : validCode && !errors.length
          ? { code: codes[0] }
          : { errorCode: "OAUTH_CALLBACK_INVALID" };
    reply(200, "Authorization response received. Return to the application to check its result.", () =>
      tx.callback.resolve(result),
    );
  }

  private async drive(tx: Transaction): Promise<void> {
    let errorCode: OAuthFlowErrorCode | undefined;
    try {
      try {
        await new Promise<void>((resolve, reject) => {
          tx.server.once("error", reject);
          tx.server.listen(tx.profile.redirectPort, "127.0.0.1", () => resolve());
        });
      } finally {
        tx.initialized.resolve();
      }
      this.assertCurrent(tx);
      const address = tx.server.address();
      if (!address || typeof address === "string" || address.address !== "127.0.0.1")
        throw new OAuthFlowError("OAUTH_UNAVAILABLE");
      tx.redirectUri = `http://127.0.0.1:${address.port}${tx.profile.redirectPath}`;
      const contract = PROFILE[tx.platformId];
      const url = new URL(tx.profile.authorizeUrl);
      url.searchParams.set(contract.clientParameter, tx.profile.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", tx.profile.scopes.join(contract.scopeSeparator));
      url.searchParams.set("redirect_uri", tx.redirectUri);
      url.searchParams.set("state", tx.state);
      url.searchParams.set(
        "code_challenge",
        createHash("sha256").update(tx.verifier).digest(contract.encoding),
      );
      url.searchParams.set("code_challenge_method", "S256");
      tx.ready.resolve(
        Object.freeze({
          transactionId: tx.id,
          authorizationUrl: url.href,
          redirectUri: tx.redirectUri,
          completion: tx.result.promise,
          cancel: () => this.terminate(tx, "OAUTH_CANCELLED"),
        }),
      );
      const callback = await tx.callback.promise;
      this.assertCurrent(tx);
      if ("errorCode" in callback) throw new OAuthFlowError(callback.errorCode);
      await this.closeListener(tx);
      this.assertCurrent(tx);
      let tokens: Tokens;
      try {
        tokens = await this.options.exchangeCode(
          Object.freeze({ ...this.context(tx), code: callback.code, codeVerifier: tx.verifier }),
        );
      } catch {
        this.assertCurrent(tx);
        throw new OAuthFlowError("OAUTH_EXCHANGE_FAILED");
      }
      this.assertCurrent(tx);
      if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens))
        throw new OAuthFlowError("OAUTH_EXCHANGE_FAILED");
      try {
        const context = this.context(tx);
        context.assertCurrent();
        const returned: unknown = this.options.saveTokens(tokens, context);
        if (
          returned &&
          (typeof returned === "object" || typeof returned === "function") &&
          "then" in returned &&
          typeof returned.then === "function"
        ) {
          // Consume rejection to avoid unhandled promises; never report async saves as authorized.
          await Promise.resolve(returned);
          throw new OAuthFlowError("OAUTH_SAVE_FAILED");
        }
      } catch {
        this.assertCurrent(tx);
        throw new OAuthFlowError("OAUTH_SAVE_FAILED");
      }
      this.assertCurrent(tx);
    } catch (error) {
      errorCode = error instanceof OAuthFlowError ? error.code : "OAUTH_UNAVAILABLE";
      tx.ready.resolve(new OAuthFlowError(errorCode));
    } finally {
      if (errorCode) tx.controller.abort(new OAuthFlowError(errorCode));
      await this.closeListener(tx);
      if (!errorCode && !tx.terminal) {
        try {
          this.assertCurrent(tx);
        } catch (error) {
          errorCode = error instanceof OAuthFlowError ? error.code : "OAUTH_REVOKED";
        }
      }
      if (tx.timeout) clearTimeout(tx.timeout);
      tx.removeAbort();
      tx.verifier = "";
      this.finish(tx, errorCode);
      tx.controller.abort(new OAuthFlowError(errorCode ?? "OAUTH_CANCELLED"));
      this.transactions.delete(tx.id);
    }
  }
}
