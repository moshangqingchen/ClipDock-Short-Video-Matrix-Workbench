import type { WorkbenchApi, ToastEvent } from "@shared/ipc";
import { PLATFORMS, PLATFORM_IDS, type PlatformId } from "@shared/platforms";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountMetricsView,
  type AppSettings,
  type Asset,
  type CollectRun,
  type MetricDelta,
  type MetricName,
  type OverviewView,
  type PlatformSummaryView,
  type PublishRecord,
  type ViewState,
  type Work,
} from "@shared/types";

type Handler = (payload: unknown) => void;

function uuid(): string {
  return crypto.randomUUID();
}

function rnd(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Deterministic demo data so the browser preview looks populated. */
export function createPreviewApi(): WorkbenchApi {
  const listeners = new Map<string, Set<Handler>>();
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload));
  const now = new Date().toISOString();

  const accounts: Account[] = [
    ["douyin", "品牌官方号", "online", 128_400],
    ["douyin", "创意工作室", "expiring", 43_100],
    ["kuaishou", "快手直播间", "online", 66_200],
    ["xiaohongshu", "小红书种草", "offline", 21_800],
    ["bilibili", "B站长视频", "online", 15_300],
    ["weixin_channels", "视频号品牌", "needs_verification", 9_100],
  ].map(([platformId, name, status, followers], index) => ({
    id: uuid(),
    platformId: platformId as PlatformId,
    displayName: name as string,
    handle: `id_${index + 1}`,
    avatarUrl: null,
    externalId: null,
    partition: `persist:preview-${index}`,
    status: status as Account["status"],
    statusMessage:
      status === "online"
        ? "登录正常"
        : status === "offline"
          ? "未检测到登录态,请扫码登录"
          : status === "expiring"
            ? "登录态即将过期"
            : "平台要求完成安全验证",
    lastOnlineAt: now,
    lastCheckedAt: now,
    sessionExpiresAt: null,
    sortOrder: index,
    note: null,
    createdAt: now,
    updatedAt: now,
    __followers: followers,
  })) as Account[];

  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  const views = new Map<string, ViewState>();
  const assets: Asset[] = [];
  const publish: PublishRecord[] = [];

  const metricsFor = (account: Account, days: number): AccountMetricsView => {
    const seedBase = account.id.charCodeAt(0) + account.id.charCodeAt(5);
    const r = rnd(seedBase);
    const followers = (account as Account & { __followers?: number }).__followers ?? 10_000;
    const make = (base: number, pct: number): MetricDelta => ({
      current: base,
      day: Math.round(base * pct * (r() - 0.3)),
      week: Math.round(base * pct * 4 * (r() - 0.2)),
      month: Math.round(base * pct * 12 * (r() - 0.1)),
    });
    const trend = Array.from({ length: days }, (_, i) => {
      const date = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
      const f = Math.round(followers * (0.85 + (i / days) * 0.15 + (r() - 0.5) * 0.01));
      return {
        date,
        followers: f,
        likes: f * 8 + Math.round(r() * 500),
        plays: f * 40 + Math.round(r() * 9000),
      };
    });
    return {
      accountId: account.id,
      platformId: account.platformId,
      capturedAt: now,
      metrics: {
        followers: make(followers, 0.004),
        likes: make(followers * 8, 0.01),
        plays: make(followers * 40, 0.02),
        comments: make(Math.round(followers * 0.6), 0.02),
        shares: make(Math.round(followers * 0.2), 0.02),
        works: { current: 40 + Math.round(r() * 200), day: 0, week: 2, month: 6 },
      },
      trend,
      lastRun: {
        accountId: account.id,
        platformId: account.platformId,
        startedAt: now,
        finishedAt: now,
        status: "success",
        trigger: "scheduled",
        metricsWritten: 12,
        worksWritten: 20,
      },
    };
  };

  const summarize = (platformId: PlatformId, days: number): PlatformSummaryView => {
    const rows = accounts.filter((a) => a.platformId === platformId);
    const totals: Partial<Record<MetricName, number>> = {};
    const dayDelta: Partial<Record<MetricName, number>> = {};
    const list = rows.map((account) => {
      const view = metricsFor(account, days);
      for (const [metric, value] of Object.entries(view.metrics) as Array<[MetricName, MetricDelta]>) {
        totals[metric] = (totals[metric] ?? 0) + (value.current ?? 0);
        dayDelta[metric] = (dayDelta[metric] ?? 0) + (value.day ?? 0);
      }
      return {
        accountId: account.id,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        status: account.status,
        metrics: view.metrics,
        capturedAt: now,
        spark: view.trend.slice(-14).map((p) => p.followers ?? 0),
      };
    });
    return {
      platformId,
      accountCount: rows.length,
      onlineCount: rows.filter((a) => a.status === "online" || a.status === "expiring").length,
      totals,
      dayDelta,
      accounts: list,
    };
  };

  const worksFor = (account: Account): Work[] => {
    const r = rnd(account.id.charCodeAt(2));
    return Array.from({ length: 12 }, (_, i) => ({
      id: `${account.id}:${i}`,
      accountId: account.id,
      platformId: account.platformId,
      remoteId: String(1000 + i),
      title: `${account.displayName} · 演示作品 ${i + 1}`,
      coverUrl: null,
      url: null,
      publishedAt: new Date(Date.now() - i * 2 * 86_400_000).toISOString(),
      status: "published",
      plays: Math.round(r() * 200_000),
      likes: Math.round(r() * 12_000),
      comments: Math.round(r() * 900),
      shares: Math.round(r() * 400),
      favorites: Math.round(r() * 1_200),
      fetchedAt: now,
    }));
  };

  const toast = (t: ToastEvent) => emit("toast", t);

  return {
    accounts: {
      list: async () => accounts,
      create: async (input) => {
        const platform = PLATFORMS[input.platformId as PlatformId];
        const account: Account = {
          id: uuid(),
          platformId: input.platformId as PlatformId,
          displayName:
            input.displayName ||
            `${platform.shortName}账号 ${accounts.filter((a) => a.platformId === input.platformId).length + 1}`,
          partition: "persist:preview",
          status: "offline",
          statusMessage: "预览模式:请在桌面端扫码",
          sortOrder: accounts.length,
          createdAt: now,
          updatedAt: now,
        };
        accounts.push(account);
        emit("account-changed", account);
        return account;
      },
      update: async (id, patch) => {
        const account = accounts.find((a) => a.id === id)!;
        Object.assign(account, patch, { updatedAt: new Date().toISOString() });
        emit("account-changed", account);
        return account;
      },
      delete: async (id) => {
        const index = accounts.findIndex((a) => a.id === id);
        if (index >= 0) accounts.splice(index, 1);
        emit("accounts-reloaded", null);
      },
      reorder: async () => undefined,
      resetEnvironment: async (id) => {
        const account = accounts.find((a) => a.id === id)!;
        account.status = "offline";
        emit("account-changed", account);
        return account;
      },
      checkStatus: async (id) => accounts.find((a) => a.id === id)!,
      refreshProfile: async (id) => accounts.find((a) => a.id === id)!,
    },
    views: {
      show: async (id) => {
        const state: ViewState = {
          accountId: id,
          attached: true,
          visible: true,
          url: PLATFORMS[accounts.find((a) => a.id === id)!.platformId].routes.home,
          title: "预览模式",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          isLoginPage: false,
          isVerificationPage: false,
        };
        views.set(id, state);
        emit("view-state", state);
        return state;
      },
      hide: async () => undefined,
      hideAll: async () => undefined,
      setBounds: async () => undefined,
      navigate: async () => undefined,
      go: async () => undefined,
      reload: async () => undefined,
      back: async () => undefined,
      forward: async () => undefined,
      stop: async () => undefined,
      state: async (id) => views.get(id) ?? null,
      states: async () => [...views.values()],
      openDevTools: async () => undefined,
    },
    metrics: {
      account: async (id, days = 30) =>
        metricsFor(
          accounts.find((a) => a.id === id)!,
          days,
        ),
      platform: async (platformId, days = 30) => summarize(platformId as PlatformId, days),
      overview: async (days = 30) => {
        const platforms = PLATFORM_IDS.map((id) => summarize(id, days)).filter((p) => p.accountCount > 0);
        const totals: Partial<Record<MetricName, number>> = {};
        const dayDelta: Partial<Record<MetricName, number>> = {};
        for (const p of platforms)
          for (const [m, v] of Object.entries(p.totals) as Array<[MetricName, number]>)
            totals[m] = (totals[m] ?? 0) + v;
        for (const p of platforms)
          for (const [m, v] of Object.entries(p.dayDelta) as Array<[MetricName, number]>)
            dayDelta[m] = (dayDelta[m] ?? 0) + v;
        const trend = metricsFor(accounts[0], days).trend.map((point, i) => ({
          date: point.date,
          followers: accounts.reduce((s, a) => s + (metricsFor(a, days).trend[i]?.followers ?? 0), 0),
          likes: accounts.reduce((s, a) => s + (metricsFor(a, days).trend[i]?.likes ?? 0), 0),
          plays: accounts.reduce((s, a) => s + (metricsFor(a, days).trend[i]?.plays ?? 0), 0),
        }));
        const attention = accounts
          .filter((a) => a.status !== "online")
          .map((a) => ({
            accountId: a.id,
            displayName: a.displayName,
            platformId: a.platformId,
            status: a.status,
            message: a.statusMessage ?? "",
          }));
        return {
          accountCount: accounts.length,
          onlineCount: accounts.filter((a) => a.status === "online" || a.status === "expiring").length,
          attentionCount: attention.length,
          totals,
          dayDelta,
          platforms,
          trend,
          attention,
        } satisfies OverviewView;
      },
      collectNow: async (id) => {
        toast({ kind: "info", title: "预览模式", message: "桌面端才会真正采集数据" });
        const targets = id ? accounts.filter((a) => a.id === id) : accounts;
        return targets.map<CollectRun>((a) => ({
          accountId: a.id,
          platformId: a.platformId,
          startedAt: now,
          finishedAt: now,
          status: "skipped",
          trigger: "manual",
          message: "预览模式",
          metricsWritten: 0,
          worksWritten: 0,
        }));
      },
      runs: async (id) => [
        metricsFor(
          accounts.find((a) => a.id === id)!,
          7,
        ).lastRun!,
      ],
    },
    works: { list: async (id) => worksFor(accounts.find((a) => a.id === id)!) },
    assets: {
      list: async () => assets,
      import: async () => {
        toast({ kind: "info", title: "预览模式", message: "桌面端可从本机导入素材" });
        return [];
      },
      remove: async (id) => {
        const i = assets.findIndex((a) => a.id === id);
        if (i >= 0) assets.splice(i, 1);
      },
      reveal: async () => undefined,
      thumbnail: async () => null,
    },
    publish: {
      list: async (accountId) => publish.filter((p) => !accountId || p.accountId === accountId),
      save: async (input) => {
        const existing = publish.find((p) => p.id === input.id);
        const record: PublishRecord = {
          id: existing?.id ?? uuid(),
          accountId: input.accountId,
          platformId: accounts.find((a) => a.id === input.accountId)!.platformId,
          assetIds: input.assetIds,
          title: input.title,
          description: input.description ?? "",
          tags: input.tags ?? [],
          scheduledAt: input.scheduledAt ?? null,
          status: input.status ?? existing?.status ?? "planned",
          publishedAt: input.status === "published" ? now : (existing?.publishedAt ?? null),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (existing) Object.assign(existing, record);
        else publish.unshift(record);
        return record;
      },
      delete: async (id) => {
        const i = publish.findIndex((p) => p.id === id);
        if (i >= 0) publish.splice(i, 1);
      },
      openUpload: async () => toast({ kind: "info", title: "预览模式", message: "桌面端会打开平台上传页" }),
      attachFiles: async () => ({ attached: 0, message: "预览模式不可用" }),
    },
    settings: {
      get: async () => settings,
      set: async (patch) => Object.assign(settings, patch),
    },
    audit: { list: async () => [] },
    backup: {
      export: async () => null,
      import: async () => null,
    },
    app: {
      info: async () => ({
        version: "preview",
        electron: "-",
        chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "-",
        userDataPath: "(browser preview)",
        userAgent: navigator.userAgent,
      }),
      openExternal: async (url) => void window.open(url, "_blank", "noopener"),
    },
    on(event: string, handler: Handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
  } as WorkbenchApi;
}
