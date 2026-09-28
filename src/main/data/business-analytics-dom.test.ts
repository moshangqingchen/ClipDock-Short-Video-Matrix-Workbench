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
it("reads a bounded nested card and slash/Chinese date inputs", () => {
  document.body.innerHTML = '<input value="2026/9/1"><input value="2026年9月7日"><section><div><span>平均观看时长</span></div><div><strong>30 秒</strong></div></section>';
  expect(read()).toMatchObject({ dates: ["2026-09-01", "2026-09-07"], cards: [{ label: "平均观看时长", text: "30 秒" }] });
});
it("never chooses a hidden metric or another card's value", () => {
  document.body.innerHTML = '<input value="2026-09-01"><div hidden><span>完播率</span><b>99%</b></div><section><div><span>完播率</span></div><div><span>平均观看时长</span><b>30 秒</b></div></section>';
  expect(read().cards.some((card) => card.label === "完播率")).toBe(false);
});
it("does not turn a comparison percentage into a completion rate", () => {
  document.body.innerHTML = '<input value="2026-09-01"><div><span>完播率</span><div>环比 <b>25%</b></div></div>';
  expect(read().cards).toEqual([]);
});
it("does not combine tables from different distributions in a shared section", () => {
  document.body.innerHTML = '<input value="2026-09-01"><section><h3>粉丝性别</h3><table><tr><td>男</td><td>60%</td></tr><tr><td>女</td><td>40%</td></tr></table><h3>粉丝年龄</h3><table><tr><td>18-24</td><td>70%</td></tr><tr><td>25-34</td><td>30%</td></tr></table></section>';
  expect(read().groups).toEqual([]);
});
it("reads distinct labelled regions without merging their count or ratio units", () => {
  document.body.innerHTML = '<input value="2026-09-01"><section><h3>粉丝性别</h3><table><tr><td>男</td><td>60%</td></tr></table></section><section><h3>粉丝年龄</h3><table><tr><td>18-24</td><td>70 人</td></tr></table></section>';
  expect(read().groups).toMatchObject([{ dimension: "粉丝性别", entries: [{ label: "男", text: "60%" }] }, { dimension: "粉丝年龄", entries: [{ label: "18-24", text: "70 人" }] }]);
});
