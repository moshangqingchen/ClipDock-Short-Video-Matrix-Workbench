/**
 * Platform registry shared by main, preload and renderer.
 *
 * Everything that describes *how a platform's official creator site behaves*
 * lives in one place so a platform change is a one-file edit. The registry is
 * deliberately data-only: no Electron, no DOM, no network.
 */

export type PlatformId = "douyin" | "kuaishou" | "xiaohongshu" | "bilibili" | "baijiahao" | "weixin_channels";

export const PLATFORM_IDS: readonly PlatformId[] = [
  "douyin",
  "kuaishou",
  "xiaohongshu",
  "bilibili",
  "baijiahao",
  "weixin_channels",
];

export interface PlatformRoutes {
  /** Creator console home ("管理"); also the landing page when a view opens. */
  home: string;
  /**
   * Consumer-facing site ("主页") for browsing / watching in the same login
   * session. Platforms without a public web product (Baijiahao, Channels)
   * leave this undefined and the console home doubles as the homepage.
   */
  site?: string;
  /** Explicit login page; used when a session is known to be logged out. */
  login: string;
  /** Upload / publish page inside the creator console. */
  upload: string;
  /** Data / analytics center. */
  analytics: string;
  /** Works / content management list. */
  works: string;
  /** Comments / interaction center when the platform has one. */
  comments?: string;
}

/**
 * Login contract for one platform. Field semantics:
 *
 * - `topLevelHosts`: hosts a top-level navigation may land on and still be
 *   considered "inside" this account's session. A navigation outside this set
 *   is opened in the system browser instead of being blocked silently.
 * - `loginPaths`: URL path fragments that indicate the page is a login shell.
 *   Used for status detection and "do not evict this view" logic; never used
 *   to deny navigation.
 * - `verificationHosts`: captcha / risk-control hosts (usually iframes). They
 *   are always allowed as sub-frames and additionally as top-level targets.
 * - `sessionCookies`: cookie names whose presence indicates a live login. All
 *   listed `required` cookies must exist; `anyOf` needs at least one.
 * - `cookieDomains`: domains whose session cookies CookieGuard may persist.
 * - `pinnedCookies`: device / fingerprint cookies that must never be cleared
 *   except by an explicit "reset environment" action.
 * - `sessionTtlHours`: empirical lifetime used to warn before expiry.
 */
export interface PlatformLoginProfile {
  topLevelHosts: readonly string[];
  loginPaths: readonly string[];
  verificationHosts: readonly string[];
  verificationPaths: readonly string[];
  sessionCookies: { required: readonly string[]; anyOf?: readonly string[] };
  cookieDomains: readonly string[];
  pinnedCookies: readonly string[];
  sessionTtlHours: number;
  /** Hours before expected expiry at which the account is marked `expiring`. */
  expiryWarningHours: number;
  /** Lightweight same-origin endpoint returning 2xx only while logged in. */
  probe: { url: string; method?: "GET" | "POST"; loggedOutStatuses?: readonly number[] };
  /**
   * Whether the probe is trustworthy when issued from the main process (no
   * page context). Platforms that require page-side signatures or a
   * same-origin Referer answer 401 to such requests even while logged in;
   * for them a negative verdict is only accepted from an in-page probe.
   */
  probeFromMain: boolean;
  /** Whether the login shell issues window.open() for its passport page. */
  loginUsesPopup: boolean;
}

export interface PlatformDefinition {
  id: PlatformId;
  name: string;
  shortName: string;
  /** Brand color used for avatars / chips. */
  color: string;
  /** Short two-character glyph for icon fallbacks. */
  glyph: string;
  routes: PlatformRoutes;
  login: PlatformLoginProfile;
  /** Supported login methods shown in the add-account wizard. */
  loginMethods: readonly ("qr" | "sms" | "password")[];
}

const DOUYIN: PlatformDefinition = {
  id: "douyin",
  name: "抖音",
  shortName: "抖音",
  color: "#111827",
  glyph: "抖",
  loginMethods: ["qr", "sms"],
  routes: {
    home: "https://creator.douyin.com/creator-micro/home",
    site: "https://www.douyin.com/",
    login: "https://creator.douyin.com/",
    upload: "https://creator.douyin.com/creator-micro/content/upload",
    analytics: "https://creator.douyin.com/creator-micro/data-center/content",
    works: "https://creator.douyin.com/creator-micro/content/manage",
    comments: "https://creator.douyin.com/creator-micro/interaction/comment",
  },
  login: {
    topLevelHosts: [
      "douyin.com",
      "iesdouyin.com",
      "snssdk.com",
      "bytedance.com",
      "zijieapi.com",
      "byteimg.com",
      "douyinstatic.com",
      "bytegoofy.com",
      "bytetos.com",
      "bytecdn.cn",
      "amemv.com",
      "douyinpic.com",
      "douyinvod.com",
      "ixigua.com",
      "toutiao.com",
    ],
    // The console root doubles as the login shell; match it exactly rather
    // than by prefix so `/creator-micro/*` pages are never mistaken for login.
    loginPaths: ["/login", "/passport/", "/sso/", "sso.douyin.com", "=https://creator.douyin.com/"],
    // Only dedicated risk-control hosts belong here; shared hosts must be
    // matched by path or every page on them becomes "needs verification".
    verificationHosts: ["verify.snssdk.com", "verify.zijieapi.com", "rmc.bytedance.com"],
    verificationPaths: ["/verify", "/captcha", "/risk-control"],
    sessionCookies: { required: [], anyOf: ["sessionid_ss", "sessionid", "sid_tt"] },
    cookieDomains: [".douyin.com", "creator.douyin.com", ".snssdk.com", ".bytedance.com"],
    pinnedCookies: ["ttwid", "s_v_web_id", "passport_csrf_token", "__ac_nonce", "odin_tt"],
    sessionTtlHours: 24 * 30,
    expiryWarningHours: 48,
    probe: {
      url: "https://creator.douyin.com/web/api/media/user/info/",
      loggedOutStatuses: [401, 403],
    },
    probeFromMain: true,
    loginUsesPopup: true,
  },
};

const KUAISHOU: PlatformDefinition = {
  id: "kuaishou",
  name: "快手",
  shortName: "快手",
  color: "#ff6a00",
  glyph: "快",
  loginMethods: ["qr", "sms"],
  routes: {
    home: "https://cp.kuaishou.com/profile",
    site: "https://www.kuaishou.com/",
    login: "https://cp.kuaishou.com/",
    upload: "https://cp.kuaishou.com/article/publish/video",
    analytics: "https://cp.kuaishou.com/analysis/works",
    works: "https://cp.kuaishou.com/article/manage/video",
    comments: "https://cp.kuaishou.com/interaction/comment",
  },
  login: {
    topLevelHosts: [
      "kuaishou.com",
      "gifshow.com",
      "kwimgs.com",
      "yximgs.com",
      "kwaicdn.com",
      "kuaishouapp.com",
      "ksapisrv.com",
      "kuaishou.cn",
    ],
    loginPaths: ["/pc/account/login", "passport.kuaishou.com", "id.kuaishou.com", "/login"],
    verificationHosts: ["captcha.zt.kuaishou.com", "captcha.kuaishou.com", "sec.kuaishou.com"],
    verificationPaths: ["/captcha", "/verify"],
    sessionCookies: {
      required: [],
      anyOf: ["kuaishou.web.cp.api_ph", "passToken", "kuaishou.server.web_ph"],
    },
    cookieDomains: [".kuaishou.com", "cp.kuaishou.com", "passport.kuaishou.com", "id.kuaishou.com"],
    pinnedCookies: ["did", "didv", "clientid", "kpn"],
    sessionTtlHours: 24 * 14,
    expiryWarningHours: 36,
    probe: {
      url: "https://cp.kuaishou.com/rest/cp/creator/pc/home/infoV2",
      method: "POST",
      loggedOutStatuses: [401, 403],
    },
    probeFromMain: false,
    loginUsesPopup: false,
  },
};

const XIAOHONGSHU: PlatformDefinition = {
  id: "xiaohongshu",
  name: "小红书",
  shortName: "小红书",
  color: "#ff2442",
  glyph: "红",
  loginMethods: ["qr", "sms"],
  routes: {
    home: "https://creator.xiaohongshu.com/new/home",
    site: "https://www.xiaohongshu.com/explore",
    login: "https://creator.xiaohongshu.com/login",
    upload: "https://creator.xiaohongshu.com/publish/publish",
    analytics: "https://creator.xiaohongshu.com/statistics/data-analysis",
    works: "https://creator.xiaohongshu.com/new/note-manager",
    comments: "https://creator.xiaohongshu.com/creator/comment",
  },
  login: {
    topLevelHosts: ["xiaohongshu.com", "xhscdn.com", "xhslink.com", "xiaohongshu.cn", "xhsstatic.com"],
    loginPaths: ["/login", "/web-login", "customer.xiaohongshu.com"],
    // The slider captcha lives on www.xiaohongshu.com, which is also the
    // consumer homepage — match it by path, never by host.
    verificationHosts: [],
    verificationPaths: ["/web-login/captcha", "/captcha", "/verify"],
    // The creator console issues its own SSO cookies; `web_session` belongs to
    // the consumer site and is only present after visiting it.
    sessionCookies: {
      required: [],
      anyOf: [
        "access-token-creator.xiaohongshu.com",
        "customer-sso-sid",
        "galaxy_creator_session_id",
        "galaxy.creator.beaker.session.id",
        "x-user-id-creator.xiaohongshu.com",
        "web_session",
      ],
    },
    cookieDomains: [".xiaohongshu.com", "creator.xiaohongshu.com", "customer.xiaohongshu.com"],
    pinnedCookies: ["a1", "webId", "gid", "websectiga", "sec_poison_id"],
    sessionTtlHours: 24 * 7,
    expiryWarningHours: 24,
    probe: {
      url: "https://creator.xiaohongshu.com/api/galaxy/user/info",
      loggedOutStatuses: [401, 403],
    },
    probeFromMain: false,
    loginUsesPopup: false,
  },
};

const BILIBILI: PlatformDefinition = {
  id: "bilibili",
  name: "哔哩哔哩",
  shortName: "B站",
  color: "#00aeec",
  glyph: "B",
  loginMethods: ["qr", "sms", "password"],
  routes: {
    home: "https://member.bilibili.com/platform/home",
    site: "https://www.bilibili.com/",
    login: "https://passport.bilibili.com/login?gourl=https%3A%2F%2Fmember.bilibili.com%2Fplatform%2Fhome",
    upload: "https://member.bilibili.com/platform/upload/video/frame",
    analytics: "https://member.bilibili.com/platform/data-up/video/overview",
    works: "https://member.bilibili.com/platform/upload-manager/article",
    comments: "https://member.bilibili.com/platform/comment/article",
  },
  login: {
    topLevelHosts: [
      "bilibili.com",
      "b23.tv",
      "hdslb.com",
      "bilivideo.com",
      "biliapi.net",
      "bilibili.co",
      "bilicdn1.com",
      "bilicdn2.com",
    ],
    loginPaths: ["passport.bilibili.com/login", "/login", "/passport"],
    verificationHosts: [
      "static.geetest.com",
      "api.geetest.com",
      "gcaptcha4.geetest.com",
      "geetest.com",
      "gt4.geetest.com",
    ],
    verificationPaths: ["/captcha", "/geetest", "/verify"],
    sessionCookies: { required: ["SESSDATA", "bili_jct"] },
    cookieDomains: [".bilibili.com", "member.bilibili.com", "passport.bilibili.com"],
    pinnedCookies: ["buvid3", "buvid4", "b_nut", "_uuid", "buvid_fp"],
    sessionTtlHours: 24 * 180,
    expiryWarningHours: 72,
    probe: {
      url: "https://api.bilibili.com/x/web-interface/nav",
      loggedOutStatuses: [401],
    },
    probeFromMain: true,
    loginUsesPopup: false,
  },
};

const BAIJIAHAO: PlatformDefinition = {
  id: "baijiahao",
  name: "百度百家号",
  shortName: "百家号",
  color: "#2563eb",
  glyph: "百",
  loginMethods: ["qr", "sms", "password"],
  routes: {
    home: "https://baijiahao.baidu.com/builder/rc/home",
    login: "https://baijiahao.baidu.com/builder/theme/bjh/login",
    upload: "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2",
    analytics: "https://baijiahao.baidu.com/builder/rc/statistics/content",
    works: "https://baijiahao.baidu.com/builder/rc/content?type=video",
    comments: "https://baijiahao.baidu.com/builder/rc/interaction/comment",
  },
  login: {
    topLevelHosts: [
      "baidu.com",
      "bdstatic.com",
      "bdimg.com",
      "baidustatic.com",
      "bcebos.com",
      "baidu-int.com",
      "baiducontent.com",
    ],
    loginPaths: ["/builder/theme/bjh/login", "passport.baidu.com", "/v2/api", "/login"],
    // passport.baidu.com is the login page (see loginPaths), not verification.
    verificationHosts: ["wappass.baidu.com"],
    verificationPaths: ["/static/captcha", "/captcha", "/wappass", "/verify"],
    sessionCookies: { required: ["BDUSS"] },
    cookieDomains: [".baidu.com", "baijiahao.baidu.com", "passport.baidu.com"],
    pinnedCookies: ["BAIDUID", "BAIDUID_BFESS", "BIDUPSID", "PSTM"],
    sessionTtlHours: 24 * 90,
    expiryWarningHours: 72,
    probe: {
      url: "https://baijiahao.baidu.com/builder/app/appinfo",
      loggedOutStatuses: [401, 403],
    },
    probeFromMain: true,
    loginUsesPopup: false,
  },
};

const WEIXIN_CHANNELS: PlatformDefinition = {
  id: "weixin_channels",
  name: "微信视频号",
  shortName: "视频号",
  color: "#07c160",
  glyph: "视",
  loginMethods: ["qr"],
  routes: {
    home: "https://channels.weixin.qq.com/platform",
    login: "https://channels.weixin.qq.com/login.html",
    upload: "https://channels.weixin.qq.com/platform/post/create",
    analytics: "https://channels.weixin.qq.com/platform/statistic/post",
    works: "https://channels.weixin.qq.com/platform/post/list",
    comments: "https://channels.weixin.qq.com/platform/comment",
  },
  login: {
    topLevelHosts: [
      "weixin.qq.com",
      "wx.qq.com",
      "qq.com",
      "gtimg.com",
      "qpic.cn",
      "qlogo.cn",
      "weixin.com",
      "wxqcloud.qq.com",
      "qcloud.com",
      "wechat.com",
    ],
    loginPaths: ["/login.html", "/login", "open.weixin.qq.com/connect"],
    verificationHosts: [
      "captcha.qq.com",
      "t.captcha.qq.com",
      "ssl.captcha.qq.com",
      "captcha.gtimg.com",
      "global.captcha.gtimg.com",
      "sg.captcha.qcloud.com",
    ],
    verificationPaths: ["/captcha", "/verify"],
    sessionCookies: { required: ["sessionid"], anyOf: ["wxuin"] },
    cookieDomains: ["channels.weixin.qq.com", ".weixin.qq.com"],
    pinnedCookies: [],
    sessionTtlHours: 48,
    expiryWarningHours: 12,
    probe: {
      url: "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data",
      method: "POST",
      loggedOutStatuses: [401, 403],
    },
    probeFromMain: true,
    loginUsesPopup: false,
  },
};

export const PLATFORMS: Readonly<Record<PlatformId, PlatformDefinition>> = {
  douyin: DOUYIN,
  kuaishou: KUAISHOU,
  xiaohongshu: XIAOHONGSHU,
  bilibili: BILIBILI,
  baijiahao: BAIJIAHAO,
  weixin_channels: WEIXIN_CHANNELS,
};

export const PLATFORM_LIST: readonly PlatformDefinition[] = PLATFORM_IDS.map((id) => PLATFORMS[id]);

export function getPlatform(id: PlatformId): PlatformDefinition {
  const platform = PLATFORMS[id];
  if (!platform) throw new Error(`Unknown platform: ${id}`);
  return platform;
}

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === "string" && (PLATFORM_IDS as readonly string[]).includes(value);
}

/** Exact host or any subdomain of `base`. */
export function hostMatches(hostname: string, base: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const root = base.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  return host === root || host.endsWith(`.${root}`);
}

/** Host of the creator console (where login completes and management lives). */
export function consoleHost(platformId: PlatformId): string {
  return new URL(getPlatform(platformId).routes.home).hostname;
}

export function isPlatformHost(platformId: PlatformId, hostname: string): boolean {
  const { topLevelHosts, verificationHosts } = getPlatform(platformId).login;
  return (
    topLevelHosts.some((h) => hostMatches(hostname, h)) ||
    verificationHosts.some((h) => hostMatches(hostname, h))
  );
}

/**
 * `loginPaths` entries are substring matches, except entries prefixed with
 * `=` which must equal the URL's origin + pathname exactly (query/hash and a
 * trailing slash ignored). The exact form exists for consoles whose root URL
 * is the login shell but whose sub-routes are the logged-in product.
 */
export function isLoginUrl(platformId: PlatformId, url: string): boolean {
  const { loginPaths } = getPlatform(platformId).login;
  const lower = url.toLowerCase();
  const normalized = lower.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return loginPaths.some((fragment) => {
    const f = fragment.toLowerCase();
    if (f.startsWith("=")) return normalized === f.slice(1).replace(/\/+$/, "");
    return lower.includes(f);
  });
}

export function isVerificationUrl(platformId: PlatformId, url: string): boolean {
  const { verificationHosts, verificationPaths } = getPlatform(platformId).login;
  try {
    const parsed = new URL(url);
    if (verificationHosts.some((h) => hostMatches(parsed.hostname, h))) return true;
    const path = parsed.pathname.toLowerCase();
    return verificationPaths.some((fragment) => path.includes(fragment.toLowerCase()));
  } catch {
    return false;
  }
}
