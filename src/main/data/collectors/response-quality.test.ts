import vm from "node:vm";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAccountWebContents, installBusinessNetwork } from "@main/network/business-access";
import { initialProgress } from "@shared/collect-jobs";
import { CN_PLATFORM_IDS, getPlatform, type CnPlatformId } from "@shared/platforms";
import type { Account } from "@shared/types";
import { createCollectorRegistry } from "./index";
import { businessResponseAllowsData, firstJson, setCollectorDiagnosticSink, type CollectorContext, type CollectorDiagnostic } from "./shared";

const cleanup: Array<() => void> = [];
afterEach(() => { setCollectorDiagnosticSink(undefined); for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function setup(platform: CnPlatformId, payload: unknown) {
  cleanup.push(installBusinessNetwork({ enforcement: "strict", check: () => ({ allowed: true, reason: "READY" }),
    acquire: () => ({ signal: new AbortController().signal, isCurrent: () => true, release: () => undefined }),
  }));
  const fetch = vi.fn(async () => Response.json(payload));
  const realm = vm.createContext({ fetch, AbortController });
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => getPlatform(platform).routes.home,
    executeJavaScript: async (script: string) => vm.runInContext(script, realm),
  }) as unknown as WebContents;
  cleanup.push(bindAccountWebContents(wc, "synthetic-account"));
  const ctx: CollectorContext = { account: { id: "synthetic-account", platformId: platform } as Account,
    webContents: wc, skipProfile: true, progress: initialProgress("history"),
    observedWorksRequest: () => ({ url: getPlatform("weixin_channels").login.probe.url.replace("auth/auth_data", "post/post_list"), method: "POST",
      body: JSON.stringify({ currentPage: 1, rawKeyBuff: "synthetic-context" }) }),
  };
  return { fetch, ctx, wc };
}
const failures: Record<CnPlatformId, unknown> = {
  douyin: { status_code: 8, aweme_list: [] },
  kuaishou: { result: 8, data: { list: [] } },
  xiaohongshu: { code: -100, success: false, data: { notes: [] } },
  bilibili: { code: -400, data: { arc_audits: [], page: { count: 0 } } },
  baijiahao: { errno: 8, data: { list: [] } },
  weixin_channels: { errCode: 8, data: { list: [] } },
};

describe("business response quality", () => {
  it.each(CN_PLATFORM_IDS)("%s rejects explicit business errors even with a valid list", async (platform) => {
    const { ctx } = setup(platform, failures[platform]);
    const diagnostics: CollectorDiagnostic[] = [];
    setCollectorDiagnosticSink(entry => diagnostics.push(entry));
    const result = await createCollectorRegistry().get(platform)!.collect(ctx);
    expect(result.works).toEqual([]);
    expect(result.metrics).toEqual([]);
    expect(result.page?.hasMore).toBeNull();
    expect(result.warnings).toEqual([result.page?.reason]);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]).toMatchObject({ code: "SCHEMA_MISMATCH", status: 200, businessCode: platform === "xiaohongshu" ? -100 : platform === "bilibili" ? -400 : 8 });
    expect(diagnostics[0].endpoint).not.toContain("?");
  });

  it.each([{ page: { count: 0 } }, { total: 0 }, { page: { count: "0" }, total: 0 }])("Bilibili accepts explicit successful empty totals %j", async totals => {
    const { ctx, fetch } = setup("bilibili", { code: 0, data: { arc_audits: null, ...totals } });
    const result = await createCollectorRegistry().get("bilibili")!.collect(ctx);
    expect(result.works).toEqual([]);
    expect(result.metrics).toEqual([]);
    expect(result.page).toMatchObject({ hasMore: false, receivedCount: 0, total: 0 });
    expect(result.warnings).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { code: 0, data: { arc_audits: null } },
    { code: 0, data: { arc_audits: null, page: { count: 1 } } },
    { code: 0, data: { arc_audits: null, page: { count: 0 }, total: 1 } },
    { code: 0, data: { arc_audits: null, page: { count: 0 }, total_count: 1 } },
    { code: 0, data: { arc_audits: null, total: null } },
    { code: 0, data: { arc_audits: null, total: false } },
    { code: -101, data: { arc_audits: null, total: 0 } },
    { code: 0, data: { page: { count: 0 } } },
  ])("Bilibili does not convert an unproven response to zero: %j", async payload => {
    const { ctx } = setup("bilibili", payload);
    const result = await createCollectorRegistry().get("bilibili")!.collect(ctx);
    expect(result.metrics).toEqual([]);
    expect(result.page?.hasMore).toBeNull();
    expect(result.warnings).toEqual([result.page?.reason]);
  });

  it("omits malformed items while preserving the received count for completeness validation", async () => {
    const { ctx } = setup("bilibili", { code: 0, data: { arc_audits: [null, false, "invalid", [], { Archive: { bvid: "one" }, stat: { like: 0 } }] } });
    const result = await createCollectorRegistry().get("bilibili")!.collect(ctx);
    expect(result.works).toHaveLength(1);
    expect(result.page?.receivedCount).toBe(5);
    expect(result.metrics).toMatchObject([{ metric: "likes", value: 0 }]);
    expect(result.metrics).toHaveLength(1);
  });

  it("retains known success conventions without treating arbitrary result objects as codes", () => {
    expect(businessResponseAllowsData({ result: 1, data: {} }, "kuaishou")).toBe(true);
    expect(businessResponseAllowsData({ status_code: "0", result: {} }, "douyin")).toBe(true);
    expect(businessResponseAllowsData({ status_code: 0, base_resp: { ret: 3 } }, "douyin")).toBe(false);
    expect(businessResponseAllowsData({ success: false }, "baijiahao")).toBe(false);
    expect(businessResponseAllowsData({ code: "some secret" }, "bilibili")).toBe(false);
  });

  it("logs only fixed shape types, a bounded numeric code and an allowlisted endpoint without query", async () => {
    const { wc } = setup("bilibili", { code: -400, message: "private-server-message", token: "private-token", data: { arc_audits: null, page: { count: 0 } } });
    const diagnostics: CollectorDiagnostic[] = [];
    setCollectorDiagnosticSink(entry => diagnostics.push(entry));
    await firstJson(wc, [{ url: "https://member.bilibili.com/x/web/archives?token=private-query" }], () => false);
    expect(diagnostics[0]).toMatchObject({ endpoint: "https://member.bilibili.com/x/web/archives", businessCode: -400, businessCodeField: "code",
      fieldTypes: { "data.arc_audits": "null", "data.page.count": "number" } });
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-|message|token/);
  });

  it("omits unrecognized paths and unsafe code strings", async () => {
    const { wc } = setup("douyin", { code: "private-code", data: { "private-key": "private-value" } });
    const diagnostics: CollectorDiagnostic[] = [];
    setCollectorDiagnosticSink(entry => diagnostics.push(entry));
    await firstJson(wc, [{ url: "https://creator.douyin.com/private-path?private-query" }], () => false);
    expect(diagnostics[0].endpoint).toBeUndefined();
    expect(diagnostics[0].businessCode).toBeUndefined();
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });
});
