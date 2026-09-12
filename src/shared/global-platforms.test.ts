import { describe, expect, it } from "vitest";
import { GLOBAL_PLATFORM_DEFINITIONS, globalWebRoute } from "./global-platforms";
import { globalWebCapabilitySchema } from "./global-web";

describe("global website shortcut destinations", () => {
  it("opens only official editors for manual publishing", () => {
    expect(globalWebCapabilitySchema.parse("publish")).toBe("publish");
    expect(globalWebRoute("youtube", "publish")).toBe("https://www.youtube.com/upload");
    expect(globalWebRoute("tiktok", "publish")).toBe("https://www.tiktok.com/tiktokstudio/upload");
    expect(globalWebRoute("x", "publish")).toBe("https://x.com/compose/post");
    expect(globalWebRoute("x", "upload")).toBe("https://x.com/compose/post");
    expect(globalWebCapabilitySchema.safeParse("https://example.com/submit").success).toBe(false);
  });
  it("requires actual YouTube channel context and never invents a channel identifier", () => {
    const channel = "UC1234567890123456789012";
    expect(globalWebRoute("youtube", "analytics")).toBeNull();
    expect(globalWebRoute("youtube", "comments", `https://example.com/channel/${channel}`)).toBeNull();
    expect(globalWebRoute("youtube", "works", `https://studio.youtube.com/channel/${channel}/videos`)).toBe(`https://studio.youtube.com/channel/${channel}/videos`);
    expect(globalWebRoute("youtube", "analytics", `https://studio.youtube.com/channel/${channel}/videos`)).toBe(`https://studio.youtube.com/channel/${channel}/analytics/tab-overview`);
    expect(globalWebRoute("youtube", "comments", `https://studio.youtube.com/channel/${channel}`)).toBe(`https://studio.youtube.com/channel/${channel}/comments/inbox`);
    expect(GLOBAL_PLATFORM_DEFINITIONS.youtube.capabilities.analytics).toBe(true);
  });
  it("keeps unsupported X destinations absent rather than redirecting to unrelated pages", () => {
    expect(globalWebRoute("x", "works")).toBeNull();
    expect(globalWebRoute("x", "comments")).toBeNull();
  });
});
