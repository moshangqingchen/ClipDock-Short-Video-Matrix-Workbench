// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { globalPageScript, type GlobalPageRead } from "./global-web-page";
function read(platform: "youtube" | "tiktok" | "x", url: string, body: string): GlobalPageRead {
  const dom = new JSDOM(body, { url, runScripts: "outside-only" });
  try {
    return dom.window.eval(globalPageScript(platform));
  } finally {
    dom.window.close();
  }
}
describe("official webpage adapters", () => {
  it("never treats an open public page or someone else's profile as login", () => {
    expect(read("x", "https://x.com/stranger", '<a href="/stranger">Profile</a>').identity.status).toBe(
      "unknown",
    );
    expect(
      read("youtube", "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", "<h1>Public channel</h1>")
        .identity.status,
    ).toBe("unknown");
  });
  it("uses the official X account link and separates post impressions from video views", () => {
    const value = read(
      "x",
      "https://x.com/home",
      '<a data-testid="AppTabBar_Profile_Link" href="/owner"></a><button data-testid="SideNav_AccountSwitcher_Button">Owner</button><article data-testid="tweet"><a href="/owner/status/123">Post</a><span data-testid="tweetText">Hello</span><span data-testid="analytics">120</span><span data-testid="like">0</span></article><article data-testid="tweet"><a href="/someone/status/456">Other</a></article>',
    );
    expect(value.identity).toMatchObject({ status: "online", subjectId: "owner" });
    expect(value.works).toHaveLength(1);
    expect(value.works[0].metrics).toEqual({ impressions: "120", likes: "0" });
  });
  it("keeps YouTube Studio channel identities explicit", () => {
    const value = read(
      "youtube",
      "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos",
      '<ytcp-app><span id="entity-name">Channel A</span><ytcp-video-row><a href="/video/abcdefghijk/edit"><span id="video-title">My video</span></a><span class="tablecell-views">0</span></ytcp-video-row></ytcp-app>',
    );
    expect(value.identity.subjectId).toBe("UCabcdefghijklmnopqrstuv");
    expect(value.works[0]).toMatchObject({
      remoteId: "abcdefghijk",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      metrics: { views: "0" },
    });
  });
  it("reads TikTok's own profile link and never reads editable draft contents", () => {
    const value = read(
      "tiktok",
      "https://www.tiktok.com/tiktokstudio/content",
      '<a data-e2e="nav-profile" href="/@owner"></a><tr data-e2e="post-item"><td><a href="/@owner/video/123">Post</a><span data-e2e="video-views">2K</span></td></tr><textarea>secret draft</textarea>',
    );
    expect(value.identity.subjectId).toBe("owner");
    expect(JSON.stringify(value)).not.toContain("secret draft");
  });
  it.each(["https://x.com/i/flow/login", "https://accounts.google.com/signin"])(
    "recognizes official login: %s",
    (url) => expect(read("x", url, '<input value="private">').identity.status).toBe("offline"),
  );
});
