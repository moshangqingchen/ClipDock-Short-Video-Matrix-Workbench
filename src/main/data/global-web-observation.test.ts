import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { GLOBAL_PAGE_TEXT_SCRIPT, observationPage, parseWebObservation } from "./global-web-observation";
const id = "8e65b156-a2ee-48ac-957e-2f990141c207";
const youtube = "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv/analytics/tab-overview";
describe("webpage observations", () => {
  it("reads displayed YouTube units and zero without turning missing data or deltas into totals", () => {
    const snapshot = parseWebObservation(id, "youtube", "chrome", {
      url: youtube + "?token=private",
      text: "Last 28 days\nCurrent subscribers\n1,234\nViews\n2.8K\nWatch time (hours)\n0\nImpressions\n+12%",
    });
    expect(snapshot.metrics).toEqual([
      { key: "views", label: "Views", value: "2.8K" },
      { key: "followers", label: "Current subscribers", value: "1,234" },
      { key: "watchHours", label: "Watch time (hours)", value: "0" },
    ]);
    expect(snapshot.page).toBe(youtube);
    expect(snapshot.period).toBe("Last 28 days");
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });
  it("adapts TikTok and X Chinese and English labels without combining conflicting periods", () => {
    const tiktok = parseWebObservation(id, "tiktok", "embedded", {
      url: "https://www.tiktok.com/tiktokstudio/analytics",
      text: "近30天\n粉丝数：1.2万\nVideo views\n500\nLikes\n0\nComments\n20",
    });
    expect(tiktok.metrics.map((m) => m.value)).toEqual(["500", "1.2万", "0", "20"]);
    const x = parseWebObservation(id, "x", "chrome", {
      url: "https://x.com/i/account_analytics",
      text: "Last 7 days\nLast 28 days\nImpressions\n15K\nEngagements: 0\nLikes\n10\nLikes\n20",
    });
    expect(x.period).toBeNull();
    expect(x.metrics).toEqual([
      { key: "impressions", label: "Impressions", value: "15K" },
      { key: "engagements", label: "Engagements", value: "0" },
    ]);
  });
  it("rejects unrelated sites, login, public feeds, personal profiles and individual video pages", () => {
    for (const url of [
      "https://accounts.google.com/",
      "https://studio.youtube.com.evil.test/channel/UCabcdefghijklmnopqrstuv/analytics",
      "http://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv",
      "https://www.youtube.com/watch?v=abc",
      "https://user:pass@studio.youtube.com/channel/UCabcdefghijklmnopqrstuv",
      "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos",
    ])
      expect(observationPage("youtube", url)).toBeNull();
    expect(observationPage("x", "https://x.com/somebody")).toBeNull();
    expect(observationPage("tiktok", "https://www.tiktok.com/login")).toBeNull();
  });
  it("reports empty data without requiring API authorization or fabricating totals", () => {
    expect(
      parseWebObservation(id, "youtube", "embedded", {
        url: youtube,
        text: "Views\n—\nSubscribers\n+32\nLikes\n12%",
      }).metrics,
    ).toEqual([]);
  });
  it("extracts only rendered noneditable text including shadow DOM", () => {
    const dom = new JSDOM(
      '<body><div>Views</div><b>124</b><div hidden>Views 999</div><input value="private-password"><textarea>private-message</textarea><div contenteditable>private-draft</div><div id="shadow"></div></body>',
      { url: youtube, runScripts: "outside-only" },
    );
    dom.window.document.querySelector("#shadow")!.attachShadow({ mode: "open" }).innerHTML =
      "<span>Current subscribers</span><b>12</b>";
    const raw = dom.window.eval(GLOBAL_PAGE_TEXT_SCRIPT);
    expect(raw.text).not.toContain("private");
    expect(raw.text).not.toContain("999");
    expect(parseWebObservation(id, "youtube", "embedded", raw).metrics.map((m) => m.value)).toEqual([
      "124",
      "12",
    ]);
    dom.window.close();
  });
});
