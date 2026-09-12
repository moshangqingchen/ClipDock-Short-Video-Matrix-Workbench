import { z } from "zod";
import { globalAccountIdSchema, globalPlatformIdSchema } from "./global-accounts";

export type WorkspaceAccountRef = { scope: "domestic" | "global"; accountId: string };
export const webIdentitySchema = z
  .object({
    status: z.enum(["unknown", "online", "offline", "needs_verification"]),
    subjectId: z.string().max(256).nullable(),
    displayName: z.string().max(120).nullable(),
    checkedAt: z.iso.datetime(),
  })
  .strict();
export type WebIdentity = z.infer<typeof webIdentitySchema>;
export const globalWorkSchema = z
  .object({
    accountId: globalAccountIdSchema,
    platformId: globalPlatformIdSchema,
    subjectId: z.string().min(1).max(256),
    remoteId: z.string().min(1).max(256),
    title: z.string().max(2000),
    url: z.url().max(1000),
    publishedAt: z.string().max(80).nullable(),
    metrics: z.partialRecord(
      z.enum(["views", "impressions", "likes", "comments", "shares"]),
      z.string().max(40),
    ),
    capturedAt: z.iso.datetime(),
  })
  .strict();
export type GlobalWork = z.infer<typeof globalWorkSchema>;
export const globalPublishInputSchema = z
  .object({
    id: z.uuid().optional(),
    accountId: globalAccountIdSchema,
    assetIds: z.array(z.uuid()).max(50),
    title: z.string().max(200),
    description: z.string().max(5000).optional(),
    tags: z.array(z.string().min(1).max(40)).max(30).optional(),
    status: z.enum(["planned", "published", "cancelled"]).optional(),
  })
  .strict();
export type GlobalPublishInput = z.infer<typeof globalPublishInputSchema>;
export const globalPublishRecordSchema = globalPublishInputSchema.extend({
  id: z.uuid(),
  platformId: globalPlatformIdSchema,
  description: z.string(),
  tags: z.array(z.string()),
  status: z.enum(["planned", "published", "cancelled"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type GlobalPublishRecord = z.infer<typeof globalPublishRecordSchema>;
export const webCollectJobSchema = z
  .object({
    id: z.uuid(),
    accountId: globalAccountIdSchema,
    state: z.enum(["queued", "waiting-network", "waiting-login", "running", "done", "failed", "cancelled"]),
    trigger: z.enum(["manual", "scheduled", "login"]),
    message: z.string().max(250).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    attempts: z.number().int().nonnegative(),
  })
  .strict();
export type WebCollectJob = z.infer<typeof webCollectJobSchema>;

export interface GlobalWorkspaceApi {
  openLoginWindow(id: string): Promise<void>;
  useBrowser(id: string, engine: "chrome" | "embedded"): Promise<void>;
  onChanged(listener: (accountId: string) => void): () => void;
  identity(id: string): Promise<WebIdentity | null>;
  checkLogin(id: string): Promise<WebIdentity>;
  resetEnvironment(id: string): Promise<void>;
  openDevTools(id: string): Promise<void>;
  openSystemBrowser(id: string): Promise<void>;
  works(id: string): Promise<GlobalWork[]>;
  collect(id: string): Promise<WebCollectJob>;
  jobs(id?: string): Promise<WebCollectJob[]>;
  cancelJob(id: string): Promise<void>;
  publishList(id?: string): Promise<GlobalPublishRecord[]>;
  publishSave(input: GlobalPublishInput): Promise<GlobalPublishRecord>;
  publishDelete(id: string): Promise<void>;
  openUpload(id: string): Promise<void>;
  attachFiles(id: string, assetIds: string[]): Promise<{ attached: number; message?: string }>;
  openWork(id: string, remoteId: string): Promise<void>;
}

export const GLOBAL_WORKSPACE_CHANNEL = "global-workspace:";
