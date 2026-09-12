import type { GlobalWorkspaceApi } from "./global-workspace";
import { z } from "zod";
import { CN_PLATFORM_IDS } from "./platforms";
import type { NetworkApi, NetworkSnapshot } from "./network";
import type { CredentialApi } from "./credentials";
import type { GlobalAccountApi } from "./global-accounts";
import type { GlobalAppsApi } from "./global-apps";
import type { GlobalOAuthApi } from "./global-oauth";
import type { GlobalReadApi } from "./global-read";
import type { GlobalJobsApi } from "./global-jobs";
import type { GlobalUploadsApi } from "./global-uploads";
import type { GlobalWebApi } from "./global-web";
import type { CollectJob } from "./collect-jobs";
import type {
  AccountDto,
  AccountMetricsView,
  AppSettings,
  Asset,
  AuditEvent,
  BackupMetadata,
  CollectRun,
  MetricName,
  OverviewDto,
  PlatformSummaryDto,
  MediaProjectionMode,
  PublishRecord,
  ViewBounds,
  ViewState,
  WorkDto,
} from "./types";
import { METRIC_NAMES } from "./types";

export { IPC, type IpcChannel } from "./ipc-channels";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

export const cnPlatformIdSchema = z.enum(CN_PLATFORM_IDS);
export const platformIdSchema = cnPlatformIdSchema;
export const accountIdSchema = z.string().uuid();
export const metricNameSchema = z.enum(METRIC_NAMES as unknown as [MetricName, ...MetricName[]]);

export const boundsSchema = z.object({
  x: z.number().finite().min(0).max(20000),
  y: z.number().finite().min(0).max(20000),
  width: z.number().finite().min(1).max(20000),
  height: z.number().finite().min(1).max(20000),
});

export const accountCreateSchema = z.object({
  platformId: cnPlatformIdSchema,
  displayName: z.string().trim().min(1).max(60).optional(),
  note: z.string().trim().max(500).optional(),
});

export const accountUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  handle: z.string().trim().max(80).nullable().optional(),
  // Collector-only media input. Public updates cannot nominate URLs or another account's cache ID.
  avatarUrl: z.never().optional(),
  externalId: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export const viewGoSchema = z.enum(["home", "site", "login", "upload", "analytics", "works", "comments"]);

export const publishRecordInputSchema = z.object({
  id: z.string().uuid().optional(),
  accountId: accountIdSchema,
  assetIds: z.array(z.string().uuid()).max(50),
  title: z.string().trim().max(200),
  description: z.string().trim().max(5000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  status: z.enum(["planned", "published", "cancelled"]).optional(),
});

export const settingsPatchSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  maxLiveViews: z.number().int().min(2).max(12).optional(),
  collectIntervalHours: z.number().int().min(1).max(48).optional(),
  keepaliveIntervalHours: z.number().int().min(2).max(72).optional(),
  collectEnabled: z.boolean().optional(),
  keepaliveEnabled: z.boolean().optional(),
  notifyOnOffline: z.boolean().optional(),
  notifyOnExpiring: z.boolean().optional(),
  sidebarCollapsed: z.boolean().optional(),
  lastActiveAccountId: z.string().uuid().nullable().optional(),
  lastGlobalAccountId: z.string().uuid().nullable().optional(),
  accountScope: z.enum(["domestic", "global"]).optional(),
  lastRoute: z.string().max(200).nullable().optional(),
});

export const backupExportSchema = z.object({
  password: z.string().min(8).max(200).optional(),
});

export const backupImportSchema = z.object({
  password: z.string().max(200).optional(),
  mode: z.enum(["merge", "replace"]).default("merge"),
});

/* ------------------------------------------------------------------ */
/* Renderer-facing API surface implemented by the preload bridge        */
/* ------------------------------------------------------------------ */

export interface ToastEvent {
  kind: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  accountId?: string;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  userDataPath: string;
  userAgent: string;
}

export interface BackupImportResult {
  metadata: BackupMetadata;
  accountsImported: number;
}

export interface WorkbenchApi {
  globalWorkspace: GlobalWorkspaceApi;
  globalAccounts: GlobalAccountApi;
  globalApps: GlobalAppsApi;
  globalOAuth: GlobalOAuthApi;
  globalRead: GlobalReadApi;
  globalJobs: GlobalJobsApi;
  globalUploads: GlobalUploadsApi;
  globalWeb: GlobalWebApi;
  network: NetworkApi;
  credentials: CredentialApi;
  accounts: {
    list(): Promise<AccountDto<MediaProjectionMode>[]>;
    create(input: z.input<typeof accountCreateSchema>): Promise<AccountDto<MediaProjectionMode>>;
    update(id: string, patch: z.input<typeof accountUpdateSchema>): Promise<AccountDto<MediaProjectionMode>>;
    delete(id: string): Promise<void>;
    reorder(ids: string[]): Promise<void>;
    resetEnvironment(id: string): Promise<AccountDto<MediaProjectionMode>>;
    checkStatus(id: string): Promise<AccountDto<MediaProjectionMode>>;
    refreshProfile(id: string): Promise<AccountDto<MediaProjectionMode>>;
  };
  views: {
    show(id: string, bounds: ViewBounds, enterHomepage?: boolean): Promise<ViewState>;
    hide(id: string): Promise<void>;
    hideAll(): Promise<void>;
    setBounds(id: string, bounds: ViewBounds): Promise<void>;
    navigate(id: string, url: string): Promise<void>;
    go(id: string, route: z.input<typeof viewGoSchema>): Promise<void>;
    reload(id: string): Promise<void>;
    back(id: string): Promise<void>;
    forward(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    state(id: string): Promise<ViewState | null>;
    states(): Promise<ViewState[]>;
    openDevTools(id: string): Promise<void>;
  };
  metrics: {
    account(id: string, days?: number): Promise<AccountMetricsView>;
    platform(platformId: string, days?: number): Promise<PlatformSummaryDto<MediaProjectionMode>>;
    overview(days?: number): Promise<OverviewDto<MediaProjectionMode>>;
    collectNow(id?: string): Promise<CollectJob[]>;
    jobs(id?: string): Promise<CollectJob[]>;
    cancelJob(id: string): Promise<CollectJob | null>;
    runs(id: string, limit?: number): Promise<CollectRun[]>;
  };
  works: {
    list(id: string, limit?: number): Promise<WorkDto<MediaProjectionMode>[]>;
  };
  assets: {
    list(): Promise<Asset[]>;
    import(): Promise<Asset[]>;
    remove(id: string): Promise<void>;
    reveal(id: string): Promise<void>;
    thumbnail(id: string): Promise<string | null>;
  };
  publish: {
    list(accountId?: string): Promise<PublishRecord[]>;
    save(input: z.input<typeof publishRecordInputSchema>): Promise<PublishRecord>;
    delete(id: string): Promise<void>;
    openUpload(accountId: string): Promise<void>;
    attachFiles(accountId: string, assetIds: string[]): Promise<{ attached: number; message?: string }>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: z.input<typeof settingsPatchSchema>): Promise<AppSettings>;
  };
  audit: {
    list(limit?: number): Promise<AuditEvent[]>;
  };
  backup: {
    export(options: z.input<typeof backupExportSchema>): Promise<BackupMetadata | null>;
    import(options: z.input<typeof backupImportSchema>): Promise<BackupImportResult | null>;
  };
  app: {
    info(): Promise<AppInfo>;
    openExternal(url: string): Promise<void>;
  };
  on(event: "account-changed", handler: (account: AccountDto<MediaProjectionMode>) => void): () => void;
  on(event: "accounts-reloaded", handler: () => void): () => void;
  on(event: "view-state", handler: (state: ViewState) => void): () => void;
  on(event: "metrics-updated", handler: (payload: { accountId: string }) => void): () => void;
  on(event: "collect-run", handler: (run: CollectRun) => void): () => void;
  on(event: "collect-job", handler: (job: CollectJob) => void): () => void;
  on(event: "toast", handler: (toast: ToastEvent) => void): () => void;
  on(event: "network-state", handler: (snapshot: NetworkSnapshot) => void): () => void;
}

declare global {
  interface Window {
    workbench?: WorkbenchApi;
  }
}
