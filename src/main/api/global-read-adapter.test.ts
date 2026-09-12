import { describe, expect, it, vi } from "vitest";
import type { GlobalTokenEnvelope } from "./global-token-store";
import { GlobalReadAdapter } from "./global-read-adapter";
import {
  ProxyTransportError,
  type ProxyTransportRequest,
  type ProxyTransportResponse,
} from "./proxy-transport";

const now = Date.parse("2026-09-08T08:00:00Z");
function token(platformId: GlobalTokenEnvelope["platformId"] = "youtube"): GlobalTokenEnvelope {
  return {
    version: 1,
    accountId: "bdb9d72a-d2b4-4cff-96df-8fa695b78ed5",
    platformId,
    remoteId: platformId === "x" ? "12345" : platformId === "youtube" ? "UC_self" : "tt-self",
    tokenType: "Bearer",
    accessToken: "synthetic-access-token",
    expiresAt: new Date(now + 60_000).toISOString(),
    scopes:
      platformId === "youtube"
        ? ["https://www.googleapis.com/auth/youtube.readonly"]
        : platformId === "x"
          ? ["users.read", "tweet.read", "offline.access"]
          : ["user.info.basic"],
  };
}
function response(body: unknown, status = 200): ProxyTransportResponse {
  return { status, headers: {}, body: Buffer.from(JSON.stringify(body)) };
}
function youtubeChannel(extra: Record<string, unknown> = {}) {
  return {
    items: [
      {
        id: "UC_self",
        snippet: {
          title: "My channel",
          customUrl: "@self",
          thumbnails: { url: "https://secret-media.invalid/path?secret" },
        },
        statistics: { subscriberCount: "12000", videoCount: "3", viewCount: "9007199254740999" },
        contentDetails: { relatedPlaylists: { uploads: "UU_self" } },
        ...extra,
      },
    ],
  };
}
function youtubeList(ids = ["v1"]) {
  return {
    items: ids.map((videoId) => ({
      id: `playlist-${videoId}`,
      contentDetails: { videoId },
      snippet: { publishedAt: "2020-01-01T00:00:00Z" },
    })),
    nextPageToken: "private-cursor",
  };
}
function youtubeVideos(ids = ["v1"]) {
  return {
    items: ids.map((id) => ({
      id,
      snippet: { channelId: "UC_self", title: `Video ${id}`, publishedAt: "2026-01-02T03:04:05Z" },
      statistics: { viewCount: "0", likeCount: "2", commentCount: "3" },
    })),
  };
}
const tt = (data: unknown) => ({ data, error: { code: "ok", message: "", log_id: "private-provider-log" } });
const ttProfile = () =>
  tt({
    user: { open_id: "tt-self", display_name: "Tik creator", avatar_url: "https://media.invalid/signed" },
  });
const xProfile = (metrics: unknown = { followers_count: 12, following_count: 3, tweet_count: 5 }) => ({
  data: { id: "12345", name: "X creator", username: "creator", public_metrics: metrics },
});
const xList = () => ({
  data: [
    {
      id: "987",
      author_id: "12345",
      text: "Post",
      created_at: "2026-01-02T03:04:05Z",
      public_metrics: {
        impression_count: 100,
        like_count: 4,
        reply_count: 2,
        retweet_count: 3,
        quote_count: 2,
      },
    },
  ],
  meta: { result_count: 1, next_token: "private-next" },
});
function setup(replies: ProxyTransportResponse[]) {
  const request = vi.fn<(options: ProxyTransportRequest) => Promise<ProxyTransportResponse>>();
  for (const reply of replies) request.mockResolvedValueOnce(reply);
  const abort = new AbortController();
  const assertCurrent = vi.fn();
  const adapter = new GlobalReadAdapter({ transport: { request }, now: () => now });
  return {
    request,
    abort,
    assertCurrent,
    adapter,
    read: (value = token()) => adapter.read({ token: value, signal: abort.signal, assertCurrent }),
  };
}

describe("GlobalReadAdapter", () => {
  it("reads the owning YouTube channel, 20-entry uploads page and bounded video IDs; preserves large decimal counts", async () => {
    const f = setup([
      response(youtubeChannel()),
      response(youtubeList(["v1", "v2"])),
      response(youtubeVideos(["v2", "v1"])),
    ]);
    const data = await f.read();
    expect(data.totals).toEqual({
      followers: "12000",
      following: null,
      works: "3",
      views: "9007199254740999",
      likes: null,
    });
    expect(data.works.map((work) => work.id)).toEqual(["v1", "v2"]);
    expect(data.works[0]).toMatchObject({
      publishedAt: "2026-01-02T03:04:05.000Z",
      views: "0",
      reposts: null,
    });
    expect(data.hasMoreWorks).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(3);
    const calls = f.request.mock.calls.map(([input]) => input);
    expect(calls[0].url).toContain("mine=true");
    expect(calls[1].url).toContain("maxResults=20&playlistId=UU_self");
    expect(calls[2].url).toContain("id=v1,v2");
    expect(
      calls.every(
        (call) =>
          call.signal === f.abort.signal && call.headers?.Authorization === "Bearer synthetic-access-token",
      ),
    ).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/secret-media|private-cursor|synthetic-access-token|thumbnails/);
  });
  it("hidden and unknown YouTube counts remain null, not zero; empty uploads avoid videos request", async () => {
    const f = setup([
      response(
        youtubeChannel({
          statistics: {
            hiddenSubscriberCount: true,
            subscriberCount: "100",
            videoCount: "-1",
            viewCount: "1e10",
          },
        }),
      ),
      response({ items: [] }),
    ]);
    const data = await f.read();
    expect(data.totals).toEqual({ followers: null, following: null, works: null, views: null, likes: null });
    expect(data.hasMoreWorks).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("current TikTok basic scope makes exactly one permitted request and explicitly disables metrics/list", async () => {
    const f = setup([response(ttProfile())]);
    const data = await f.read(token("tiktok"));
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][0].url).toBe(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
    );
    expect(data.capabilities).toEqual({
      readProfile: "ready",
      readMetrics: "scope_required",
      listWorks: "scope_required",
    });
    expect(data.profile).toEqual({ displayName: "Tik creator", username: null });
    expect(data.hasMoreWorks).toBeNull();
    expect(JSON.stringify(data)).not.toContain("https:");
  });
  it("TikTok added, actually granted scopes select separate stats and JSON POST list, without cursor loops", async () => {
    const value = token("tiktok");
    value.scopes.push("user.info.profile", "user.info.stats", "video.list");
    const f = setup([
      response(tt({ user: { open_id: "tt-self", display_name: "Creator", username: "self" } })),
      response(
        tt({
          user: { open_id: "tt-self", follower_count: 5, following_count: 6, likes_count: 7, video_count: 8 },
        }),
      ),
      response(
        tt({
          videos: [
            {
              id: "tt-1",
              title: "Title",
              create_time: 1700000000,
              view_count: 123,
              like_count: 4,
              comment_count: 2,
              share_count: 1,
            },
          ],
          has_more: true,
          cursor: 1699000000000,
        }),
      ),
    ]);
    const data = await f.read(value);
    expect(data.totals).toEqual({ followers: "5", following: "6", works: "8", likes: "7", views: null });
    expect(data.works[0]).toMatchObject({
      views: "123",
      likes: "4",
      comments: "2",
      reposts: "1",
      publishedAt: "2023-11-14T22:13:20.000Z",
    });
    expect(data.hasMoreWorks).toBe(true);
    const last = f.request.mock.calls[2][0];
    expect(last).toMatchObject({
      method: "POST",
      body: '{"max_count":20}',
      headers: { "Content-Type": "application/json" },
    });
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(data)).not.toMatch(/cursor|log_id/);
  });
  it("TikTok stats denial leaves basic profile valid and still permits separately authorized video list", async () => {
    const value = token("tiktok");
    value.scopes.push("user.info.stats", "video.list");
    const f = setup([
      response(ttProfile()),
      response({ error: { code: "scope_not_authorized", message: "secret" } }, 403),
      response(tt({ videos: [], has_more: false })),
    ]);
    const data = await f.read(value);
    expect(data.capabilities).toEqual({ readProfile: "ready", readMetrics: "forbidden", listWorks: "ready" });
    expect(data.totals.followers).toBeNull();
  });
  it("unsafe int64 numeric values are unknown, while exact decimal strings survive", async () => {
    const value = token("tiktok");
    value.scopes.push("user.info.stats");
    const f = setup([
      response(ttProfile()),
      response(
        tt({
          user: {
            open_id: "tt-self",
            follower_count: 9007199254740992,
            following_count: 0,
            likes_count: "9007199254740999",
            video_count: 1.5,
          },
        }),
      ),
    ]);
    expect((await f.read(value)).totals).toEqual({
      followers: null,
      following: "0",
      works: null,
      likes: "9007199254740999",
      views: null,
    });
  });
  it("X uses authenticated ID for its timeline and does not confuse quoted counts with reposts", async () => {
    const f = setup([response(xProfile()), response(xList())]);
    const data = await f.read(token("x"));
    expect(data.totals).toEqual({ followers: "12", following: "3", works: "5", likes: null, views: null });
    expect(data.works[0]).toMatchObject({
      kind: "post",
      views: "100",
      reposts: "3",
      likes: "4",
      comments: "2",
    });
    expect(f.request.mock.calls[1][0].url).toContain("/users/12345/tweets?max_results=20");
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("handles documented X post-count aliases and rejects contradictory aliases as unknown", async () => {
    const list = xList();
    Object.assign(list.data[0].public_metrics, { repost_count: 9 });
    const f = setup([
      response(xProfile({ post_count: 50, followers_count: 1, following_count: 2 })),
      response(list),
    ]);
    const data = await f.read(token("x"));
    expect(data.totals.works).toBe("50");
    expect(data.works[0].reposts).toBeNull();
  });
  it("accepts an explicitly empty X timeline", async () => {
    const f = setup([response(xProfile()), response({ meta: { result_count: 0 } })]);
    expect((await f.read(token("x"))).hasMoreWorks).toBe(false);
  });
  it.each([403, 429])(
    "optional list HTTP %s produces only the corresponding capability state",
    async (status) => {
      const f = setup([response(youtubeChannel()), response({ private: "provider message" }, status)]);
      const data = await f.read();
      expect(data.capabilities.listWorks).toBe(status === 403 ? "forbidden" : "rate_limited");
      expect(data.works).toEqual([]);
      expect(data.hasMoreWorks).toBeNull();
    },
  );
  it.each([401, 403, 429])(
    "profile HTTP %s is a fixed fatal error, never successful empty data",
    async (status) => {
      const f = setup([response({ error: "provider token/path secret" }, status)]);
      const code =
        status === 401
          ? "GLOBAL_READ_REAUTHORIZE"
          : status === 403
            ? "GLOBAL_READ_FORBIDDEN"
            : "GLOBAL_READ_RATE_LIMITED";
      await expect(f.read()).rejects.toThrow(code);
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("401 in an optional segment invalidates the entire read instead of returning the earlier profile", async () => {
    const f = setup([response(xProfile()), response({}, 401)]);
    await expect(f.read(token("x"))).rejects.toThrow("GLOBAL_READ_REAUTHORIZE");
  });
  it("provider-level TikTok invalid-token errors cannot be masked by HTTP 200", async () => {
    const f = setup([
      response({ error: { code: "access_token_invalid", message: "sensitive", log_id: "secret" } }),
    ]);
    await expect(f.read(token("tiktok"))).rejects.toThrow("GLOBAL_READ_REAUTHORIZE");
  });
  it.each(["profile", "work"])("YouTube %s identity must match the authorized channel", async (stage) => {
    const channel = youtubeChannel();
    const videos = youtubeVideos();
    if (stage === "profile") channel.items[0].id = "UC_other";
    else videos.items[0].snippet.channelId = "UC_other";
    const f = setup([response(channel), response(youtubeList()), response(videos)]);
    await expect(f.read()).rejects.toThrow("GLOBAL_READ_IDENTITY_MISMATCH");
    expect(f.request).toHaveBeenCalledTimes(stage === "profile" ? 1 : 3);
  });
  it("TikTok stats cannot switch the authenticated open_id", async () => {
    const value = token("tiktok");
    value.scopes.push("user.info.stats");
    const f = setup([response(ttProfile()), response(tt({ user: { open_id: "other", follower_count: 1 } }))]);
    await expect(f.read(value)).rejects.toThrow("GLOBAL_READ_IDENTITY_MISMATCH");
  });
  it("X timeline rows require the exact authenticated author", async () => {
    const list = xList();
    list.data[0].author_id = "999";
    const f = setup([response(xProfile()), response(list)]);
    await expect(f.read(token("x"))).rejects.toThrow("GLOBAL_READ_IDENTITY_MISMATCH");
  });
  it("late transport responses after abort are discarded, with no later request", async () => {
    const f = setup([]);
    f.request.mockImplementationOnce(async () => {
      f.abort.abort();
      return response(youtubeChannel());
    });
    await expect(f.read()).rejects.toThrow("GLOBAL_READ_CANCELLED");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("assertCurrent revocation after the final await cannot publish old data", async () => {
    const f = setup([response(xProfile())]);
    let revoked = false;
    f.assertCurrent.mockImplementation(() => {
      if (revoked) throw new Error("GLOBAL_READ_WAITING_PROXY");
    });
    f.request.mockImplementationOnce(async () => {
      revoked = true;
      return response(xList());
    });
    await expect(f.read(token("x"))).rejects.toThrow("GLOBAL_READ_WAITING_PROXY");
  });
  it("network lease withdrawal and opaque transport errors are fatal even in optional reads", async () => {
    const f = setup([response(xProfile())]);
    f.request.mockRejectedValueOnce(new ProxyTransportError("LEASE_REVOKED"));
    // The queued profile succeeds, then the queued rejection reaches the list.
    await expect(f.read(token("x"))).rejects.toThrow("GLOBAL_READ_WAITING_PROXY");
  });
  it("copies token/identity/scopes before external callbacks can mutate the caller object", async () => {
    const value = token("tiktok");
    const f = setup([response(ttProfile())]);
    f.assertCurrent.mockImplementation(() => {
      value.accessToken = "changed";
      value.remoteId = "other";
      value.scopes.push("video.list");
    });
    const data = await f.read(value);
    expect(data.remoteId).toBe("tt-self");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][0].headers?.Authorization).toBe("Bearer synthetic-access-token");
  });
  it("missing scope, expired token and path-injection identity fail without any transport request", async () => {
    const f = setup([]);
    const value = token("x");
    value.scopes = [];
    await expect(f.read(value)).rejects.toThrow("GLOBAL_READ_UNAUTHORIZED");
    value.scopes = ["users.read", "tweet.read"];
    value.expiresAt = new Date(now).toISOString();
    await expect(f.read(value)).rejects.toThrow("GLOBAL_READ_REAUTHORIZE");
    value.remoteId = "../other";
    await expect(f.read(value)).rejects.toThrow("GLOBAL_READ_INPUT_INVALID");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("oversized pages and duplicate identities reject rather than silently exceed the 20-work budget", async () => {
    const f = setup([
      response(youtubeChannel()),
      response(youtubeList(Array.from({ length: 21 }, (_, i) => `v${i}`))),
    ]);
    await expect(f.read()).rejects.toThrow("GLOBAL_READ_RESPONSE_INVALID");
    const g = setup([response(youtubeChannel()), response(youtubeList(["v1", "v1"]))]);
    await expect(g.read()).rejects.toThrow("GLOBAL_READ_RESPONSE_INVALID");
  });
  it("X partial errors and non-JSON responses cannot become successful snapshots or leak provider details", async () => {
    const f = setup([
      response(xProfile()),
      response({ ...xList(), errors: [{ detail: "token secret", resource_id: "other" }] }),
    ]);
    await expect(f.read(token("x"))).rejects.toThrow("GLOBAL_READ_RESPONSE_INVALID");
    const g = setup([{ status: 200, headers: {}, body: Buffer.from("<html>provider secret</html>") }]);
    await expect(g.read()).rejects.toThrow(/^GLOBAL_READ_RESPONSE_INVALID$/);
  });
  it("TikTok documented scope error HTTP 401 remains a reauthorization result even in optional stats", async () => {
    const value = token("tiktok");
    value.scopes.push("user.info.stats");
    const f = setup([
      response(ttProfile()),
      response({ error: { code: "scope_not_authorized", message: "private detail" } }, 401),
    ]);
    await expect(f.read(value)).rejects.toThrow("GLOBAL_READ_REAUTHORIZE");
  });
  it("an unrecognized pagination shape cannot falsely declare the timeline complete", async () => {
    const f = setup([
      response(xProfile()),
      response({ ...xList(), meta: { result_count: 1, next_token: 7 } }),
    ]);
    await expect(f.read(token("x"))).rejects.toThrow("GLOBAL_READ_RESPONSE_INVALID");
  });
});
