import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie } from "electron";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import {
  bodyLooksLoggedOut,
  buildInPageProbeScript,
  detectLoginState as detect,
  hasSessionCookies,
  type DetectionInput,
  type ProbeResponse,
} from "./login-detector";
import { installBusinessNetwork } from "@main/network/business-access";
import { getPlatform, type PlatformId } from "@shared/platforms";

const nativeNet = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", () => ({ net: nativeNet }));
const nativeReplies = new WeakMap<object, { status: number; body?: string } | Error>();

let disposeNetwork: () => void;
beforeEach(() => {
  nativeNet.request.mockReset();
  nativeNet.request.mockImplementation(
    (options: { session: object; credentials: string; method: string; redirect: string }) => {
      expect(options).toMatchObject({ credentials: "include", method: "GET", redirect: "manual" });
      const reply = nativeReplies.get(options.session);
      if (!reply) throw new Error("Unregistered test Session");
      let aborted = false;
      let body: Readable | undefined;
      const request = Object.assign(new EventEmitter(), {
        setHeader: vi.fn(),
        followRedirect: vi.fn(),
        abort: vi.fn(() => {
          aborted = true;
          body?.destroy();
        }),
        end: vi.fn(() => {
          void Promise.resolve().then(() => {
            if (aborted) return;
            if (reply instanceof Error) {
              request.emit("error", reply);
              return;
            }
            body = Object.assign(Readable.from([Buffer.from(reply.body ?? "")]), {
              statusCode: reply.status,
              statusMessage: "Fixture",
              headers: {},
            });
            request.emit("response", body);
          });
        }),
      });
      return request;
    },
  );
  disposeNetwork = installBusinessNetwork({
    enforcement: "observe",
    check: () => ({ allowed: false, reason: "CHECKING" }),
    acquire: () => null,
  });
});
afterEach(() => disposeNetwork());
const detectLoginState = (input: Omit<DetectionInput, "accountId">) =>
  detect({ ...input, accountId: "00000000-0000-4000-8000-000000000001" });

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
  probe: { status: number; body?: string; url?: string } | Error = { status: 200, body: "{}" },
) {
  const session = {
    cookies: { get: async () => cookies } as never,
    fetch: async (requestUrl: string) => {
      if (probe instanceof Error) throw probe;
      const response = new Response([204, 205, 304].includes(probe.status) ? null : (probe.body ?? ""), {
        status: probe.status,
      });
      Object.defineProperty(response, "url", { value: probe.url ?? requestUrl });
      return response;
    },
  } as unknown as Parameters<typeof detectLoginState>[0]["session"];
  nativeReplies.set(session, probe);
  return session;
}

describe("homepage authentication", () => {
  it.each(["douyin", "kuaishou", "xiaohongshu", "bilibili"] as const)(
    "trusts the %s homepage login without creator API or cookie/TTL heuristics",
    async (platformId) => {
      const session = fakeSession([], new Error("creator session expired"));
      const cookieRead = vi.spyOn(session.cookies, "get").mockRejectedValue(new Error("cookie store unavailable"));
      const probe = vi.fn(async () => ({ status: 401, text: "", url: getPlatform(platformId).login.probe.url }));
      const result = await detectLoginState({
        platformId, session, currentUrl: getPlatform(platformId).routes.site, probe,
        previousStatus: "expiring", lastOnlineAt: "2000-01-01T00:00:00.000Z",
        homepage: { kind: "online", source: "homepage", reason: "主页已登录" },
      });
      expect(result).toMatchObject({ status: "online", source: "homepage", message: "主页已登录" });
      expect(result.unconfirmed).toBeUndefined();
      expect(result.sessionExpiresAt).toBeUndefined();
      expect(cookieRead).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("preserves the last status while the homepage loads instead of falling back to the creator API", async () => {
    const probe = vi.fn(async () => ({ status: 401, text: "" }));
    const result = await detectLoginState({
      platformId: "xiaohongshu", session: fakeSession([]),
      currentUrl: getPlatform("xiaohongshu").routes.site, loading: true, previousStatus: "online", probe,
      homepage: { kind: "offline", source: "homepage", reason: "旧页面未登录" },
    });
    expect(result).toMatchObject({ status: "online", source: "homepage", unconfirmed: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not accept a homepage verdict in a creator-console context", async () => {
    const probe = vi.fn(async () => ({ status: 401, text: "" }));
    const result = await detectLoginState({
      platformId: "xiaohongshu", session: fakeSession([]),
      currentUrl: getPlatform("xiaohongshu").routes.home, previousStatus: "online", probe,
      homepage: { kind: "online", source: "homepage", reason: "wrong context" },
    });
    expect(result.status).toBe("offline");
    expect(result.source).toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
  });

  it.each([
    ["xiaohongshu", "https://www.xiaohongshu.com/web-login/captcha"],
    ["bilibili", "https://www.bilibili.com/geetest"],
  ] as const)("does not let cached homepage login hide a %s verification page", async (platformId, currentUrl) => {
    const probe = vi.fn(async () => ({ status: 200, text: "{}" }));
    const result = await detectLoginState({
      platformId, currentUrl, session: fakeSession([]), previousStatus: "online", probe,
      homepage: { kind: "online", source: "homepage", reason: "旧主页已登录" },
    });
    expect(result.status).toBe("needs_verification");
    expect(probe).not.toHaveBeenCalled();
  });
});

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

describe("Bilibili generated in-page probe body bounds", () => {
  async function execute(chunks: readonly string[]) {
    let pulls = 0;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[pulls++]));
          else controller.close();
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    );
    const reader = body.getReader();
    const cancel = vi.spyOn(reader, "cancel");
    const release = vi.spyOn(reader, "releaseLock");
    const probe = (await runInNewContext(buildInPageProbeScript("bilibili"), {
      AbortController,
      setTimeout,
      clearTimeout,
      TextDecoder,
      Uint8Array,
      fetch: async () => ({
        status: 200,
        url: "https://api.bilibili.com/x/web-interface/nav",
        body: { getReader: () => reader },
      }),
    })) as ProbeResponse;
    const result = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession([cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")]),
      probe: async () => probe,
      previousStatus: "offline",
      now: 0,
    });
    return { probe, result, pulls, cancelled, cancel, release, body };
  }

  it("accepts complete valid JSON and releases the real reader after consuming it", async () => {
    const f = await execute(['{"code":0,"data":', '{"isLogin":true}}']);
    expect(f.result.status).toBe("online");
    expect(f.result.unconfirmed).toBeUndefined();
    expect(f.pulls).toBe(2);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.body.locked).toBe(false);
  });

  it("does not confirm a valid 20000-byte JSON prefix when trailing data exceeds the cap", async () => {
    const prefix = '{"code":0,"data":{"isLogin":true}}'.padEnd(20000, " ");
    const f = await execute([prefix, "invalid-synthetic-trailing-content", "must-never-be-read"]);
    expect(f.probe.text).toBe("");
    expect(f.result).toMatchObject({ status: "offline", unconfirmed: true });
    expect(f.pulls).toBe(2);
    expect(f.cancelled).toHaveBeenCalledOnce();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.body.locked).toBe(false);
  });

  it("bounds encoded bytes instead of JavaScript character count", async () => {
    const text = JSON.stringify({ code: 0, data: { isLogin: true }, padding: "中".repeat(7000) });
    expect(text.length).toBeLessThan(20000);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(20000);
    const f = await execute([text, "must-never-be-read"]);
    expect(f.probe.text).toBe("");
    expect(f.result.unconfirmed).toBe(true);
    expect(f.pulls).toBe(1);
    expect(f.cancelled).toHaveBeenCalledOnce();
    expect(f.body.locked).toBe(false);
  });

  it("accepts an exactly 20000-byte complete response only after its real end", async () => {
    const text = '{"code":0,"data":{"isLogin":true}}'.padEnd(20000, " ");
    const f = await execute([text]);
    expect(f.probe.text).toBe(text);
    expect(f.result.status).toBe("online");
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.body.locked).toBe(false);
  });
});

describe("non-Bilibili authentication confirmation", () => {
  const now = Date.parse("2026-09-03T00:00:00Z");
  const platforms = [
    { platformId: "douyin", success: { status_code: 0 }, loggedOut: { status_code: 8 } },
    {
      platformId: "kuaishou",
      success: { result: 1, data: { userId: "fixture-user" } },
      loggedOut: { result: 109 },
    },
    { platformId: "xiaohongshu", success: { code: 0, data: {} }, loggedOut: { code: -100 } },
    { platformId: "baijiahao", success: { errno: 0, data: {} }, loggedOut: { errno: 10000 } },
    { platformId: "weixin_channels", success: { errCode: 0 }, loggedOut: { errCode: 300333 } },
  ] as const;

  function sessionFor(platformId: PlatformId) {
    const login = getPlatform(platformId).login;
    const names = [...login.sessionCookies.required, ...(login.sessionCookies.anyOf?.slice(0, 1) ?? [])];
    return fakeSession(names.map((name) => cookie(login.cookieDomains[0], name)));
  }

  it.each(platforms)(
    "preserves authentication and verification age for $platformId unconfirmed responses",
    async ({ platformId, loggedOut }) => {
      const responses: ProbeResponse[] = [
        { status: 204, text: "" },
        { status: 200, text: "" },
        { status: 200, text: "<!doctype html><html>verification</html>" },
        {
          status: 200,
          text: `<html><script>${JSON.stringify(loggedOut)}</script></html>`,
          url: getPlatform(platformId).routes.login,
        },
        { status: 200, text: "{broken" },
        { status: 200, text: "{}" },
        { status: 200, text: "null" },
        { status: 200, text: "[]" },
        { status: 200, text: "true" },
        { status: 403, text: "" },
        { status: 500, text: "" },
        { status: 0, text: "Synthetic page fetch failure" },
      ];
      for (const previousStatus of ["online", "offline", "expiring"] as const) {
        for (const response of responses) {
          const result = await detectLoginState({
            platformId,
            session: sessionFor(platformId),
            probe: async () => response,
            previousStatus,
            lastOnlineAt: new Date(now - 72 * 3600_000).toISOString(),
            now,
          });
          expect(result, JSON.stringify({ platformId, previousStatus, response })).toMatchObject({
            status:
              response.status === 0 && platformId !== "weixin_channels" ? "network_error" : previousStatus,
            ...(response.status === 0 && platformId !== "weixin_channels" ? {} : { unconfirmed: true }),
            sessionCookiesPresent: true,
            probeStatus: platformId === "weixin_channels" || response.status === 0 ? null : response.status,
          });
          expect(result).not.toHaveProperty("sessionExpiresAt");
        }
      }
    },
  );

  it.each(platforms)(
    "does not use $platformId cookies or URLs to replace a skipped/null probe",
    async ({ platformId }) => {
      for (const kind of ["skip", "null"] as const) {
        for (const previousStatus of [undefined, "online", "offline"] as const) {
          const session = sessionFor(platformId);
          const fetch = vi.spyOn(session, "fetch");
          const probe = vi.fn(async () => null);
          const result = await detectLoginState({
            platformId,
            session,
            probe,
            skipProbe: kind === "skip",
            previousStatus,
            currentUrl: getPlatform(platformId).routes.home,
            loading: false,
            now,
          });
          expect(result).toMatchObject({
            status: previousStatus ?? "unknown",
            unconfirmed: true,
            probeStatus: null,
          });
          expect(result).not.toHaveProperty("sessionExpiresAt");
          expect(probe).toHaveBeenCalledTimes(kind === "skip" || platformId === "weixin_channels" ? 0 : 1);
          expect(fetch).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(platforms.filter((p) => p.platformId !== "weixin_channels"))(
    "accepts only the existing $platformId success envelope and preserves explicit logout",
    async ({ platformId, success, loggedOut }) => {
      for (const [status, text, expected] of [
        [200, JSON.stringify(success), "online"],
        [200, JSON.stringify(loggedOut), "offline"],
        [401, "", "offline"],
      ] as const) {
        const result = await detectLoginState({
          platformId,
          session: sessionFor(platformId),
          probe: async () => ({ status, text, url: getPlatform(platformId).login.probe.url }),
          previousStatus: expected === "online" ? "offline" : "online",
          now,
        });
        expect(result.status).toBe(expected);
        expect(result.unconfirmed).toBeUndefined();
        if (expected === "online") expect(result.sessionExpiresAt).toBeDefined();
        else expect(result).not.toHaveProperty("sessionExpiresAt");
      }
    },
  );

  it.each([
    ["douyin", { status_code: "0" }],
    ["douyin", { status_code: 123 }],
    ["kuaishou", { result: "1", data: {} }],
    ["kuaishou", { result: 1 }],
    ["xiaohongshu", { code: 0 }],
    ["xiaohongshu", { success: "true", data: {} }],
    ["baijiahao", { errno: 0 }],
    ["baijiahao", { errno: 123, data: {} }],
    ["weixin_channels", { errCode: "0" }],
    ["weixin_channels", { errCode: 123 }],
  ] as const)(
    "does not infer %s success from an unknown/incomplete envelope: %j",
    async (platformId, value) => {
      const result = await detectLoginState({
        platformId,
        session: sessionFor(platformId),
        probe: async () => ({ status: 200, text: JSON.stringify(value) }),
        previousStatus: "offline",
        now,
      });
      expect(result).toMatchObject({ status: "offline", unconfirmed: true });
      expect(result).not.toHaveProperty("sessionExpiresAt");
    },
  );

  it.each([
    ["xiaohongshu", { code: "0", data: {} }],
    ["xiaohongshu", { success: true, data: {} }],
    ["baijiahao", { errno: "0", data: {} }],
  ] as const)("keeps the collector-compatible %s success envelope: %j", async (platformId, value) => {
    const result = await detectLoginState({
      platformId,
      session: sessionFor(platformId),
      probe: async () => ({ status: 200, text: JSON.stringify(value) }),
      previousStatus: "offline",
      now,
    });
    expect(result.status).toBe("online");
    expect(result.unconfirmed).toBeUndefined();
  });

  it.each(["kuaishou", "xiaohongshu"] as const)(
    "keeps %s without a page probe unconfirmed and does not issue main fetch",
    async (platformId) => {
      const session = sessionFor(platformId);
      const fetch = vi.spyOn(session, "fetch");
      const result = await detectLoginState({ platformId, session, previousStatus: "online", now });
      expect(result).toMatchObject({ status: "online", unconfirmed: true, probeStatus: null });
      expect(result).not.toHaveProperty("sessionExpiresAt");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not turn a cookie-free main-process success into a new authentication conclusion", async () => {
    for (const previousStatus of [undefined, "online", "offline"] as const) {
      const result = await detectLoginState({
        platformId: "douyin",
        session: fakeSession([], { status: 200, body: '{"status_code":0}' }),
        previousStatus,
        now,
      });
      expect(result).toMatchObject({
        status: previousStatus ?? "unknown",
        unconfirmed: true,
        probeStatus: 200,
      });
      expect(result).not.toHaveProperty("sessionExpiresAt");
    }
  });

  it("never sends a context-free Weixin Channels main-process POST", async () => {
    const session = fakeSession(
      [cookie("channels.weixin.qq.com", "sessionid"), cookie("channels.weixin.qq.com", "wxuin")],
      { status: 200, body: '{"errCode":0}' },
    );
    const fetch = vi.spyOn(session, "fetch");
    const result = await detectLoginState({ platformId: "weixin_channels", session, now });
    expect(result).toMatchObject({ status: "unknown", unconfirmed: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("detectLoginState", () => {
  const now = Date.parse("2026-09-03T00:00:00Z");

  it("does not infer an authentication result from missing cookies and an unknown response", async () => {
    const result = await detectLoginState({ platformId: "douyin", session: fakeSession([]), now });
    expect(result).toMatchObject({ status: "unknown", unconfirmed: true, sessionCookiesPresent: false });
    expect(result).not.toHaveProperty("sessionExpiresAt");
  });

  it("reports needs_verification on captcha hosts regardless of cookies", async () => {
    const result = await detectLoginState({
      platformId: "douyin",
      session: fakeSession([cookie(".douyin.com", "sessionid_ss")]),
      currentUrl: "https://verify.snssdk.com/captcha/x",
      now,
    });
    expect(result.status).toBe("needs_verification");
    expect(result).not.toHaveProperty("probeStatus");
    expect(result).not.toHaveProperty("sessionExpiresAt");
  });

  it("does not turn Bilibili challenges, skipped probes or a transient login URL into confirmation", async () => {
    const cookies = [cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")];
    const url = "https://passport.bilibili.com/login?gourl=x";
    const antiBot = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession(cookies, { status: 403 }),
      currentUrl: url,
      loading: false,
      now,
    });
    expect(antiBot).toMatchObject({ status: "unknown", unconfirmed: true });
    const noProbe = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession(cookies),
      currentUrl: url,
      loading: false,
      skipProbe: true,
      now,
    });
    expect(noProbe).toMatchObject({ status: "unknown", unconfirmed: true });
    // While still loading (redirect in flight) the URL is not trusted.
    const loading = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession(cookies, { status: 403 }),
      currentUrl: url,
      loading: true,
      now,
    });
    expect(loading).toMatchObject({ status: "unknown", unconfirmed: true });
  });

  it.each(["skip", "null"] as const)(
    "keeps Bilibili %s probe results unconfirmed despite present cookies",
    async (kind) => {
      const session = fakeSession([cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")]);
      const fetch = vi.spyOn(session, "fetch");
      const pageProbe = vi.fn(async () => null);
      const result = await detectLoginState({
        platformId: "bilibili",
        session,
        probe: pageProbe,
        currentUrl: "https://member.bilibili.com/platform/home",
        previousStatus: "online",
        skipProbe: kind === "skip",
        now,
      });
      expect(result).toMatchObject({ status: "online", unconfirmed: true, probeStatus: null });
      expect(result).not.toHaveProperty("sessionExpiresAt");
      expect(pageProbe).toHaveBeenCalledTimes(kind === "skip" ? 0 : 1);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("retains Bilibili's current verification-page priority even when the probe is skipped", async () => {
    const result = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession([]),
      currentUrl: "https://gcaptcha4.geetest.com/verify",
      previousStatus: "online",
      skipProbe: true,
      now,
    });
    expect(result.status).toBe("needs_verification");
    expect(result.unconfirmed).toBeUndefined();
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

  it("uses the original Bilibili Session for tracked main probes without falling back to Session.fetch", async () => {
    const session = fakeSession([cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")], {
      status: 200,
      body: '{"code":0,"data":{"isLogin":true}}',
    });
    const fetch = vi.spyOn(session, "fetch");
    expect((await detectLoginState({ platformId: "bilibili", session, now })).status).toBe("online");
    expect(nativeNet.request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ session, url: "https://api.bilibili.com/x/web-interface/nav" }),
    );
    nativeReplies.set(session, new Error("Synthetic transport failure"));
    expect((await detectLoginState({ platformId: "bilibili", session, now })).status).toBe("network_error");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://passport.bilibili.com/login",
    "http://api.bilibili.com/x/web-interface/nav",
    "https://api.bilibili.com:444/x/web-interface/nav",
    "https://api.bilibili.com.evil.test/x/web-interface/nav",
    "https://user:synthetic@api.bilibili.com/x/web-interface/nav",
    "https://user@api.bilibili.com/x/web-interface/nav",
    "https://api.bilibili.com:invalid/x/web-interface/nav",
    " https://api.bilibili.com/x/web-interface/nav",
    "https://api.bilibili.com/\nnav",
    "https:\\api.bilibili.com/x/web-interface/nav",
    "not-a-url",
    "",
    undefined,
  ])("requires the final Bilibili probe origin before either auth verdict: %j", async (url) => {
    const session = fakeSession([cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")]);
    for (const response of [
      { status: 200, text: '{"code":0,"data":{"isLogin":true}}' },
      { status: 200, text: '{"code":-101,"data":{"isLogin":false}}' },
      { status: 401, text: "" },
    ]) {
      const previousStatus =
        response.status === 200 && response.text.includes('"isLogin":true') ? "offline" : "online";
      const result = await detectLoginState({
        platformId: "bilibili",
        session,
        probe: async () => ({ ...response, url }),
        previousStatus,
        now,
      });
      expect(result.unconfirmed).toBe(true);
      expect(result.status).toBe(previousStatus);
      expect(result).not.toHaveProperty("sessionExpiresAt");
    }
  });

  it.each(["https://api.bilibili.com/fixture/final", "https://api.bilibili.com:443/another/path"])(
    "accepts recognised responses at the configured origin without an exact-path restriction: %s",
    async (url) => {
      for (const [httpStatus, text, expected] of [
        [200, '{"code":0,"data":{"isLogin":true}}', "online"],
        [200, '{"code":-101}', "offline"],
        [401, "", "offline"],
      ] as const) {
        const result = await detectLoginState({
          platformId: "bilibili",
          session: fakeSession([]),
          probe: async () => ({ status: httpStatus, text, url }),
          now,
        });
        expect(result.status).toBe(expected);
        expect(result.unconfirmed).toBeUndefined();
      }
    },
  );

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
      expect(skipped, `${url} (skipProbe)`).toMatchObject({ status: "unknown", unconfirmed: true });
      expect(skipped).not.toHaveProperty("sessionExpiresAt");
    }
  });

  it("does not infer login status from the Douyin console root when the probe is skipped", async () => {
    const cookies = [cookie(".douyin.com", "sessionid_ss")];
    const atRoot = await detectLoginState({
      platformId: "douyin",
      session: fakeSession(cookies),
      currentUrl: "https://creator.douyin.com/",
      skipProbe: true,
      now,
    });
    expect(atRoot).toMatchObject({ status: "unknown", unconfirmed: true });
    expect(atRoot).not.toHaveProperty("sessionExpiresAt");
    // A recognised probe response can confirm authentication during redirects.
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

  it.each([
    { status: 200, body: "" },
    { status: 200, body: "{broken" },
    { status: 200, body: "<!doctype html><html>verification</html>" },
    { status: 200, body: "{}" },
    { status: 200, body: "null" },
    { status: 200, body: "[]" },
    { status: 200, body: '{"code":-352,"message":"synthetic challenge"}' },
    { status: 200, body: '{"code":0,"data":{"isLogin":"true"}}' },
    { status: 200, body: '{"code":"0","data":{"isLogin":true}}' },
    { status: 204 },
    { status: 403 },
    { status: 500 },
  ])("does not let Bilibili cookies turn an unconfirmed nav response into online: %j", async (probe) => {
    const result = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession([cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")], probe),
      previousStatus: "offline",
      now,
    });
    expect(result).toMatchObject({ status: "offline", sessionCookiesPresent: true, unconfirmed: true });
    expect(result).not.toHaveProperty("sessionExpiresAt");
  });

  it("accepts an explicit Bilibili logged-out flag even with otherwise unknown response metadata", async () => {
    const result = await detectLoginState({
      platformId: "bilibili",
      session: fakeSession([cookie(".bilibili.com", "SESSDATA"), cookie(".bilibili.com", "bili_jct")], {
        status: 200,
        body: '{"code":123,"data":{"isLogin":false}}',
      }),
      previousStatus: "online",
      now,
    });
    expect(result.status).toBe("offline");
    expect(result.unconfirmed).toBeUndefined();
  });

  it("keeps an existing online conclusion without confirming an anti-bot 403", async () => {
    const result = await detectLoginState({
      platformId: "douyin",
      session: fakeSession([cookie(".douyin.com", "sessionid_ss")], { status: 403, body: "" }),
      previousStatus: "online",
      now,
    });
    expect(result).toMatchObject({ status: "online", unconfirmed: true });
    expect(result).not.toHaveProperty("sessionExpiresAt");
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
      previousStatus: "online",
      now,
    });
    expect(result).toMatchObject({ status: "online", unconfirmed: true });
    expect(result).not.toHaveProperty("sessionExpiresAt");
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
    expect(kept).toMatchObject({ status: "online", unconfirmed: true });
    expect(kept).not.toHaveProperty("sessionExpiresAt");
    // ...a previously offline account without cookies stays offline
    const stillOffline = await detectLoginState({
      platformId: "xiaohongshu",
      session: fakeSession([]),
      previousStatus: "offline",
      now,
    });
    expect(stillOffline).toMatchObject({ status: "offline", unconfirmed: true });
    expect(stillOffline).not.toHaveProperty("sessionExpiresAt");
  });

  it("marks expiring near the platform TTL", async () => {
    const lastOnline = new Date(now - getPlatform("douyin").login.sessionTtlHours * 3600_000).toISOString();
    const result = await detectLoginState({
      platformId: "douyin",
      session: fakeSession([cookie(".douyin.com", "sessionid")], { status: 200, body: '{"status_code":0}' }),
      lastOnlineAt: lastOnline,
      now,
    });
    expect(result.status).toBe("expiring");
  });
});
