import { describe, expect, it, vi } from "vitest";
import {
  YOUTUBE_MAX_BYTES,
  YOUTUBE_UPLOAD_CHUNK_BYTES,
  YOUTUBE_UPLOAD_SCOPE,
  youtubeUploadMetadataSchema,
  type YouTubeUploadMetadata,
} from "@shared/youtube-upload";
import { YouTubeUploadAdapter, youtubeUploadPlan, type YouTubeUploadContext } from "./youtube-upload-adapter";
import {
  issueYouTubeUploadTarget,
  assertYouTubeUploadTarget,
  validYouTubeUploadUrl,
} from "./youtube-upload-target";
import type { ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";

const url =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=synthetic-session&part=snippet%2Cstatus";
const metadata: YouTubeUploadMetadata = {
  title: "明确选择的视频",
  description: "测试描述",
  categoryId: "22",
  privacy: "private",
  madeForKids: false,
  containsSyntheticMedia: false,
  notifySubscribers: false,
};
const receipt = (privacy = "private", uploadStatus = "uploaded") => ({
  id: "abcdefghijk",
  snippet: { channelId: "synthetic-channel" },
  status: { privacyStatus: privacy, uploadStatus },
});
const response = (
  status: number,
  data?: object,
  headers: ProxyTransportResponse["headers"] = {},
): ProxyTransportResponse => ({ status, headers, body: Buffer.from(data ? JSON.stringify(data) : "") });
function fixture() {
  const controller = new AbortController();
  const ctx: YouTubeUploadContext = {
    signal: controller.signal,
    assertCurrent: vi.fn(),
    token: {
      version: 1,
      platformId: "youtube",
      accountId: "11111111-1111-4111-8111-111111111111",
      remoteId: "synthetic-channel",
      accessToken: "synthetic-private-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: [YOUTUBE_UPLOAD_SCOPE],
    },
  };
  const request = vi.fn<(input: ProxyTransportRequest) => Promise<ProxyTransportResponse>>(async () =>
    response(200, undefined, { location: url }),
  );
  const session = {
    uploadUrl: url,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    videoId: null,
  };
  return { ctx, controller, request, session, adapter: new YouTubeUploadAdapter({ request }) };
}
describe("YouTube resumable upload contract", () => {
  it.each([429, 500, 503])("honors Retry-After on an HTTP %s response", async (status) => {
    const f = fixture();
    f.request.mockResolvedValue(response(status, undefined, { "retry-after": "300" }));
    await expect(f.adapter.query(f.ctx, f.session, 100)).rejects.toMatchObject({
      code: status === 429 ? "GLOBAL_UPLOAD_RATE_LIMITED" : "GLOBAL_UPLOAD_UNAVAILABLE",
      retryAfterMs: 300_000,
    });
  });
  it("does not report disappeared processing information as a confirmed video failure", async () => {
    const f = fixture();
    f.request.mockResolvedValue(
      response(200, { items: [{ ...receipt(), processingDetails: { processingStatus: "terminated" } }] }),
    );
    await expect(f.adapter.status(f.ctx, "abcdefghijk")).rejects.toMatchObject({
      code: "GLOBAL_UPLOAD_UNCERTAIN",
    });
  });
  it("keeps a contradictory processing response pending instead of claiming publication", async () => {
    const f = fixture();
    f.request.mockResolvedValue(
      response(200, {
        items: [{ ...receipt("public", "processed"), processingDetails: { processingStatus: "processing" } }],
      }),
    );
    expect(await f.adapter.status(f.ctx, "abcdefghijk")).toMatchObject({ state: "processing" });
  });
  it.each([1, 256 * 1024, YOUTUBE_UPLOAD_CHUNK_BYTES, YOUTUBE_UPLOAD_CHUNK_BYTES + 1, YOUTUBE_MAX_BYTES])(
    "plans %s bytes in constant aligned chunks with a bounded final remainder",
    (size) => {
      const plan = youtubeUploadPlan(size);
      let next = 0;
      for (const part of plan.parts) {
        expect(part.start).toBe(next);
        expect(part.end - part.start + 1).toBeLessThanOrEqual(YOUTUBE_UPLOAD_CHUNK_BYTES);
        next = part.end + 1;
      }
      expect(next).toBe(size);
      expect(plan.chunkSize % (256 * 1024)).toBe(0);
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, YOUTUBE_MAX_BYTES + 1])("refuses invalid size %s", (size) =>
    expect(() => youtubeUploadPlan(size)).toThrow("GLOBAL_UPLOAD_FILE_UNSUPPORTED"),
  );
  it("starts with explicit metadata and preserves the returned session URL only in main-process data", async () => {
    const f = fixture(),
      started = Date.now(),
      session = await f.adapter.initialize(f.ctx, 9, "video/mp4", metadata);
    expect(session.uploadUrl).toBe(url);
    expect(session.videoId).toBeNull();
    expect(Date.parse(session.expiresAt)).toBeGreaterThanOrEqual(started + 86_400_000);
    const sent = f.request.mock.calls[0][0];
    expect(sent.url).toBe(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus&notifySubscribers=false",
    );
    expect(sent.headers).toMatchObject({
      "X-Upload-Content-Length": "9",
      "X-Upload-Content-Type": "video/mp4",
    });
    expect(JSON.parse(String(sent.body))).toEqual({
      snippet: { title: metadata.title, description: metadata.description, categoryId: "22" },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: false },
    });
    expect(sent.uploadTarget).toBeUndefined();
  });
  it("queries with an empty authenticated PUT and counts the zero-indexed Range exactly", async () => {
    const f = fixture();
    f.request.mockResolvedValue(response(308, undefined, { range: "bytes=0-1234", "retry-after": "5" }));
    expect(await f.adapter.query(f.ctx, f.session, 2000)).toEqual({
      kind: "progress",
      receivedBytes: 1235,
      retryAfterMs: 5000,
    });
    const sent = f.request.mock.calls[0][0];
    expect(sent.headers).toEqual({
      Authorization: "Bearer synthetic-private-token",
      "Content-Range": "bytes */2000",
    });
    expect(sent.body).toEqual(Buffer.alloc(0));
    expect(sent.timeoutMs).toBe(120000);
    expect(sent.uploadTarget?.kind).toBe("youtube-upload");
  });
  it("absence of Range means zero confirmed bytes, not a completed upload", async () => {
    const f = fixture();
    f.request.mockResolvedValue(response(308));
    expect(await f.adapter.query(f.ctx, f.session, 10)).toEqual({
      kind: "progress",
      receivedBytes: 0,
      retryAfterMs: 0,
    });
  });
  it("resumes from a partial byte offset without skipping to a planned chunk boundary", async () => {
    const f = fixture();
    f.request.mockResolvedValue(response(201, receipt()));
    expect(await f.adapter.upload(f.ctx, f.session, 20, 7, "video/mp4", Buffer.alloc(13))).toMatchObject({
      kind: "complete",
      receipt: { videoId: "abcdefghijk", privacy: "private", state: "processing" },
    });
    expect(f.request.mock.calls[0][0].headers?.["Content-Range"]).toBe("bytes 7-19/20");
  });
  it.each([
    ["private", "ready"],
    ["unlisted", "ready"],
    ["public", "published"],
  ])("reports actual processed visibility %s as %s", async (privacy, state) => {
    const f = fixture();
    f.request.mockResolvedValue(response(200, { items: [receipt(privacy, "processed")] }));
    expect(await f.adapter.status(f.ctx, "abcdefghijk")).toEqual({ videoId: "abcdefghijk", privacy, state });
  });
  it.each(["failed", "rejected", "deleted"])(
    "does not turn %s into published despite public privacy",
    async (stage) => {
      const f = fixture();
      f.request.mockResolvedValue(response(200, { items: [receipt("public", stage)] }));
      expect((await f.adapter.status(f.ctx, "abcdefghijk")).state).toBe("failed");
    },
  );
  it.each([
    "bytes=1-9",
    "bytes=0-01",
    "bytes=0--1",
    "bytes=0-100",
    "bytes=0-9,20-30",
    "bytes=0-9007199254740991",
  ])("refuses invalid Range %s", async (range) => {
    const f = fixture();
    f.request.mockResolvedValue(response(308, undefined, { range }));
    await expect(f.adapter.query(f.ctx, f.session, 100)).rejects.toMatchObject({
      code: "GLOBAL_UPLOAD_PROGRESS_MISMATCH",
    });
  });
  it.each(["rollback", "beyond-request", "premature-complete"])(
    "rejects %s acknowledgement",
    async (mode) => {
      const f = fixture(),
        size = YOUTUBE_UPLOAD_CHUNK_BYTES * 3;
      f.request.mockResolvedValue(
        mode === "premature-complete"
          ? response(201, receipt())
          : response(308, undefined, {
              range: mode === "rollback" ? "bytes=0-4" : `bytes=0-${YOUTUBE_UPLOAD_CHUNK_BYTES + 6}`,
            }),
      );
      await expect(
        f.adapter.upload(f.ctx, f.session, size, 6, "video/mp4", Buffer.alloc(YOUTUBE_UPLOAD_CHUNK_BYTES)),
      ).rejects.toMatchObject({ code: "GLOBAL_UPLOAD_PROGRESS_MISMATCH" });
    },
  );
  it.each([
    [401, "authError", "GLOBAL_UPLOAD_REAUTHORIZE"],
    [403, "insufficientPermissions", "GLOBAL_UPLOAD_SCOPE_MISSING"],
    [403, "quotaExceeded", "GLOBAL_UPLOAD_RATE_LIMITED"],
    [429, "rateLimitExceeded", "GLOBAL_UPLOAD_RATE_LIMITED"],
    [404, "notFound", "GLOBAL_UPLOAD_EXPIRED"],
    [500, "backendError", "GLOBAL_UPLOAD_UNAVAILABLE"],
    [400, "invalidTitle", "GLOBAL_UPLOAD_REJECTED"],
  ] as const)("maps %s / %s without leaking provider text or retrying", async (status, reason, code) => {
    const f = fixture();
    f.request.mockResolvedValue(
      response(status, { error: { errors: [{ reason, message: "synthetic private provider data" }] } }),
    );
    await expect(f.adapter.query(f.ctx, f.session, 10)).rejects.toMatchObject({ code, message: code });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["another-channel", "another-video", "missing-privacy", "unknown-stage", "bad-processing"])(
    "rejects %s final status",
    async (mode) => {
      const f = fixture(),
        item: Record<string, unknown> = receipt("public", "processed");
      if (mode === "another-channel") item.snippet = { channelId: "other" };
      if (mode === "another-video") item.id = "mnopqrstuvw";
      if (mode === "missing-privacy") item.status = { uploadStatus: "processed" };
      if (mode === "unknown-stage") item.status = { privacyStatus: "public", uploadStatus: "__proto__" };
      if (mode === "bad-processing") item.processingDetails = { processingStatus: "unknown" };
      f.request.mockResolvedValue(response(200, { items: [item] }));
      await expect(f.adapter.status(f.ctx, "abcdefghijk")).rejects.toMatchObject({
        code: "GLOBAL_UPLOAD_RESPONSE_INVALID",
      });
    },
  );
  it.each(["scope", "platform", "cancelled", "expired"])(
    "does not send initialization for %s",
    async (mode) => {
      const f = fixture();
      if (mode === "scope") f.ctx.token.scopes = [];
      if (mode === "platform") f.ctx.token.platformId = "tiktok";
      if (mode === "cancelled") f.controller.abort();
      if (mode === "expired") f.ctx.token.expiresAt = "not-a-date";
      await expect(f.adapter.initialize(f.ctx, 10, "video/mp4", metadata)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("a late success cannot return a URL after cancellation", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.controller.abort();
      return response(200, undefined, { location: url });
    });
    await expect(f.adapter.initialize(f.ctx, 10, "video/mp4", metadata)).rejects.toMatchObject({
      code: "GLOBAL_UPLOAD_CANCELLED",
    });
  });
});
describe("YouTube upload configuration and owned destination", () => {
  it.each(["madeForKids", "containsSyntheticMedia", "privacy", "notifySubscribers"])(
    "requires explicit %s",
    (key) => {
      const value: Record<string, unknown> = { ...metadata };
      delete value[key];
      expect(youtubeUploadMetadataSchema.safeParse(value).success).toBe(false);
    },
  );
  it("counts description UTF-8 bytes and refuses secret or URL fields", () => {
    expect(
      youtubeUploadMetadataSchema.safeParse({ ...metadata, description: "字".repeat(1700) }).success,
    ).toBe(false);
    expect(youtubeUploadMetadataSchema.safeParse({ ...metadata, uploadUrl: url }).success).toBe(false);
  });
  it("accepts encoded or literal commas without rewriting the opaque URL", () => {
    expect(validYouTubeUploadUrl(url)).toBe(true);
    expect(validYouTubeUploadUrl(url.replace("%2C", ","))).toBe(true);
  });
  it.each([
    url.replace("www.googleapis.com", "youtube.com"),
    url.replace("https:", "http:"),
    url + "&upload_id=other",
    url + "&token=private",
    url + "#hash",
    url.replace("snippet%2Cstatus", "snippet"),
    url.replace("/upload/youtube/v3/videos", "/oauth/token"),
    url.replace("www.googleapis.com", "user@www.googleapis.com"),
  ])("rejects %s", (value) => expect(validYouTubeUploadUrl(value)).toBe(false));
  it("checks capability ownership, exact URL, revocation and local expiry", () => {
    let current = true;
    const cap = issueYouTubeUploadTarget(url, performance.now() + 1000, () => {
      if (!current) throw new Error("revoked");
    });
    expect(() => assertYouTubeUploadTarget({ ...cap }, url)).toThrow();
    expect(() => assertYouTubeUploadTarget(cap, url + "x")).toThrow();
    expect(() => issueYouTubeUploadTarget(url, performance.now() - 1, () => undefined)).toThrow();
    current = false;
    expect(() => assertYouTubeUploadTarget(cap, url)).toThrow();
  });
});
