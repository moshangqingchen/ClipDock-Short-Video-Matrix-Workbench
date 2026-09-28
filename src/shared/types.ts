import type { AnalyticsRecord } from "./business-analytics";
import type { GlobalAccount } from "./global-accounts";
import type { WebObservation } from "./global-web-observation";
import type { GlobalWork, GlobalPublishRecord } from "./global-workspace";
import type { PlatformId } from "./platforms";

export type { PlatformId };

/**
 * Account login state as observed by the main process.
 *
 * - `unknown`: no applicable confirmed login observation yet.
 * - `online`: the authoritative homepage or platform identity check confirmed login.
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
  /** Outcome of the last attempt, independent of the last confirmed login conclusion. */
  checkInfo?: AccountCheckInfo | null;
  lastOnlineAt?: string | null;
  lastCheckedAt?: string | null;
  /** Estimated time at which the session will expire (from TTL heuristics). */
  sessionExpiresAt?: string | null;
  sortOrder: number;
  note?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCheckInfo {
  state: "checking" | "confirmed" | "unconfirmed" | "network_error" | "paused";
  reason: string;
  attemptedAt: string;
  /** Last explicit observation of this account's public homepage; unrelated checks preserve it. */
  homepageConfirmation?: HomepageConfirmation | null;
}

export interface HomepageConfirmation {
  kind: "online" | "offline";
  /** Observation time in Unix milliseconds, never renewed by a cached-result read. */
  observedAt: number;
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
  /** An official message page is being used; background work must preserve it. */
  messageMode?: boolean;
  lifecycle?: "loading" | "ready" | "sleeping" | "crashed" | "destroyed";
  revision?: number;
  instanceId?: number;
  navigationId?: number;
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
export type MetricOrigin = "official" | "page" | "legacy";
export const WORK_METRICS = ["plays", "likes", "comments", "shares", "favorites"] as const;
export type WorkMetric = (typeof WORK_METRICS)[number];
export interface FieldObservation { capturedAt: string; origin: MetricOrigin }

export interface MetricSnapshot {
  id?: number;
  accountId: string;
  platformId: PlatformId;
  metric: MetricName;
  value: number;
  capturedAt: string;
  source: MetricSource;
  origin?: MetricOrigin;
  /** Work-level snapshot when set; account-level when null. */
  workId?: string | null;
}

export interface Work {
  /** Missing entries are unknown, not zero. Absent metadata identifies legacy data. */
  observations?: Partial<Record<WorkMetric, FieldObservation>>;
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
  capturedAt?: string;
  origin?: MetricOrigin;
  current: number | null;
  day: number | null;
  week: number | null;
  month: number | null;
}

/** Only actual daily observations; null denotes an unobserved field/day. */
export interface MetricTrendPoint {
  date: string;
  followers: number | null;
  likes: number | null;
  plays: number | null;
  following?: number | null;
  comments?: number | null;
  shares?: number | null;
  favorites?: number | null;
  works?: number | null;
  coverage?: Partial<Record<MetricName, number>>;
}

export interface WorkMetricCoverage {
  /** Works contributing a value to the collected-work sum, including legacy values. */
  observed: number;
  /** Subset whose field provenance is unknown or legacy. */
  legacy: number;
  capturedAt: string | null;
}

export interface AccountMetricsView {
  collectedWorkCount?: number;
  workTotals?: Partial<Record<WorkMetric, number>>;
  workCoverage?: Partial<Record<WorkMetric, WorkMetricCoverage>>;
  accountId: string;
  platformId: PlatformId;
  capturedAt: string | null;
  metrics: Partial<Record<MetricName, MetricDelta>>;
  trend: MetricTrendPoint[];
  lastRun?: CollectRun | null;
}

export interface PlatformSummaryView {
  coverage?: Partial<Record<MetricName, number>>;
  dayCoverage?: Partial<Record<MetricName, number>>;
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
    spark: Array<number | null>;
    lastRun?: CollectRun | null;
  }>;
}

export interface OverviewView {
  coverage?: Partial<Record<MetricName, number>>;
  dayCoverage?: Partial<Record<MetricName, number>>;
  accountCount: number;
  onlineCount: number;
  attentionCount: number;
  totals: Partial<Record<MetricName, number>>;
  dayDelta: Partial<Record<MetricName, number>>;
  platforms: PlatformSummaryView[];
  trend: MetricTrendPoint[];
  attention: Array<{
    accountId: string;
    displayName: string;
    platformId: PlatformId;
    status: AccountStatus;
    message: string;
  }>;
}

/** Internal collector records retain source URLs; strict renderer projections contain cache IDs only. */
export type LocalMediaUrl = `sv-asset://remote/${string}`;
export type MediaProjectionMode = "strict" | "observe";
type ProjectedMediaField<Key extends string, Mode extends MediaProjectionMode> = Mode extends "strict"
  ? { [Field in Key]: LocalMediaUrl | null }
  : { [Field in Key]?: string | null };
export type AccountDto<Mode extends MediaProjectionMode = "strict"> = Omit<Account, "avatarUrl"> &
  ProjectedMediaField<"avatarUrl", Mode>;
export type WorkDto<Mode extends MediaProjectionMode = "strict"> = Omit<Work, "coverUrl"> &
  ProjectedMediaField<"coverUrl", Mode>;
export type PlatformSummaryDto<Mode extends MediaProjectionMode = "strict"> = Omit<
  PlatformSummaryView,
  "accounts"
> & {
  accounts: Array<
    Omit<PlatformSummaryView["accounts"][number], "avatarUrl"> & ProjectedMediaField<"avatarUrl", Mode>
  >;
};
export type OverviewDto<Mode extends MediaProjectionMode = "strict"> = Omit<OverviewView, "platforms"> & {
  platforms: PlatformSummaryDto<Mode>[];
};

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
  lastGlobalAccountId?: string | null;
  accountScope?: "domestic" | "global";
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
  globalAccountCount?: number;
  format: "sv-workbench-backup";
  version: number;
  createdAt: string;
  appVersion?: string;
  accountCount: number;
  checksum?: string;
  encrypted: boolean;
}

export interface BackupPayload {
  analytics?: AnalyticsRecord[];
  metadata: BackupMetadata;
  accounts: Account[];
  metrics: MetricSnapshot[];
  works: Work[];
  assets: Asset[];
  publishRecords: PublishRecord[];
  settings: Partial<AppSettings>;
  global?: {
    accounts: Array<
      Pick<
        GlobalAccount,
        "id" | "platformId" | "displayName" | "note" | "browserEngine" | "createdAt" | "updatedAt"
      >
    >;
    observations: WebObservation[];
    works: GlobalWork[];
    publishRecords: GlobalPublishRecord[];
  };
}

export interface AuditEvent {
  id?: number;
  action: string;
  accountId?: string | null;
  details?: Record<string, unknown> | null;
  createdAt: string;
}
