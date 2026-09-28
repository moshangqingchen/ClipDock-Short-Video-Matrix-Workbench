import type { Work } from "@shared/types";
import { PLATFORMS } from "@shared/platforms";
import {
  LoggedOutError,
  emptyResult,
  firstDefined,
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

const BASE = "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin";
const HEADERS = { "content-type": "application/json", accept: "application/json" };

function assertLoggedIn(json: any): void {
  const code = pick(json, "errCode");
  if (code === 300330 || code === 300333 || code === 300334) throw new LoggedOutError();
}

async function readProfile(ctx: CollectorContext): Promise<CollectorProfile | null> {
  // auth_data needs the page's live security context. A fabricated POST can
  // return an auth error while the real page is healthy. Reuse only the
  // identity observer's verified, allowlisted profile projection.
  return ctx.identityProfile ?? null;
}

async function readWorks(ctx: CollectorContext, fetchedAt: string): Promise<Work[] | null> {
  const observed = ctx.observedWorksRequest?.();
  if (!observed?.body) {
    ctx.pageResult = { nextCursor: ctx.progress?.cursor ?? "", nextPage: ctx.progress?.page ?? 1,
      hasMore: null, reason: "等待官方作品页的有效请求，请打开作品管理页后重试" };
    return null;
  }
  const pageBody = JSON.parse(observed.body) as Record<string, unknown>;
  pageBody.currentPage = ctx.progress?.page ?? 1;
  pageBody.pageSize = 30;
  const json = await worksJson(ctx, [{ url: `${BASE}/post/post_list`,
    init: { method: "POST", headers: HEADERS, body: JSON.stringify(pageBody) } }],
    (j) => Array.isArray(pick(j, "data.list")));
  if (!json) return null;
  assertLoggedIn(json);
  const list = pick(json, "data.list") as any[];
  recordWorksPage(ctx, json, list, "page", []);
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
          plays: toNumber(firstDefined(item, ["readCount", "playCount", "viewCount"])),
          likes: toNumber(firstDefined(item, ["likeCount", "likeCnt"])),
          comments: toNumber(firstDefined(item, ["commentCount", "commentCnt"])),
          shares: toNumber(firstDefined(item, ["forwardCount", "shareCount"])),
          favorites: toNumber(firstDefined(item, ["favCount", "favoriteCount"])),
        },
        fetchedAt,
      );
    })
    .filter((w): w is Work => Boolean(w));
}

export const weixinChannelsCollector: Collector = {
  platformId: "weixin_channels",
  workingUrl: PLATFORMS.weixin_channels.routes.works,

  async fetchProfile(ctx) {
    try {
      return ctx.skipProfile ? null : await readProfile(ctx);
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
      profile = ctx.skipProfile ? null : await readProfile(ctx);
      fetchedWorks = await readWorks(ctx, capturedAt);
    } catch (error) {
      if (error instanceof LoggedOutError) {
        result.loggedOut = true;
        return result;
      }
      throw error;
    }
    if (!ctx.skipProfile && !profile) result.warnings.push("无法读取账号概览");
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
