import type { PlatformId } from "./platforms";

export type { PlatformId };

/**
 * Account login state as observed by the main process.
 *
 * - `unknown`: never inspected (fresh account) or inspection failed.
 * - `online`: session cookies present and probe succeeded.
 * - `offline`: no valid session; login page expected.
 * - `needs_verification`: a captcha / risk-control page is showing.
 * - `expiring`: online but within the platform's warning window.
 * - `network_error`: last check failed because of connectivity, not auth.
 */
export type AccountStatus =
  "unknown" | "online" | "offline" | "needs_verification" | "expiring" | "network_error";

export interface Account {
  id: string;
  platformId: PlatformId;
  displayName: string;
  handle?: string | null;
  avatarUrl?: string | null;
  /** Platform-side numeric/string user id when known. */
  externalId?: string | null;
  partition: string;
  status: AccountStatus;
  statusMessage?: string | null;
  lastOnlineAt?: string | null;
  lastCheckedAt?: string | null;
  /** Estimated time at which the session will expire (from TTL heuristics). */
  sessionExpiresAt?: string | null;
  sortOrder: number;
  note?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCreateInput {
  platformId: PlatformId;
  displayName?: string;
  note?: string;
}

export interface AccountUpdateInput {
  displayName?: string;
  handle?: string | null;
  avatarUrl?: string | null;
  externalId?: string | null;
  note?: string | null;
  sortOrder?: number;
}

/** Per-account browser view runtime state, mirrored to the renderer. */
export interface ViewState {
  accountId: string;
  attached: boolean;
  visible: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoginPage: boolean;
  isVerificationPage: boolean;
  lastError?: string | null;
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MetricName =
  "followers" | "following" | "likes" | "comments" | "plays" | "shares" | "favorites" | "works";

export const METRIC_NAMES: readonly MetricName[] = [
  "followers",
  "following",
  "likes",
  "comments",
  "plays",
  "shares",
  "favorites",
  "works",
];

export type MetricSource = "session" | "manual";

export interface MetricSnapshot {
  id?: number;
  accountId: string;
  platformId: PlatformId;
  metric: MetricName;
  value: number;
  capturedAt: string;
  source: MetricSource;
  /** Work-level snapshot when set; account-level when null. */
  workId?: string | null;
}

export interface Work {
  id: string;
  accountId: string;
  platformId: PlatformId;
  remoteId: string;
  title: string;
  coverUrl?: string | null;
  url?: string | null;
  publishedAt?: string | null;
  status?: string | null;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  favorites: number;
  fetchedAt: string;
}

export type CollectRunStatus = "success" | "partial" | "failed" | "skipped";

export interface CollectRun {
  id?: number;
  accountId: string;
  platformId: PlatformId;
  startedAt: string;
  finishedAt?: string | null;
  status: CollectRunStatus;
  trigger: "login" | "manual" | "scheduled" | "keepalive";
  message?: string | null;
  metricsWritten: number;
  worksWritten: number;
}

export interface MetricDelta {
  current: number | null;
  day: number | null;
  week: number | null;
  month: number | null;
}

export interface AccountMetricsView {
  accountId: string;
  platformId: PlatformId;
  capturedAt: string | null;
  metrics: Partial<Record<MetricName, MetricDelta>>;
  trend: Array<{ date: string; followers: number | null; likes: number | null; plays: number | null }>;
  lastRun?: CollectRun | null;
}

export interface PlatformSummaryView {
  platformId: PlatformId;
  accountCount: number;
  onlineCount: number;
  totals: Partial<Record<MetricName, number>>;
  dayDelta: Partial<Record<MetricName, number>>;
  accounts: Array<{
    accountId: string;
    displayName: string;
    avatarUrl?: string | null;
    status: AccountStatus;
    metrics: Partial<Record<MetricName, MetricDelta>>;
    capturedAt: string | null;
    spark: number[];
  }>;
}

export interface OverviewView {
  accountCount: number;
  onlineCount: number;
  attentionCount: number;
  totals: Partial<Record<MetricName, number>>;
  dayDelta: Partial<Record<MetricName, number>>;
  platforms: PlatformSummaryView[];
  trend: Array<{ date: string; followers: number; likes: number; plays: number }>;
  attention: Array<{
    accountId: string;
    displayName: string;
    platformId: PlatformId;
    status: AccountStatus;
    message: string;
  }>;
}

export type AssetKind = "video" | "image" | "audio" | "other";

export interface Asset {
  id: string;
  kind: AssetKind;
  filePath: string;
  fileName: string;
  mimeType?: string | null;
  sizeBytes: number;
  sha256?: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  thumbnailPath?: string | null;
  createdAt: string;
}

export type PublishRecordStatus = "planned" | "published" | "cancelled";

export interface PublishRecord {
  id: string;
  accountId: string;
  platformId: PlatformId;
  assetIds: string[];
  title: string;
  description: string;
  tags: string[];
  scheduledAt?: string | null;
  status: PublishRecordStatus;
  publishedAt?: string | null;
  workId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishRecordInput {
  id?: string;
  accountId: string;
  assetIds: string[];
  title: string;
  description?: string;
  tags?: string[];
  scheduledAt?: string | null;
  status?: PublishRecordStatus;
}

export interface AppSettings {
  theme: "light" | "dark" | "system";
  maxLiveViews: number;
  collectIntervalHours: number;
  keepaliveIntervalHours: number;
  collectEnabled: boolean;
  keepaliveEnabled: boolean;
  notifyOnOffline: boolean;
  notifyOnExpiring: boolean;
  sidebarCollapsed: boolean;
  lastActiveAccountId?: string | null;
  lastRoute?: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  maxLiveViews: 6,
  collectIntervalHours: 6,
  keepaliveIntervalHours: 12,
  collectEnabled: true,
  keepaliveEnabled: true,
  notifyOnOffline: true,
  notifyOnExpiring: true,
  sidebarCollapsed: false,
  lastActiveAccountId: null,
  lastRoute: null,
};

export interface BackupMetadata {
  format: "sv-workbench-backup";
  version: number;
  createdAt: string;
  appVersion?: string;
  accountCount: number;
  checksum?: string;
  encrypted: boolean;
}

export interface BackupPayload {
  metadata: BackupMetadata;
  accounts: Account[];
  metrics: MetricSnapshot[];
  works: Work[];
  assets: Asset[];
  publishRecords: PublishRecord[];
  settings: Partial<AppSettings>;
}

export interface AuditEvent {
  id?: number;
  action: string;
  accountId?: string | null;
  details?: Record<string, unknown> | null;
  createdAt: string;
}
