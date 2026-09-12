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

const BASE = "https://creator.douyin.com";

/** Prefer the platform's existing static image variant; never rewrite a signed CDN URL. */
export function firstDouyinCoverUrl(value: unknown): string | null {
  const preferred = (item: unknown, depth = 0): string | null => {
    if (depth > 8) return null;
    if (typeof item === "string") {
      const candidate = firstUrl(item);
      if (!candidate) return null;
      try {
        const url = new URL(candidate);
        if (!["http:", "https:"].includes(url.protocol)) return null;
        const format = url.searchParams.get("format") ?? url.searchParams.get("fm");
        const supported =
          format === null ? /\.(?:png|jpe?g)$/i.test(url.pathname) : /^(?:png|jpe?g)$/i.test(format);
        return supported ? candidate : null;
      } catch {
        return null;
      }
    }
    if (Array.isArray(item)) {
      for (const candidate of item) {
        const found = preferred(candidate, depth + 1);
        if (found) return found;
      }
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return preferred(record.url_list ?? record.url ?? record.uri ?? record.src ?? null, depth + 1);
    }
    return null;
  };
  return preferred(value) ?? firstUrl(value);
}

function loggedOut(json: any): boolean {
  const code = pick(json, "status_code");
  return code === 8 || code === 2190004 || code === 2190008;
}

async function readProfile(ctx: CollectorContext): Promise<CollectorProfile | null> {
  const json = await firstJson(
    ctx.webContents,
    [
      { url: `${BASE}/web/api/media/user/info/` },
      { url: `${BASE}/aweme/v1/creator/user/info/` },
      { url: `${BASE}/web/api/creator/user/info/` },
    ],
    (j) => Boolean(pick(j, "user") || pick(j, "data.user") || pick(j, "user_info")),
  );
  if (!json) return null;
  if (loggedOut(json)) return null;
  const user = (pick(json, "user") ?? pick(json, "data.user") ?? pick(json, "user_info")) as Record<
    string,
    unknown
  >;
  return {
    displayName: (firstDefined(user, ["nickname", "nick_name", "name"]) as string) ?? null,
    avatarUrl: firstUrl(
      firstDefined(user, ["avatar_thumb", "avatar_medium", "avatar_larger", "avatar", "avatar_url"]),
    ),
    handle: (firstDefined(user, ["unique_id", "short_id", "douyin_id"]) as string) ?? null,
    externalId: (firstDefined(user, ["sec_uid", "uid", "user_id"]) as string) ?? null,
    followers: toNumber(firstDefined(user, ["follower_count", "fans_count", "mplatform_followers_count"])),
    following: toNumber(firstDefined(user, ["following_count", "follow_count"])),
    likes: toNumber(firstDefined(user, ["total_favorited", "digg_count", "favorited_count"])),
    works: toNumber(firstDefined(user, ["aweme_count", "item_count", "video_count"])),
  };
}

async function readWorks(ctx: CollectorContext, fetchedAt: string): Promise<Work[] | null> {
  const json = await firstJson(
    ctx.webContents,
    [
      { url: `${BASE}/web/api/media/aweme/post/?status=0&count=30&scene=star_atlas&max_cursor=0` },
      { url: `${BASE}/web/api/media/aweme/post/?count=30&max_cursor=0` },
      { url: `${BASE}/aweme/v1/creator/item/list/?count=30&cursor=0` },
    ],
    (j) =>
      Array.isArray(pick(j, "aweme_list")) ||
      Array.isArray(pick(j, "data.aweme_list")) ||
      Array.isArray(pick(j, "item_list")),
  );
  if (!json) return null;
  const list = (pick(json, "aweme_list") ??
    pick(json, "data.aweme_list") ??
    pick(json, "item_list")) as any[];
  return list
    .map((item) => {
      const remoteId = String(firstDefined(item, ["aweme_id", "item_id", "id"]) ?? "");
      if (!remoteId) return null;
      const stats = (item.statistics ?? item.stats ?? item) as Record<string, unknown>;
      return makeWork(
        ctx.account,
        remoteId,
        {
          title: String(firstDefined(item, ["desc", "title", "caption"]) ?? "").slice(0, 200),
          coverUrl: firstDouyinCoverUrl(
            firstDefined(item, ["video.cover", "video.origin_cover", "cover", "video.dynamic_cover"]),
          ),
          url: `https://www.douyin.com/video/${remoteId}`,
          publishedAt: toIso(firstDefined(item, ["create_time", "publish_time"])),
          status: String(firstDefined(item, ["status", "aweme_status", "item_status"]) ?? "") || null,
          plays: toNumber(firstDefined(stats, ["play_count", "vv"])) ?? 0,
          likes: toNumber(firstDefined(stats, ["digg_count", "like_count"])) ?? 0,
          comments: toNumber(firstDefined(stats, ["comment_count"])) ?? 0,
          shares: toNumber(firstDefined(stats, ["share_count", "forward_count"])) ?? 0,
          favorites: toNumber(firstDefined(stats, ["collect_count", "favorite_count"])) ?? 0,
        },
        fetchedAt,
      );
    })
    .filter((w): w is Work => Boolean(w));
}

export const douyinCollector: Collector = {
  platformId: "douyin",
  workingUrl: PLATFORMS.douyin.routes.home,

  async fetchProfile(ctx) {
    return readProfile(ctx);
  },

  async collect(ctx): Promise<CollectorResult> {
    const result = emptyResult();
    const capturedAt = new Date().toISOString();
    let profile = await readProfile(ctx);
    if (!profile) {
      const scraped = await domScrapeNumbers(ctx.webContents, DEFAULT_LABELS);
      if (Object.keys(scraped).length) {
        profile = {
          followers: scraped.followers ?? null,
          likes: scraped.likes ?? null,
          works: scraped.works ?? null,
        };
        result.warnings.push("接口不可用,已从页面读取概览数据");
      } else {
        result.warnings.push("无法读取账号概览");
      }
    }
    const fetchedWorks = await readWorks(ctx, capturedAt);
    if (fetchedWorks === null) result.warnings.push("作品接口不可用");
    const works = fetchedWorks ?? [];
    if (profile && works.length) profile = { ...profile, ...aggregateFromWorks(works) };
    result.profile = profile;
    result.works = works;
    result.metrics = [
      ...(profile ? profileToMetrics(ctx.account, profile, capturedAt) : []),
      ...worksToMetrics(works, capturedAt),
    ];
    return result;
  },
};
