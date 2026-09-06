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

const BASE = "https://cp.kuaishou.com";
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };

async function readProfile(ctx: CollectorContext): Promise<CollectorProfile | null> {
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
  const body = JSON.stringify({ pcursor: "", count: 30, status: 0, sortType: 1, keyword: "" });
  const json = await firstJson(
    ctx.webContents,
    [
      {
        url: `${BASE}/rest/cp/works/v2/video/pc/photo/list`,
        init: { method: "POST", headers: JSON_HEADERS, body },
      },
      {
        url: `${BASE}/rest/cp/works/v2/video/pc/photo/list?pcursor=&count=30`,
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
          plays: toNumber(firstDefined(item, ["viewCount", "playCount", "displayViewCount"])) ?? 0,
          likes: toNumber(firstDefined(item, ["likeCount", "displayLikeCount"])) ?? 0,
          comments: toNumber(firstDefined(item, ["commentCount", "displayCommentCount"])) ?? 0,
          shares: toNumber(firstDefined(item, ["shareCount", "forwardCount"])) ?? 0,
          favorites: toNumber(firstDefined(item, ["collectCount", "favoriteCount"])) ?? 0,
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
