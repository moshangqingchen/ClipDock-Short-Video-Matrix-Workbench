import { z } from "zod";
import { PLATFORM_IDS, type PlatformId } from "./platforms";
import type {
  Account,
  AccountMetricsView,
  AppSettings,
  Asset,
  AuditEvent,
  BackupMetadata,
  CollectRun,
  MetricName,
  OverviewView,
  PlatformSummaryView,
  PublishRecord,
  ViewBounds,
  ViewState,
  Work,
} from "./types";
import { METRIC_NAMES } from "./types";

export { IPC, type IpcChannel } from "./ipc-channels";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

export const platformIdSchema = z.enum(PLATFORM_IDS as unknown as [PlatformId, ...PlatformId[]]);
export const accountIdSchema = z.string().uuid();
export const metricNameSchema = z.enum(METRIC_NAMES as unknown as [MetricName, ...MetricName[]]);

export const boundsSchema = z.object({
  x: z.number().finite().min(0).max(20000),
  y: z.number().finite().min(0).max(20000),
  width: z.number().finite().min(1).max(20000),
  height: z.number().finite().min(1).max(20000),
});

export const accountCreateSchema = z.object({
  platformId: platformIdSchema,
  displayName: z.string().trim().min(1).max(60).optional(),
  note: z.string().trim().max(500).optional(),
});

export const accountUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  handle: z.string().trim().max(80).nullable().optional(),
  avatarUrl: z.string().url().max(2000).nullable().optional(),
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
  accounts: {
    list(): Promise<Account[]>;
    create(input: z.input<typeof accountCreateSchema>): Promise<Account>;
    update(id: string, patch: z.input<typeof accountUpdateSchema>): Promise<Account>;
    delete(id: string): Promise<void>;
    reorder(ids: string[]): Promise<void>;
    resetEnvironment(id: string): Promise<Account>;
    checkStatus(id: string): Promise<Account>;
    refreshProfile(id: string): Promise<Account>;
  };
  views: {
    show(id: string, bounds: ViewBounds): Promise<ViewState>;
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
    platform(platformId: string, days?: number): Promise<PlatformSummaryView>;
    overview(days?: number): Promise<OverviewView>;
    collectNow(id?: string): Promise<CollectRun[]>;
    runs(id: string, limit?: number): Promise<CollectRun[]>;
  };
  works: {
    list(id: string, limit?: number): Promise<Work[]>;
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
  on(event: "account-changed", handler: (account: Account) => void): () => void;
  on(event: "accounts-reloaded", handler: () => void): () => void;
  on(event: "view-state", handler: (state: ViewState) => void): () => void;
  on(event: "metrics-updated", handler: (payload: { accountId: string }) => void): () => void;
  on(event: "collect-run", handler: (run: CollectRun) => void): () => void;
  on(event: "toast", handler: (toast: ToastEvent) => void): () => void;
}

declare global {
  interface Window {
    workbench?: WorkbenchApi;
  }
}
