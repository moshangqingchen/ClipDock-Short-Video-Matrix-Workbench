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
  finishWorksPage,
  withIdentityProfile,
  type Collector,
  type CollectorContext,
  type CollectorProfile,
  type CollectorResult,
} from "./shared";

const API = "https://api.bilibili.com";
const MEMBER = "https://member.bilibili.com";

/** Some empty-account responses use null. Only an explicit successful zero total proves emptiness. */
function worksList(json: unknown): unknown[] | null {
  if (pick(json, "code") !== 0) return null;
  const list = pick(json, "data.arc_audits");
  if (Array.isArray(list)) return list;
  const totals = ["data.page.count", "data.total", "data.total_count", "data.totalCount", "total", "total_count"]
    .map(path => pick(json, path)).filter((value) => value !== undefined);
  return list === null && totals.length > 0 && totals.every((value) => value === 0 || value === "0") ? [] : null;
}

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
    (j) => worksList(j) !== null,
  );
  if (!json) return null;
  const list = worksList(json) as any[];
  recordWorksPage(ctx, json, list, "page", []);
  return list
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
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
    if (!ctx.skipProfile) profile = withIdentityProfile(profile, ctx.identityProfile);
    if (!ctx.skipProfile && !profile) result.warnings.push("无法读取账号概览");
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
