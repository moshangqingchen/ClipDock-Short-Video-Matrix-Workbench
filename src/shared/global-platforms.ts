import type { GlobalPlatformId } from "./platforms";

export type GlobalWebCapability =
  "home" | "manage" | "upload" | "analytics" | "works" | "comments" | "publish";

export interface GlobalPlatformDefinition {
  id: GlobalPlatformId;
  name: string;
  entry: string;
  routes: Readonly<Partial<Record<GlobalWebCapability, string>>>;
  capabilities: Readonly<Record<GlobalWebCapability, boolean>>;
}

/** Conservative UI capability contract; unsupported entries stay visible but disabled. */
export const GLOBAL_PLATFORM_DEFINITIONS: Readonly<Record<GlobalPlatformId, GlobalPlatformDefinition>> = {
  youtube: {
    id: "youtube",
    name: "YouTube",
    entry: "https://studio.youtube.com/",
    routes: {
      home: "https://www.youtube.com/",
      manage: "https://studio.youtube.com/",
      upload: "https://www.youtube.com/upload",
      publish: "https://www.youtube.com/upload",
    },
    capabilities: {
      home: true,
      manage: true,
      upload: true,
      analytics: true,
      works: true,
      comments: true,
      publish: true,
    },
  },
  tiktok: {
    id: "tiktok",
    name: "TikTok",
    entry: "https://www.tiktok.com/tiktokstudio/",
    routes: {
      home: "https://www.tiktok.com/",
      manage: "https://www.tiktok.com/tiktokstudio/",
      upload: "https://www.tiktok.com/tiktokstudio/upload",
      analytics: "https://www.tiktok.com/tiktokstudio/analytics",
      works: "https://www.tiktok.com/tiktokstudio/content",
      comments: "https://www.tiktok.com/tiktokstudio/comments",
      publish: "https://www.tiktok.com/tiktokstudio/upload",
    },
    capabilities: {
      home: true,
      manage: true,
      upload: true,
      analytics: true,
      works: true,
      comments: true,
      publish: true,
    },
  },
  x: {
    id: "x",
    name: "X",
    entry: "https://x.com/home",
    routes: {
      home: "https://x.com/home",
      manage: "https://x.com/settings/account",
      analytics: "https://x.com/i/account_analytics",
      upload: "https://x.com/compose/post",
      publish: "https://x.com/compose/post",
    },
    capabilities: {
      home: true,
      manage: true,
      upload: true,
      analytics: true,
      works: true,
      comments: true,
      publish: true,
    },
  },
};

export function globalWebRoute(
  platformId: GlobalPlatformId,
  capability: GlobalWebCapability,
  currentUrl = "",
): string | null {
  const platform = GLOBAL_PLATFORM_DEFINITIONS[platformId];
  if (!platform?.capabilities[capability]) return null;
  if (platform.routes[capability]) return platform.routes[capability]!;
  if (platformId === "x" && capability === "comments") {
    try {
      const url = new URL(currentUrl);
      return url.origin === "https://x.com" && /^\/[a-zA-Z0-9_]{1,15}\/status\/\d+$/.test(url.pathname)
        ? url.origin + url.pathname
        : null;
    } catch {
      return null;
    }
  }
  if (platformId === "youtube") {
    try {
      const url = new URL(currentUrl);
      const channel =
        url.hostname === "studio.youtube.com" &&
        /^\/channel\/(UC[a-zA-Z0-9_-]{22})(?:\/|$)/.exec(url.pathname)?.[1];
      if (!channel) return null;
      const suffix = { analytics: "analytics/tab-overview", works: "videos", comments: "comments/inbox" }[
        capability as "analytics" | "works" | "comments"
      ];
      return suffix ? `https://studio.youtube.com/channel/${channel}/${suffix}` : null;
    } catch {
      return null;
    }
  }
  return null;
}
