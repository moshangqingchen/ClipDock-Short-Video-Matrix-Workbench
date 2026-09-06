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
  const json = await firstJson(
    ctx.webContents,
    [
      { url: `${MEMBER}/x/web/archives?status=is_pubing,pubed,not_pubed&pn=1&ps=30&coop=1&interactive=1` },
      { url: `${MEMBER}/x/web/archives?status=pubed&pn=1&ps=30` },
    ],
    (j) => pick(j, "code") === 0 && Array.isArray(pick(j, "data.arc_audits")),
  );
  if (!json) return null;
  const list = pick(json, "data.arc_audits") as any[];
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
          plays: toNumber(stat.view) ?? 0,
          likes: toNumber(stat.like) ?? 0,
          comments: toNumber(stat.reply) ?? 0,
          shares: toNumber(stat.share) ?? 0,
          favorites: toNumber(stat.favorite) ?? 0,
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
    try {
      profile = await readProfile(ctx);
    } catch (error) {
      if (error instanceof LoggedOutError) {
        result.loggedOut = true;
        return result;
      }
      throw error;
    }
    if (!profile) result.warnings.push("无法读取账号概览");
    const fetchedWorks = await readWorks(ctx, capturedAt);
    if (fetchedWorks === null) result.warnings.push("作品接口不可用");
    const works = fetchedWorks ?? [];
    if (profile) {
      profile = {
        ...profile,
        works: profile.works ?? toNumber(firstDefined(works, ["length"])) ?? null,
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
