import { createHash } from "node:crypto";
import type { Database } from "@main/db/database";
import type { CredentialEncryptionProvider } from "@main/security/credential-vault";
import { globalAccountIdSchema } from "@shared/global-accounts";
import type { GlobalPlatformId } from "@shared/platforms";
import type { GlobalAppConfiguration } from "@shared/global-apps";
import {
  globalReadDataSchema,
  globalReadErrorCode,
  type GlobalReadData,
  type GlobalReadErrorCode,
  type GlobalReadSnapshot,
} from "@shared/global-read";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAppRepository } from "./global-app-repository";
import { GlobalTokenStore, type GlobalTokenEnvelope } from "./global-token-store";
import { GlobalReadRepository } from "./global-read-repository";
import type { GlobalOAuthEligibility } from "./global-oauth-service";

export class GlobalReadServiceError extends Error {
  constructor(readonly code: GlobalReadErrorCode) {
    super(code);
    this.name = "GlobalReadServiceError";
  }
}
function fail(code: GlobalReadErrorCode): never {
  throw new GlobalReadServiceError(code);
}
interface ReadContext {
  token: GlobalTokenEnvelope;
  signal: AbortSignal;
  assertCurrent(): void;
}
export interface GlobalReadServiceOptions {
  db: Database;
  encryption?: CredentialEncryptionProvider;
  acquireEligibility(platform: GlobalPlatformId, signal: AbortSignal): Promise<GlobalOAuthEligibility | null>;
  read(input: ReadContext): Promise<GlobalReadData>;
  refreshToken(input: ReadContext & { app: GlobalAppConfiguration }): Promise<GlobalTokenEnvelope>;
  timeoutMs?: number;
  maxConcurrent?: number;
}
interface Operation {
  accountId: string;
  platformId: GlobalPlatformId;
  remoteId: string;
  app: GlobalAppConfiguration;
  appRevision: string;
  tokenRevision: string;
  controller: AbortController;
  eligibility: GlobalOAuthEligibility | null;
  deadline: number;
  error: GlobalReadErrorCode | null;
  assertQueued?: () => void;
}

/** Manual, bounded official reads. Credentials, raw responses and network state stay in main.
 * The public cancel result can return early; the account slot and shutdown retain actual work.
 */
export class GlobalReadService {
  private readonly accounts: GlobalAccountRepository;
  private readonly apps: GlobalAppRepository;
  private readonly tokens: GlobalTokenStore;
  private readonly snapshots: GlobalReadRepository;
  private readonly operations = new Map<string, Operation>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private disposed = false;

  constructor(private readonly options: GlobalReadServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000 ||
      !Number.isInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      this.maxConcurrent > 8 ||
      [options.acquireEligibility, options.read, options.refreshToken].some((fn) => typeof fn !== "function")
    )
      fail("GLOBAL_READ_INPUT_INVALID");
    this.accounts = new GlobalAccountRepository(options.db);
    this.apps = new GlobalAppRepository(options.db);
    this.tokens = new GlobalTokenStore(options.db, options.encryption);
    this.snapshots = new GlobalReadRepository(options.db);
  }

  get(accountId: string): GlobalReadSnapshot | null {
    this.id(accountId);
    try {
      return this.snapshots.get(accountId);
    } catch {
      return fail("GLOBAL_READ_UNAVAILABLE");
    }
  }

  async refresh(accountId: string, assertQueued?: () => void): Promise<GlobalReadSnapshot> {
    this.id(accountId);
    assertQueued?.();
    if (this.disposed) fail("GLOBAL_READ_UNAVAILABLE");
    if (this.operations.has(accountId) || this.operations.size >= this.maxConcurrent)
      fail("GLOBAL_READ_BUSY");
    let token: GlobalTokenEnvelope, app: GlobalAppConfiguration;
    try {
      const account = this.accounts.get(accountId);
      if (!account || account.authStatus !== "authorized" || !account.remoteId)
        fail("GLOBAL_READ_UNAUTHORIZED");
      const saved = this.tokens.read(accountId),
        config = this.apps.get(account.platformId);
      if (!saved) fail("GLOBAL_READ_REAUTHORIZE");
      if (!config) fail("GLOBAL_READ_UNAVAILABLE");
      token = saved;
      app = config;
    } catch (error) {
      if (error instanceof GlobalReadServiceError) throw error;
      return fail("GLOBAL_READ_REAUTHORIZE");
    }
    const op: Operation = {
      accountId,
      platformId: token.platformId,
      remoteId: token.remoteId,
      app,
      appRevision: this.appRevision(app),
      tokenRevision: this.tokenRevision(accountId),
      controller: new AbortController(),
      eligibility: null,
      deadline: performance.now() + this.timeoutMs,
      error: null,
      assertQueued,
    };
    this.operations.set(accountId, op);
    const pending = Promise.resolve().then(() => this.drive(op, token));
    this.work.add(pending);
    void pending.then(
      () => this.work.delete(pending),
      () => this.work.delete(pending),
    );
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new GlobalReadServiceError(op.error ?? "GLOBAL_READ_CANCELLED"));
      op.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (op.controller.signal.aborted) onAbort();
    });
    try {
      return await Promise.race([pending, aborted]);
    } catch (error) {
      if (error instanceof GlobalReadServiceError) throw error;
      return fail(globalReadErrorCode(error));
    } finally {
      op.controller.signal.removeEventListener("abort", onAbort);
    }
  }

  cancel(accountId: string): void {
    this.id(accountId);
    const op = this.operations.get(accountId);
    if (op) this.revoke(op, "GLOBAL_READ_CANCELLED");
  }
  invalidateAccount(accountId: string): void {
    this.cancel(accountId);
  }
  invalidatePlatform(platform: GlobalPlatformId): void {
    for (const op of this.operations.values())
      if (op.platformId === platform) this.revoke(op, "GLOBAL_READ_CANCELLED");
  }
  invalidate(): void {
    for (const op of this.operations.values()) this.revoke(op, "GLOBAL_READ_WAITING_PROXY");
  }
  async whenIdle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await this.whenIdle();
  }

  private id(value: string): void {
    if (!globalAccountIdSchema.safeParse(value).success) fail("GLOBAL_READ_INPUT_INVALID");
  }
  private tokenRevision(accountId: string): string {
    return createHash("sha256")
      .update(
        JSON.stringify(
          this.options.db.get(
            "SELECT id, ciphertext, encryption_version, created_at, updated_at FROM credentials WHERE kind = 'oauth_token' AND owner_id = ?",
            [accountId],
          ),
        ),
      )
      .digest("hex");
  }
  private appRevision(app: GlobalAppConfiguration): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          app: this.apps.get(app.platformId),
          credential: this.options.db.get(
            "SELECT id, ciphertext, encryption_version, created_at, updated_at FROM credentials WHERE kind = 'oauth_client_secret' AND owner_id = ?",
            [app.id],
          ),
        }),
      )
      .digest("hex");
  }
  private revoke(op: Operation, code: GlobalReadErrorCode): void {
    if (op.controller.signal.aborted) return;
    op.error = code;
    op.controller.abort();
  }
  private current(op: Operation, checkToken = true): void {
    try {
      if (op.error || op.controller.signal.aborted) fail(op.error ?? "GLOBAL_READ_CANCELLED");
      op.assertQueued?.();
      if (this.disposed || this.operations.get(op.accountId) !== op || performance.now() >= op.deadline)
        fail("GLOBAL_READ_CANCELLED");
      const account = this.accounts.get(op.accountId);
      if (
        !account ||
        account.platformId !== op.platformId ||
        account.remoteId !== op.remoteId ||
        account.authStatus !== "authorized" ||
        this.appRevision(op.app) !== op.appRevision ||
        (checkToken && this.tokenRevision(op.accountId) !== op.tokenRevision)
      )
        fail("GLOBAL_READ_CANCELLED");
      const lease = op.eligibility;
      if (
        !lease ||
        !Number.isSafeInteger(lease.generation) ||
        lease.generation < 0 ||
        lease.signal.aborted ||
        !lease.isCurrent()
      )
        fail("GLOBAL_READ_WAITING_PROXY");
      if (
        this.disposed ||
        op.controller.signal.aborted ||
        lease.signal.aborted ||
        performance.now() >= op.deadline
      )
        fail(op.error ?? "GLOBAL_READ_CANCELLED");
    } catch (error) {
      const code = error instanceof GlobalReadServiceError ? error.code : "GLOBAL_READ_CANCELLED";
      this.revoke(op, code);
      fail(code);
    }
  }

  private async drive(op: Operation, original: GlobalTokenEnvelope): Promise<GlobalReadSnapshot> {
    let removeAbort = () => undefined as void;
    let timer: ReturnType<typeof setInterval> | undefined;
    const expiry = setTimeout(
      () => this.revoke(op, "GLOBAL_READ_CANCELLED"),
      Math.max(1, op.deadline - performance.now()),
    );
    expiry.unref?.();
    try {
      if (op.controller.signal.aborted || this.disposed) fail(op.error ?? "GLOBAL_READ_CANCELLED");
      op.assertQueued?.();
      op.eligibility = await this.options.acquireEligibility(op.platformId, op.controller.signal);
      if (!op.eligibility) fail("GLOBAL_READ_WAITING_PROXY");
      this.current(op);
      const revoked = () => this.revoke(op, "GLOBAL_READ_WAITING_PROXY");
      op.eligibility.signal.addEventListener("abort", revoked, { once: true });
      removeAbort = () => op.eligibility?.signal.removeEventListener("abort", revoked);
      this.current(op);
      timer = setInterval(() => {
        try {
          this.current(op);
        } catch {
          /* current revokes synchronously */
        }
      }, 1000);
      timer.unref?.();
      let token = original;
      if (Date.parse(token.expiresAt) <= Date.now() + 30_000 && token.refreshToken) {
        try {
          const next = await this.options.refreshToken({
            token: structuredClone(token),
            app: structuredClone(op.app),
            signal: op.controller.signal,
            assertCurrent: () => this.current(op),
          });
          this.current(op);
          this.tokens.commitRefresh(next, token, {
            accountId: op.accountId,
            platformId: op.platformId,
            assertCurrent: () => this.current(op, false),
          });
          op.tokenRevision = this.tokenRevision(op.accountId);
          token = this.tokens.read(op.accountId) ?? fail("GLOBAL_READ_REAUTHORIZE");
          this.current(op);
        } catch (error) {
          this.current(op);
          const code = error && typeof error === "object" && "code" in error ? error.code : null;
          if (code === "OAUTH_REFRESH_REAUTH_REQUIRED" || code === "OAUTH_REFRESH_SCOPE_MISSING")
            fail("GLOBAL_READ_REAUTHORIZE");
          if (code === "OAUTH_REFRESH_RATE_LIMITED") fail("GLOBAL_READ_RATE_LIMITED");
          if (error instanceof GlobalReadServiceError) throw error;
          fail("GLOBAL_READ_UNAVAILABLE");
        }
      }
      const readable = () => {
        this.current(op);
        if (Date.parse(token.expiresAt) <= Date.now()) fail("GLOBAL_READ_REAUTHORIZE");
      };
      readable();
      const raw = await this.options.read({
        token: structuredClone(token),
        signal: op.controller.signal,
        assertCurrent: readable,
      });
      readable();
      const parsed = globalReadDataSchema.safeParse(raw);
      if (!parsed.success) fail("GLOBAL_READ_RESPONSE_INVALID");
      if (parsed.data.remoteId !== op.remoteId) fail("GLOBAL_READ_IDENTITY_MISMATCH");
      const result = this.snapshots.save(
        {
          ...parsed.data,
          accountId: op.accountId,
          platformId: op.platformId,
          fetchedAt: new Date().toISOString(),
        },
        readable,
      );
      readable();
      return result;
    } catch (error) {
      if (op.error) return fail(op.error);
      if (error instanceof GlobalReadServiceError) throw error;
      return fail(globalReadErrorCode(error));
    } finally {
      clearTimeout(expiry);
      if (timer) clearInterval(timer);
      removeAbort();
      try {
        op.eligibility?.release();
      } finally {
        if (this.operations.get(op.accountId) === op) this.operations.delete(op.accountId);
      }
    }
  }
}
