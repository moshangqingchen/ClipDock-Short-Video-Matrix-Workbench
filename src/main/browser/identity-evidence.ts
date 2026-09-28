import type { PlatformId } from "@shared/platforms";

export interface IdentityVerdict {
  kind: "online" | "offline" | "unconfirmed";
  reason: string;
  subject?: string;
  /** Main-process only. Avatar sources go through the media intake, never IPC/storage. */
  profile?: { displayName?: string; handle?: string; externalId: string; followers?: number; following?: number; likes?: number; avatarUrl?: string };
}
export interface IdentityEvidence extends IdentityVerdict {
  key: string;
  sequence: number;
  observedAt: number;
}

const paths: Partial<Record<PlatformId, { host: string; paths: string[] }>> = {
  bilibili: { host: "api.bilibili.com", paths: ["/x/web-interface/nav"] },
  douyin: { host: "creator.douyin.com", paths: [
    "/web/api/media/user/info/", "/aweme/v1/creator/user/info/", "/web/api/creator/user/info/",
  ] },
  xiaohongshu: { host: "creator.xiaohongshu.com", paths: ["/api/galaxy/user/info", "/api/galaxy/creator/user/info"] },
  baijiahao: { host: "baijiahao.baidu.com", paths: ["/builder/app/appinfo", "/pcui/user/getinfo", "/builder/author/appinfo"] },
  kuaishou: {
    host: "cp.kuaishou.com",
    paths: [
      "/rest/cp/creator/pc/home/infoV2",
      "/rest/cp/creator/pc/home/info",
      "/rest/pc/creator/user/info",
      "/rest/cp/creator/pc/user/info",
    ],
  },
  weixin_channels: {
    host: "channels.weixin.qq.com",
    paths: ["/cgi-bin/mmfinderassistant-bin/auth/auth_data"],
  },
};

export function isIdentityEndpoint(platform: PlatformId, url: string): boolean {
  try {
    const parsed = new URL(url);
    const target = paths[platform];
    return Boolean(
      target &&
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      parsed.hostname === target.host &&
      target.paths.includes(parsed.pathname) &&
      ![...parsed.searchParams.keys()].some(key => /^(?:mid|uid|user_?id|sec_uid|target_?id|author_?id|app_?id)$/i.test(key)),
    );
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function identity(value: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const candidate = value[field];
    if (
      (typeof candidate === "string" && candidate.trim() && candidate !== "0") ||
      (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0)
    )
      return String(candidate).slice(0, 256);
  }
  return undefined;
}

function avatarSource(user: Record<string, unknown>, platform: PlatformId): string | undefined {
  const fields = platform === "weixin_channels" ? ["headImgUrl"] : platform === "bilibili" ? ["face"] :
    platform === "douyin" ? ["avatar_thumb", "avatar_medium", "avatar_larger", "avatar", "avatar_url"] :
    platform === "xiaohongshu" ? ["userAvatar", "avatar", "image", "images"] :
    platform === "baijiahao" ? ["avatar", "avatar_url", "logo", "head_img"] : ["headUrl", "headurl", "avatar", "userHead"];
  for (const field of fields) {
    const raw = user[field];
    const item = record(raw);
    const values = Array.isArray(raw) ? raw.slice(0, 8) : Array.isArray(item.url_list) ? item.url_list.slice(0, 8) : [item.url ?? raw];
    for (const candidate of values) {
      const value = typeof candidate === "string" && candidate.startsWith("//") ? `https:${candidate}` : candidate;
      if (typeof value !== "string" || value.length > 8192 ||
          [...value].some((char) => char.charCodeAt(0) <= 0x20 || char === "\u007f" || char === "\\")) continue;
      try {
        const url = new URL(value);
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port)
          return url.href;
      } catch { /* Missing/malformed avatar does not affect the identity verdict. */ }
    }
  }
  return undefined;
}

function authenticated(user: Record<string, unknown>, subject: string, platform: PlatformId): IdentityVerdict {
  const nickname = user.nickname ?? user.nickName ?? user.nick_name ?? user.uname ?? user.name ?? user.userName ?? user.app_name ?? user.author_name;
  const handle = platform === "bilibili" ? subject : user.uniqId ?? user.kwaiId ?? user.userKwaiId ?? user.unique_id ?? user.short_id ?? user.redId ?? user.red_id;
  const followers = user.fansCount ?? user.fans_count ?? user.followerCount ?? user.fansCnt;
  const following = user.followCnt ?? user.followCount;
  const likes = user.likeCnt ?? user.likeCount;
  const avatarUrl = avatarSource(user, platform);
  return {
    kind: "online",
    reason: "平台网页已确认登录身份",
    subject,
    profile: {
      externalId: subject,
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(typeof nickname === "string" && nickname.trim()
        ? { displayName: nickname.trim().slice(0, 60) }
        : {}),
      ...(typeof handle === "string" && handle.trim() ? { handle: handle.trim().slice(0, 128) } : {}),
      ...(typeof followers === "number" && Number.isSafeInteger(followers) && followers >= 0
        ? { followers }
        : {}),
      ...(typeof following === "number" && Number.isSafeInteger(following) && following >= 0 ? { following } : {}),
      ...(typeof likes === "number" && Number.isSafeInteger(likes) && likes >= 0 ? { likes } : {}),
    },
  };
}

/** Only identity-bearing success envelopes or exact platform auth codes are conclusive. */
export function parseIdentityResponse(
  platform: PlatformId,
  url: string,
  status: number,
  text: string,
): IdentityVerdict {
  const unknown: IdentityVerdict = { kind: "unconfirmed", reason: "身份接口尚未返回可确认的结果" };
  if (!isIdentityEndpoint(platform, url)) return unknown;
  if (status === 403 || status === 429)
    return { ...unknown, reason: status === 429 ? "平台限流，稍后重试" : "平台请求受限，等待复核" };
  if (status === 401) return { kind: "offline", reason: "身份接口返回登录失效" };
  if (status < 200 || status >= 300 || text.length > 262144) return unknown;
  let root: Record<string, unknown>;
  try {
    root = record(JSON.parse(text));
  } catch {
    return unknown;
  }
  const data = record(root.data);
  // Only dedicated current-account endpoints are observed; author/profile-by-ID
  // endpoints must never be added here. These profiles do not confer homepage login.
  if (platform === "bilibili") {
    if (root.code === -101 || root.code === 0 && data.isLogin === false)
      return { kind: "offline", reason: "身份接口返回登录失效" };
    const subject = identity(data, ["mid"]);
    if (root.code === 0 && data.isLogin === true && subject && /^[1-9]\d*$/.test(subject))
      return authenticated(data, subject, platform);
  }
  if (platform === "douyin" && (root.status_code === 0 || root.status_code === "0")) {
    for (const user of [record(root.user), record(data.user), record(root.user_info)]) {
      const subject = identity(user, ["sec_uid", "uid", "user_id"]);
      if (subject) return authenticated(user, subject, platform);
    }
  }
  if (platform === "xiaohongshu" && root.success !== false && (root.code === 0 || root.code === "0")) {
    for (const user of [data, record(data.userDetail)]) {
      const subject = identity(user, ["userId", "user_id"]);
      if (subject) return authenticated(user, subject, platform);
    }
  }
  if (platform === "baijiahao" && (root.errno === 0 || root.errno === "0")) {
    for (const user of [record(data.user), record(data.author), data]) {
      const subject = identity(user, ["app_id", "appid", "author_id", "uid"]);
      if (subject) return authenticated(user, subject, platform);
    }
  }
  if (platform === "kuaishou") {
    if ([109, 401, 100110000].includes(Number(root.result)))
      return { kind: "offline", reason: "平台身份接口确认登录失效" };
    if (root.result !== 1 && root.result !== "1") return unknown;
    for (const user of [
      record(data.userInfo),
      record(data.user),
      data,
      record(root.userInfo),
      record(root.user),
    ]) {
      const subject = identity(user, ["userId", "uid", "id", "eid", "kwaiId", "kuaishouId"]);
      if (subject) return authenticated(user, subject, platform);
    }
  }
  if (platform === "weixin_channels") {
    const code = root.errCode ?? record(root.base_resp).ret;
    if ([300330, 300333, 300334].includes(Number(code)))
      return { kind: "offline", reason: "平台身份接口确认登录失效" };
    if (code !== 0 && code !== "0") return unknown;
    for (const user of [record(data.finderUser), record(data.user), record(root.finderUser)]) {
      const subject = identity(user, ["finderUsername", "uin", "uniqId", "username"]);
      if (subject) return authenticated(user, subject, platform);
    }
  }
  return unknown;
}
