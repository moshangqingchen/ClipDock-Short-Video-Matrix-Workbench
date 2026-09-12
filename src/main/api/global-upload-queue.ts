import type { Database } from "@main/db/database";
import { AssetsRepository } from "@main/db/repositories/assets";
import type { CredentialEncryptionProvider } from "@main/security/credential-vault";
import {
  globalUploadErrorCode,
  isActiveUpload,
  type GlobalUploadJob,
  type GlobalUploadErrorCode,
  type GlobalUploadState,
  type GlobalUploadSubmit,
} from "@shared/global-uploads";
import {
  YOUTUBE_UPLOAD_SCOPE,
  YOUTUBE_UPLOAD_CHUNK_BYTES,
  type YouTubeUploadReceipt,
} from "@shared/youtube-upload";
import type { GlobalPlatformId } from "@shared/platforms";
import type { GlobalOAuthEligibility } from "./global-oauth-service";
import { GlobalAppRepository } from "./global-app-repository";
import { GlobalTokenStore, type GlobalTokenEnvelope } from "./global-token-store";
import type { OAuthTokenRefresher } from "./oauth-refresh";
import { GlobalUploadsRepository, type StoredUpload } from "./global-uploads-repository";
import { prepareUploadFile } from "./global-upload-file";
import {
  GlobalUploadError,
  tiktokChunks,
  type TikTokDraftAdapter,
  type TikTokDraftContext,
} from "./tiktok-draft-adapter";
import type {
  YouTubeUploadAdapter,
  YouTubeUploadSession,
  YouTubeTransferResult,
} from "./youtube-upload-adapter";
import { YouTubeUploadRetryError } from "./youtube-upload-adapter";

interface Options {
  db: Database;
  encryption?: CredentialEncryptionProvider;
  adapter: Pick<TikTokDraftAdapter, "initialize" | "upload" | "status">;
  youtube?: Pick<YouTubeUploadAdapter, "initialize" | "upload" | "query" | "status">;
  acquireEligibility(platform: GlobalPlatformId, signal: AbortSignal): Promise<GlobalOAuthEligibility | null>;
  refreshToken: OAuthTokenRefresher["refresh"];
  canAttempt(): boolean;
  whenTransportIdle(): Promise<void>;
  onChanged?(job: GlobalUploadJob): void;
  pollMs?: number;
  retryMs?: number;
}
interface Operation {
  item: StoredUpload;
  abort: AbortController;
  eligibility: GlobalOAuthEligibility | null;
  deadline: number;
}
function fail(code: GlobalUploadErrorCode): never {
  throw new GlobalUploadError(code);
}

/** Durable upload intent. Resume the original session only after reading its acknowledged byte count. */
export class GlobalUploadQueue {
  private readonly repo: GlobalUploadsRepository;
  private readonly tokens: GlobalTokenStore;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private disposed = false;
  private faulted = false;
  private operation: Operation | null = null;
  private flight: Promise<void> | null = null;
  private readonly due = new Map<string, number>();
  private readonly checks = new Map<string, number>();
  constructor(private readonly options: Options) {
    if ([options.pollMs ?? 1000, options.retryMs ?? 30_000].some((n) => !Number.isSafeInteger(n) || n < 1))
      fail("GLOBAL_UPLOAD_INVALID");
    this.repo = new GlobalUploadsRepository(options.db, options.encryption);
    this.tokens = new GlobalTokenStore(options.db, options.encryption);
    this.repo.recover();
  }
  submit(input: GlobalUploadSubmit): GlobalUploadJob {
    if (this.disposed || this.faulted) fail("GLOBAL_UPLOAD_UNAVAILABLE");
    const job = this.repo.submit(input);
    this.emit(job);
    return job;
  }
  list(accountId: string): GlobalUploadJob[] {
    return this.repo.list(accountId);
  }
  cancel(jobId: string): GlobalUploadJob | null {
    const item = this.repo.get(jobId);
    if (!item || !isActiveUpload(item.job)) return item?.job ?? null;
    if (this.operation?.item.job.id === jobId) this.operation.abort.abort();
    try {
      const next = this.repo.update(item, "cancelled", { errorCode: "GLOBAL_UPLOAD_CANCELLED" });
      this.due.delete(jobId);
      this.checks.delete(jobId);
      if (next) this.emit(next.job);
      return next?.job ?? this.repo.get(jobId)?.job ?? null;
    } catch (error) {
      this.halt();
      throw error;
    }
  }
  check(jobId: string): GlobalUploadJob {
    if (this.disposed || this.faulted) fail("GLOBAL_UPLOAD_UNAVAILABLE");
    const item = this.repo.get(jobId);
    if (!item || !this.repo.hasSession(item)) fail("GLOBAL_UPLOAD_UNCERTAIN");
    if (this.repo.binding(item.job.accountId) !== item.bindingHash) fail("GLOBAL_UPLOAD_UNAUTHORIZED");
    if (isActiveUpload(item.job)) return item.job;
    if (this.repo.active().some((value) => value.job.accountId === item.job.accountId))
      fail("GLOBAL_UPLOAD_BUSY");
    const next = this.repo.update(item, "waiting-proxy", {
      checkOnly: true,
      attempts: 0,
      errorCode: "GLOBAL_UPLOAD_WAITING_PROXY",
    });
    if (!next) return fail("GLOBAL_UPLOAD_UNAVAILABLE");
    this.due.delete(jobId);
    this.checks.delete(jobId);
    this.emit(next.job);
    return next.job;
  }
  invalidateAccount(accountId: string): void {
    for (const item of this.repo.active()) if (item.job.accountId === accountId) this.cancel(item.job.id);
  }
  invalidatePlatform(platformId: GlobalPlatformId): void {
    for (const item of this.repo.active()) if (item.job.platformId === platformId) this.cancel(item.job.id);
  }
  invalidateNetwork(): void {
    this.operation?.abort.abort();
    try {
      for (const item of this.repo.active())
        if (item.job.state !== "waiting-proxy") {
          const uncertain = item.initAttempted && !this.repo.hasSession(item);
          const next = this.repo.update(item, uncertain ? "uncertain" : "waiting-proxy", {
            errorCode: uncertain ? "GLOBAL_UPLOAD_UNCERTAIN" : "GLOBAL_UPLOAD_WAITING_PROXY",
          });
          if (next) this.emit(next.job);
        }
    } catch {
      this.halt();
    }
  }
  start(): void {
    if (this.running || this.disposed || this.faulted) return;
    this.running = true;
    this.timer = setInterval(() => this.sync(), this.options.pollMs ?? 1000);
    this.timer.unref?.();
    this.sync();
  }
  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.invalidateNetwork();
  }
  sync(): void {
    if (!this.running || this.disposed || this.faulted) return;
    try {
      if (this.options.canAttempt() !== true) {
        if (this.operation) this.invalidateNetwork();
        return;
      }
      if (this.flight) return;
      const item = this.repo.active().find((value) => {
        let current = false;
        try {
          current = this.repo.binding(value.job.accountId) === value.bindingHash;
        } catch {
          /* no longer authorized */
        }
        if (!current) {
          const next = this.repo.update(value, "cancelled", { errorCode: "GLOBAL_UPLOAD_UNAUTHORIZED" });
          if (next) this.emit(next.job);
        }
        return (
          current && value.notBeforeAt <= Date.now() && (this.due.get(value.job.id) ?? 0) <= performance.now()
        );
      });
      if (!item) return;
      const op: Operation = {
        item,
        abort: new AbortController(),
        eligibility: null,
        deadline: performance.now() + (item.job.platformId === "youtube" ? 86_400_000 : 3_600_000),
      };
      this.operation = op;
      const pending = Promise.resolve()
        .then(() => this.execute(op))
        .catch(() => this.halt())
        .finally(() => {
          if (this.operation === op) this.operation = null;
          if (this.flight === pending) this.flight = null;
        });
      this.flight = pending;
    } catch {
      this.halt();
    }
  }
  async whenIdle(): Promise<void> {
    while (this.flight) await this.flight;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stop();
    await this.whenIdle();
  }
  private current(op: Operation, requireEligibility = true): void {
    if (this.disposed || this.faulted || !this.running || this.operation !== op || op.abort.signal.aborted)
      fail("GLOBAL_UPLOAD_CANCELLED");
    if (performance.now() >= op.deadline) fail("GLOBAL_UPLOAD_EXPIRED");
    if (this.options.canAttempt() !== true) fail("GLOBAL_UPLOAD_WAITING_PROXY");
    this.repo.assertCurrent(op.item);
    if (
      requireEligibility &&
      (!op.eligibility || op.eligibility.signal.aborted || !op.eligibility.isCurrent())
    )
      fail("GLOBAL_UPLOAD_WAITING_PROXY");
    if (op.abort.signal.aborted || this.disposed || this.operation !== op) fail("GLOBAL_UPLOAD_CANCELLED");
  }
  private set(
    op: Operation,
    state: GlobalUploadState,
    patch: Parameters<GlobalUploadsRepository["update"]>[2] = {},
  ): void {
    this.current(op);
    op.item = this.repo.update(op.item, state, patch) ?? fail("GLOBAL_UPLOAD_CANCELLED");
    this.emit(op.item.job);
    if (isActiveUpload(op.item.job)) this.current(op);
  }
  private async context(op: Operation): Promise<TikTokDraftContext> {
    this.current(op);
    let token = this.tokens.read(op.item.job.accountId);
    const platform = op.item.job.platformId,
      scope = platform === "youtube" ? YOUTUBE_UPLOAD_SCOPE : "video.upload";
    if (!token || token.platformId !== platform) fail("GLOBAL_UPLOAD_REAUTHORIZE");
    if (!token.scopes.includes(scope)) fail("GLOBAL_UPLOAD_SCOPE_MISSING");
    if (Date.parse(token.expiresAt) <= Date.now() + 150_000 && token.refreshToken) {
      const app = new GlobalAppRepository(this.options.db).get(platform);
      if (!app) fail("GLOBAL_UPLOAD_UNAVAILABLE");
      const previous: GlobalTokenEnvelope = token;
      try {
        const fresh = await this.options.refreshToken({
          token: structuredClone(previous),
          app,
          signal: op.abort.signal,
          assertCurrent: () => this.current(op),
        });
        this.current(op);
        this.tokens.commitRefresh(fresh, previous, {
          accountId: op.item.job.accountId,
          platformId: platform,
          assertCurrent: () => this.current(op),
        });
      } catch (error) {
        this.current(op);
        const rotated = this.tokens.read(op.item.job.accountId);
        if (
          !rotated ||
          JSON.stringify(rotated) === JSON.stringify(previous) ||
          Date.parse(rotated.expiresAt) <= Date.now() + 150_000
        ) {
          const code = error && typeof error === "object" && "code" in error ? error.code : null;
          if (code === "OAUTH_REFRESH_RATE_LIMITED") fail("GLOBAL_UPLOAD_RATE_LIMITED");
          if (code === "OAUTH_REFRESH_REAUTH_REQUIRED" || code === "OAUTH_REFRESH_SCOPE_MISSING")
            fail("GLOBAL_UPLOAD_REAUTHORIZE");
          fail("GLOBAL_UPLOAD_UNAVAILABLE");
        }
      }
      token = this.tokens.read(op.item.job.accountId);
    }
    this.current(op);
    if (!token || token.platformId !== platform || Date.parse(token.expiresAt) <= Date.now())
      fail("GLOBAL_UPLOAD_REAUTHORIZE");
    if (!token.scopes.includes(scope)) fail("GLOBAL_UPLOAD_SCOPE_MISSING");
    return { token, signal: op.abort.signal, assertCurrent: () => this.current(op) };
  }
  private async execute(op: Operation): Promise<void> {
    let file: Awaited<ReturnType<typeof prepareUploadFile>> | undefined;
    const revoke = () => op.abort.abort();
    const timer = setInterval(() => {
      try {
        this.current(op, !!op.eligibility);
      } catch {
        revoke();
      }
    }, 1000);
    timer.unref?.();
    try {
      this.current(op, false);
      op.eligibility = await this.options.acquireEligibility(op.item.job.platformId, op.abort.signal);
      if (!op.eligibility) fail("GLOBAL_UPLOAD_WAITING_PROXY");
      op.eligibility.signal.addEventListener("abort", revoke, { once: true });
      this.current(op);
      if (op.item.job.platformId === "youtube") {
        await this.executeYouTube(op);
        return;
      }
      let session = this.repo.session(op.item);
      if (session && !("publishId" in session)) fail("GLOBAL_UPLOAD_INVALID");
      if (session) {
        this.set(op, "checking");
        const status = await this.options.adapter.status(
          await this.context(op),
          session.publishId,
          op.item.job.totalBytes,
        );
        this.current(op);
        if (status.state !== "uploading") {
          this.set(op, status.state, {
            sentBytes: status.state === "failed" ? op.item.job.sentBytes : op.item.job.totalBytes,
            errorCode: status.state === "failed" ? "GLOBAL_UPLOAD_REJECTED" : null,
          });
          return;
        }
        const n = status.uploadedBytes;
        if (
          n === null ||
          n < op.item.job.sentBytes ||
          (n !== op.item.job.totalBytes &&
            !tiktokChunks(op.item.job.totalBytes).parts.some((part) => part.start === n))
        )
          fail("GLOBAL_UPLOAD_PROGRESS_MISMATCH");
        this.set(op, "checking", { sentBytes: n });
        if (n === op.item.job.totalBytes) {
          const checks = (this.checks.get(op.item.job.id) ?? 0) + 1;
          this.checks.set(op.item.job.id, checks);
          this.set(op, checks >= 60 ? "uncertain" : "processing", {
            errorCode: checks >= 60 ? "GLOBAL_UPLOAD_UNCERTAIN" : null,
          });
          return;
        }
        if (op.item.checkOnly) {
          this.set(op, "uncertain", { errorCode: "GLOBAL_UPLOAD_UNCERTAIN" });
          return;
        }
        if (Date.parse(session.expiresAt) <= Date.now()) fail("GLOBAL_UPLOAD_EXPIRED");
      } else if (op.item.initAttempted || op.item.checkOnly) fail("GLOBAL_UPLOAD_UNCERTAIN");
      this.set(op, "preparing");
      const asset = new AssetsRepository(this.options.db).get(op.item.job.assetId);
      if (!asset || asset.sha256 !== op.item.assetSha || asset.sizeBytes !== op.item.job.totalBytes)
        fail("GLOBAL_UPLOAD_FILE_CHANGED");
      file = await prepareUploadFile(asset, () => this.current(op));
      this.current(op);
      if (!session) {
        const ctx = await this.context(op);
        this.set(op, "initializing", { initAttempted: true });
        session = await this.options.adapter.initialize(ctx, op.item.job.totalBytes);
        this.current(op);
        op.item = this.repo.saveSession(op.item, session);
        this.emit(op.item.job);
      }
      for (let i = 0; i < file.plan.count; i++) {
        const part = file.plan.parts[i];
        if (part.end < op.item.job.sentBytes) continue;
        this.set(op, "uploading");
        const bytes = await file.read(i),
          ctx = await this.context(op);
        this.current(op);
        await this.options.adapter.upload(ctx, session, op.item.job.totalBytes, part.start, file.mime, bytes);
        this.set(op, "uploading", { sentBytes: part.end + 1 });
      }
      this.set(op, "processing");
    } catch (error) {
      // A cancelled/replaced task's revision cannot be updated by this old operation.
      const live = this.repo.get(op.item.job.id);
      if (live?.job.revision === op.item.job.revision && isActiveUpload(live.job)) {
        const code = globalUploadErrorCode(error),
          hasSession = this.repo.hasSession(live);
        let state: GlobalUploadState = "failed",
          errorCode = code;
        const transient = [
          "GLOBAL_UPLOAD_WAITING_PROXY",
          "GLOBAL_UPLOAD_CANCELLED",
          "GLOBAL_UPLOAD_UNAVAILABLE",
          "GLOBAL_UPLOAD_UNCERTAIN",
        ].includes(code);
        const refused = [
          "GLOBAL_UPLOAD_SCOPE_MISSING",
          "GLOBAL_UPLOAD_REAUTHORIZE",
          "GLOBAL_UPLOAD_RATE_LIMITED",
          "GLOBAL_UPLOAD_FORBIDDEN",
          "GLOBAL_UPLOAD_REJECTED",
        ].includes(code);
        if (live.initAttempted && !hasSession && !refused) {
          state = "uncertain";
          errorCode = "GLOBAL_UPLOAD_UNCERTAIN";
        } else if (
          code === "GLOBAL_UPLOAD_PROGRESS_MISMATCH" ||
          (live.job.platformId === "youtube" && code === "GLOBAL_UPLOAD_UNCERTAIN")
        )
          state = "uncertain";
        else if (transient) {
          state = "waiting-proxy";
          errorCode = "GLOBAL_UPLOAD_WAITING_PROXY";
        }
        const attempts = Math.min(30, live.attempts + 1);
        if (
          live.job.platformId === "youtube" &&
          (!live.initAttempted || hasSession) &&
          state !== "uncertain" &&
          (transient || code === "GLOBAL_UPLOAD_RATE_LIMITED") &&
          code !== "GLOBAL_UPLOAD_WAITING_PROXY" &&
          code !== "GLOBAL_UPLOAD_CANCELLED"
        ) {
          state = attempts >= 8 ? "failed" : "waiting-retry";
          errorCode = code;
        }
        const notBeforeAt =
          state === "waiting-retry"
            ? Date.now() +
              Math.max(
                Math.min(300_000, 30_000 * 2 ** Math.min(4, attempts - 1)),
                error instanceof YouTubeUploadRetryError ? error.retryAfterMs : 0,
              )
            : live.notBeforeAt;
        const next = this.repo.update(live, state, { errorCode, attempts, notBeforeAt });
        if (next) this.emit(next.job);
      }
    } finally {
      clearInterval(timer);
      op.abort.abort();
      let cleanupFailed = false;
      try {
        await file?.close();
      } catch {
        cleanupFailed = true;
      }
      try {
        op.eligibility?.signal.removeEventListener("abort", revoke);
        op.eligibility?.release();
      } catch {
        cleanupFailed = true;
      }
      try {
        await this.options.whenTransportIdle();
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) fail("GLOBAL_UPLOAD_UNAVAILABLE");
      const live = this.repo.get(op.item.job.id);
      if (live && isActiveUpload(live.job))
        this.due.set(op.item.job.id, performance.now() + (this.options.retryMs ?? 30_000));
      else {
        this.due.delete(op.item.job.id);
        this.checks.delete(op.item.job.id);
      }
    }
  }
  private youtubeProcessing(op: Operation, receipt?: YouTubeUploadReceipt): void {
    const checks = (this.checks.get(op.item.job.id) ?? 0) + 1;
    this.checks.set(op.item.job.id, checks);
    this.set(op, checks >= 60 ? "uncertain" : "processing", {
      receipt,
      errorCode: checks >= 60 ? "GLOBAL_UPLOAD_UNCERTAIN" : null,
    });
  }
  private youtubeReceipt(op: Operation, session: YouTubeUploadSession, receipt: YouTubeUploadReceipt): void {
    this.current(op);
    if (session.videoId && session.videoId !== receipt.videoId) fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    if (!session.videoId) {
      op.item = this.repo.saveSession(op.item, { ...session, videoId: receipt.videoId });
      this.emit(op.item.job);
    }
    this.set(op, "checking", { sentBytes: op.item.job.totalBytes, receipt, attempts: 0, notBeforeAt: 0 });
    if (receipt.state === "processing") this.youtubeProcessing(op, receipt);
    else
      this.set(op, receipt.state, {
        receipt,
        errorCode: receipt.state === "failed" ? "GLOBAL_UPLOAD_REJECTED" : null,
      });
  }
  private youtubeProgress(
    op: Operation,
    session: YouTubeUploadSession,
    result: YouTubeTransferResult,
  ): boolean {
    if (result.kind === "complete") {
      this.youtubeReceipt(op, session, result.receipt);
      return true;
    }
    const previous = op.item.job.sentBytes;
    if (result.receivedBytes < previous) fail("GLOBAL_UPLOAD_PROGRESS_MISMATCH");
    this.set(op, "checking", {
      sentBytes: result.receivedBytes,
      attempts: result.receivedBytes > previous ? 0 : op.item.attempts,
    });
    if (result.retryAfterMs > 0) {
      this.set(op, "waiting-retry", { notBeforeAt: Date.now() + Math.ceil(result.retryAfterMs) });
      return true;
    }
    if (result.receivedBytes === op.item.job.totalBytes) {
      this.youtubeProcessing(op);
      return true;
    }
    return false;
  }
  private async executeYouTube(op: Operation): Promise<void> {
    const adapter = this.options.youtube;
    if (!adapter || !op.item.job.youtube) fail("GLOBAL_UPLOAD_UNAVAILABLE");
    const saved = this.repo.session(op.item);
    if (saved && !("videoId" in saved)) fail("GLOBAL_UPLOAD_INVALID");
    let session: YouTubeUploadSession | null = saved;
    if (session) {
      this.set(op, "checking");
      if (session.videoId) {
        this.youtubeReceipt(op, session, await adapter.status(await this.context(op), session.videoId));
        return;
      }
      const result = await adapter.query(await this.context(op), session, op.item.job.totalBytes);
      this.current(op);
      if (this.youtubeProgress(op, session, result)) return;
      if (op.item.checkOnly) {
        this.set(op, "uncertain", { errorCode: "GLOBAL_UPLOAD_UNCERTAIN" });
        return;
      }
    } else if (op.item.initAttempted || op.item.checkOnly) fail("GLOBAL_UPLOAD_UNCERTAIN");
    this.set(op, "preparing");
    const asset = new AssetsRepository(this.options.db).get(op.item.job.assetId);
    if (!asset || asset.sha256 !== op.item.assetSha || asset.sizeBytes !== op.item.job.totalBytes)
      fail("GLOBAL_UPLOAD_FILE_CHANGED");
    const file = await prepareUploadFile(asset, () => this.current(op), "youtube");
    try {
      if (!session) {
        const ctx = await this.context(op);
        this.set(op, "initializing", { initAttempted: true });
        session = await adapter.initialize(ctx, asset.sizeBytes, file.mime, op.item.job.youtube!);
        this.current(op);
        op.item = this.repo.saveSession(op.item, session);
        this.emit(op.item.job);
      }
      while (op.item.job.sentBytes < asset.sizeBytes) {
        const start = op.item.job.sentBytes;
        this.set(op, "uploading", { notBeforeAt: 0 });
        const bytes = await file.readRange(
          start,
          Math.min(YOUTUBE_UPLOAD_CHUNK_BYTES, asset.sizeBytes - start),
        );
        const result = await adapter.upload(
          await this.context(op),
          session,
          asset.sizeBytes,
          start,
          file.mime,
          bytes,
        );
        this.current(op);
        if (this.youtubeProgress(op, session, result)) return;
        if (op.item.job.sentBytes === start) {
          const attempts = Math.min(30, op.item.attempts + 1);
          this.set(op, attempts >= 8 ? "uncertain" : "waiting-retry", {
            attempts,
            notBeforeAt: Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(4, attempts - 1)),
            errorCode: "GLOBAL_UPLOAD_UNCERTAIN",
          });
          return;
        }
      }
    } finally {
      try {
        await file.close();
      } catch {
        this.halt();
      }
    }
  }
  private emit(job: GlobalUploadJob): void {
    if (!isActiveUpload(job)) {
      this.due.delete(job.id);
      this.checks.delete(job.id);
    }
    try {
      this.options.onChanged?.(structuredClone(job));
    } catch {
      /* projection only */
    }
  }
  private halt(): void {
    this.faulted = true;
    this.running = false;
    clearInterval(this.timer);
    this.operation?.abort.abort();
  }
}
