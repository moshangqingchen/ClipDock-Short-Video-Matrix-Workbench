import type { GlobalPlatformId } from "@shared/platforms";
import { webObservationSchema, type WebObservation, type WEB_METRICS } from "@shared/global-web-observation";

/** Main-only text transport. Raw page text/URLs never cross the renderer bridge or enter storage. */
export interface GlobalPageText {
  url: string;
  text: string;
}
export function observationPage(platform: GlobalPlatformId, raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
      return null;
    const allowed =
      platform === "youtube"
        ? url.hostname === "studio.youtube.com" &&
          /^\/channel\/UC[\w-]{22}(?:\/(?:analytics(?:\/[^?#]*)?|dashboard))?\/?$/.test(url.pathname)
        : platform === "tiktok"
          ? ["www.tiktok.com", "tiktok.com"].includes(url.hostname) &&
            /^\/tiktokstudio(?:\/analytics(?:\/[^?#]*)?)?\/?$/.test(url.pathname)
          : ["x.com", "www.x.com"].includes(url.hostname) &&
            /^\/i\/account_analytics(?:\/[^?#]*)?\/?$/.test(url.pathname);
    return allowed ? url.origin + url.pathname : null;
  } catch {
    return null;
  }
}

type MetricKey = keyof typeof WEB_METRICS;
const common: Partial<Record<MetricKey, string[]>> = {
  views: [
    "Views",
    "Video views",
    "Post views",
    "观看次数",
    "观看量",
    "视频观看次数",
    "视频播放量",
    "播放量",
    "浏览量",
  ],
  followers: ["Followers", "Total followers", "粉丝", "粉丝数", "总粉丝数"],
  likes: ["Likes", "点赞", "点赞数", "获赞数"],
  comments: ["Comments", "评论", "评论数"],
  shares: ["Shares", "分享", "分享数"],
  works: ["Total videos", "Total posts", "Videos published", "Posts published", "已发布视频", "作品总数"],
};
const labels: Record<GlobalPlatformId, Partial<Record<MetricKey, string[]>>> = {
  youtube: {
    views: common.views,
    likes: common.likes,
    comments: common.comments,
    shares: common.shares,
    works: common.works,
    followers: ["Current subscribers", "当前订阅人数", "当前订阅者人数", "当前订阅人数总计"],
    watchHours: [
      "Watch time (hours)",
      "Watch time (in hours)",
      "观看时长（小时）",
      "观看时长 (小时)",
      "观看时长（以小时为单位）",
    ],
    impressions: ["Impressions", "展示次数"],
  },
  tiktok: { ...common, profileVisits: ["Profile views", "Profile visits", "主页浏览量", "个人主页浏览量"] },
  x: {
    ...common,
    impressions: ["Impressions", "展示次数"],
    engagements: ["Engagements", "互动次数"],
    profileVisits: ["Profile visits", "个人资料访问次数", "主页访问次数"],
  },
};
// Keep the site's exact display units. Percentage deltas, dates and signed changes are not totals.
const valuePattern =
  /^(?:\d{1,3}(?:[,，\u00a0 ]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:[KMBkmb万亿千]|million|billion)?$/;
const normalize = (s: string) =>
  s
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
export function parseWebObservation(
  accountId: string,
  platformId: GlobalPlatformId,
  engine: WebObservation["engine"],
  raw: GlobalPageText,
  capturedAt = new Date().toISOString(),
): WebObservation {
  if (!raw || typeof raw.url !== "string" || typeof raw.text !== "string" || raw.text.length > 60000)
    throw new Error("WEB_OBSERVE_UNAVAILABLE");
  const page = observationPage(platformId, raw.url);
  if (!page) throw new Error("WEB_OBSERVE_PAGE_REQUIRED");
  const lines = raw.text
    .split(/[\r\n]+/)
    .map(normalize)
    .filter(Boolean)
    .slice(0, 5000);
  const metrics: WebObservation["metrics"] = [];
  for (const [key, aliases] of Object.entries(labels[platformId]) as [MetricKey, string[]][]) {
    const candidates: { label: string; value: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      for (const alias of aliases) {
        const line = lines[i],
          a = normalize(alias);
        const equal = line.toLocaleLowerCase() === a.toLocaleLowerCase();
        // Only a label followed by a value on the same/next line is accepted.
        const inline = line.toLocaleLowerCase().startsWith(a.toLocaleLowerCase())
          ? line.slice(a.length).replace(/^\s*[:：]?\s*/, "")
          : "";
        const value = equal ? (lines[i + 1] ?? "") : inline;
        if (valuePattern.test(value) && (equal || /^[:：\s]/.test(line.slice(a.length))))
          candidates.push({ label: a, value });
      }
    }
    // Repeated labels with different values are ambiguous (e.g. table rows or different periods).
    if (candidates.length && new Set(candidates.map((v) => v.value)).size === 1)
      metrics.push({ key, ...candidates[0] });
  }
  const periods = [
    ...new Set(
      lines.filter((s) =>
        /^(?:Last (?:7|28|30|60|90|365) days|Lifetime|过去\s*(?:7|28|30|60|90|365)\s*天|近\s*(?:7|28|30|60|90|365)\s*天|最近\s*(?:7|28|30|60|90|365)\s*天|自始至终|全部时间)$/i.test(
          s,
        ),
      ),
    ),
  ];
  return webObservationSchema.parse({
    accountId,
    platformId,
    engine,
    source: "webpage",
    capturedAt,
    page,
    period: periods.length === 1 ? periods[0] : null,
    metrics,
  });
}

/** Fixed read-only DOM extraction. It reads rendered text, excluding editable/login controls. */
export const GLOBAL_PAGE_TEXT_SCRIPT = `(() => {
  const lines = []; let length = 0, nodes = 0;
  const visit = root => {
    for (const node of root.childNodes) {
      if (++nodes > 12000 || length >= 60000) return;
      if (node.nodeType === 3) {
        const text = node.textContent.trim();
        if (text) { lines.push(text); length += text.length + 1; }
      } else if (node.nodeType === 1) {
        if (node.matches('script,style,noscript,input,textarea,select,[contenteditable],[aria-hidden="true"],[role="textbox"]')) continue;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (node.shadowRoot) visit(node.shadowRoot); else visit(node);
      }
    }
  };
  if (document.body) visit(document.body);
  return { url: location.href, text: lines.join('\\n').slice(0,60000) };
})()`;
