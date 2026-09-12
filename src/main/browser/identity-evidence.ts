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
      target.paths.includes(parsed.pathname),
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
  const fields = platform === "weixin_channels" ? ["headImgUrl"] : ["headUrl", "headurl", "avatar", "userHead"];
  for (const field of fields) {
    const value = user[field];
    if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) continue;
    try {
      const url = new URL(value);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port)
        return url.href;
    } catch { /* Missing/malformed avatar does not affect the identity verdict. */ }
  }
  return undefined;
}

function authenticated(user: Record<string, unknown>, subject: string, platform: PlatformId): IdentityVerdict {
  const nickname = user.nickname ?? user.nickName ?? user.name ?? user.userName;
  const handle = user.uniqId ?? user.kwaiId ?? user.userKwaiId;
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
