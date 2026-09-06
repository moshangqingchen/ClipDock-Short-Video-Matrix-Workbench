import type { Work } from "@shared/types";
import { PLATFORMS } from "@shared/platforms";
import {
  LoggedOutError,
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

const BASE = "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin";
const HEADERS = { "content-type": "application/json", accept: "application/json" };

function body(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: String(Date.now()),
    _log_finder_uin: "",
    _log_finder_id: "",
    rawKeyBuff: null,
    pluginSessionId: null,
    scene: 7,
    reqScene: 7,
    ...extra,
  });
}

function assertLoggedIn(json: any): void {
  const code = pick(json, "errCode");
  if (code === 300330 || code === 300333 || code === 300334) throw new LoggedOutError();
}

async function readProfile(ctx: CollectorContext): Promise<CollectorProfile | null> {
  const json = await firstJson(
    ctx.webContents,
    [{ url: `${BASE}/auth/auth_data`, init: { method: "POST", headers: HEADERS, body: body() } }],
    (j) => pick(j, "errCode") !== undefined,
  );
  if (!json) return null;
  assertLoggedIn(json);
  if (pick(json, "errCode") !== 0) return null;
  const user = (pick(json, "data.finderUser") ?? pick(json, "data.user") ?? {}) as Record<string, unknown>;
  return {
    displayName: (firstDefined(user, ["nickname", "nickName"]) as string) ?? null,
    avatarUrl: firstUrl(firstDefined(user, ["headImgUrl", "headImg", "avatar"])),
    handle: (firstDefined(user, ["uniqId", "finderUsername"]) as string) ?? null,
    externalId: (firstDefined(user, ["finderUsername", "uin"]) as string) ?? null,
    followers: toNumber(firstDefined(user, ["fansCount", "fans_count", "followerCount"])),
    works: toNumber(firstDefined(user, ["feedsCount", "feedCount", "postCount"])),
  };
}

async function readWorks(ctx: CollectorContext, fetchedAt: string): Promise<Work[] | null> {
  const json = await firstJson(
    ctx.webContents,
    [
      {
        url: `${BASE}/post/post_list`,
        init: {
          method: "POST",
          headers: HEADERS,
          body: body({
            pageSize: 30,
            currentPage: 1,
            onlyUnread: false,
            userpageType: 3,
            needAllCommentCount: true,
          }),
        },
      },
      {
        url: `${BASE}/post/post_list`,
        init: { method: "POST", headers: HEADERS, body: body({ pageSize: 30, currentPage: 1 }) },
      },
    ],
    (j) => Array.isArray(pick(j, "data.list")),
  );
  if (!json) return null;
  assertLoggedIn(json);
  const list = pick(json, "data.list") as any[];
  return list
    .map((item) => {
      const remoteId = String(firstDefined(item, ["objectId", "exportId", "id"]) ?? "");
      if (!remoteId) return null;
      return makeWork(
        ctx.account,
        remoteId,
        {
          title: String(firstDefined(item, ["desc.description", "description", "title"]) ?? "").slice(0, 200),
          coverUrl: firstUrl(
            firstDefined(item, ["desc.media.0.coverUrl", "desc.media.0.thumbUrl", "coverUrl", "thumbUrl"]),
          ),
          url: null,
          publishedAt: toIso(firstDefined(item, ["createTime", "createtime", "publishTime"])),
          status: String(firstDefined(item, ["objectStatus", "status"]) ?? "") || null,
          plays: toNumber(firstDefined(item, ["readCount", "playCount", "viewCount"])) ?? 0,
          likes: toNumber(firstDefined(item, ["likeCount", "likeCnt"])) ?? 0,
          comments: toNumber(firstDefined(item, ["commentCount", "commentCnt"])) ?? 0,
          shares: toNumber(firstDefined(item, ["forwardCount", "shareCount"])) ?? 0,
          favorites: toNumber(firstDefined(item, ["favCount", "favoriteCount"])) ?? 0,
        },
        fetchedAt,
      );
    })
    .filter((w): w is Work => Boolean(w));
}

export const weixinChannelsCollector: Collector = {
  platformId: "weixin_channels",
  workingUrl: PLATFORMS.weixin_channels.routes.home,

  async fetchProfile(ctx) {
    try {
      return await readProfile(ctx);
    } catch (error) {
      if (error instanceof LoggedOutError) return null;
      throw error;
    }
  },

  async collect(ctx): Promise<CollectorResult> {
    const result = emptyResult();
    const capturedAt = new Date().toISOString();
    let profile: CollectorProfile | null;
    let fetchedWorks: Work[] | null;
    try {
      profile = await readProfile(ctx);
      fetchedWorks = await readWorks(ctx, capturedAt);
    } catch (error) {
      if (error instanceof LoggedOutError) {
        result.loggedOut = true;
        return result;
      }
      throw error;
    }
    if (!profile) result.warnings.push("无法读取账号概览");
    if (fetchedWorks === null) result.warnings.push("作品接口不可用");
    const works = fetchedWorks ?? [];
    if (profile) {
      profile = {
        ...profile,
        works: profile.works ?? works.length,
        plays: works.reduce((s, w) => s + w.plays, 0),
        likes: works.reduce((s, w) => s + w.likes, 0),
        comments: works.reduce((s, w) => s + w.comments, 0),
        shares: works.reduce((s, w) => s + w.shares, 0),
        favorites: works.reduce((s, w) => s + w.favorites, 0),
      };
    }
    result.profile = profile;
    result.works = works;
    result.metrics = [
      ...(profile ? profileToMetrics(ctx.account, profile, capturedAt) : []),
      ...worksToMetrics(works, capturedAt),
    ];
    return result;
  },
};
