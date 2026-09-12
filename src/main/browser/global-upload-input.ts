import type { GlobalPlatformId } from "@shared/platforms";
/** Main-only file chooser targets, kept separate from arbitrary webpage navigation. */
export function globalUploadInput(platform: GlobalPlatformId, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (
    platform === "youtube" &&
    ((url.hostname === "studio.youtube.com" &&
      /^\/channel\/UC[a-zA-Z0-9_-]{22}(?:\/|$)/.test(url.pathname)) ||
      (url.hostname === "www.youtube.com" && url.pathname === "/upload"))
  )
    return 'input[type="file"][accept*="video"]';
  if (
    platform === "tiktok" &&
    url.hostname === "www.tiktok.com" &&
    /^\/tiktokstudio\/upload\/?$/.test(url.pathname)
  )
    return 'input[type="file"]';
  if (platform === "x" && url.hostname === "x.com" && /^\/compose\/(?:post|tweet)\/?$/.test(url.pathname))
    return 'input[type="file"][data-testid="fileInput"],input[type="file"][accept*="video"]';
  return null;
}
