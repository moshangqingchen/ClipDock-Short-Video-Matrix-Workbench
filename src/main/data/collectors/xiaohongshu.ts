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

const BASE = "https://creator.xiaohongshu.com";
const ACCEPT = { accept: "application/json, text/plain, */*" };

function ok(json: any): boolean {
  const code = pick(json, "code");
  return (code === 0 || code === "0" || pick(json, "success") === true) && Boolean(pick(json, "data"));
}

async function readProfile(ctx: CollectorContext): Promise<CollectorProfile | null> {
  const [info, personal] = await Promise.all([
    firstJson(
      ctx.webContents,
      [
        { url: `${BASE}/api/galaxy/user/info`, init: { headers: ACCEPT } },
        { url: `${BASE}/api/galaxy/creator/user/info`, init: { headers: ACCEPT } },
      ],
      ok,
    ),
    firstJson(
      ctx.webContents,
      [
        { url: `${BASE}/api/galaxy/creator/home/personal_info`, init: { headers: ACCEPT } },
        { url: `${BASE}/api/galaxy/creator/data/home/overview`, init: { headers: ACCEPT } },
        { url: `${BASE}/api/galaxy/creator/home/data`, init: { headers: ACCEPT } },
      ],
      ok,
    ),
  ]);
  if (!info && !personal) return null;
  const user = (pick(info, "data") ?? {}) as Record<string, unknown>;
  const stats = (pick(personal, "data") ?? {}) as Record<string, unknown>;
  return {
    displayName:
      (firstDefined(user, ["userName", "nickname", "name", "userDetail.nickname"]) as string) ?? null,
    avatarUrl: firstUrl(firstDefined(user, ["userAvatar", "avatar", "image", "images", "userDetail.avatar"])),
    handle: (firstDefined(user, ["redId", "red_id", "userDetail.redId"]) as string) ?? null,
    externalId: (firstDefined(user, ["userId", "user_id", "userDetail.userId"]) as string) ?? null,
    followers: toNumber(
      firstDefined(stats, ["fansCount", "fans", "fans_count", "followerCount", "fansTotal"]) ??
        firstDefined(user, ["fansCount", "fans"]),
    ),
    following: toNumber(
      firstDefined(stats, ["followCount", "follows", "follow_count"]) ??
        firstDefined(user, ["followCount", "follows"]),
    ),
    likes: toNumber(
      firstDefined(stats, ["likeAndCollectCount", "likedCount", "likes", "liked", "like_count"]) ??
        firstDefined(user, ["liked", "likes"]),
    ),
    works: toNumber(
      firstDefined(stats, ["noteCount", "notes", "note_count"]) ?? firstDefined(user, ["noteCount", "notes"]),
    ),
  };
}

async function readWorks(ctx: CollectorContext, fetchedAt: string): Promise<Work[] | null> {
  const json = await firstJson(
    ctx.webContents,
    [
      {
        url: `${BASE}/api/galaxy/creator/note/user/posted?tab=0&page=1&pageSize=30`,
        init: { headers: ACCEPT },
      },
      { url: `${BASE}/api/galaxy/creator/note/user/posted?tab=0&page=1`, init: { headers: ACCEPT } },
      { url: `${BASE}/api/galaxy/creator/notes?page=1&page_size=30`, init: { headers: ACCEPT } },
    ],
    (j) =>
      Array.isArray(pick(j, "data.notes")) ||
      Array.isArray(pick(j, "data.list")) ||
      Array.isArray(pick(j, "data")),
  );
  if (!json) return null;
  const raw = pick(json, "data.notes") ?? pick(json, "data.list") ?? pick(json, "data");
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item) => {
      const remoteId = String(firstDefined(item, ["id", "noteId", "note_id"]) ?? "");
      if (!remoteId) return null;
      return makeWork(
        ctx.account,
        remoteId,
        {
          title: String(firstDefined(item, ["display_title", "title", "desc"]) ?? "").slice(0, 200),
          coverUrl: firstUrl(
            firstDefined(item, ["images_list.0.url", "cover.url", "cover", "image", "images_list"]),
          ),
          url: `https://www.xiaohongshu.com/explore/${remoteId}`,
          publishedAt: toIso(firstDefined(item, ["time", "create_time", "publish_time", "createTime"])),
          status: String(firstDefined(item, ["status", "note_status", "auditStatus"]) ?? "") || null,
          plays: toNumber(firstDefined(item, ["view_count", "read_count", "viewCount", "impression"])) ?? 0,
          likes: toNumber(firstDefined(item, ["likes", "like_count", "likedCount", "likeCount"])) ?? 0,
          comments: toNumber(firstDefined(item, ["comments", "comment_count", "commentCount"])) ?? 0,
          shares: toNumber(firstDefined(item, ["shared_count", "share_count", "shareCount"])) ?? 0,
          favorites:
            toNumber(firstDefined(item, ["collects", "collected_count", "collectCount", "favCount"])) ?? 0,
        },
        fetchedAt,
      );
    })
    .filter((w): w is Work => Boolean(w));
}

export const xiaohongshuCollector: Collector = {
  platformId: "xiaohongshu",
  workingUrl: PLATFORMS.xiaohongshu.routes.home,

  async fetchProfile(ctx) {
    return readProfile(ctx);
  },

  async collect(ctx): Promise<CollectorResult> {
    const result = emptyResult();
    const capturedAt = new Date().toISOString();
    let profile = await readProfile(ctx);
    if (!profile || (profile.followers == null && profile.likes == null)) {
      const scraped = await domScrapeNumbers(ctx.webContents, DEFAULT_LABELS);
      if (Object.keys(scraped).length) {
        profile = {
          ...(profile ?? {}),
          followers: profile?.followers ?? scraped.followers ?? null,
          likes: profile?.likes ?? scraped.likes ?? null,
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
