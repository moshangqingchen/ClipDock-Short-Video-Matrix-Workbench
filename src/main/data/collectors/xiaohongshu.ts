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

const BASE = "https://creator.xiaohongshu.com";
const ACCEPT = { accept: "application/json, text/plain, */*" };

function ok(json: any): boolean {
  const code = pick(json, "code");
  return businessResponseAllowsData(json, "xiaohongshu") &&
    (code === 0 || code === "0" || pick(json, "success") === true) && Boolean(pick(json, "data"));
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
      firstDefined(stats, ["likedCount", "likes", "liked", "like_count"]) ??
        firstDefined(user, ["liked", "likes"]),
    ),
    works: toNumber(
      firstDefined(stats, ["noteCount", "notes", "note_count"]) ?? firstDefined(user, ["noteCount", "notes"]),
    ),
  };
}

async function readWorks(ctx: CollectorContext, fetchedAt: string): Promise<Work[] | null> {
  const json = await worksJson(
    ctx,
    [
      {
        url: `${BASE}/api/galaxy/creator/note/user/posted?tab=0&page=${ctx.progress?.page ?? 1}&pageSize=30`,
        init: { headers: ACCEPT },
      },
      { url: `${BASE}/api/galaxy/creator/note/user/posted?tab=0&page=${ctx.progress?.page ?? 1}`, init: { headers: ACCEPT } },
      { url: `${BASE}/api/galaxy/creator/notes?page=${ctx.progress?.page ?? 1}&page_size=30`, init: { headers: ACCEPT } },
    ],
    (j) =>
      Array.isArray(pick(j, "data.notes")) ||
      Array.isArray(pick(j, "data.list")) ||
      Array.isArray(pick(j, "data")),
  );
  if (!json) return null;
  const raw = pick(json, "data.notes") ?? pick(json, "data.list") ?? pick(json, "data");
  const list = Array.isArray(raw) ? raw : [];
  recordWorksPage(ctx, json, list, "page", []);
  return list
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
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
          plays: toNumber(firstDefined(item, ["view_count", "read_count", "viewCount"])),
          likes: toNumber(firstDefined(item, ["likes", "like_count", "likedCount", "likeCount"])),
          comments: toNumber(firstDefined(item, ["comments", "comment_count", "commentCount"])),
          shares: toNumber(firstDefined(item, ["shared_count", "share_count", "shareCount"])),
          favorites:
            toNumber(firstDefined(item, ["collects", "collected_count", "collectCount", "favCount"])),
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
