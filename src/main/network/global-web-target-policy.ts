import type { GlobalPlatformId } from "@shared/platforms";

export const GLOBAL_WEB_ENTRY_URLS: Readonly<Record<GlobalPlatformId, string>> = Object.freeze({
  youtube: "https://studio.youtube.com/",
  tiktok: "https://www.tiktok.com/tiktokstudio/",
  x: "https://x.com/home",
});
/** Website destinations, separate from official application API permissions. These are
 * initial platform-owned website/login/resource families, not a claim of complete login
 * compatibility. Unknown third parties remain blocked and require an explicit review.
 */
const exact: Readonly<Record<GlobalPlatformId, readonly string[]>> = Object.freeze({
  youtube: Object.freeze([
    "youtube.com",
    "www.youtube.com",
    "studio.youtube.com",
    "accounts.youtube.com",
    "accounts.google.com",
    "www.google.com",
    "www.gstatic.com",
    "ssl.gstatic.com",
    "fonts.gstatic.com",
    "fonts.googleapis.com",
    "youtubei.googleapis.com",
    "content.googleapis.com",
    "www.googleapis.com",
    "yt3.ggpht.com",
    "yt3.googleusercontent.com",
    "lh3.googleusercontent.com",
  ]),
  tiktok: Object.freeze(["tiktok.com", "www.tiktok.com", "m.tiktok.com"]),
  x: Object.freeze([
    "x.com",
    "www.x.com",
    "api.x.com",
    "twitter.com",
    "www.twitter.com",
    "api.twitter.com",
    "upload.twitter.com",
  ]),
});
const families: Readonly<Record<GlobalPlatformId, readonly string[]>> = Object.freeze({
  youtube: Object.freeze(["ytimg.com", "googlevideo.com"]),
  tiktok: Object.freeze([
    "tiktok.com",
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "tiktokv.com",
  ]),
  x: Object.freeze(["twimg.com"]),
});
export function isGlobalWebHost(platform: string, host: string): boolean {
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
  )
    return false;
  return (
    !!exact[platform as GlobalPlatformId]?.includes(host) ||
    !!families[platform as GlobalPlatformId]?.some((root) => host === root || host.endsWith(`.${root}`))
  );
}
