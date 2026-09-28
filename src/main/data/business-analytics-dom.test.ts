// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { analyticsPageScript, parseAnalyticsPage, type AnalyticsPageSample } from "./business-analytics-page";
const originalText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 20, height: 20 }] as unknown as DOMRectList);
  Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
});
afterEach(() => {
  document.body.innerHTML = ""; vi.restoreAllMocks();
  if (originalText) Object.defineProperty(HTMLElement.prototype, "innerText", originalText); else delete (HTMLElement.prototype as Partial<HTMLElement>).innerText;
});
const read = () => window.eval(analyticsPageScript("douyin")) as AnalyticsPageSample;
it("does not interpret publication dates elsewhere on the page as the analytics period", () => {
  document.body.innerHTML = '<p>2026-09-01</p><p>2026-09-07</p><div><span>完播率</span><strong>25%</strong></div>';
  const sample = read(); expect(sample.cards).toHaveLength(1); expect(sample.dates).toEqual([]);
  expect(parseAnalyticsPage({ id: "00000000-0000-4000-8000-000000000001", platformId: "douyin" }, sample).records).toEqual([]);
});
it("reads explicit date inputs and marks a single-work page", () => {
  document.body.innerHTML = '<input value="2026-09-01"><input value="2026-09-07"><h1>作品详情</h1><div><span>完播率</span><strong>25%</strong></div>';
  expect(read()).toMatchObject({ dates: ["2026-09-01", "2026-09-07"], workDetail: true, cards: [{ label: "完播率", text: "25%" }] });
});
it("recognizes a labelled statistics period while rejecting duplicate metric labels", () => {
  document.body.innerHTML = '<p>统计周期：2026-09-01 至 2026-09-07</p><div><span>完播率</span><b>25%</b></div><div><span>完播率</span><b>40%</b></div>';
  expect(read()).toMatchObject({ dates: ["2026-09-01", "2026-09-07"], cards: [] });
});
