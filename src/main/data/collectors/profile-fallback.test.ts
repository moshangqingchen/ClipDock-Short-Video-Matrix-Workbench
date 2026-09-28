// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccountWebContents, installBusinessNetwork } from "@main/network/business-access";
import { completeProfile, DEFAULT_LABELS, domScrapeNumbers, withIdentityProfile } from "./shared";

const cleanup: Array<() => void> = [];
beforeEach(() => {
  // JSDOM has no layout; provide geometry for visible nodes while production also
  // checks CSS, hidden/aria-hidden/inert and the browser's actual geometry.
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function page(html: string): WebContents {
  document.body.innerHTML = html;
  cleanup.push(installBusinessNetwork({ enforcement: "strict", check: () => ({ allowed: true, reason: "READY" }),
    acquire: () => ({ signal: new AbortController().signal, isCurrent: () => true, release: () => undefined }),
  }));
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => "https://creator.douyin.com/creator-micro/home",
    executeJavaScript: async (script: string) => window.eval(script),
  }) as unknown as WebContents;
  cleanup.push(bindAccountWebContents(wc, "synthetic-account"));
  return wc;
}
describe("safe cumulative page fallback", () => {
  it("reads visible unique cumulative metrics and inline values without network requests", async () => {
    const wc = page('<section><div><span>累计播放量</span><strong>1.2万</strong></div><div><span>总阅读量：4,567</span></div><div><span>累计收藏量</span><strong>0</strong></div></section>');
    // Two competing cumulative play/read totals are ambiguous and must not merge.
    expect(await domScrapeNumbers(wc, DEFAULT_LABELS)).toEqual({ favorites: 0 });
    document.body.innerHTML = '<section><div><span>累计播放量</span><strong>1.2万</strong></div><div><span>累计获赞：4,567</span></div><div><span>累计收藏量</span><strong>0</strong></div></section>';
    expect(await domScrapeNumbers(wc, DEFAULT_LABELS)).toEqual({ plays: 12000, likes: 4567, favorites: 0 });
  });

  it.each(["今日", "昨日", "近7天", "过去 30 天", "本月", "2026-09-01 至 2026-09-28"])("never treats %s metrics as cumulative", async period => {
    const wc = page(`<section><div>${period}</div><div><span>播放量</span><strong>321</strong></div><div><span>点赞量</span><strong>12</strong></div></section>`);
    expect(await domScrapeNumbers(wc, DEFAULT_LABELS)).toEqual({});
  });

  it("allows explicit totals beside a separate period panel but rejects contradictory local period labels", async () => {
    const wc = page('<section><div>近7天</div><div><span>播放量</span><strong>321</strong></div></section><section><div><span>累计播放量</span><strong>5万</strong></div></section><section><div><span>累计获赞</span><span>今日</span><strong>12</strong></div></section>');
    expect(await domScrapeNumbers(wc, DEFAULT_LABELS)).toEqual({ plays: 50000 });
  });

  it("ignores hidden duplicates, links and per-work table cells", async () => {
    const wc = page('<section><div><span>粉丝数</span><strong>42</strong></div></section><div hidden><span>粉丝数</span><strong>99</strong></div><div aria-hidden="true"><span>总播放量</span><strong>999</strong></div><a><span>累计获赞</span><strong>100</strong></a><table><tbody><tr><td>累计收藏</td><td>300</td></tr></tbody></table>');
    expect(await domScrapeNumbers(wc, DEFAULT_LABELS)).toEqual({ followers: 42 });
  });

  it("keeps missing, ambiguous and nonnumeric values absent", async () => {
    const wc = page('<section><div><span>播放量</span><strong>--</strong></div><div><span>点赞量</span><strong>10</strong><strong>20</strong></div><div><span>累计收藏量</span><strong>未知</strong></div></section>');
    expect(await domScrapeNumbers(wc, DEFAULT_LABELS)).toEqual({});
  });

  it("never borrows a neighboring card's value for a missing metric", async () => {
    const wc = page('<section><div><span>累计播放量</span><strong>--</strong></div><div><span>累计收藏量</span><strong>0</strong></div></section>');
    expect(await domScrapeNumbers(wc, DEFAULT_LABELS)).toEqual({ favorites: 0 });
  });
  it("refuses oversized pages instead of missing later duplicate labels", async () => {
    const wc = page('<div><span>累计播放量</span><strong>1</strong></div>' + '<i></i>'.repeat(20000) + '<div><span>累计播放量</span><strong>2</strong></div>');
    expect(await domScrapeNumbers(wc, DEFAULT_LABELS)).toEqual({});
  });
});

describe("verified profile fallback", () => {
  it("preserves official zero and fills only absent values with their source", () => {
    const identity = { followers: 99, following: 8, plays: 50, origins: { followers: "page", plays: "page" } } as const;
    const merged = withIdentityProfile({ followers: 0, plays: null, origins: { followers: "official", plays: "official" } }, identity);
    expect(merged).toMatchObject({ followers: 0, following: 8, plays: 50, origins: { followers: "official", plays: "page" } });
    const warnings: string[] = [];
    const completed = completeProfile(merged, { followers: 10, favorites: 0 }, warnings);
    expect(completed).toMatchObject({ followers: 0, favorites: 0, origins: { favorites: "page" } });
    expect(completed?.shares).toBeUndefined();
    expect(warnings).toEqual(["部分数据从页面读取"]);
    expect(identity.plays).toBe(50);
    expect(withIdentityProfile({ followers: 0 }, identity)?.origins?.followers).toBeUndefined();
  });

  it("does not invent an overview when neither source returned any metric", () => {
    const warnings: string[] = [];
    expect(completeProfile(withIdentityProfile(null, null), {}, warnings)).toBeNull();
    expect(warnings).toEqual(["无法读取账号概览"]);
  });
});
