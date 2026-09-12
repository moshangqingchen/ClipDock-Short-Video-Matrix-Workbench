import type { Work } from "@shared/types";
import { PLATFORMS } from "@shared/platforms";
import {
  DEFAULT_LABELS,
  aggregateFromWorks,
  domScrapeNumbers,
  emptyResult,
  firstDefined,
  firstJson,
  firstUrl,
  makeWork,
  pick,
  profileToMetrics,
  toIso,
  toNumber,
  worksToMetrics,
  type Collector,
  type CollectorContext,
  type CollectorProfile,
  type CollectorResult,
} from "./shared";

const BASE = "https://baijiahao.baidu.com";

function ok(json: any): boolean {
  return (pick(json, "errno") === 0 || pick(json, "errno") === "0") && Boolean(pick(json, "data"));
}

async function readProfile(ctx: CollectorContext): Promise<CollectorProfile | null> {
  const [app, overview] = await Promise.all([
    firstJson(
      ctx.webContents,
      [
        { url: `${BASE}/builder/app/appinfo` },
        { url: `${BASE}/pcui/user/getinfo` },
        { url: `${BASE}/builder/author/appinfo` },
      ],
      ok,
    ),
    firstJson(
      ctx.webContents,
      [
        { url: `${BASE}/builder/author/statistic/overview` },
        { url: `${BASE}/pcui/statistic/overview` },
        { url: `${BASE}/builder/author/data/overview` },
      ],
      ok,
    ),
  ]);
  if (!app && !overview) return null;
  const data = (pick(app, "data") ?? {}) as Record<string, unknown>;
  const user = (pick(data, "user") ?? pick(data, "author") ?? data) as Record<string, unknown>;
  const stats = (pick(overview, "data") ?? {}) as Record<string, unknown>;
  return {
    displayName: (firstDefined(user, ["name", "app_name", "author_name", "nickname"]) as string) ?? null,
    avatarUrl: firstUrl(firstDefined(user, ["avatar", "avatar_url", "logo", "head_img"])),
    handle: null,
    externalId:
      firstDefined(user, ["app_id", "appid", "author_id", "uid"]) == null
        ? null
        : String(firstDefined(user, ["app_id", "appid", "author_id", "uid"])),
    followers: toNumber(
      firstDefined(stats, ["fans_num", "fansCount", "fans", "subscribe_num"]) ??
        firstDefined(user, ["fans_num", "fansCount", "subscribe_num"]),
    ),
    likes: toNumber(firstDefined(stats, ["like_num", "likeCount", "praise_num"])),
    plays: toNumber(firstDefined(stats, ["view_num", "read_num", "playCount", "recommend_num"])),
    comments: toNumber(firstDefined(stats, ["comment_num", "commentCount"])),
    works: toNumber(
      firstDefined(stats, ["article_num", "content_num", "works"]) ??
        firstDefined(user, ["article_num", "content_num"]),
    ),
  };
}

async function readWorks(ctx: CollectorContext, fetchedAt: string): Promise<Work[] | null> {
  const json = await firstJson(
    ctx.webContents,
    [
      { url: `${BASE}/pcui/article/lists?type=video&collection=&pageSize=30&currentPage=1` },
      { url: `${BASE}/pcui/article/lists?type=&collection=&pageSize=30&currentPage=1` },
      { url: `${BASE}/builder/author/article/list?type=video&page=1&size=30` },
    ],
    (j) => Array.isArray(pick(j, "data.list")) || Array.isArray(pick(j, "data.items")),
  );
  if (!json) return null;
  const list = (pick(json, "data.list") ?? pick(json, "data.items")) as any[];
  return list
    .map((item) => {
      const remoteId = String(firstDefined(item, ["article_id", "id", "nid"]) ?? "");
      if (!remoteId) return null;
      return makeWork(
        ctx.account,
        remoteId,
        {
          title: String(firstDefined(item, ["title", "name"]) ?? "").slice(0, 200),
          coverUrl: firstUrl(
            firstDefined(item, ["cover_images.0.src", "cover_images.0", "cover_url", "cover", "thumb"]),
          ),
          url: (firstDefined(item, ["url", "share_url", "article_url"]) as string) ?? null,
          publishedAt: toIso(firstDefined(item, ["publish_at", "publish_time", "created_at", "updated_at"])),
          status: String(firstDefined(item, ["status_name", "status", "audit_status"]) ?? "") || null,
          plays:
            toNumber(firstDefined(item, ["view_count", "read_count", "play_count", "recommend_count"])) ?? 0,
          likes: toNumber(firstDefined(item, ["like_count", "praise_count", "likes"])) ?? 0,
          comments: toNumber(firstDefined(item, ["comment_count", "comments"])) ?? 0,
          shares: toNumber(firstDefined(item, ["share_count", "forward_count"])) ?? 0,
          favorites: toNumber(firstDefined(item, ["collect_count", "favorite_count"])) ?? 0,
        },
        fetchedAt,
      );
    })
    .filter((w): w is Work => Boolean(w));
}

export const baijiahaoCollector: Collector = {
  platformId: "baijiahao",
  workingUrl: PLATFORMS.baijiahao.routes.home,

  async fetchProfile(ctx) {
    return readProfile(ctx);
  },

  async collect(ctx): Promise<CollectorResult> {
    const result = emptyResult();
    const capturedAt = new Date().toISOString();
    let profile = await readProfile(ctx);
    if (!profile || profile.followers == null) {
      const scraped = await domScrapeNumbers(ctx.webContents, DEFAULT_LABELS);
      if (Object.keys(scraped).length) {
        profile = {
          ...(profile ?? {}),
          followers: profile?.followers ?? scraped.followers ?? null,
          following: profile?.following ?? scraped.following ?? null,
          likes: profile?.likes ?? scraped.likes ?? null,
          comments: profile?.comments ?? scraped.comments ?? null,
          shares: profile?.shares ?? scraped.shares ?? null,
          favorites: profile?.favorites ?? scraped.favorites ?? null,
          plays: profile?.plays ?? scraped.plays ?? null,
          works: profile?.works ?? scraped.works ?? null,
        };
        result.warnings.push("部分数据从页面读取");
      } else if (!profile) {
        result.warnings.push("无法读取账号概览");
      }
    }
    const fetchedWorks = await readWorks(ctx, capturedAt);
    if (fetchedWorks === null) result.warnings.push("作品接口不可用");
    const works = fetchedWorks ?? [];
    if (profile && works.length && profile.plays == null)
      profile = { ...profile, ...aggregateFromWorks(works) };
    result.profile = profile;
    result.works = works;
    result.metrics = [
      ...(profile ? profileToMetrics(ctx.account, profile, capturedAt) : []),
      ...worksToMetrics(works, capturedAt),
    ];
    return result;
  },
};
