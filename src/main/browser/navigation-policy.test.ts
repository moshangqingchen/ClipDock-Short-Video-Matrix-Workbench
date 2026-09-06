import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn(async () => undefined) } }));

import { decideTopLevelNavigation } from "./navigation-policy";

describe("decideTopLevelNavigation", () => {
  it("keeps first-party creator, passport and CDN hosts inside the account view", () => {
    expect(decideTopLevelNavigation("douyin", "https://creator.douyin.com/creator-micro/home")).toEqual({
      action: "allow",
      url: "https://creator.douyin.com/creator-micro/home",
    });
    expect(decideTopLevelNavigation("douyin", "https://sso.douyin.com/login/?x=1").action).toBe("allow");
    expect(decideTopLevelNavigation("douyin", "https://verify.snssdk.com/captcha").action).toBe("allow");
    expect(
      decideTopLevelNavigation("kuaishou", "https://id.kuaishou.com/pass/kuaishou/login/qr").action,
    ).toBe("allow");
    expect(decideTopLevelNavigation("bilibili", "https://passport.bilibili.com/login?gourl=x").action).toBe(
      "allow",
    );
    expect(decideTopLevelNavigation("bilibili", "https://static.geetest.com/x.js").action).toBe("allow");
    expect(decideTopLevelNavigation("baijiahao", "https://wappass.baidu.com/static/captcha").action).toBe(
      "allow",
    );
    expect(
      decideTopLevelNavigation("weixin_channels", "https://channels.weixin.qq.com/platform").action,
    ).toBe("allow");
    expect(decideTopLevelNavigation("xiaohongshu", "https://customer.xiaohongshu.com/api/x").action).toBe(
      "allow",
    );
  });

  it("does not treat look-alike hosts as first party", () => {
    expect(decideTopLevelNavigation("douyin", "https://creator.douyin.com.evil.example/").action).toBe(
      "external",
    );
    expect(decideTopLevelNavigation("bilibili", "https://notbilibili.com/").action).toBe("external");
  });

  it("hands unrelated http(s) links to the system browser instead of blocking", () => {
    expect(decideTopLevelNavigation("douyin", "https://www.baidu.com/")).toEqual({
      action: "external",
      url: "https://www.baidu.com/",
    });
  });

  it("upgrades insecure first-party hops to https (Baijiahao)", () => {
    expect(decideTopLevelNavigation("baijiahao", "http://baijiahao.baidu.com/builder/rc/home")).toEqual({
      action: "allow",
      url: "https://baijiahao.baidu.com/builder/rc/home",
    });
  });

  it("denies dangerous schemes", () => {
    expect(decideTopLevelNavigation("douyin", "javascript:alert(1)").action).toBe("deny");
    expect(decideTopLevelNavigation("douyin", "file:///C:/Windows").action).toBe("deny");
    expect(decideTopLevelNavigation("douyin", "data:text/html,hi").action).toBe("deny");
    expect(decideTopLevelNavigation("douyin", "https://user:pw@creator.douyin.com/").action).toBe("deny");
    expect(decideTopLevelNavigation("douyin", "not a url").action).toBe("deny");
  });

  it("allows about:blank (popup placeholders)", () => {
    expect(decideTopLevelNavigation("douyin", "about:blank").action).toBe("allow");
  });
});
