import type { Work } from "@shared/types";
import { PLATFORMS } from "@shared/platforms";
import {
  LoggedOutError,
  emptyResult,
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

const API = "https://api.bilibili.com";
const MEMBER = "https://member.bilibili.com";

async function readProfile(ctx: CollectorContext): Promise<CollectorProfile | null> {
  const nav = await firstJson(
    ctx.webContents,
    [{ url: `${API}/x/web-interface/nav` }],
    (j) => pick(j, "code") === 0 || pick(j, "code") === -101,
  );
  if (!nav) return null;
  if (pick(nav, "code") === -101 || pick(nav, "data.isLogin") === false) throw new LoggedOutError();
  const data = pick(nav, "data") as Record<string, unknown>;
  const mid = String(data.mid ?? "");
  const [stat, upstat] = await Promise.all([
    firstJson(ctx.webContents, [{ url: `${API}/x/web-interface/nav/stat` }], (j) => pick(j, "code") === 0),
    mid
      ? firstJson(
          ctx.webContents,
          [{ url: `${API}/x/space/upstat?mid=${mid}` }],
          (j) => pick(j, "code") === 0,
        )
      : Promise.resolve(null),
  ]);
  return {
    displayName: (data.uname as string) ?? null,
    avatarUrl: firstUrl(data.face),
    handle: mid || null,
    externalId: mid || null,
    followers: toNumber(pick(stat, "data.follower")),
    following: toNumber(pick(stat, "data.following")),
    likes: toNumber(pick(upstat, "data.likes")),
    plays: toNumber(pick(upstat, "data.archive.view")),
  };
}

async function readWorks(ctx: CollectorContext, fetchedAt: string): Promise<Work[] | null> {
  const json = await worksJson(
    ctx,
    [
      { url: `${MEMBER}/x/web/archives?status=is_pubing,pubed,not_pubed&pn=${ctx.progress?.page ?? 1}&ps=30&coop=1&interactive=1` },
      { url: `${MEMBER}/x/web/archives?status=pubed&pn=${ctx.progress?.page ?? 1}&ps=30` },
    ],
    (j) => pick(j, "code") === 0 && Array.isArray(pick(j, "data.arc_audits")),
  );
  if (!json) return null;
  const list = pick(json, "data.arc_audits") as any[];
  recordWorksPage(ctx, json, list, "page", []);
  return list
    .map((item) => {
      const archive = item.Archive ?? item.archive ?? {};
      const stat = item.stat ?? {};
      const remoteId = String(archive.bvid ?? archive.aid ?? "");
      if (!remoteId) return null;
      return makeWork(
        ctx.account,
        remoteId,
        {
          title: String(archive.title ?? "").slice(0, 200),
          coverUrl: firstUrl(archive.cover),
          url: `https://www.bilibili.com/video/${remoteId}`,
          publishedAt: toIso(archive.ptime ?? archive.ctime),
          status: String(archive.state_desc ?? archive.state ?? "") || null,
          plays: toNumber(stat.view),
          likes: toNumber(stat.like),
          comments: toNumber(stat.reply),
          shares: toNumber(stat.share),
          favorites: toNumber(stat.favorite),
        },
        fetchedAt,
      );
    })
    .filter((w): w is Work => Boolean(w));
}

export const bilibiliCollector: Collector = {
  platformId: "bilibili",
  workingUrl: PLATFORMS.bilibili.routes.home,

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
    try {
      profile = ctx.skipProfile ? null : await readProfile(ctx);
    } catch (error) {
      if (error instanceof LoggedOutError) {
        result.loggedOut = true;
        return result;
      }
      throw error;
    }
    if (!ctx.skipProfile && !profile) result.warnings.push("无法读取账号概览");
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
