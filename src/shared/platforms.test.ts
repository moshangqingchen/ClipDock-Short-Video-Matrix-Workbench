import { describe, expect, it } from "vitest";
import { PLATFORM_LIST, consoleHost, isLoginUrl, isVerificationUrl } from "./platforms";

describe("platform login profiles", () => {
  it("does not treat consumer homepages or consoles as verification pages", () => {
    for (const platform of PLATFORM_LIST) {
      for (const url of [
        platform.routes.home,
        platform.routes.site,
        platform.routes.upload,
        platform.routes.analytics,
      ]) {
        if (!url) continue;
        expect(isVerificationUrl(platform.id, url), `${platform.id} ${url}`).toBe(false);
      }
    }
  });

  it("recognises captcha pages by path on shared hosts (Xiaohongshu regression)", () => {
    expect(isVerificationUrl("xiaohongshu", "https://www.xiaohongshu.com/explore")).toBe(false);
    expect(
      isVerificationUrl("xiaohongshu", "https://www.xiaohongshu.com/web-login/captcha?redirectPath=x"),
    ).toBe(true);
    expect(isVerificationUrl("douyin", "https://verify.snssdk.com/verify?x=1")).toBe(true);
    expect(isVerificationUrl("douyin", "https://creator.douyin.com/creator-micro/setting/security")).toBe(
      false,
    );
    expect(isVerificationUrl("baijiahao", "https://passport.baidu.com/v2/?login")).toBe(false);
    expect(isVerificationUrl("baijiahao", "https://wappass.baidu.com/static/captcha/tuxing.html")).toBe(true);
  });

  it("keeps passport pages classified as login, not verification", () => {
    expect(isLoginUrl("baijiahao", "https://passport.baidu.com/v2/?login")).toBe(true);
    expect(isLoginUrl("bilibili", "https://passport.bilibili.com/login?gourl=x")).toBe(true);
    expect(isLoginUrl("douyin", "https://creator.douyin.com/")).toBe(true);
    expect(isLoginUrl("douyin", "https://creator.douyin.com/creator-micro/home")).toBe(false);
    expect(isLoginUrl("xiaohongshu", "https://www.xiaohongshu.com/explore")).toBe(false);
  });

  it("derives the console host from the home route", () => {
    expect(consoleHost("douyin")).toBe("creator.douyin.com");
    expect(consoleHost("bilibili")).toBe("member.bilibili.com");
    expect(consoleHost("weixin_channels")).toBe("channels.weixin.qq.com");
  });
});
