import { describe, expect, it } from "vitest";
import { CN_PLATFORM_IDS, isPlatformHost } from "@shared/platforms";
import { isDomesticWebHost } from "./domestic-web-target-policy";

describe("domestic page resource families", () => {
  it.each([
    "unpkg.byted-static.com",
    "lf3-short.ibytedapm.com",
    "lf-ucenter-web.yhgfb-cn-static.com",
    "lf-headquarters-speed.yhgfb-cn-static.com",
    "lf-rc1.yhgfb-cn-static.com",
    "lf-rc2.yhgfb-cn-static.com",
    "lf-cdn-tos.bytescm.com",
    "lf3-config.bytetcc.com",
  ])("permits the verified Douyin dependency %s only for its resource transport", (host) => {
    expect(isDomesticWebHost("douyin", host)).toBe(true);
    expect(isPlatformHost("douyin", host)).toBe(false);
    for (const platform of CN_PLATFORM_IDS.filter((id) => id !== "douyin"))
      expect(isDomesticWebHost(platform, host)).toBe(false);
    expect(isDomesticWebHost("douyin", `child.${host}`)).toBe(false);
    expect(isDomesticWebHost("douyin", `${host}.evil.com`)).toBe(false);
  });

  it.each([
    "yhgfb-cn-static.com",
    "unknown.yhgfb-cn-static.com",
    "bytescm.com",
    "lf1-cdn-tos.bytescm.com",
    "ibytedapm.com",
    "byted-static.com",
    "bytetcc.com",
    "lf1-config.bytetcc.com",
    "vc-gate-edge.ndcpp.com",
    "storage.googleapis.com",
    "lf-rc1.yhgfb-cn-static.com:443",
    "user@lf-rc1.yhgfb-cn-static.com",
  ])("does not expand Douyin resource admission to unverified or malformed host %s", (host) => {
    expect(isDomesticWebHost("douyin", host)).toBe(false);
  });

  it.each(["p1-plat.wskwai.com", "p3-plat.wsbkwai.com", "p66-plat.wskwai.com", "video.djvod.ndcimgs.com", "v4.oskwai.com"])(
    "permits Kuaishou resource %s without making it a login/navigation origin",
    (host) => {
      expect(isDomesticWebHost("kuaishou", host)).toBe(true);
      expect(isPlatformHost("kuaishou", host)).toBe(false);
      expect(isDomesticWebHost("douyin", host)).toBe(false);
    },
  );
  it.each(["evilwskwai.com", "p1-plat.wskwai.com.evil.com", "wskwai.com:443", "user@wskwai.com"])(
    "rejects lookalike and malformed resource host %s",
    (host) => expect(isDomesticWebHost("kuaishou", host)).toBe(false),
  );
});
