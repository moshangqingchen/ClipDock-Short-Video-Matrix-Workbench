import { z } from "zod";
import { globalAccountIdSchema, globalPlatformIdSchema } from "./global-accounts";
import { GLOBAL_READ_ERRORS } from "./global-read";

export const globalJobSchema = z
  .object({
    id: z.string().uuid(),
    accountId: globalAccountIdSchema,
    platformId: globalPlatformIdSchema,
    kind: z.literal("read"),
    state: z.enum(["queued", "waiting-proxy", "running", "done", "failed", "cancelled"]),
    errorCode: z.enum(GLOBAL_READ_ERRORS).nullable(),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    attempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .refine((job) => (job.finishedAt === null) === ["queued", "waiting-proxy", "running"].includes(job.state));
export const globalJobsSchema = z.array(globalJobSchema).max(20);
export type GlobalJob = z.infer<typeof globalJobSchema>;
export type GlobalJobState = GlobalJob["state"];
export function isActiveGlobalJob(job: GlobalJob): boolean {
  return job.state === "queued" || job.state === "waiting-proxy" || job.state === "running";
}
/** Persisted user intent only. A task record never supplies network permission. */
export interface GlobalJobsApi {
  submit(accountId: string): Promise<GlobalJob>;
  list(accountId: string): Promise<GlobalJob[]>;
  cancel(jobId: string): Promise<GlobalJob | null>;
  onChanged(handler: (job: GlobalJob) => void): () => void;
}
