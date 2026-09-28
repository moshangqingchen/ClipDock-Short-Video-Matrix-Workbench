import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewPool } from "./view-pool";
import type { AccountService } from "@main/services/account-service";
import { openOfficialMessages } from "./open-messages";
import { CN_PLATFORM_IDS, type PlatformId } from "@shared/platforms";
import { messageEntry } from "@shared/messages";
import { decideTopLevelNavigation } from "./navigation-policy";
import { evaluateWithLease } from "@main/network/page-evaluation";

vi.mock("electron", () => ({ shell: {} }));
vi.mock("@main/network/page-evaluation", () => ({ evaluateWithLease: vi.fn() }));
vi.mock("@main/network/business-access", () => ({
  beginBusinessOperation: () => ({ assertCurrent() {}, release() {} }),
  isNetworkDormantError: () => false,
}));

function fixture(platformId: PlatformId = "bilibili") {
  const page = { visible: true, messageMode: false, navigationId: 1, url: "https://www.bilibili.com/", lastError: null };
  const wc = { getURL: () => page.url, isDestroyed: () => false, isLoading: () => false };
  const pool = {
    getState: vi.fn(() => page), ensure: vi.fn(), getWebContents: vi.fn(() => wc),
    setMessageMode: vi.fn((_id, enabled) => { page.messageMode = enabled; }),
    navigate: vi.fn(async (_id, url) => { page.url = url; }),
  };
  const accounts = { get: vi.fn(() => ({ id: "owner", platformId })), prepareNetworkOperation: vi.fn() };
  return { page, pool, accounts, open: () => openOfficialMessages("owner", pool as unknown as ViewPool, accounts as unknown as AccountService) };
}

describe("account-scoped official inbox", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(CN_PLATFORM_IDS)("uses an allowed official HTTPS entry for %s", platformId => {
    const entry = messageEntry(platformId);
    expect(decideTopLevelNavigation(platformId, entry.url)).toEqual({ action: "allow", url: entry.url });
    expect(entry.url).not.toMatch(/token|cookie|accountId/);
  });
  it("protects the owner before navigation and never uses another account", async () => {
    const f = fixture();
    const result = await f.open();
    expect(result.opened).toBe(true);
    expect(f.accounts.prepareNetworkOperation).toHaveBeenCalledWith("owner", "view-navigate", "https://message.bilibili.com/#/whisper");
    expect(f.pool.ensure).toHaveBeenCalledWith({ id: "owner", platformId: "bilibili" }, { navigate: false });
    expect(f.pool.setMessageMode).toHaveBeenCalledWith("owner", true);
    expect(f.pool.setMessageMode.mock.invocationCallOrder[0]).toBeLessThan(f.pool.navigate.mock.invocationCallOrder[0]);
  });
  it("restores an existing conversation without reloading or losing its draft", async () => {
    const f = fixture();
    f.page.messageMode = true;
    await f.open();
    expect(f.pool.navigate).not.toHaveBeenCalled();
    expect(f.pool.ensure).not.toHaveBeenCalled();
  });
  it("refuses to open a hidden account or expand its network scope", async () => {
    const f = fixture(); f.page.visible = false;
    await expect(f.open()).rejects.toThrow("请先打开这个账号");
    expect(f.accounts.prepareNetworkOperation).not.toHaveBeenCalled();
  });
  it("stops when the user switches accounts during navigation", async () => {
    const f = fixture();
    f.pool.navigate.mockImplementation(async () => { f.page.visible = false; });
    expect((await f.open()).opened).toBe(false);
  });
  it("does not expose page errors or private URLs", async () => {
    const f = fixture();
    f.pool.navigate.mockRejectedValue(new Error("https://private.example/?token=secret"));
    await expect(f.open()).rejects.toThrow(/^消息页面暂未打开/);
  });
  it("retries an unavailable homepage entry without reloading, and preserves it once opened", async () => {
    const f = fixture("douyin");
    f.page.url = "https://www.douyin.com/jingxuan";
    vi.mocked(evaluateWithLease).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await f.open()).opened).toBe(false);
    expect((await f.open()).opened).toBe(true);
    expect((await f.open()).opened).toBe(true);
    expect(evaluateWithLease).toHaveBeenCalledTimes(2);
    expect(f.pool.navigate).not.toHaveBeenCalled();
  });
  it("opens the header again after the user reloads the same homepage URL", async () => {
    const f = fixture("douyin"); f.page.url = "https://www.douyin.com/jingxuan";
    vi.mocked(evaluateWithLease).mockResolvedValue(true);
    await f.open();
    f.page.navigationId++;
    await f.open();
    expect(evaluateWithLease).toHaveBeenCalledTimes(2);
    expect(f.pool.navigate).not.toHaveBeenCalled();
  });
  it("does not report a late header activation as success after leaving the account", async () => {
    const f = fixture("douyin"); f.page.url = "https://www.douyin.com/";
    vi.mocked(evaluateWithLease).mockImplementation(async () => { f.page.visible = false; return true; });
    expect((await f.open()).opened).toBe(false);
  });
  it("does not cache an old document's result after a reload completes during evaluation", async () => {
    const f = fixture("douyin"); f.page.url = "https://www.douyin.com/";
    vi.mocked(evaluateWithLease).mockImplementationOnce(async () => { f.page.navigationId++; return true; })
      .mockResolvedValueOnce(true);
    expect((await f.open()).opened).toBe(false);
    expect((await f.open()).opened).toBe(true);
    expect(evaluateWithLease).toHaveBeenCalledTimes(2);
  });
});
