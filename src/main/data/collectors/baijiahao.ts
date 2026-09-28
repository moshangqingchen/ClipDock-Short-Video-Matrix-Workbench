import type { Work } from "@shared/types";
import { PLATFORMS } from "@shared/platforms";
import {
  completeProfile,
  DEFAULT_LABELS,
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
  worksJson,
  recordWorksPage,
  finishWorksPage,
  withIdentityProfile,
  businessResponseAllowsData,
  type Collector,
  type CollectorContext,
  type CollectorProfile,
  type CollectorResult,
} from "./shared";

const BASE = "https://baijiahao.baidu.com";

function ok(json: any): boolean {
  return businessResponseAllowsData(json, "baijiahao") &&
    (pick(json, "errno") === 0 || pick(json, "errno") === "0") && Boolean(pick(json, "data"));
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
    plays: toNumber(firstDefined(stats, ["view_num", "read_num", "playCount"])),
    comments: toNumber(firstDefined(stats, ["comment_num", "commentCount"])),
    works: toNumber(
      firstDefined(stats, ["article_num", "content_num", "works"]) ??
        firstDefined(user, ["article_num", "content_num"]),
    ),
  };
}

async function readWorks(ctx: CollectorContext, fetchedAt: string): Promise<Work[] | null> {
  const json = await worksJson(
    ctx,
    [
      { url: `${BASE}/pcui/article/lists?type=video&collection=&pageSize=30&currentPage=${ctx.progress?.page ?? 1}` },
      { url: `${BASE}/pcui/article/lists?type=&collection=&pageSize=30&currentPage=${ctx.progress?.page ?? 1}` },
      { url: `${BASE}/builder/author/article/list?type=video&page=${ctx.progress?.page ?? 1}&size=30` },
    ],
    (j) => Array.isArray(pick(j, "data.list")) || Array.isArray(pick(j, "data.items")),
  );
  if (!json) return null;
  const list = (pick(json, "data.list") ?? pick(json, "data.items")) as any[];
  recordWorksPage(ctx, json, list, "page", []);
  return list
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
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
            toNumber(firstDefined(item, ["view_count", "read_count", "play_count"])),
          likes: toNumber(firstDefined(item, ["like_count", "praise_count", "likes"])),
          comments: toNumber(firstDefined(item, ["comment_count", "comments"])),
          shares: toNumber(firstDefined(item, ["share_count", "forward_count"])),
          favorites: toNumber(firstDefined(item, ["collect_count", "favorite_count"])),
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
    let profile = ctx.skipProfile ? null : await readProfile(ctx);
    if (!ctx.skipProfile) profile = completeProfile(withIdentityProfile(profile, ctx.identityProfile), await domScrapeNumbers(ctx.webContents, DEFAULT_LABELS), result.warnings);
    const fetchedWorks = await readWorks(ctx, capturedAt);
    const works = fetchedWorks ?? [];
    result.profile = profile;
    result.works = works;
    result.page = finishWorksPage(ctx, fetchedWorks, result.warnings);
    result.metrics = [
      ...(profile ? profileToMetrics(ctx.account, profile, capturedAt) : []),
      ...worksToMetrics(works, capturedAt),
    ];
    return result;
  },
};
