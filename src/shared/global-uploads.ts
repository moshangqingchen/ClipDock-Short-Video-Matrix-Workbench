import { z } from "zod";
import { globalAccountIdSchema } from "./global-accounts";
import {
  YOUTUBE_MAX_BYTES,
  youtubeUploadMetadataSchema,
  youtubeVideoIdSchema,
  youtubePrivacySchema,
} from "./youtube-upload";

export const GLOBAL_UPLOAD_ERRORS = [
  "GLOBAL_UPLOAD_INVALID",
  "GLOBAL_UPLOAD_UNAVAILABLE",
  "GLOBAL_UPLOAD_UNAUTHORIZED",
  "GLOBAL_UPLOAD_SCOPE_MISSING",
  "GLOBAL_UPLOAD_WAITING_PROXY",
  "GLOBAL_UPLOAD_CANCELLED",
  "GLOBAL_UPLOAD_BUSY",
  "GLOBAL_UPLOAD_FILE_CHANGED",
  "GLOBAL_UPLOAD_FILE_UNSUPPORTED",
  "GLOBAL_UPLOAD_SAVE_FAILED",
  "GLOBAL_UPLOAD_RESPONSE_INVALID",
  "GLOBAL_UPLOAD_REAUTHORIZE",
  "GLOBAL_UPLOAD_RATE_LIMITED",
  "GLOBAL_UPLOAD_FORBIDDEN",
  "GLOBAL_UPLOAD_EXPIRED",
  "GLOBAL_UPLOAD_UNCERTAIN",
  "GLOBAL_UPLOAD_REJECTED",
  "GLOBAL_UPLOAD_PROGRESS_MISMATCH",
] as const;
export type GlobalUploadErrorCode = (typeof GLOBAL_UPLOAD_ERRORS)[number];
export const globalUploadSubmitSchema = z
  .object({
    accountId: globalAccountIdSchema,
    assetId: z.string().uuid(),
    youtube: youtubeUploadMetadataSchema.optional(),
  })
  .strict();
export const globalUploadJobSchema = z
  .object({
    id: z.string().uuid(),
    accountId: globalAccountIdSchema,
    platformId: z.enum(["tiktok", "youtube"]),
    assetId: z.string().uuid(),
    fileName: z.string().min(1).max(512),
    state: z.enum([
      "waiting-proxy",
      "waiting-retry",
      "preparing",
      "initializing",
      "uploading",
      "checking",
      "processing",
      "inbox",
      "ready",
      "published",
      "failed",
      "cancelled",
      "uncertain",
    ]),
    sentBytes: z.number().int().min(0).max(YOUTUBE_MAX_BYTES),
    totalBytes: z.number().int().min(1).max(YOUTUBE_MAX_BYTES),
    youtube: youtubeUploadMetadataSchema.optional(),
    receipt: z
      .object({
        videoId: youtubeVideoIdSchema,
        privacy: youtubePrivacySchema,
        state: z.enum(["processing", "ready", "published", "failed"]),
      })
      .strict()
      .optional(),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    errorCode: z.enum(GLOBAL_UPLOAD_ERRORS).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (job) =>
      job.sentBytes <= job.totalBytes &&
      (job.platformId === "youtube"
        ? !!job.youtube &&
          job.state !== "inbox" &&
          (!["ready", "published"].includes(job.state) || job.receipt?.state === job.state)
        : job.totalBytes <= 4 * 1024 ** 3 && !job.youtube && !job.receipt && job.state !== "ready"),
  );
export const globalUploadJobsSchema = z.array(globalUploadJobSchema).max(20);
export type GlobalUploadJob = z.infer<typeof globalUploadJobSchema>;
export type GlobalUploadState = GlobalUploadJob["state"];
export type GlobalUploadSubmit = z.infer<typeof globalUploadSubmitSchema>;
export function isActiveUpload(job: GlobalUploadJob): boolean {
  return [
    "waiting-proxy",
    "waiting-retry",
    "preparing",
    "initializing",
    "uploading",
    "checking",
    "processing",
  ].includes(job.state);
}
export function globalUploadErrorCode(error: unknown): GlobalUploadErrorCode {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    if (GLOBAL_UPLOAD_ERRORS.includes(value.code as GlobalUploadErrorCode))
      return value.code as GlobalUploadErrorCode;
    if (typeof value.message === "string") {
      const match =
        /^(?:Error invoking remote method 'global-uploads:(?:submit|list|cancel|check)': Error: )?(GLOBAL_UPLOAD_[A-Z_]+)$/.exec(
          value.message,
        );
      if (match && GLOBAL_UPLOAD_ERRORS.includes(match[1] as GlobalUploadErrorCode))
        return match[1] as GlobalUploadErrorCode;
    }
  }
  return "GLOBAL_UPLOAD_UNAVAILABLE";
}
export interface GlobalUploadsApi {
  submit(input: z.infer<typeof globalUploadSubmitSchema>): Promise<GlobalUploadJob>;
  list(accountId: string): Promise<GlobalUploadJob[]>;
  cancel(jobId: string): Promise<GlobalUploadJob | null>;
  check(jobId: string): Promise<GlobalUploadJob>;
  onChanged(handler: (job: GlobalUploadJob) => void): () => void;
}
