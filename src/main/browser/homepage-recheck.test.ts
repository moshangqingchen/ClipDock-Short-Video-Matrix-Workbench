import { describe, expect, it } from "vitest";
import { PLATFORM_LIST } from "@shared/platforms";
import { isHomepageRecheckSource } from "./homepage-recheck";

describe("automatic homepage navigation sources", () => {
  it.each(PLATFORM_LIST.filter((platform) => platform.routes.site))(
    "accepts only blank and exact read-only management routes for $id",
    (platform) => {
      for (const url of ["", "about:blank", platform.routes.home, platform.routes.analytics, platform.routes.works])
        expect(isHomepageRecheckSource(platform.id, url), url).toBe(true);
      for (const url of [platform.routes.site!, platform.routes.login, platform.routes.upload, platform.routes.comments!])
        expect(isHomepageRecheckSource(platform.id, url), url).toBe(false);
      for (const route of [platform.routes.home, platform.routes.analytics, platform.routes.works]) {
        for (const suffix of ["?edit=1", "?redirect=%2Fpublish", "#edit", "#/message", "/edit", "/%65dit"])
          expect(isHomepageRecheckSource(platform.id, route + suffix), route + suffix).toBe(false);
        expect(isHomepageRecheckSource(platform.id, route.replace("https:", "http:"))).toBe(false);
        expect(isHomepageRecheckSource(platform.id, route.replace("https://", "https://user:password@"))).toBe(false);
        const nonDefaultPort = new URL(route);
        nonDefaultPort.port = "8443";
        expect(isHomepageRecheckSource(platform.id, nonDefaultPort.href)).toBe(false);
      }
    },
  );

  it.each(PLATFORM_LIST.filter((platform) => !platform.routes.site))(
    "does not apply public-homepage navigation to $id",
    (platform) => {
      for (const url of ["", "about:blank", platform.routes.home, platform.routes.analytics, platform.routes.works])
        expect(isHomepageRecheckSource(platform.id, url)).toBe(false);
    },
  );

  it.each(["not a url", "javascript:alert(1)", "https://member.bilibili.com.evil.test/platform/home", "https://member.bilibili.com/platform/home?", "https://member.bilibili.com/platform/home#"])(
    "rejects nonexact or unsafe input %s",
    (url) => expect(isHomepageRecheckSource("bilibili", url)).toBe(false),
  );
});
