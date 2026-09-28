import { describe, expect, it } from "vitest";
import { isIdentityEndpoint, parseIdentityResponse } from "./identity-evidence";

describe("current profile observation on additional platforms", () => {
  const cases = [
    ["bilibili", "https://api.bilibili.com/x/web-interface/nav", { code: 0, data: { isLogin: true, mid: 1234, uname: "新昵称", face: "//i0.hdslb.com/new.jpg" } }],
    ["douyin", "https://creator.douyin.com/web/api/media/user/info/", { status_code: 0, user: { sec_uid: "self", nickname: "新昵称", avatar_thumb: { url_list: ["https://p.byteimg.com/new.jpg"] } } }],
    ["xiaohongshu", "https://creator.xiaohongshu.com/api/galaxy/user/info", { code: 0, success: true, data: { userId: "self", userName: "新昵称", userAvatar: "https://sns.xhscdn.com/new.jpg" } }],
    ["baijiahao", "https://baijiahao.baidu.com/builder/app/appinfo", { errno: 0, data: { app_id: "self", app_name: "新昵称", logo: "https://pic.bdstatic.com/new.jpg" } }],
  ] as const;
  it.each(cases)("reads only %s's own successful identity response", (platform, url, body) => {
    const result = parseIdentityResponse(platform, url, 200, JSON.stringify({ ...body, token: "secret" }));
    expect(result).toMatchObject({ kind: "online", profile: { displayName: "新昵称", avatarUrl: expect.stringMatching(/^https:/) } });
    expect(JSON.stringify(result)).not.toContain("secret");
    for (const badUrl of [url + "?user_id=another", url + "?mid=123", url.replace("https:", "http:"), url.replace(".com", ".com.evil.example")]) {
      expect(isIdentityEndpoint(platform, badUrl)).toBe(false);
      expect(parseIdentityResponse(platform, badUrl, 200, JSON.stringify(body)).kind).toBe("unconfirmed");
    }
    for (const code of [401, 403, 429, 500])
      expect(parseIdentityResponse(platform, url, code, JSON.stringify(body)).profile).toBeUndefined();
    expect(parseIdentityResponse(platform, url, 200, '{}').profile).toBeUndefined();
  });
  it("rejects Bilibili profile-by-ID, unsuccessful envelopes, and a guest's cached nickname", () => {
    const url = cases[0][1];
    expect(isIdentityEndpoint("bilibili", "https://api.bilibili.com/x/space/wbi/acc/info?mid=1234")).toBe(false);
    for (const data of [{ isLogin: false, mid: 1234 }, { isLogin: true, mid: 0 }, { mid: 1234 }])
      expect(parseIdentityResponse("bilibili", url, 200, JSON.stringify({ code: 0, data: { ...data, uname: "旧昵称" } })).profile).toBeUndefined();
    expect(parseIdentityResponse("bilibili", url, 200, JSON.stringify({ ...cases[0][2], code: -1 })).profile).toBeUndefined();
  });
});

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
