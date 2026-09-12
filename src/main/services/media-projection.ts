import type {
  Account,
  AccountDto,
  LocalMediaUrl,
  MediaProjectionMode,
  OverviewDto,
  OverviewView,
  PlatformSummaryDto,
  PlatformSummaryView,
  Work,
  WorkDto,
} from "@shared/types";

export type MediaProjectionSubject =
  { accountId: string; kind: "avatar" } | { accountId: string; kind: "cover"; workId: string };

export interface MediaProjectionOptions<Mode extends MediaProjectionMode = MediaProjectionMode> {
  enforcement: Mode;
  /** Local index lookup only. Never a cache-miss fetch and never a renderer-supplied URL. */
  preview?: (subject: MediaProjectionSubject) => { url: string | null };
}

/** Exact canonical cache reference: no alternate authority, encoded path, query, fragment or filename. */
export function isLocalMediaUrl(value: unknown): value is LocalMediaUrl {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    /^sv-asset:\/\/remote\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

/** Explicit DTO field selection keeps internal source URLs and incidental internal fields out of IPC. */
export function createMediaProjection<Mode extends MediaProjectionMode>(
  options: MediaProjectionOptions<Mode>,
) {
  const media = (subject: MediaProjectionSubject, observed: string | null | undefined): string | null => {
    if (options.enforcement === "observe") return observed ?? null;
    try {
      const candidate = options.preview?.(subject)?.url;
      return isLocalMediaUrl(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };

  const projectAccount = (account: Account): AccountDto<Mode> =>
    ({
      id: account.id,
      platformId: account.platformId,
      displayName: account.displayName,
      handle: account.handle,
      avatarUrl: media({ accountId: account.id, kind: "avatar" }, account.avatarUrl),
      externalId: account.externalId,
      partition: account.partition,
      status: account.status,
      statusMessage: account.statusMessage,
      checkInfo: account.checkInfo ? {
        state: account.checkInfo.state,
        reason: account.checkInfo.reason,
        attemptedAt: account.checkInfo.attemptedAt,
      } : account.checkInfo,
      lastOnlineAt: account.lastOnlineAt,
      lastCheckedAt: account.lastCheckedAt,
      sessionExpiresAt: account.sessionExpiresAt,
      sortOrder: account.sortOrder,
      note: account.note,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }) as AccountDto<Mode>;

  const projectWork = (work: Work): WorkDto<Mode> =>
    ({
      id: work.id,
      accountId: work.accountId,
      platformId: work.platformId,
      remoteId: work.remoteId,
      title: work.title,
      coverUrl: media({ accountId: work.accountId, kind: "cover", workId: work.id }, work.coverUrl),
      url: work.url,
      publishedAt: work.publishedAt,
      status: work.status,
      plays: work.plays,
      likes: work.likes,
      comments: work.comments,
      shares: work.shares,
      favorites: work.favorites,
      fetchedAt: work.fetchedAt,
    }) as WorkDto<Mode>;

  const projectPlatformSummary = (platform: PlatformSummaryView): PlatformSummaryDto<Mode> =>
    ({
      platformId: platform.platformId,
      accountCount: platform.accountCount,
      onlineCount: platform.onlineCount,
      totals: { ...platform.totals },
      dayDelta: { ...platform.dayDelta },
      accounts: platform.accounts.map((account) => ({
        accountId: account.accountId,
        displayName: account.displayName,
        avatarUrl: media({ accountId: account.accountId, kind: "avatar" }, account.avatarUrl),
        status: account.status,
        metrics: structuredClone(account.metrics),
        capturedAt: account.capturedAt,
        spark: [...account.spark],
      })),
    }) as PlatformSummaryDto<Mode>;

  const projectOverview = (overview: OverviewView): OverviewDto<Mode> => ({
    accountCount: overview.accountCount,
    onlineCount: overview.onlineCount,
    attentionCount: overview.attentionCount,
    totals: { ...overview.totals },
    dayDelta: { ...overview.dayDelta },
    platforms: overview.platforms.map(projectPlatformSummary),
    trend: overview.trend.map(({ date, followers, likes, plays }) => ({ date, followers, likes, plays })),
    attention: overview.attention.map(({ accountId, displayName, platformId, status, message }) => ({
      accountId,
      displayName,
      platformId,
      status,
      message,
    })),
  });

  return {
    projectAccount,
    projectAccounts: (accounts: readonly Account[]) => accounts.map(projectAccount),
    projectWork,
    projectWorks: (works: readonly Work[]) => works.map(projectWork),
    projectPlatformSummary,
    projectOverview,
  };
}

export type MediaProjection = ReturnType<typeof createMediaProjection>;
