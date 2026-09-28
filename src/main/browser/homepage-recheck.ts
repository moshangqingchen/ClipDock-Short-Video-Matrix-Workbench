import { getPlatform, isLoginUrl, isVerificationUrl, type PlatformId } from "@shared/platforms";

/** Only known read-only routes can be replaced by an automatic homepage observation. */
export function isHomepageRecheckSource(platformId: PlatformId, rawUrl: string): boolean {
  const { routes } = getPlatform(platformId);
  if (!routes.site) return false;
  if (rawUrl === "" || rawUrl === "about:blank") return true;
  if (isLoginUrl(platformId, rawUrl) || isVerificationUrl(platformId, rawUrl)) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    // Exact equality deliberately rejects extra query/hash state: even a list
    // route may use those fields to open an editor or a conversation.
    return [routes.home, routes.analytics, routes.works].some((route) => url.href === new URL(route).href);
  } catch {
    return false;
  }
}
