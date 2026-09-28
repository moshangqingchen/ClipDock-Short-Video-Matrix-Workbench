import vm from "node:vm";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAccountWebContents, installBusinessNetwork } from "@main/network/business-access";
import { initialProgress } from "@shared/collect-jobs";
import { CN_PLATFORM_IDS, getPlatform, type CnPlatformId } from "@shared/platforms";
import type { Account } from "@shared/types";
import { createCollectorRegistry } from "./index";
import { recordWorksPage, type CollectorContext } from "./shared";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function setup(platform: CnPlatformId, payload: unknown) {
  cleanup.push(installBusinessNetwork({ enforcement: "strict", check: () => ({ allowed: true, reason: "READY" }),
    acquire: () => ({ signal: new AbortController().signal, isCurrent: () => true, release: () => undefined }),
  }));
  const fetch = vi.fn(async () => Response.json(payload));
  const realm = vm.createContext({ fetch, AbortController });
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => getPlatform(platform).routes.home,
    executeJavaScript: async (script: string) => vm.runInContext(script, realm),
  }) as unknown as WebContents;
  cleanup.push(bindAccountWebContents(wc, "00000000-0000-4000-8000-000000000001"));
  const ctx: CollectorContext = { account: { id: "00000000-0000-4000-8000-000000000001", platformId: platform } as Account,
    webContents: wc, skipProfile: true, progress: { ...initialProgress("history"), page: 7, cursor: "cursor 6" },
    observedWorksRequest: () => ({ url: getPlatform("weixin_channels").login.probe.url.replace("auth/auth_data", "post/post_list"), method: "POST",
      body: JSON.stringify({ currentPage: 1, rawKeyBuff: "synthetic-context" }) }),
  };
  return { fetch, ctx };
}
const payloads: Record<CnPlatformId, unknown> = {
  douyin: { aweme_list: [{ aweme_id: "one", statistics: { digg_count: 0 } }], has_more: 1, max_cursor: "next" },
  kuaishou: { data: { list: [{ photoId: "one", likeCount: 0 }], pcursor: "next" } },
  xiaohongshu: { data: { notes: [{ noteId: "one", likeCount: 0 }], hasMore: true } },
  bilibili: { code: 0, data: { arc_audits: [{ Archive: { bvid: "one" }, stat: { like: 0 } }] } },
  baijiahao: { data: { list: [{ article_id: "one", like_count: 0 }], hasMore: true } },
  weixin_channels: { data: { list: [{ objectId: "one", likeCount: 0 }], hasMore: true } },
};
describe("six-platform pagination and missing-field semantics", () => {
  it.each(CN_PLATFORM_IDS)("%s uses the saved page/cursor and does not manufacture zeros", async (platform) => {
    const { ctx, fetch } = setup(platform, payloads[platform]);
    const result = await createCollectorRegistry().get(platform)!.collect(ctx);
    expect(result.works).toHaveLength(1);
    expect(result.metrics).toMatchObject([{ metric: "likes", value: 0, workId: expect.any(String) }]);
    expect(result.metrics).toHaveLength(1);
    expect(result.works[0].observations?.plays).toBeUndefined();
    expect(result.page).toMatchObject({ hasMore: true, nextPage: 8 });
    const requests = JSON.stringify(fetch.mock.calls);
    expect(requests).toMatch(platform === "douyin" || platform === "kuaishou" ? /cursor(%20| )6/ : /(?:page|pn|currentPage)(?:=|\\":)7/);
    if (platform === "weixin_channels") expect(requests).toContain("synthetic-context");
  });
  it("does not fabricate a Channels security context", async () => {
    const { ctx, fetch } = setup("weixin_channels", payloads.weixin_channels);
    ctx.observedWorksRequest = () => null;
    const result = await createCollectorRegistry().get("weixin_channels")!.collect(ctx);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.page?.hasMore).toBeNull();
    expect(result.metrics).toEqual([]);
  });
  it("refuses a missing/repeated cursor and distinguishes a successful empty page", () => {
    const { ctx } = setup("douyin", {});
    recordWorksPage(ctx, { has_more: 1, max_cursor: "cursor 6" }, [{}], "cursor", ["max_cursor"]);
    expect(ctx.pageResult?.hasMore).toBeNull();
    recordWorksPage(ctx, { has_more: 0 }, [], "cursor", ["max_cursor"]);
    expect(ctx.pageResult?.hasMore).toBe(false);
    recordWorksPage(ctx, { has_more: 1 }, [], "page");
    expect(ctx.pageResult?.hasMore).toBeNull();
  });
  it("never treats an HTTP error body containing a list as successful data", async () => {
    const { ctx, fetch } = setup("douyin", {});
    fetch.mockImplementation(async () => Response.json(payloads.douyin, { status: 500 }));
    const result = await createCollectorRegistry().get("douyin")!.collect(ctx);
    expect(result.works).toEqual([]);
    expect(result.page).toMatchObject({ hasMore: null });
    expect(result.warnings).toEqual([result.page?.reason]);
  });
  it("does not mark an empty page complete before the declared total has been read", () => {
    const { ctx } = setup("bilibili", {});
    ctx.progress!.worksSeen = 30;
    recordWorksPage(ctx, { data: { total: 31 }, has_more: false }, [], "page");
    expect(ctx.pageResult).toMatchObject({ hasMore: null, receivedCount: 0, total: 31, nextPage: 7 });
    ctx.progress!.total = 31;
    recordWorksPage(ctx, {}, [], "page");
    expect(ctx.pageResult?.hasMore).toBeNull();
    ctx.progress!.worksSeen = 31;
    recordWorksPage(ctx, { data: { total: 31 } }, [], "page");
    expect(ctx.pageResult?.hasMore).toBe(false);
  });
});
