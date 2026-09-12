import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { getPlatform, isVerificationUrl, type PlatformId } from "@shared/platforms";
import { buildHomepageLoginScript, isHomepageContext, type HomepageLoginVerdict } from "./homepage-login";

const homes = {
  douyin: "https://www.douyin.com/",
  kuaishou: "https://www.kuaishou.com/",
  xiaohongshu: "https://www.xiaohongshu.com/explore",
  bilibili: "https://www.bilibili.com/",
};

function read(
  platform: PlatformId,
  body = "",
  state: Record<string, unknown> = {},
  options: { url?: string; loading?: boolean; currentSrc?: string } = {},
): HomepageLoginVerdict {
  const dom = new JSDOM(body, {
    url: options.url ?? homes[platform as keyof typeof homes] ?? "https://channels.weixin.qq.com/",
    runScripts: "outside-only",
  });
  try {
    Object.assign(dom.window, state);
    if (options.currentSrc) {
      const image = dom.window.document.querySelector("img");
      if (image) Object.defineProperty(image, "currentSrc", { value: options.currentSrc });
    }
    Object.defineProperty(dom.window.document, "readyState", {
      value: options.loading ? "loading" : "complete",
    });
    Object.defineProperty(dom.window.document, "cookie", {
      get() {
        throw new Error("The homepage detector must not read cookies");
      },
    });
    Object.defineProperty(dom.window, "fetch", {
      value: () => {
        throw new Error("The homepage detector must not issue requests");
      },
    });
    const original = dom.window.document.documentElement.outerHTML;
    const result = dom.window.eval(buildHomepageLoginScript(platform));
    expect(dom.window.document.documentElement.outerHTML).toBe(original);
    expect(result.source).toBe("homepage");
    return result;
  } finally {
    dom.window.close();
  }
}

describe("public homepage context", () => {
  it("keeps a public login route in public-site detection without guessing its login status", () => {
    const url = "https://www.douyin.com/login";
    expect(isHomepageContext("douyin", url)).toBe(true);
    expect(read("douyin", "", {}, { url }).kind).toBe("unconfirmed");
    expect(
      read("douyin", '<header><button data-e2e="login-button">登录</button></header>', {}, { url }).kind,
    ).toBe("offline");
  });
  it.each(Object.entries(homes))("accepts %s's public site", (platform, url) => {
    expect(isHomepageContext(platform as PlatformId, url)).toBe(true);
  });
  it.each([
    ["douyin", "https://creator.douyin.com/creator-micro/home"],
    ["xiaohongshu", "https://creator.xiaohongshu.com/new/home"],
    ["kuaishou", "https://cp.kuaishou.com/"],
    ["bilibili", "https://member.bilibili.com/"],
    ["weixin_channels", "https://channels.weixin.qq.com/"],
    ["baijiahao", "https://baijiahao.baidu.com/"],
    ["douyin", "https://www.douyin.com.evil.test/"],
    ["douyin", "https://evil.test/?next=https://www.douyin.com/"],
    ["douyin", "https://someone@www.douyin.com/"],
    ["douyin", "http://www.douyin.com/"],
    ["douyin", "https://www.douyin.com:8080/"],
    ["douyin", "https://www.douyin.com/verify/challenge"],
    ["xiaohongshu", "https://www.xiaohongshu.com/web-login/captcha"],
    ["bilibili", "https://www.bilibili.com/geetest"],
    ["douyin", "https://www.douyin.com/login/verify/challenge"],
    ["kuaishou", "https://www.kuaishou.com/login/CAPTCHA/challenge"],
    ["bilibili", "https://www.bilibili.com/login/geetest"],
  ])("excludes unsupported or non-homepage context: %s %s", (platform, url) => {
    expect(isHomepageContext(platform as PlatformId, url)).toBe(false);
    expect(read(platform as PlatformId, "<header><button>退出登录</button></header>", {}, { url }).kind).toBe(
      "unconfirmed",
    );
  });

  it.each(Object.entries(homes))("uses every shared verification path for %s", (platform, homepage) => {
    for (const path of getPlatform(platform as PlatformId).login.verificationPaths) {
      const url = new URL("/nested" + path, homepage).href;
      expect(isVerificationUrl(platform as PlatformId, url)).toBe(true);
      expect(isHomepageContext(platform as PlatformId, url)).toBe(false);
      expect(
        read(platform as PlatformId, "<header><button>退出登录</button></header>", {}, { url }).kind,
      ).toBe("unconfirmed");
    }
  });
});

describe("homepage current-account avatar extraction", () => {
  const kuaishouSidebar = (name = "当前账号", avatar = "https://p66.a.kwimgs.com/own.jpg") =>
    `<div class="workbench reco-view"><main><div class="wb-left"><div class="sidebar"><div class="down"><div class="down-box login"><div class="user item"><img class="image" src="${avatar}"><div class="text">${name}</div></div></div></div></div></div></main></div>`;
  const kuaishouSelf = {
    INIT_STATE: {
      "tusjoh.0sftu0w0qspgjmf0hfu-pckfdu.": {
        result: 1, userId: 123, userName: "当前账号", userHead: "https://p66.a.kwimgs.com/own.jpg",
      },
    },
  };
  it("recognizes the current Kuaishou sidebar account and its own avatar", () => {
    expect(read("kuaishou", kuaishouSidebar(), kuaishouSelf, { url: "https://www.kuaishou.com/new-reco" }))
      .toMatchObject({ kind: "online", avatarUrl: "https://p66.a.kwimgs.com/own.jpg" });
  });
  it.each([
    ["missing live account", ""],
    ["different account name", kuaishouSidebar("另一个账号")],
    ["different avatar", kuaishouSidebar("当前账号", "https://p66.a.kwimgs.com/other.jpg")],
    ["feed author", `<article>${kuaishouSidebar()}</article>`],
    ["hidden sidebar", `<div hidden>${kuaishouSidebar()}</div>`],
    ["signed-out sidebar", kuaishouSidebar().replace('down-box login', 'down-box')],
  ])("does not authenticate Kuaishou from stale self data: %s", (_name, body) => {
    expect(read("kuaishou", body, kuaishouSelf).kind).toBe("unconfirmed");
  });
  it("waits for Kuaishou hydration and a successful self response", () => {
    expect(read("kuaishou", kuaishouSidebar(), kuaishouSelf, { loading: true }).kind).toBe("unconfirmed");
    expect(read("kuaishou", kuaishouSidebar()).kind).toBe("unconfirmed");
    expect(read("kuaishou", kuaishouSidebar(), {
      INIT_STATE: { "tusjoh.0sftu0w0qspgjmf0hfu-pckfdu.": { ...kuaishouSelf.INIT_STATE["tusjoh.0sftu0w0qspgjmf0hfu-pckfdu."], result: 109 } },
    }).kind).toBe("unconfirmed");
  });
  it.each([
    [
      "douyin",
      '<header><div data-e2e="user-info"><a href="/user/own-id"><img src="/own.jpg"></a></div></header>',
    ],
    [
      "xiaohongshu",
      '<aside class="side-bar"><div class="user"><a href="/user/profile/own-id"><img src="/own.jpg"></a></div></aside>',
    ],
    [
      "kuaishou",
      '<header><div class="user-info"><a href="/profile/own-id"><img src="/own.jpg"></a></div></header>',
    ],
    [
      "bilibili",
      '<div class="bili-header"><div class="header-avatar-wrap"><a href="https://space.bilibili.com/1234"><img src="/own.jpg"></a></div></div>',
    ],
  ])("returns only the dedicated current-profile avatar for %s", (platform, account) => {
    const author =
      '<main><article><header><div class="user-info"><a href="/profile/other"><img src="/author.jpg"></a></div></header></article></main>';
    const result = read(platform as PlatformId, author + account);
    expect(result).toMatchObject({
      kind: "online",
      avatarUrl: new URL("/own.jpg", homes[platform as keyof typeof homes]).href,
    });
    expect(result).not.toHaveProperty("displayName");
    expect(result).not.toHaveProperty("externalId");
  });

  it("reads the displayed currentSrc while preserving the existing login verdict", () => {
    const body =
      '<header><div data-e2e="user-info"><a href="/user/own-id"><img src="/fallback.jpg"></a></div></header>';
    expect(read("douyin", body, {}, { currentSrc: "https://p3.douyinpic.com/own.webp" })).toMatchObject({
      kind: "online",
      avatarUrl: "https://p3.douyinpic.com/own.webp",
    });
  });

  it.each([
    [
      "xiaohongshu",
      {
        __INITIAL_STATE__: {
          user: {
            loggedIn: true,
            userInfo: { userId: "self", imageb: "https://sns-avatar-qc.xhscdn.com/own.jpg" },
          },
        },
      },
      "https://sns-avatar-qc.xhscdn.com/own.jpg",
    ],
    [
      "douyin",
      {
        __INITIAL_STATE__: {
          userStore: {
            isLogin: true,
            userInfo: { sec_uid: "self", avatar_thumb: { url_list: ["https://p3.douyinpic.com/own.jpg"] } },
          },
        },
      },
      "https://p3.douyinpic.com/own.jpg",
    ],
    [
      "kuaishou",
      {
        __NUXT__: {
          state: {
            user: {
              isLogin: true,
              userInfo: { userId: "self", headUrls: [{ url: "//tx2.a.yximgs.com/own.jpg" }] },
            },
          },
        },
      },
      "https://tx2.a.yximgs.com/own.jpg",
    ],
  ])("reads bounded current-account avatar fields for %s", (platform, state, avatarUrl) => {
    expect(read(platform as PlatformId, "", state as Record<string, unknown>)).toMatchObject({
      kind: "online",
      avatarUrl,
    });
  });

  it("prefers the rendered current avatar over an old initial-state avatar", () => {
    const body =
      '<aside class="side-bar"><div class="user"><a href="/user/profile/own-id"><img src="/current.jpg"></a></div></aside>';
    const state = {
      __INITIAL_STATE__: {
        user: {
          loggedIn: true,
          userInfo: { userId: "old-user", imageb: "https://sns-avatar-qc.xhscdn.com/old.jpg" },
        },
      },
    };
    expect(read("xiaohongshu", body, state).avatarUrl).toBe("https://www.xiaohongshu.com/current.jpg");
  });

  it("does not copy a sibling decoration next to the current-profile link", () => {
    const body =
      '<header><div data-e2e="user-info"><img src="/decoration.jpg"><a href="/user/own-id">我的</a></div></header>';
    const result = read("douyin", body);
    expect(result.kind).toBe("online");
    expect(result.avatarUrl).toBeUndefined();
  });

  it("does not infer an avatar from a generic logout control or recommendation data", () => {
    const body =
      '<header><img src="/logo.jpg"><button>退出登录</button></header><main><img src="/author.jpg"></main>';
    const state = {
      __INITIAL_STATE__: { userInfo: { id: "author", avatar: "https://www.douyin.com/author.jpg" } },
    };
    const result = read("douyin", body, state);
    expect(result.kind).toBe("online");
    expect(result.avatarUrl).toBeUndefined();
  });

  it.each([
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "file:///private.png",
    "blob:https://www.douyin.com/123",
    "http://p3.douyinpic.com/own.jpg",
    "https://user:password@p3.douyinpic.com/own.jpg",
    "https://p3.douyinpic.com:8443/own.jpg",
    "https://p3.douyinpic.com/default-avatar.png",
    "https://p3.douyinpic.com/noface.jpg",
  ])("omits an unsupported avatar source without changing online status: %s", (avatar) => {
    const result = read("douyin", "", {
      __INITIAL_STATE__: { userStore: { isLogin: true, userInfo: { sec_uid: "self", avatar } } },
    });
    expect(result.kind).toBe("online");
    expect(result.avatarUrl).toBeUndefined();
  });

  it("does not let an unreadable avatar field change the login verdict", () => {
    const userInfo = Object.defineProperty({ sec_uid: "self" }, "avatar_thumb", {
      get() {
        throw new Error("unavailable avatar");
      },
    });
    const result = read("douyin", "", { __INITIAL_STATE__: { userStore: { isLogin: true, userInfo } } });
    expect(result.kind).toBe("online");
    expect(result.avatarUrl).toBeUndefined();
  });

  it("omits avatar data on explicit logout, conflicting controls and verification pages", () => {
    const state = {
      __INITIAL_STATE__: {
        user: {
          loggedIn: true,
          userInfo: { userId: "old-user", imageb: "https://sns-avatar-qc.xhscdn.com/old.jpg" },
        },
      },
    };
    const login = '<aside class="side-bar"><button class="login-btn">登录</button></aside>';
    const account =
      '<aside class="side-bar"><div class="user"><a href="/user/profile/own-id"><img src="/current.jpg"></a></div></aside>';
    for (const result of [
      read("xiaohongshu", login, state),
      read("xiaohongshu", login + account, state),
      read("xiaohongshu", account, state, { url: "https://www.xiaohongshu.com/web-login/captcha" }),
    ]) {
      expect(result.kind).not.toBe("online");
      expect(result.avatarUrl).toBeUndefined();
    }
  });

  it("does not return stale logged-out or unidentified store avatars", () => {
    for (const user of [
      {
        loggedIn: false,
        userInfo: { userId: "old-user", avatar: "https://sns-avatar-qc.xhscdn.com/old.jpg" },
      },
      { loggedIn: true, userInfo: { avatar: "https://sns-avatar-qc.xhscdn.com/old.jpg" } },
    ]) {
      const result = read("xiaohongshu", "", { __INITIAL_STATE__: { user } });
      expect(result.kind).toBe("unconfirmed");
      expect(result.avatarUrl).toBeUndefined();
    }
  });

  it("waits for an unambiguous image and excludes hidden images", () => {
    const start = '<header><div data-e2e="user-info"><a href="/user/own-id">';
    const end = "</a></div></header>";
    const ambiguous = read("douyin", start + '<img src="/one.jpg"><img src="/two.jpg">' + end);
    expect(ambiguous.kind).toBe("online");
    expect(ambiguous.avatarUrl).toBeUndefined();
    expect(
      read("douyin", start + '<img hidden src="/old.jpg"><img src="/current.jpg">' + end).avatarUrl,
    ).toBe("https://www.douyin.com/current.jpg");
  });
});

describe("homepage current-account login detection", () => {
  it.each([
    [
      "douyin",
      '<header><div data-e2e="user-info"><a href="/user/own-sec-id"><img src="/own.jpg"></a></div></header>',
    ],
    [
      "xiaohongshu",
      '<aside class="side-bar"><div class="user side-bar-component"><a href="/user/profile/own-id"><img src="/own.jpg"></a></div></aside>',
    ],
    [
      "kuaishou",
      '<header><div class="user-info"><a href="/profile/own-id"><img src="/own.jpg"></a></div></header>',
    ],
    [
      "bilibili",
      '<div class="bili-header"><div class="header-avatar-wrap"><a href="https://space.bilibili.com/1234"><img src="/own.jpg"></a></div></div>',
    ],
  ])("confirms %s from its signed-in account avatar and self-profile link", (platform, body) => {
    expect(read(platform as PlatformId, body)).toMatchObject({ kind: "online", source: "homepage" });
  });

  it.each([
    [
      "xiaohongshu",
      {
        __INITIAL_STATE__: {
          user: { loggedIn: true, userInfo: { userId: "self", nickname: "Private", token: "secret" } },
        },
      },
    ],
    [
      "xiaohongshu",
      {
        __INITIAL_STATE__: {
          user: {
            loggedIn: { __v_isRef: true, value: true },
            userInfo: { __v_isRef: true, _value: { userId: "self" } },
          },
        },
      },
    ],
    ["douyin", { __INITIAL_STATE__: { userStore: { isLogin: true, userInfo: { sec_uid: "self" } } } }],
    ["kuaishou", { __NUXT__: { state: { user: { isLogin: true, userInfo: { userId: "self" } } } } }],
  ])("confirms %s's dedicated current-account store without returning private data", (platform, state) => {
    const result = read(platform as PlatformId, "", state as Record<string, unknown>);
    expect(result.kind).toBe("online");
    expect(Object.keys(result).sort()).toEqual(["kind", "reason", "source"]);
    expect(JSON.stringify(result)).not.toMatch(/Private|secret|self/);
  });

  it.each(Object.keys(homes))("accepts an explicit, visible account logout control on %s", (platform) => {
    expect(read(platform as PlatformId, "<header><button>退出登录</button></header>").kind).toBe("online");
  });

  it.each([
    ["douyin", '<header><button data-e2e="login-button">登录</button></header>'],
    ["xiaohongshu", '<aside class="side-bar"><button class="login-btn">登录</button></aside>'],
    ["kuaishou", '<header><button class="login-btn">登录 / 注册</button></header>'],
    ["bilibili", '<div class="bili-header"><div class="header-login-entry">登录</div></div>'],
  ])("recognizes %s's rendered signed-out entry, but not while loading", (platform, body) => {
    expect(read(platform as PlatformId, body).kind).toBe("offline");
    expect(read(platform as PlatformId, body, {}, { loading: true }).kind).toBe("unconfirmed");
  });

  it.each(Object.keys(homes))(
    "does not infer %s login from recommendations, public profiles or generic navigation",
    (platform) => {
      const body =
        '<nav><a href="/user/self">我的</a></nav><main><a href="/user/someone"><img src="/author.jpg">作者</a><button>退出登录</button></main>';
      const state = {
        unrelatedProfile: { isLogin: true, userInfo: { id: "stranger" } },
        __INITIAL_STATE__: { userInfo: { id: "stranger" }, feed: { author: { id: "stranger" } } },
      };
      expect(read(platform as PlatformId, body, state).kind).toBe("unconfirmed");
      expect(read(platform as PlatformId).kind).toBe("unconfirmed");
    },
  );

  it("requires a current-user identity alongside the login flag", () => {
    for (const user of [
      { loggedIn: true },
      { loggedIn: true, userInfo: { userId: "0" } },
      { loggedIn: "true", userInfo: { userId: "self" } },
    ])
      expect(read("xiaohongshu", "", { __INITIAL_STATE__: { user } }).kind).toBe("unconfirmed");
  });

  it("does not use a recommendation card's author header or profile popover", () => {
    expect(
      read(
        "douyin",
        '<article><header><div data-e2e="user-info"><a href="/user/stranger"><img src="/author.jpg"></a></div></header></article>',
      ).kind,
    ).toBe("unconfirmed");
    expect(
      read(
        "xiaohongshu",
        '<div class="user-menu"><a href="/user/profile/stranger"><img src="/author.jpg"></a></div>',
      ).kind,
    ).toBe("unconfirmed");
  });

  it.each(["main", "article"])("does not use a Kuaishou author header inside %s", (tag) => {
    const body =
      "<" +
      tag +
      '><header><div class="user-info"><a href="/profile/other"><img src="/other.jpg"></a></div><button>退出登录</button></header></' +
      tag +
      ">";
    expect(read("kuaishou", body).kind).toBe("unconfirmed");
  });

  it("does not mistake an unhydrated store default for logout", () => {
    expect(
      read("xiaohongshu", "", {
        __INITIAL_STATE__: { user: { loggedIn: false, userInfo: { userId: "cached" } } },
      }).kind,
    ).toBe("unconfirmed");
  });

  it("accepts logout when visible login controls contradict stale initial-state login", () => {
    const state = { __INITIAL_STATE__: { user: { loggedIn: true, userInfo: { userId: "previous-user" } } } };
    const body = '<aside class="side-bar"><button class="login-btn">登录</button></aside>';
    expect(read("xiaohongshu", body, state).kind).toBe("offline");
    expect(read("xiaohongshu", body, state, { loading: true }).kind).toBe("unconfirmed");
  });

  it("keeps simultaneous signed-in and signed-out controls unconfirmed", () => {
    const state = {
      __INITIAL_STATE__: { userStore: { isLogin: true, userInfo: { sec_uid: "previous-user" } } },
    };
    const login = '<header><button data-e2e="login-button">登录</button></header>';
    const account =
      '<header><div data-e2e="user-info"><a href="/user/own-id"><img src="/own.jpg"></a></div></header>';
    expect(read("douyin", login + account, state).kind).toBe("unconfirmed");
    expect(read("douyin", login + "<header><button>退出登录</button></header>", state).kind).toBe(
      "unconfirmed",
    );
  });

  it("ignores hidden account controls and generic or placeholder avatars", () => {
    expect(read("douyin", "<header hidden><button>退出登录</button></header>").kind).toBe("unconfirmed");
    expect(
      read("douyin", '<header><button style="display:none" data-e2e="login-button">登录</button></header>')
        .kind,
    ).toBe("unconfirmed");
    expect(
      read(
        "douyin",
        '<header><div data-e2e="user-info"><a href="/user/self"><img src="/own.jpg"></a></div></header>',
      ).kind,
    ).toBe("unconfirmed");
    expect(
      read(
        "bilibili",
        '<div class="bili-header"><div class="header-avatar-wrap"><a href="https://space.bilibili.com/1234"><img src="/noface.jpg"></a></div></div>',
      ).kind,
    ).toBe("unconfirmed");
  });

  it("ignores an unrelated global object's accessor rather than traversing window", () => {
    expect(
      read("xiaohongshu", "", {
        unrelated: Object.defineProperty({}, "userInfo", {
          get() {
            throw new Error("private");
          },
        }),
        __INITIAL_STATE__: { user: { loggedIn: true, userInfo: { userId: "self" } } },
      }).kind,
    ).toBe("online");
  });
});
