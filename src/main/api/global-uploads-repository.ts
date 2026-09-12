import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "@main/db/database";
import { AssetsRepository } from "@main/db/repositories/assets";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { globalAccountIdSchema } from "@shared/global-accounts";
import {
  globalUploadJobSchema,
  globalUploadSubmitSchema,
  isActiveUpload,
  type GlobalUploadJob,
  type GlobalUploadState,
  type GlobalUploadErrorCode,
  type GlobalUploadSubmit,
} from "@shared/global-uploads";
import { YOUTUBE_UPLOAD_SCOPE, youtubeVideoIdSchema } from "@shared/youtube-upload";
import { GlobalJobsRepository } from "./global-jobs-repository";
import { GlobalTokenStore } from "./global-token-store";
import { uploadAssetMime } from "./global-upload-file";
import { GlobalUploadError, type TikTokDraftSession } from "./tiktok-draft-adapter";
import { validTikTokUploadUrl } from "./proxy-target-policy";
import { validYouTubeUploadUrl } from "./youtube-upload-target";
import type { YouTubeUploadSession } from "./youtube-upload-adapter";
export type SavedUploadSession = TikTokDraftSession | YouTubeUploadSession;

export interface StoredUpload {
  job: GlobalUploadJob;
  bindingHash: string;
  assetSha: string;
  initAttempted: boolean;
  checkOnly: boolean;
  notBeforeAt: number;
  attempts: number;
}
const ACTIVE =
  "state IN ('waiting-proxy','waiting-retry','preparing','initializing','uploading','checking','processing')";
const envelope = z
  .object({
    jobId: z.string().uuid(),
    accountId: z.string().uuid(),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    session: z.union([
      z
        .object({
          publishId: z.string().regex(/^[A-Za-z0-9_.~-]{1,64}$/),
          uploadUrl: z.string().refine(validTikTokUploadUrl),
          expiresAt: z.string().datetime({ offset: true }),
        })
        .strict(),
      z
        .object({
          uploadUrl: z.string().refine(validYouTubeUploadUrl),
          expiresAt: z.string().datetime({ offset: true }),
          videoId: youtubeVideoIdSchema.nullable(),
        })
        .strict(),
    ]),
  })
  .strict();
function fail(code: GlobalUploadErrorCode = "GLOBAL_UPLOAD_SAVE_FAILED"): never {
  throw new GlobalUploadError(code);
}
function id(value: string): void {
  if (!globalAccountIdSchema.safeParse(value).success) fail("GLOBAL_UPLOAD_INVALID");
}
function fixed<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof GlobalUploadError) throw error;
    return fail();
  }
}
function fromRow(row: Record<string, unknown>): StoredUpload {
  const job = globalUploadJobSchema.parse(JSON.parse(String(row.job_json)));
  if (
    job.id !== row.id ||
    job.accountId !== row.account_id ||
    job.state !== row.state ||
    job.revision !== row.revision ||
    !/^[a-f0-9]{64}$/.test(String(row.binding_hash)) ||
    !/^[a-f0-9]{64}$/.test(String(row.asset_sha256)) ||
    ![0, 1].includes(row.init_attempted as number) ||
    ![0, 1].includes(row.check_only as number) ||
    ![row.not_before_at, row.attempts].every(
      (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    )
  )
    fail("GLOBAL_UPLOAD_UNAVAILABLE");
  return {
    job,
    bindingHash: String(row.binding_hash),
    assetSha: String(row.asset_sha256),
    initAttempted: row.init_attempted === 1,
    checkOnly: row.check_only === 1,
    notBeforeAt: Number(row.not_before_at),
    attempts: Number(row.attempts),
  };
}
export class GlobalUploadsRepository {
  private readonly vault: CredentialVault;
  private readonly tokens: GlobalTokenStore;
  constructor(
    private readonly db: Database,
    encryption?: CredentialEncryptionProvider,
  ) {
    this.vault = new CredentialVault(db, encryption);
    this.tokens = new GlobalTokenStore(db, encryption);
  }
  binding(accountId: string): string {
    id(accountId);
    try {
      const value = new GlobalJobsRepository(this.db).binding(accountId);
      if (value.platformId !== "tiktok" && value.platformId !== "youtube") fail("GLOBAL_UPLOAD_INVALID");
      return value.hash;
    } catch (error) {
      if (error instanceof GlobalUploadError) throw error;
      return fail("GLOBAL_UPLOAD_UNAUTHORIZED");
    }
  }
  get(jobId: string): StoredUpload | null {
    id(jobId);
    return fixed(() => {
      const row = this.db.get("SELECT * FROM global_upload_jobs WHERE id = ?", [jobId]);
      return row ? fromRow(row) : null;
    });
  }
  list(accountId: string): GlobalUploadJob[] {
    id(accountId);
    return fixed(() =>
      this.db
        .all(
          `SELECT * FROM global_upload_jobs WHERE account_id = ? ORDER BY CASE WHEN ${ACTIVE} THEN 0 ELSE 1 END, rowid DESC LIMIT 20`,
          [accountId],
        )
        .map((row) => fromRow(row).job),
    );
  }
  active(): StoredUpload[] {
    return fixed(() =>
      this.db.all(`SELECT * FROM global_upload_jobs WHERE ${ACTIVE} ORDER BY rowid`).map(fromRow),
    );
  }
  submit(input: GlobalUploadSubmit): GlobalUploadJob {
    const parsed = globalUploadSubmitSchema.safeParse(input);
    if (!parsed.success) fail("GLOBAL_UPLOAD_INVALID");
    input = parsed.data;
    return fixed(() =>
      this.db.transaction(() => {
        const bindingHash = this.binding(input.accountId),
          token = this.tokens.read(input.accountId);
        if (!token || (token.platformId !== "tiktok" && token.platformId !== "youtube"))
          fail("GLOBAL_UPLOAD_UNAUTHORIZED");
        if (!token.scopes.includes(token.platformId === "youtube" ? YOUTUBE_UPLOAD_SCOPE : "video.upload"))
          fail("GLOBAL_UPLOAD_SCOPE_MISSING");
        if ((token.platformId === "youtube") !== !!input.youtube) fail("GLOBAL_UPLOAD_INVALID");
        const asset = new AssetsRepository(this.db).get(input.assetId);
        if (!asset) fail("GLOBAL_UPLOAD_FILE_CHANGED");
        uploadAssetMime(asset, token.platformId);
        const previous = this.active().find((item) => item.job.accountId === input.accountId);
        if (previous) {
          if (
            previous.bindingHash === bindingHash &&
            previous.job.assetId === asset.id &&
            previous.assetSha === asset.sha256 &&
            JSON.stringify(previous.job.youtube ?? null) === JSON.stringify(input.youtube ?? null)
          )
            return previous.job;
          return fail("GLOBAL_UPLOAD_BUSY");
        }
        if (!this.vault.meta({ kind: "upload_session", ownerId: "default" }).encryptionAvailable)
          fail("GLOBAL_UPLOAD_UNAVAILABLE");
        const now = new Date().toISOString();
        const job = globalUploadJobSchema.parse({
          id: randomUUID(),
          ...input,
          platformId: token.platformId,
          fileName: asset.fileName,
          state: "waiting-proxy",
          sentBytes: 0,
          totalBytes: asset.sizeBytes,
          revision: 1,
          errorCode: "GLOBAL_UPLOAD_WAITING_PROXY",
          createdAt: now,
          updatedAt: now,
        });
        const result = this.db.run(
          "INSERT INTO global_upload_jobs (id,account_id,state,revision,job_json,binding_hash,asset_sha256) VALUES (?,?,?,?,?,?,?)",
          [job.id, job.accountId, job.state, job.revision, JSON.stringify(job), bindingHash, asset.sha256!],
        );
        if (result.changes !== 1 || JSON.stringify(this.get(job.id)?.job) !== JSON.stringify(job)) fail();
        this.audit(job);
        this.prune(job.accountId);
        return job;
      }),
    );
  }
  update(
    previous: StoredUpload,
    state: GlobalUploadState,
    patch: {
      errorCode?: GlobalUploadErrorCode | null;
      sentBytes?: number;
      initAttempted?: boolean;
      checkOnly?: boolean;
      notBeforeAt?: number;
      attempts?: number;
      receipt?: GlobalUploadJob["receipt"];
    } = {},
  ): StoredUpload | null {
    return fixed(() =>
      this.db.transaction(() => {
        const current = this.get(previous.job.id);
        if (!current || current.job.revision !== previous.job.revision) return null;
        const job = globalUploadJobSchema.parse({
          ...current.job,
          ...(patch.receipt ? { receipt: patch.receipt } : {}),
          state,
          sentBytes: patch.sentBytes ?? current.job.sentBytes,
          errorCode: patch.errorCode ?? null,
          revision: current.job.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        const init = patch.initAttempted ?? current.initAttempted,
          checkOnly = patch.checkOnly ?? current.checkOnly,
          notBeforeAt = patch.notBeforeAt ?? current.notBeforeAt,
          attempts = patch.attempts ?? current.attempts;
        if (![notBeforeAt, attempts].every((value) => Number.isSafeInteger(value) && value >= 0)) fail();
        const changed = this.db.run(
          "UPDATE global_upload_jobs SET state=?,revision=?,job_json=?,init_attempted=?,check_only=?,not_before_at=?,attempts=? WHERE id=? AND revision=?",
          [
            state,
            job.revision,
            JSON.stringify(job),
            Number(init),
            Number(checkOnly),
            notBeforeAt,
            attempts,
            job.id,
            current.job.revision,
          ],
        );
        const saved = this.get(job.id);
        if (
          changed.changes !== 1 ||
          !saved ||
          JSON.stringify(saved.job) !== JSON.stringify(job) ||
          saved.initAttempted !== init ||
          saved.checkOnly !== checkOnly ||
          saved.notBeforeAt !== notBeforeAt ||
          saved.attempts !== attempts
        )
          fail();
        this.audit(job);
        if (!isActiveUpload(job)) this.prune(job.accountId);
        return saved;
      }),
    );
  }
  assertCurrent(item: StoredUpload): void {
    const current = this.get(item.job.id);
    if (
      !current ||
      current.job.revision !== item.job.revision ||
      !isActiveUpload(current.job) ||
      this.binding(item.job.accountId) !== item.bindingHash
    )
      fail("GLOBAL_UPLOAD_CANCELLED");
  }
  session(item: StoredUpload): SavedUploadSession | null {
    return fixed(() => {
      const raw = this.vault.get({ kind: "upload_session", ownerId: item.job.id });
      if (!raw) return null;
      const parsed = envelope.parse(JSON.parse(raw));
      if (
        parsed.jobId !== item.job.id ||
        parsed.accountId !== item.job.accountId ||
        parsed.bindingHash !== item.bindingHash ||
        (item.job.platformId === "youtube") !== "videoId" in parsed.session
      )
        fail("GLOBAL_UPLOAD_UNAVAILABLE");
      return parsed.session;
    });
  }
  saveSession(item: StoredUpload, session: SavedUploadSession): StoredUpload {
    return fixed(() =>
      this.db.transaction(() => {
        this.assertCurrent(item);
        if ((item.job.platformId === "youtube") !== "videoId" in session) fail();
        const payload = envelope.parse({
          jobId: item.job.id,
          accountId: item.job.accountId,
          bindingHash: item.bindingHash,
          session,
        });
        const secret = JSON.stringify(payload);
        const ref = { kind: "upload_session" as const, ownerId: item.job.id };
        this.vault.set({ ...ref, secret });
        if (this.vault.get(ref) !== secret) fail();
        this.assertCurrent(item);
        return this.update(item, "uploading") ?? fail();
      }),
    );
  }
  hasSession(item: StoredUpload): boolean {
    return this.vault.has({ kind: "upload_session", ownerId: item.job.id });
  }
  recover(): void {
    fixed(() =>
      this.db.transaction(() => {
        for (const item of this.active()) {
          const uncertain = item.initAttempted && !this.hasSession(item);
          const retrying = item.notBeforeAt > Date.now();
          this.update(item, uncertain ? "uncertain" : retrying ? "waiting-retry" : "waiting-proxy", {
            errorCode: uncertain
              ? "GLOBAL_UPLOAD_UNCERTAIN"
              : retrying
                ? item.job.errorCode
                : "GLOBAL_UPLOAD_WAITING_PROXY",
          });
        }
      }),
    );
  }
  private prune(accountId: string): void {
    this.db.run(
      `DELETE FROM global_upload_jobs WHERE id IN (SELECT id FROM global_upload_jobs WHERE account_id = ? AND NOT (${ACTIVE}) ORDER BY rowid DESC LIMIT -1 OFFSET 20)`,
      [accountId],
    );
  }
  private audit(job: GlobalUploadJob): void {
    const details = JSON.stringify({
      jobId: job.id,
      state: job.state,
      revision: job.revision,
      sentBytes: job.sentBytes,
      totalBytes: job.totalBytes,
      errorCode: job.errorCode,
    });
    const result = this.db.run(
      "INSERT INTO audit_events (action,account_id,details_json,created_at) VALUES ('UploadAttempt',?,?,?)",
      [job.accountId, details, job.updatedAt],
    );
    const row = this.db.get("SELECT action,account_id,details_json FROM audit_events WHERE id = ?", [
      result.lastInsertRowid,
    ]);
    if (
      result.changes !== 1 ||
      row?.action !== "UploadAttempt" ||
      row.account_id !== job.accountId ||
      row.details_json !== details
    )
      fail();
  }
}
