import { describe, expect, it } from "vitest";
import { GLOBAL_PLATFORM_IDS, type GlobalPlatformId } from "@shared/platforms";
import { isOfficialProxyHost } from "@main/api/proxy-target-policy";
import { GLOBAL_WEB_ENTRY_URLS, isGlobalWebHost } from "./global-web-target-policy";

describe("separate website destinations", () => {
  it.each(GLOBAL_PLATFORM_IDS)(
    "has an HTTPS official entry for %s that does not expand API access",
    (platform) => {
      const url = new URL(GLOBAL_WEB_ENTRY_URLS[platform]);
      expect(url.protocol).toBe("https:");
      expect(isGlobalWebHost(platform, url.hostname)).toBe(true);
      expect(isOfficialProxyHost(platform, url.hostname)).toBe(false);
    },
  );
  it.each([
    ["youtube", "accounts.google.com"],
    ["youtube", "i.ytimg.com"],
    ["youtube", "rr1---sn-example.googlevideo.com"],
    ["tiktok", "www.tiktok.com"],
    ["tiktok", "p16-sign.tiktokcdn-us.com"],
    ["x", "pbs.twimg.com"],
  ] as const)("permits a website target only for its platform: %s %s", (platform, host) => {
    expect(isGlobalWebHost(platform, host)).toBe(true);
    for (const other of GLOBAL_PLATFORM_IDS.filter((value) => value !== platform))
      expect(isGlobalWebHost(other, host)).toBe(false);
  });
  it.each([
    "douyin.com",
    "creator.douyin.com",
    "bilibili.com",
    "weixin.qq.com",
    "127.0.0.1",
    "::1",
    "www.youtube.com.evil.test",
    "evilytimg.com",
    "pbs.twimg.com.evil.test",
    "www.tiktok.com.",
    "www.tiktok.com:443",
    "WWW.TIKTOK.COM",
    "accounts.google.com@evil.test",
    "example.com",
    "a..tiktok.com",
  ])("does not accept unreviewed, domestic or malformed host %s", (host) => {
    for (const platform of GLOBAL_PLATFORM_IDS) expect(isGlobalWebHost(platform, host)).toBe(false);
  });
  it("rejects an unknown platform and never offers a generic web route", () => {
    expect(isGlobalWebHost("unknown" as GlobalPlatformId, "www.youtube.com")).toBe(false);
  });
});
