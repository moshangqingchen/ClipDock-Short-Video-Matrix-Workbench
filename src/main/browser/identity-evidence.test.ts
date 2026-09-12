import { describe, expect, it } from "vitest";
import { isIdentityEndpoint, parseIdentityResponse } from "./identity-evidence";

// Synthetic, identity-only fixtures: no cookies, signatures or full production payloads.
const samples = [
  {
    platform: "kuaishou",
    url: "https://cp.kuaishou.com/rest/cp/creator/pc/home/infoV2",
    good: { result: 1, data: { userInfo: { userId: "redacted-id" } } },
    bad: { result: 109 },
  },
  {
    platform: "weixin_channels",
    url: "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data",
    good: { errCode: 0, data: { finderUser: { finderUsername: "redacted-id" } } },
    bad: { errCode: 300333 },
  },
] as const;
it("reads Kuaishou's actual home info counters while preserving zero",()=>{
  const result=parseIdentityResponse("kuaishou",samples[0].url,200,JSON.stringify({result:1,data:{userId:123,userName:"当前账号",userKwaiId:"own-handle",fansCnt:0,followCnt:2,likeCnt:3}}));
  expect(result.profile).toEqual({externalId:"123",displayName:"当前账号",handle:"own-handle",followers:0,following:2,likes:3});
});
describe.each(samples)("$platform identity confirmation", ({ platform, url, good, bad }) => {
  it("projects only the authenticated account's own avatar field", () => {
    const avatarUrl = platform === "weixin_channels" ? "https://wx.qlogo.cn/own/0" : "https://p66.a.kwimgs.com/own.jpg";
    const user = platform === "weixin_channels"
      ? { finderUsername: "self", headImgUrl: avatarUrl, coverImgUrl: "https://wx.qlogo.cn/cover/0" }
      : { userId: "self", headUrl: avatarUrl };
    const data = platform === "weixin_channels" ? { finderUser: user } : { userInfo: user };
    const body = { ...good, data, avatarUrl: "https://example.test/unrelated.jpg", token: "synthetic-secret" };
    const verdict = parseIdentityResponse(platform, url, 201, JSON.stringify(body));
    expect(verdict.kind).toBe("online");
    expect(verdict.profile?.avatarUrl).toBe(avatarUrl);
    expect(JSON.stringify(verdict)).not.toContain("synthetic-secret");
    expect(JSON.stringify(verdict)).not.toContain("cover/0");
  });
  it.each(["javascript:alert(1)", "https://user:pass@wx.qlogo.cn/0", "https://wx.qlogo.cn:8443/0", "https://wx.qlogo.cn/a b"])(
    "does not treat malformed avatar %s as a logout",
    (value) => {
      const user = platform === "weixin_channels" ? { finderUsername: "self", headImgUrl: value } : { userId: "self", headUrl: value };
      const data = platform === "weixin_channels" ? { finderUser: user } : { userInfo: user };
      const verdict = parseIdentityResponse(platform, url, 200, JSON.stringify({ ...good, data }));
      expect(verdict.kind).toBe("online");
      expect(verdict.profile?.avatarUrl).toBeUndefined();
    },
  );
  it("requires an allowed origin, a success code and nonempty identity", () => {
    expect(parseIdentityResponse(platform, url, 200, JSON.stringify(good)).kind).toBe("online");
    expect(parseIdentityResponse(platform, url, 200, JSON.stringify(bad)).kind).toBe("offline");
    for (const text of [
      "",
      "null",
      "{}",
      "[]",
      "{broken",
      "<html>captcha</html>",
      JSON.stringify({ ...good, data: {} }),
      JSON.stringify({ ...good, data: { user: { nickname: "abc", fansCount: 123 } } }),
      JSON.stringify({ ...good, data: { user: { userId: 0, finderUsername: " " } } }),
      '{"errCode":2,"errMsg":"session context missing"}',
    ])
      expect(parseIdentityResponse(platform, url, 200, text).kind, text).toBe("unconfirmed");
  });
  it.each([0, 403, 429, 500])("does not turn HTTP %s into logout", (status) => {
    expect(parseIdentityResponse(platform, url, status, JSON.stringify(bad)).kind).toBe("unconfirmed");
  });
  it("rejects lookalike origins, redirects and unrelated endpoints", () => {
    for (const address of [
      url.replace("https:", "http:"),
      url.replace(".com/", ".com.evil.test/"),
      url + "/works",
      url.replace("https://", "https://user@"),
    ])
      expect(isIdentityEndpoint(platform, address)).toBe(false);
    expect(parseIdentityResponse(platform, "https://example.test/", 401, "").kind).toBe("unconfirmed");
  });
});
