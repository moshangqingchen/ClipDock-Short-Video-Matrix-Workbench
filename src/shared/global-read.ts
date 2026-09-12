import { z } from "zod";
import { globalAccountIdSchema, globalPlatformIdSchema } from "./global-accounts";

const count = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,39})$/)
  .nullable();
const capability = z.enum(["ready", "scope_required", "forbidden", "rate_limited", "unavailable"]);
const text = (max: number) => z.string().max(max);
const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._~-]+$/);

/** Public business data only. No remote media URLs, raw API responses or pagination secrets. */
export const globalReadDataSchema = z
  .object({
    remoteId: identity,
    profile: z
      .object({
        displayName: text(256),
        username: text(256).nullable(),
      })
      .strict(),
    totals: z
      .object({
        followers: count,
        following: count,
        works: count,
        views: count,
        likes: count,
      })
      .strict(),
    works: z
      .array(
        z
          .object({
            id: identity,
            kind: z.enum(["video", "post"]),
            title: text(1000),
            publishedAt: z.string().datetime({ offset: true }).nullable(),
            views: count,
            likes: count,
            comments: count,
            reposts: count,
          })
          .strict(),
      )
      .max(20),
    hasMoreWorks: z.boolean().nullable(),
    capabilities: z
      .object({
        readProfile: capability,
        readMetrics: capability,
        listWorks: capability,
      })
      .strict(),
  })
  .strict();

export const globalReadSnapshotSchema = globalReadDataSchema
  .extend({
    accountId: globalAccountIdSchema,
    platformId: globalPlatformIdSchema,
    fetchedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type GlobalReadData = z.infer<typeof globalReadDataSchema>;
export type GlobalReadSnapshot = z.infer<typeof globalReadSnapshotSchema>;
export type GlobalReadCapabilityState = z.infer<typeof capability>;

export const GLOBAL_READ_ERRORS = [
  "GLOBAL_READ_INPUT_INVALID",
  "GLOBAL_READ_UNAVAILABLE",
  "GLOBAL_READ_UNAUTHORIZED",
  "GLOBAL_READ_REAUTHORIZE",
  "GLOBAL_READ_WAITING_PROXY",
  "GLOBAL_READ_CANCELLED",
  "GLOBAL_READ_BUSY",
  "GLOBAL_READ_RATE_LIMITED",
  "GLOBAL_READ_FORBIDDEN",
  "GLOBAL_READ_RESPONSE_INVALID",
  "GLOBAL_READ_IDENTITY_MISMATCH",
  "GLOBAL_READ_SAVE_FAILED",
] as const;
export type GlobalReadErrorCode = (typeof GLOBAL_READ_ERRORS)[number];
export interface GlobalReadApi {
  /** Local snapshot only; does not contact a platform or restore network eligibility. */
  get(accountId: string): Promise<GlobalReadSnapshot | null>;
}

/** Avoid forwarding Electron wrappers, provider bodies, tokens or arbitrary exception messages. */
export function globalReadErrorCode(error: unknown): GlobalReadErrorCode {
  const message = error instanceof Error ? error.message : "";
  const wrapped =
    /^Error invoking remote method '(?:global-read:get|global-jobs:(?:submit|list|cancel))': Error: (GLOBAL_READ_[A-Z_]+)$/.exec(
      message,
    );
  const candidate = wrapped?.[1] ?? message;
  return GLOBAL_READ_ERRORS.find((code) => code === candidate) ?? "GLOBAL_READ_UNAVAILABLE";
}
