import { describe, expect, it } from "vitest";
import { isIdentityEndpoint, parseIdentityResponse, identityResponseMetadata } from "./identity-evidence";

describe("redacted identity failure diagnostics", () => {
  const endpoint = "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data";
  it("preserves the exact numeric auth error without query, response body or credentials", () => {
    const meta = identityResponseMetadata("weixin_channels", endpoint + "?token=secret", 200,
      JSON.stringify({ base_resp: { ret: 300333 }, sessionid: "secret", user: { username: "private" } }));
    expect(meta).toEqual({ endpoint: new URL(endpoint).pathname, httpStatus: 200, platformCode: 300333 });
    expect(JSON.stringify(meta)).not.toMatch(/secret|private|sessionid/);
  });
  it("ignores arbitrary codes and unreviewed destinations", () => {
    expect(identityResponseMetadata("weixin_channels", endpoint, 403, '{"errCode":"secret"}'))
      .toEqual({ endpoint: new URL(endpoint).pathname, httpStatus: 403 });
    expect(identityResponseMetadata("weixin_channels", "https://example.com/auth?token=secret", 200, '{"errCode":300333}')).toEqual({});
    expect(identityResponseMetadata("weixin_channels", endpoint, 200, '{"errCode":9007199254740991}').platformCode).toBeUndefined();
  });
});

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

describe("Douyin consumer homepage self-profile observation", () => {
  const url = "https://www.douyin.com/aweme/v1/web/user/profile/self/";
  const user = { uid: "123456", sec_uid: "self-subject", nickname: "新昵称", unique_id: "own-handle",
    avatar_thumb: { url_list: ["https://p3.douyinpic.com/new.jpg"] },
    follower_count: 0, following_count: 2, total_favorited: 3 };

  it("reads the official self response envelope and native account fields", () => {
    for (const status_code of [0, "0"]) {
      const verdict = parseIdentityResponse("douyin", url + "?aid=6383&source=channel_pc_web&personal_center_strategy=1",
        200, JSON.stringify({ status_code, user, token: "never-export", author: { nickname: "别人" } }));
      expect(verdict).toMatchObject({ kind: "online", subject: "self-subject", profile: {
        externalId: "self-subject", displayName: "新昵称", handle: "own-handle",
        avatarUrl: "https://p3.douyinpic.com/new.jpg", followers: 0, following: 2, likes: 3,
      } });
      expect(JSON.stringify(verdict)).not.toMatch(/never-export|别人/);
    }
  });

  it("never observes public authors, target-user query parameters or lookalike destinations", () => {
    for (const badUrl of [
      url.replace("/self/", "/other/"), url.replace("www.douyin.com", "creator.douyin.com"),
      url.replace("www.douyin.com", "www.douyin.com.evil.example"), url.replace("https:", "http:"),
      url.replace("https://", "https://user:password@"), url.replace(".com/", ".com:8443/"),
      ...["sec_user_id", "secUserId", "sec_uid", "secUid", "uid", "user_id", "target_id", "target_user_id", "author_id"]
        .map(key => url + `?${key}=another`),
    ]) {
      expect(isIdentityEndpoint("douyin", badUrl)).toBe(false);
      expect(parseIdentityResponse("douyin", badUrl, 200, JSON.stringify({ status_code: 0, user })).profile).toBeUndefined();
    }
  });

  it("requires success and the positive uid in the root current-user container", () => {
    for (const body of [
      { status_code: 8, user }, { user }, { status_code: 0, data: { user } },
      { status_code: 0, user_info: user },
      ...[undefined, null, "", "0", 0, -1, "guest"].map(uid => ({ status_code: 0, user: { ...user, uid } })),
    ]) expect(parseIdentityResponse("douyin", url, 200, JSON.stringify(body)).profile).toBeUndefined();
    for (const status of [401, 403, 429, 500])
      expect(parseIdentityResponse("douyin", url, status, JSON.stringify({ status_code: 0, user })).profile).toBeUndefined();
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
