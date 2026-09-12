import { createHash } from "node:crypto";
import type { Database } from "@main/db/database";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { globalAccountIdSchema } from "@shared/global-accounts";
import { GLOBAL_APP_PROFILES, type GlobalAppConfiguration } from "@shared/global-apps";
import type { GlobalPlatformId } from "@shared/platforms";
import { YOUTUBE_UPLOAD_SCOPE } from "@shared/youtube-upload";
import type { GlobalOAuthErrorCode, GlobalOAuthState } from "@shared/global-oauth";
export type { GlobalOAuthErrorCode, GlobalOAuthState } from "@shared/global-oauth";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAppRepository } from "./global-app-repository";
import { GlobalTokenStore, type GlobalTokenEnvelope } from "./global-token-store";
import {
  OAuthFlowManager,
  type OAuthCodeExchangeInput,
  type OAuthFlowHandle,
  type OAuthFlowResult,
} from "./oauth-flow";

/** A live authorization eligibility handle, not a permit for API requests. Every exchange
 * still needs ProxyTransport's separate target/socket-bound permit. This handle may be
 * renewed by the source while its generation remains current; it must abort on loss. */
export interface GlobalOAuthEligibility {
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  release(): void;
}
export class GlobalOAuthServiceError extends Error {
  constructor(readonly code: GlobalOAuthErrorCode) {
    super(code);
    this.name = "GlobalOAuthServiceError";
  }
}

export interface GlobalOAuthServiceOptions {
  db: Database;
  encryption?: CredentialEncryptionProvider;
  /** Must establish current international eligibility before binding a listener or opening a browser. */
  acquireEligibility(
    platformId: GlobalPlatformId,
    signal: AbortSignal,
  ): Promise<GlobalOAuthEligibility | null>;
  exchangeCode(input: OAuthCodeExchangeInput, app: GlobalAppConfiguration): Promise<GlobalTokenEnvelope>;
  /** Main-only, explicit system-browser handoff. Never expose the URL through IPC. */
  openAuthorizationUrl(url: string): Promise<void>;
  onChanged?(state: GlobalOAuthState): void;
  timeoutMs?: number;
  maxConcurrent?: number;
}
interface Operation {
  readonly uploadScope: string | null;
  readonly accountId: string;
  readonly platformId: GlobalPlatformId;
  readonly app: GlobalAppConfiguration;
  readonly fingerprint: string;
  readonly controller: AbortController;
  readonly deadline: number;
  state: GlobalOAuthState;
  eligibility: GlobalOAuthEligibility | null;
  manager: OAuthFlowManager<GlobalTokenEnvelope> | null;
  handle: OAuthFlowHandle | null;
  terminal: boolean;
  retainState: boolean;
}

/** Composes the real loopback manager and atomic vault/identity commit. It never supplies a
 * default transport or eligibility fallback. Mutating IPC handlers must revoke first. */
export class GlobalOAuthService {
  private readonly accounts: GlobalAccountRepository;
  private readonly apps: GlobalAppRepository;
  private readonly vault: CredentialVault;
  private readonly tokens: GlobalTokenStore;
  private readonly operations = new Map<string, Operation>();
  private readonly history = new Map<string, GlobalOAuthState>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private disposed = false;

  constructor(private readonly options: GlobalOAuthServiceOptions) {
    if (
      !options ||
      !options.db ||
      [
        options.db.get,
        options.db.run,
        options.db.transaction,
        options.acquireEligibility,
        options.exchangeCode,
        options.openAuthorizationUrl,
      ].some((value) => typeof value !== "function") ||
      (options.encryption !== undefined &&
        (!options.encryption ||
          [
            options.encryption.isEncryptionAvailable,
            options.encryption.encryptString,
            options.encryption.decryptString,
          ].some((value) => typeof value !== "function")))
    )
      throw new GlobalOAuthServiceError("GLOBAL_OAUTH_UNAVAILABLE");
    this.accounts = new GlobalAccountRepository(options.db);
    this.apps = new GlobalAppRepository(options.db);
    this.vault = new CredentialVault(options.db, options.encryption);
    this.tokens = new GlobalTokenStore(options.db, options.encryption);
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    if (
      !Number.isInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      this.maxConcurrent > 16 ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 10 * 60_000
    )
      throw new GlobalOAuthServiceError("GLOBAL_OAUTH_UNAVAILABLE");
  }

  state(accountId: string): GlobalOAuthState {
    const account = this.account(accountId);
    const operation = this.operations.get(accountId);
    return {
      ...((operation?.retainState ? operation.state : undefined) ??
        this.history.get(accountId) ?? {
          accountId: account.id,
          platformId: account.platformId,
          transactionId: null,
          phase: "idle",
          errorCode: null,
        }),
    };
  }

  startDraft(accountId: string): Promise<GlobalOAuthState> {
    return this.startWithIntent(accountId, "tiktok");
  }
  startUpload(accountId: string): Promise<GlobalOAuthState> {
    return this.startWithIntent(accountId, "youtube");
  }
  start(accountId: string): Promise<GlobalOAuthState> {
    return this.startWithIntent(accountId, null);
  }
  private async startWithIntent(
    accountId: string,
    uploadPlatform: "tiktok" | "youtube" | null,
  ): Promise<GlobalOAuthState> {
    if (this.disposed) throw new GlobalOAuthServiceError("GLOBAL_OAUTH_UNAVAILABLE");
    const account = this.account(accountId);
    if (uploadPlatform && account.platformId !== uploadPlatform)
      throw new GlobalOAuthServiceError("GLOBAL_OAUTH_INVALID_ACCOUNT");
    if (this.operations.has(accountId) || this.operations.size >= this.maxConcurrent)
      throw new GlobalOAuthServiceError("GLOBAL_OAUTH_BUSY");
    let app: GlobalAppConfiguration | null;
    let fingerprint: string;
    try {
      app = this.apps.get(account.platformId);
      if (!app) throw new GlobalOAuthServiceError("GLOBAL_OAUTH_NOT_CONFIGURED");
      this.checkStorage(account.id, app);
      fingerprint = this.fingerprint(app);
    } catch (error) {
      if (error instanceof GlobalOAuthServiceError) throw error;
      throw new GlobalOAuthServiceError("GLOBAL_OAUTH_UNAVAILABLE");
    }
    const op: Operation = {
      uploadScope:
        uploadPlatform === "youtube"
          ? YOUTUBE_UPLOAD_SCOPE
          : uploadPlatform === "tiktok"
            ? "video.upload"
            : null,
      accountId,
      platformId: account.platformId,
      app,
      fingerprint,
      controller: new AbortController(),
      deadline: performance.now() + this.timeoutMs,
      eligibility: null,
      manager: null,
      handle: null,
      terminal: false,
      retainState: true,
      state: {
        accountId,
        platformId: account.platformId,
        transactionId: null,
        phase: "starting",
        errorCode: null,
      },
    };
    // Reserve before asynchronous eligibility work, including reentrant observer callbacks.
    let resolve!: (state: GlobalOAuthState) => void;
    let reject!: (error: unknown) => void;
    const work = new Promise<GlobalOAuthState>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.track(work);
    this.operations.set(accountId, op);
    this.emit(op.state);
    void this.drive(op).then(resolve, reject);
    return work;
  }

  cancel(accountId: string): GlobalOAuthState {
    this.account(accountId);
    const op = this.operations.get(accountId);
    if (op) this.revoke(op, "GLOBAL_OAUTH_CANCELLED");
    return this.state(accountId);
  }
  invalidateAccount(accountId: string): void {
    const op = this.operations.get(accountId);
    if (op) {
      op.retainState = false;
      this.revoke(op, "GLOBAL_OAUTH_REVOKED");
    }
    this.history.delete(accountId);
  }
  invalidatePlatform(platformId: GlobalPlatformId): void {
    for (const op of this.operations.values())
      if (op.platformId === platformId) {
        op.retainState = false;
        this.revoke(op, "GLOBAL_OAUTH_REVOKED");
      }
    for (const [id, state] of this.history) if (state.platformId === platformId) this.history.delete(id);
  }
  invalidate(): void {
    for (const op of this.operations.values()) this.revoke(op, "GLOBAL_OAUTH_REVOKED");
  }
  async whenIdle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await this.whenIdle();
    this.history.clear();
  }

  private account(id: string) {
    try {
      if (globalAccountIdSchema.safeParse(id).success) {
        const account = this.accounts.get(id);
        if (account) return account;
      }
    } catch {
      /* fixed boundary */
    }
    throw new GlobalOAuthServiceError("GLOBAL_OAUTH_INVALID_ACCOUNT");
  }
  private checkStorage(accountId: string, app: GlobalAppConfiguration): void {
    const token = this.vault.meta({ kind: "oauth_token", ownerId: accountId });
    if (!token.encryptionAvailable) throw new GlobalOAuthServiceError("GLOBAL_OAUTH_ENCRYPTION_UNAVAILABLE");
    if (app.platformId !== "x") {
      const secret = this.vault.meta({ kind: "oauth_client_secret", ownerId: app.id });
      if ((secret.hasCredential || app.platformId === "tiktok") && !secret.available)
        throw new GlobalOAuthServiceError("GLOBAL_OAUTH_SECRET_UNAVAILABLE");
    }
  }
  private fingerprint(app: GlobalAppConfiguration): string {
    const current = this.apps.get(app.platformId);
    const credential = this.options.db.get(
      "SELECT id, ciphertext, encryption_version, created_at, updated_at FROM credentials WHERE kind = 'oauth_client_secret' AND owner_id = ?",
      [app.id],
    );
    // Hash only in main; neither the blob nor this private configuration binding is a DTO.
    return createHash("sha256")
      .update(JSON.stringify({ app: current, credential }))
      .digest("hex");
  }
  private assertCurrent(op: Operation): number {
    try {
      if (performance.now() >= op.deadline) throw new GlobalOAuthServiceError("GLOBAL_OAUTH_EXPIRED");
      if (
        this.disposed ||
        op.terminal ||
        op.controller.signal.aborted ||
        this.operations.get(op.accountId) !== op
      )
        throw new Error();
      const eligibility = op.eligibility;
      if (
        !eligibility ||
        !Number.isSafeInteger(eligibility.generation) ||
        eligibility.generation < 0 ||
        eligibility.signal.aborted ||
        !eligibility.isCurrent() ||
        this.fingerprint(op.app) !== op.fingerprint ||
        this.account(op.accountId).platformId !== op.platformId
      )
        throw new Error();
      this.checkStorage(op.accountId, op.app);
      // Callbacks/providers may synchronously revoke; check again after calling them.
      if (op.terminal || op.controller.signal.aborted || eligibility.signal.aborted || this.disposed)
        throw new Error();
      if (performance.now() >= op.deadline) throw new GlobalOAuthServiceError("GLOBAL_OAUTH_EXPIRED");
      return eligibility.generation;
    } catch (error) {
      if (error instanceof GlobalOAuthServiceError && error.code === "GLOBAL_OAUTH_EXPIRED") throw error;
      throw new GlobalOAuthServiceError("GLOBAL_OAUTH_REVOKED");
    }
  }
  private emit(state: GlobalOAuthState): void {
    try {
      this.options.onChanged?.(Object.freeze({ ...state }));
    } catch {
      /* UI observer has no authority */
    }
  }
  private set(
    op: Operation,
    phase: GlobalOAuthState["phase"],
    errorCode: GlobalOAuthErrorCode | null = null,
  ): void {
    op.state = Object.freeze({ ...op.state, phase, errorCode });
    this.emit(op.state);
  }
  private revoke(op: Operation, errorCode: GlobalOAuthErrorCode): void {
    if (op.terminal) return;
    op.terminal = true;
    op.controller.abort(new GlobalOAuthServiceError(errorCode));
    op.manager?.invalidate();
    this.set(
      op,
      errorCode === "GLOBAL_OAUTH_CANCELLED"
        ? "cancelled"
        : errorCode === "GLOBAL_OAUTH_EXPIRED"
          ? "expired"
          : "failed",
      errorCode,
    );
  }
  private finish(op: Operation, result: OAuthFlowResult): void {
    if (op.terminal) return;
    op.terminal = true;
    const code: GlobalOAuthErrorCode | null =
      result.status === "authorized"
        ? null
        : result.status === "cancelled"
          ? "GLOBAL_OAUTH_CANCELLED"
          : result.status === "expired"
            ? "GLOBAL_OAUTH_EXPIRED"
            : "GLOBAL_OAUTH_FAILED";
    this.set(op, result.status, code);
  }
  private track(work: Promise<unknown>): void {
    this.work.add(work);
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work),
    );
  }
  private result(op: Operation): GlobalOAuthState {
    return op.retainState
      ? { ...op.state }
      : {
          accountId: op.accountId,
          platformId: op.platformId,
          transactionId: null,
          phase: "idle",
          errorCode: null,
        };
  }

  private async drive(op: Operation): Promise<GlobalOAuthState> {
    let removeAbort = () => undefined as void;
    let timer: ReturnType<typeof setInterval> | undefined;
    let completion: Promise<void> | null = null;
    const deadlineTimer = setTimeout(
      () => this.revoke(op, "GLOBAL_OAUTH_EXPIRED"),
      Math.max(1, op.deadline - performance.now()),
    );
    deadlineTimer.unref?.();
    const cleanup = () => {
      clearTimeout(deadlineTimer);
      removeAbort();
    };
    try {
      if (op.controller.signal.aborted || op.terminal || this.disposed)
        throw new GlobalOAuthServiceError("GLOBAL_OAUTH_CANCELLED");
      if (performance.now() >= op.deadline) throw new GlobalOAuthServiceError("GLOBAL_OAUTH_EXPIRED");
      const eligibility = await this.options.acquireEligibility(op.platformId, op.controller.signal);
      op.eligibility = eligibility;
      if (!eligibility) throw new GlobalOAuthServiceError("GLOBAL_OAUTH_PROXY_UNVERIFIED");
      this.assertCurrent(op);
      const revoked = () => this.revoke(op, "GLOBAL_OAUTH_REVOKED");
      eligibility.signal.addEventListener("abort", revoked, { once: true });
      removeAbort = () => eligibility.signal.removeEventListener("abort", revoked);
      this.assertCurrent(op);
      const profile = GLOBAL_APP_PROFILES[op.platformId];
      op.manager = new OAuthFlowManager({
        profiles: [
          {
            ...profile,
            scopes: op.uploadScope ? [...profile.scopes, op.uploadScope] : profile.scopes,
            platformId: op.platformId,
            clientId: op.app.clientId,
            redirectPort: op.app.redirectPort,
          },
        ],
        timeoutMs: Math.max(1, Math.ceil(op.deadline - performance.now())),
        maxConcurrent: 1,
        getGeneration: () => this.assertCurrent(op),
        exchangeCode: async (input) => {
          this.assertCurrent(op);
          this.set(op, "exchanging");
          this.assertCurrent(op);
          const token = await this.options.exchangeCode(input, op.app);
          this.assertCurrent(op);
          if (op.uploadScope && !token.scopes.includes(op.uploadScope))
            throw new GlobalOAuthServiceError("GLOBAL_OAUTH_FAILED");
          return token;
        },
        saveTokens: (token, context) => {
          this.tokens.commitAuthorization(token, context);
        },
      });
      // Signals close immediately; the timer also detects missed source events or out-of-band DB edits.
      timer = setInterval(() => {
        try {
          this.assertCurrent(op);
        } catch {
          revoked();
        }
      }, 1000);
      timer.unref?.();
      op.handle = await op.manager.start({
        accountId: op.accountId,
        platformId: op.platformId,
        signal: op.controller.signal,
      });
      op.state = Object.freeze({ ...op.state, transactionId: op.handle.transactionId });
      completion = op.handle.completion.then((result) => this.finish(op, result));
      this.assertCurrent(op);
      this.set(op, "awaiting_user");
      this.assertCurrent(op);
      // Await the actual browser handoff. Cancellation cannot make an unresolved dependency disappear.
      await this.options.openAuthorizationUrl(op.handle.authorizationUrl);
      if (!op.terminal) this.assertCurrent(op);
      // The start IPC can return while the consent dialog is open. Retirement retains the slot
      // through listener shutdown and any exchange that ignores AbortSignal.
      const retire = this.retire(op, completion, cleanup, timer);
      this.track(retire);
      return this.result(op);
    } catch (error) {
      if (!op.terminal)
        this.revoke(op, error instanceof GlobalOAuthServiceError ? error.code : "GLOBAL_OAUTH_FAILED");
      await this.retire(op, completion, cleanup, timer);
      return this.result(op);
    }
  }
  private async retire(
    op: Operation,
    completion: Promise<void> | null,
    removeAbort: () => void,
    timer: ReturnType<typeof setInterval> | undefined,
  ): Promise<void> {
    if (completion) await completion;
    if (timer) clearInterval(timer);
    removeAbort();
    await op.manager?.dispose();
    try {
      op.eligibility?.release();
    } catch {
      /* fixed cleanup; never restore eligibility */
    }
    if (this.operations.get(op.accountId) === op) this.operations.delete(op.accountId);
    if (!this.disposed && op.retainState) {
      this.history.delete(op.accountId);
      this.history.set(op.accountId, op.state);
      while (this.history.size > 30) this.history.delete(this.history.keys().next().value!);
    }
  }
}
