import { describe, expect, it } from "vitest";
import type { Cookie } from "electron";
import { bodyLooksLoggedOut, detectLoginState, hasSessionCookies } from "./login-detector";

function cookie(domain: string, name: string, value = "x"): Cookie {
  return {
    domain,
    name,
    value,
    path: "/",
    secure: true,
    httpOnly: true,
    session: false,
    hostOnly: false,
  } as Cookie;
}

function fakeSession(
  cookies: Cookie[],
  probe: { status: number; body?: string } | Error = { status: 200, body: "{}" },
) {
  return {
    cookies: { get: async () => cookies } as never,
    fetch: async () => {
      if (probe instanceof Error) throw probe;
      return new Response(probe.body ?? "", { status: probe.status });
    },
  } as unknown as Parameters<typeof detectLoginState>[0]["session"];
}

describe("hasSessionCookies", () => {
  it("requires all `required` cookies on a login domain", () => {
    expect(hasSessionCookies("bilibili", [cookie(".bilibili.com", "SESSDATA")])).toBe(false);
    expect(
      hasSessionCookies("bilibili", [
        cookie(".bilibili.com", "SESSDATA"),
        cookie(".bilibili.com", "bili_jct"),
      ]),
    ).toBe(true);
  });

  it("accepts any-of cookies for platforms with several login cookie names", () => {
    expect(hasSessionCookies("douyin", [cookie(".douyin.com", "ttwid")])).toBe(false);
    expect(hasSessionCookies("douyin", [cookie(".douyin.com", "sessionid_ss")])).toBe(true);
    expect(hasSessionCookies("kuaishou", [cookie(".kuaishou.com", "passToken")])).toBe(true);
  });

  it("ignores cookies from unrelated domains", () => {
    expect(hasSessionCookies("douyin", [cookie(".evil.example", "sessionid_ss")])).toBe(false);
  });
});

describe("bodyLooksLoggedOut", () => {
  it("recognises platform-specific logged-out payloads", () => {
    expect(bodyLooksLoggedOut("bilibili", '{"code":-101,"message":"账号未登录"}')).toBe(true);
    expect(bodyLooksLoggedOut("douyin", '{"status_code":8,"status_msg":"请登录"}')).toBe(true);
    expect(bodyLooksLoggedOut("weixin_channels", '{"errCode":300333}')).toBe(true);
    expect(bodyLooksLoggedOut("xiaohongshu", '{"code":-100}')).toBe(true);
  });

  it("does not flag healthy payloads", () => {
    expect(bodyLooksLoggedOut("bilibili", '{"code":0,"data":{"isLogin":true}}')).toBe(false);
    expect(bodyLooksLoggedOut("douyin", '{"status_code":0,"user":{}}')).toBe(false);
  });
});

describe("detectLoginState", () => {
  const now = Date.parse("2026-09-03T00:00:00Z");

  it("reports offline when no session cookies exist", async () => {
    const result = await detectLoginState({ platformId: "douyin", session: fakeSession([]), now });
    expect(result.status).toBe("offline");
  });

  it("reports needs_verification on captcha hosts regardless of cookies", async () => {
    const result = await detectLoginState({
      platformId: "douyin",
      session: fakeSession([cookie(".douyin.com", "sessionid_ss")]),
      currentUrl: "https://verify.snssdk.com/captcha/x",
      now,
    });
    expect(result.status).toBe("needs_verification");
  });

  it("reports offline when the view settled on a login page and the probe is inconclusive", async () => {
    const cookies = [cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")];
    const url = "https://passport.bilibili.com/login?gourl=x";
    const antiBot = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession(cookies, { status: 403 }),
      currentUrl: url,
      loading: false,
      now,
    });
    expect(antiBot.status).toBe("offline");
    const noProbe = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession(cookies),
      currentUrl: url,
      loading: false,
      skipProbe: true,
      now,
    });
    expect(noProbe.status).toBe("offline");
    // While still loading (redirect in flight) the URL is not trusted.
    const loading = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession(cookies, { status: 403 }),
      currentUrl: url,
      loading: true,
      now,
    });
    expect(loading.status).toBe("online");
  });

  it("lets a conclusive probe override a login URL seen mid-redirect", async () => {
    const result = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession([cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")], {
        status: 200,
        body: '{"code":0,"data":{"isLogin":true}}',
      }),
      currentUrl: "https://passport.bilibili.com/login?gourl=x",
      loading: false,
      now,
    });
    expect(result.status).toBe("online");
  });

  it("never flags Douyin console sub-routes as login pages (regression: online/offline flapping)", async () => {
    const cookies = [cookie(".douyin.com", "sessionid_ss")];
    for (const url of [
      "https://creator.douyin.com/creator-micro/home",
      "https://creator.douyin.com/creator-micro/content/manage?enter_from=home",
      "https://creator.douyin.com/creator-micro/data-center/content",
    ]) {
      const result = await detectLoginState({
        platformId: "douyin",
        session: fakeSession(cookies, { status: 200, body: '{"status_code":0}' }),
        currentUrl: url,
        now,
      });
      expect(result.status, url).toBe("online");
      const skipped = await detectLoginState({
        platformId: "douyin",
        session: fakeSession(cookies),
        currentUrl: url,
        skipProbe: true,
        now,
      });
      expect(skipped.status, `${url} (skipProbe)`).toBe("online");
    }
  });

  it("treats only the exact Douyin console root as the login shell", async () => {
    const cookies = [cookie(".douyin.com", "sessionid_ss")];
    const atRoot = await detectLoginState({
      platformId: "douyin",
      session: fakeSession(cookies),
      currentUrl: "https://creator.douyin.com/",
      skipProbe: true,
      now,
    });
    expect(atRoot.status).toBe("offline");
    // ...but a conclusive probe overrides the URL heuristic during redirects.
    const redirecting = await detectLoginState({
      platformId: "douyin",
      session: fakeSession(cookies, { status: 200, body: '{"status_code":0,"user":{}}' }),
      currentUrl: "https://creator.douyin.com/",
      now,
    });
    expect(redirecting.status).toBe("online");
  });

  it("does not treat the Douyin console root as a login page once cookies exist", async () => {
    const result = await detectLoginState({
      platformId: "douyin",
      session: fakeSession([cookie(".douyin.com", "sessionid_ss")], {
        status: 200,
        body: '{"status_code":0}',
      }),
      currentUrl: "https://creator.douyin.com/creator-micro/home",
      now,
    });
    expect(result.status).toBe("online");
  });

  it("flips offline on a 401 probe or logged-out body", async () => {
    const cookies = [cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")];
    expect(
      (
        await detectLoginState({
          platformId: "bilibili",
          session: fakeSession(cookies, { status: 401 }),
          now,
        })
      ).status,
    ).toBe("offline");
    expect(
      (
        await detectLoginState({
          platformId: "bilibili",
          session: fakeSession(cookies, { status: 200, body: '{"code":-101}' }),
          now,
        })
      ).status,
    ).toBe("offline");
  });

  it("keeps the account online on an anti-bot 403", async () => {
    const result = await detectLoginState({
      platformId: "douyin",
      session: fakeSession([cookie(".douyin.com", "sessionid_ss")], { status: 403, body: "" }),
      now,
    });
    expect(result.status).toBe("online");
  });

  it("reports network_error instead of offline when the probe cannot connect", async () => {
    const result = await detectLoginState({
      platformId: "douyin",
      session: fakeSession([cookie(".douyin.com", "sessionid_ss")], new Error("ECONNRESET")),
      now,
    });
    expect(result.status).toBe("network_error");
  });

  it("prefers the in-page probe over the main-process fetch", async () => {
    const cookies = [cookie(".douyin.com", "sessionid_ss")];
    // main-process fetch would say logged out, page says fine → page wins
    const result = await detectLoginState({
      platformId: "douyin",
      session: fakeSession(cookies, { status: 200, body: '{"status_code":8}' }),
      probe: async () => ({ status: 200, text: '{"status_code":0,"user":{}}', url: "" }),
      now,
    });
    expect(result.status).toBe("online");
    const loggedOut = await detectLoginState({
      platformId: "douyin",
      session: fakeSession(cookies),
      probe: async () => ({ status: 200, text: '{"status_code":8,"status_msg":"用户未登录"}', url: "" }),
      now,
    });
    expect(loggedOut.status).toBe("offline");
  });

  it("does not trust a main-process 401 for signature-gated platforms (Xiaohongshu regression)", async () => {
    const cookies = [cookie(".xiaohongshu.com", "web_session")];
    const result = await detectLoginState({
      platformId: "xiaohongshu",
      session: fakeSession(cookies, { status: 401, body: '{"code":-1,"msg":"登录已过期"}' }),
      currentUrl: "https://creator.xiaohongshu.com/new/home",
      now,
    });
    expect(result.status).toBe("online");
    // ...but the same answer from inside the page is authoritative.
    const inPage = await detectLoginState({
      platformId: "xiaohongshu",
      session: fakeSession(cookies),
      probe: async () => ({ status: 401, text: '{"code":-1}', url: "" }),
      now,
    });
    expect(inPage.status).toBe("offline");
  });

  it("lets a positive in-page probe prove login even when expected cookie names are absent", async () => {
    // e.g. Xiaohongshu creator console logged in without `web_session`
    const result = await detectLoginState({
      platformId: "xiaohongshu",
      session: fakeSession([cookie(".xiaohongshu.com", "some_unknown_sso_cookie")]),
      currentUrl: "https://creator.xiaohongshu.com/new/home",
      probe: async () => ({ status: 200, text: '{"code":0,"data":{"userName":"设计"}}', url: "" }),
      now,
    });
    expect(result.status).toBe("online");
  });

  it("does not downgrade a healthy account on a background check without a page", async () => {
    const kept = await detectLoginState({
      platformId: "xiaohongshu",
      session: fakeSession([cookie(".xiaohongshu.com", "some_unknown_sso_cookie")]),
      previousStatus: "online",
      now,
    });
    expect(kept.status).toBe("online");
    // ...a previously offline account without cookies stays offline
    const stillOffline = await detectLoginState({
      platformId: "xiaohongshu",
      session: fakeSession([]),
      previousStatus: "offline",
      now,
    });
    expect(stillOffline.status).toBe("offline");
  });

  it("marks expiring near the platform TTL", async () => {
    const lastOnline = new Date(now - 47 * 3600_000).toISOString(); // channels TTL 48h, warn 12h
    const result = await detectLoginState({
      platformId: "weixin_channels",
      session: fakeSession(
        [cookie("channels.weixin.qq.com", "sessionid"), cookie("channels.weixin.qq.com", "wxuin")],
        { status: 200, body: '{"errCode":0}' },
      ),
      lastOnlineAt: lastOnline,
      now,
    });
    expect(result.status).toBe("expiring");
  });
});
