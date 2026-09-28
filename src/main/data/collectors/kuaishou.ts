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
  type Collector,
  type CollectorContext,
  type CollectorProfile,
  type CollectorResult,
} from "./shared";

const BASE = "https://cp.kuaishou.com";
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };

async function readProfile(ctx: CollectorContext): Promise<CollectorProfile | null> {
  // The real page includes its live request/security context. Reuse its
  // verified projection rather than replaying auth endpoints with an empty body.
  if (ctx.identityProfile) return ctx.identityProfile;
  const json = await firstJson(
    ctx.webContents,
    [
      {
        url: `${BASE}/rest/cp/creator/pc/home/infoV2`,
        init: { method: "POST", headers: JSON_HEADERS, body: "{}" },
      },
      {
        url: `${BASE}/rest/cp/creator/pc/home/info`,
        init: { method: "POST", headers: JSON_HEADERS, body: "{}" },
      },
      { url: `${BASE}/rest/pc/creator/user/info`, init: { method: "GET", headers: JSON_HEADERS } },
      {
        url: `${BASE}/rest/cp/creator/pc/user/info`,
        init: { method: "POST", headers: JSON_HEADERS, body: "{}" },
      },
    ],
    (j) => pick(j, "result") === 1 && Boolean(pick(j, "data")),
  );
  if (!json) return null;
  const data = pick(json, "data") as Record<string, unknown>;
  const user = (pick(data, "userInfo") ?? pick(data, "user") ?? data) as Record<string, unknown>;
  return {
    displayName: (firstDefined(user, ["name", "userName", "nickName", "nickname"]) as string) ?? null,
    avatarUrl: firstUrl(firstDefined(user, ["headUrl", "avatar", "headUrls", "userHead"])),
    handle: (firstDefined(user, ["kwaiId", "kuaishouId", "eid"]) as string) ?? null,
    externalId:
      firstDefined(user, ["userId", "uid", "id"]) == null
        ? null
        : String(firstDefined(user, ["userId", "uid", "id"])),
    followers: toNumber(
      firstDefined(data, [
        "fansCount",
        "fanCount",
        "followerCount",
        "userInfo.fansCount",
        "overview.fansCount",
      ]),
    ),
    following: toNumber(firstDefined(data, ["followCount", "followingCount", "userInfo.followCount"])),
    likes: toNumber(
      firstDefined(data, ["likeCount", "receivedLikeCount", "userInfo.likeCount", "overview.likeCount"]),
    ),
    works: toNumber(firstDefined(data, ["photoCount", "workCount", "videoCount", "userInfo.photoCount"])),
  };
}

async function readWorks(ctx: CollectorContext, fetchedAt: string): Promise<Work[] | null> {
  const body = JSON.stringify({ pcursor: ctx.progress?.cursor ?? "", count: 30, status: 0, sortType: 1, keyword: "" });
  const json = await worksJson(
    ctx,
    [
      {
        url: `${BASE}/rest/cp/works/v2/video/pc/photo/list`,
        init: { method: "POST", headers: JSON_HEADERS, body },
      },
      {
        url: `${BASE}/rest/cp/works/v2/video/pc/photo/list?pcursor=${encodeURIComponent(ctx.progress?.cursor ?? "")}&count=30`,
        init: { method: "GET", headers: JSON_HEADERS },
      },
      { url: `${BASE}/rest/pc/works/photo/list`, init: { method: "POST", headers: JSON_HEADERS, body } },
    ],
    (j) =>
      Array.isArray(pick(j, "data.list")) ||
      Array.isArray(pick(j, "list")) ||
      Array.isArray(pick(j, "data.photoList")),
  );
  if (!json) return null;
  const list = (pick(json, "data.list") ?? pick(json, "list") ?? pick(json, "data.photoList")) as any[];
  recordWorksPage(ctx, json, list, "cursor", ["data.pcursor","pcursor"]);
  return list
    .map((item) => {
      const remoteId = String(firstDefined(item, ["photoId", "id", "workId"]) ?? "");
      if (!remoteId) return null;
      return makeWork(
        ctx.account,
        remoteId,
        {
          title: String(firstDefined(item, ["caption", "title", "desc"]) ?? "").slice(0, 200),
          coverUrl: firstUrl(firstDefined(item, ["coverUrl", "cover", "coverUrls", "thumbnailUrl"])),
          url: `https://www.kuaishou.com/short-video/${remoteId}`,
          publishedAt: toIso(firstDefined(item, ["timestamp", "publishTime", "createTime", "uploadTime"])),
          status: String(firstDefined(item, ["statusDesc", "status", "auditStatus"]) ?? "") || null,
          plays: toNumber(firstDefined(item, ["viewCount", "playCount", "displayViewCount"])),
          likes: toNumber(firstDefined(item, ["likeCount", "displayLikeCount"])),
          comments: toNumber(firstDefined(item, ["commentCount", "displayCommentCount"])),
          shares: toNumber(firstDefined(item, ["shareCount", "forwardCount"])),
          favorites: toNumber(firstDefined(item, ["collectCount", "favoriteCount"])),
        },
        fetchedAt,
      );
    })
    .filter((w): w is Work => Boolean(w));
}

export const kuaishouCollector: Collector = {
  platformId: "kuaishou",
  workingUrl: PLATFORMS.kuaishou.routes.home,

  async fetchProfile(ctx) {
    return readProfile(ctx);
  },

  async collect(ctx): Promise<CollectorResult> {
    const result = emptyResult();
    const capturedAt = new Date().toISOString();
    let profile = ctx.skipProfile ? null : await readProfile(ctx);
    if (!ctx.skipProfile) profile = completeProfile(profile, await domScrapeNumbers(ctx.webContents, DEFAULT_LABELS), result.warnings);
    const fetchedWorks = await readWorks(ctx, capturedAt);
    if (fetchedWorks === null) result.warnings.push("作品接口不可用");
    const works = fetchedWorks ?? [];
    result.profile = profile;
    result.works = works;
    result.page = ctx.pageResult;
    if (result.page?.hasMore === null) result.warnings.push(result.page.reason ?? "分页范围未确认");
    result.metrics = [
      ...(profile ? profileToMetrics(ctx.account, profile, capturedAt) : []),
      ...worksToMetrics(works, capturedAt),
    ];
    return result;
  },
};
