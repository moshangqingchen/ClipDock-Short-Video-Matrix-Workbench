// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.resetModules(); });
const draft = { title: "明天发布", description: "保留完整文案", tags: ["生活"], selected: ["asset-1"] };

it("restores a draft from browser storage after the module memory is discarded and isolates accounts/scopes", async () => {
  const first = await import("./publish-drafts");
  expect(first.savePublishDraft("domestic", "account-1", draft).error).toBeNull();
  vi.resetModules();
  const afterRestart = await import("./publish-drafts");
  expect(afterRestart.readPublishDraft("domestic", "account-1").draft).toEqual(draft);
  expect(afterRestart.readPublishDraft("global", "account-1").draft).toBeNull();
  expect(afterRestart.readPublishDraft("domestic", "account-2").draft).toBeNull();
});

it("reports quota failures and retains the edit in memory until saving succeeds", async () => {
  const drafts = await import("./publish-drafts");
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  expect(drafts.savePublishDraft("domestic", "quota", draft).error).toContain("自动保存失败");
  expect(drafts.readPublishDraft("domestic", "quota").draft).toEqual(draft);
  write.mockRestore();
  expect(drafts.savePublishDraft("domestic", "quota", draft).error).toBeNull();
  expect(JSON.parse(localStorage.getItem(drafts.draftStorageKey("domestic", "quota"))!).version).toBe(1);
});

it("keeps malformed or unsupported stored data intact instead of silently erasing it", async () => {
  const drafts = await import("./publish-drafts");
  const key = drafts.draftStorageKey("global", "broken");
  const original = '{"version":99,"draft":{}}';
  localStorage.setItem(key, original);
  expect(drafts.readPublishDraft("global", "broken")).toMatchObject({ draft: null, error: expect.stringContaining("读取失败") });
  expect(localStorage.getItem(key)).toBe(original);
});
