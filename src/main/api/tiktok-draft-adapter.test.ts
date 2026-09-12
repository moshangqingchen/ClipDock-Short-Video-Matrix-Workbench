import { describe, expect, it, vi } from "vitest";
import {
  TikTokDraftAdapter,
  tiktokChunks,
  TIKTOK_CHUNK_BYTES,
  type TikTokDraftContext,
} from "./tiktok-draft-adapter";
import {
  assertTikTokUploadTarget,
  issueTikTokUploadTarget,
  validTikTokUploadUrl,
} from "./proxy-target-policy";
import type { ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";

const uploadUrl = "https://open-upload.tiktokapis.com/video/?upload_id=synthetic&upload_token=private";
const payload = (data: object, status = 200, error = "ok"): ProxyTransportResponse => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify({ data, error: { code: error, message: "private provider text" } })),
});
function fixture() {
  const abort = new AbortController();
  const ctx: TikTokDraftContext = {
    signal: abort.signal,
    assertCurrent: vi.fn(),
    token: {
      version: 1,
      accountId: "11111111-1111-4111-8111-111111111111",
      platformId: "tiktok",
      remoteId: "synthetic-owner",
      tokenType: "Bearer",
      accessToken: "private-token",
      scopes: ["user.info.basic", "video.upload"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  };
  const request = vi.fn<(input: ProxyTransportRequest) => Promise<ProxyTransportResponse>>(async () =>
    payload({ publish_id: "v_inbox_file~v2.123", upload_url: uploadUrl }),
  );
  return { ctx, abort, request, adapter: new TikTokDraftAdapter({ request }) };
}
describe("TikTok draft API contract", () => {
  it.each([
    1,
    4194304,
    5242880,
    TIKTOK_CHUNK_BYTES,
    TIKTOK_CHUNK_BYTES + 1,
    TIKTOK_CHUNK_BYTES * 2 - 1,
    TIKTOK_CHUNK_BYTES * 2,
    4 * 1024 ** 3,
  ])("plans %s bytes without a too-small trailing fragment", (size) => {
    const plan = tiktokChunks(size);
    expect(plan.count).toBe(Math.max(1, Math.floor(size / plan.chunkSize)));
    expect(plan.parts[0].start).toBe(0);
    expect(plan.parts.at(-1)!.end).toBe(size - 1);
    let next = 0;
    for (const part of plan.parts) {
      expect(part.start).toBe(next);
      expect(part.end - part.start + 1).toBeLessThanOrEqual(16 * 1024 ** 2);
      next = part.end + 1;
    }
    expect(next).toBe(size);
    expect(plan.count).toBeLessThanOrEqual(1000);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 4 * 1024 ** 3 + 1])("refuses invalid total size %s", (size) => {
    expect(() => tiktokChunks(size)).toThrow("GLOBAL_UPLOAD_FILE_UNSUPPORTED");
  });
  it("initializes an inbox upload with bounded chunks and an expiry counted before the init request", async () => {
    const f = fixture(),
      before = Date.now();
    const session = await f.adapter.initialize(f.ctx, 17 * 1024 ** 2);
    expect(Date.parse(session.expiresAt)).toBeGreaterThanOrEqual(before + 3600000);
    const sent = f.request.mock.calls[0][0];
    expect(sent.url).toBe("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/");
    expect(JSON.parse(String(sent.body))).toEqual({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: 17 * 1024 ** 2,
        chunk_size: TIKTOK_CHUNK_BYTES,
        total_chunk_count: 2,
      },
    });
    expect(sent.headers?.Authorization).toBe("Bearer private-token");
  });
  it("sends signed upload requests without the OAuth token and requires the final 201", async () => {
    const f = fixture(),
      session = await f.adapter.initialize(f.ctx, 10);
    f.request.mockResolvedValue(payload({}, 201));
    await f.adapter.upload(f.ctx, session, 10, 0, "video/mp4", Buffer.alloc(10));
    const sent = f.request.mock.calls[1][0];
    expect(sent.url).toBe(uploadUrl);
    expect(sent.method).toBe("PUT");
    expect(sent.timeoutMs).toBe(120000);
    expect(sent.headers).toEqual({ "Content-Type": "video/mp4", "Content-Range": "bytes 0-9/10" });
    expect(sent.uploadTarget).toEqual({ kind: "tiktok-upload" });
    if (sent.uploadTarget?.kind !== "tiktok-upload") throw new Error("wrong upload capability");
    expect(assertTikTokUploadTarget(sent.uploadTarget, uploadUrl)).toBeGreaterThan(performance.now());
    expect(JSON.stringify(sent.uploadTarget)).not.toContain("private");
    f.request.mockResolvedValue(payload({}, 206));
    await expect(
      f.adapter.upload(f.ctx, session, 10, 0, "video/mp4", Buffer.alloc(10)),
    ).rejects.toMatchObject({ code: "GLOBAL_UPLOAD_UNCERTAIN" });
    expect(f.request).toHaveBeenCalledTimes(3);
  });
  it.each([
    ["PROCESSING_UPLOAD", "uploading"],
    ["SEND_TO_USER_INBOX", "inbox"],
    ["PUBLISH_COMPLETE", "published"],
    ["FAILED", "failed"],
  ])("maps %s to %s without treating transfer as published", async (remote, local) => {
    const f = fixture();
    f.request.mockResolvedValue(
      payload({ status: remote, uploaded_bytes: 10, fail_reason: "private details" }),
    );
    expect(await f.adapter.status(f.ctx, "v_inbox_file~v2.123", 10)).toEqual({
      state: local,
      uploadedBytes: 10,
    });
    expect(f.request.mock.calls[0][0].url).toBe("https://open.tiktokapis.com/v2/post/publish/status/fetch/");
  });
  it.each(["missing", "unknown", "download", "over-count", "fraction", "negative"])(
    "rejects ambiguous status %s",
    async (mode) => {
      const f = fixture();
      f.request.mockResolvedValue(
        payload({
          status:
            mode === "missing"
              ? undefined
              : mode === "unknown"
                ? "OTHER"
                : mode === "download"
                  ? "PROCESSING_DOWNLOAD"
                  : "PROCESSING_UPLOAD",
          uploaded_bytes: mode === "fraction" ? 1.5 : mode === "negative" ? -1 : 11,
        }),
      );
      await expect(f.adapter.status(f.ctx, "valid", 10)).rejects.toMatchObject({
        code: "GLOBAL_UPLOAD_RESPONSE_INVALID",
      });
    },
  );
  it.each([
    [401, "scope_not_authorized", "GLOBAL_UPLOAD_SCOPE_MISSING"],
    [401, "access_token_invalid", "GLOBAL_UPLOAD_REAUTHORIZE"],
    [403, "spam_risk_too_many_pending_share", "GLOBAL_UPLOAD_FORBIDDEN"],
    [429, "rate_limit_exceeded", "GLOBAL_UPLOAD_RATE_LIMITED"],
  ] as const)("keeps %s / %s refusal explicit", async (status, code, expected) => {
    const f = fixture();
    f.request.mockResolvedValue(payload({}, status, code));
    await expect(f.adapter.initialize(f.ctx, 10)).rejects.toMatchObject({
      code: expected,
      message: expected,
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["__proto__", "constructor", "toString"])("rejects inherited status name %s", async (status) => {
    const f = fixture();
    f.request.mockResolvedValue(payload({ status }));
    await expect(f.adapter.status(f.ctx, "valid", 10)).rejects.toMatchObject({
      code: "GLOBAL_UPLOAD_RESPONSE_INVALID",
    });
  });
  it.each(["scope", "expired", "cancelled", "changed"])(
    "does no network work for %s intent",
    async (mode) => {
      const f = fixture();
      if (mode === "scope") f.ctx.token.scopes = ["user.info.basic"];
      if (mode === "expired") f.ctx.token.expiresAt = new Date(0).toISOString();
      if (mode === "cancelled") f.abort.abort();
      if (mode === "changed")
        f.ctx.assertCurrent = () => {
          throw new Error("changed");
        };
      await expect(f.adapter.initialize(f.ctx, 10)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("a late init response after cancellation cannot return its signed URL", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.abort.abort();
      return payload({ publish_id: "valid", upload_url: uploadUrl });
    });
    await expect(f.adapter.initialize(f.ctx, 10)).rejects.toMatchObject({ code: "GLOBAL_UPLOAD_CANCELLED" });
  });
});

describe("main-owned signed upload target", () => {
  it.each([uploadUrl, uploadUrl.replace("open-upload", "upload.us")])(
    "accepts reviewed exact origin %s",
    (url) => expect(validTikTokUploadUrl(url)).toBe(true),
  );
  it.each([
    uploadUrl.replace("https:", "http:"),
    uploadUrl.replace("tiktokapis.com", "tiktokapis.com.evil.test"),
    uploadUrl.replace("open-upload.tiktokapis.com", "creator.douyin.com"),
    uploadUrl.replace("/video/", "/oauth/token/"),
    uploadUrl + "#private",
    uploadUrl + "&upload_token=again",
    uploadUrl + "&redirect=https%3A%2F%2Fevil.test",
    "https://127.0.0.1/video/?upload_id=a&upload_token=b",
  ])("rejects unreviewed signed URL %s", (url) => expect(validTikTokUploadUrl(url)).toBe(false));
  it("does not accept copied markers, mismatched URLs, expiry or revoked intent", () => {
    let live = true;
    const target = issueTikTokUploadTarget(uploadUrl, performance.now() + 1000, () => {
      if (!live) throw new Error("revoked");
    });
    expect(() => assertTikTokUploadTarget({ ...target }, uploadUrl)).toThrow();
    expect(() => assertTikTokUploadTarget(target, uploadUrl + "x")).toThrow();
    expect(() => issueTikTokUploadTarget(uploadUrl, performance.now() - 1, () => undefined)).toThrow();
    live = false;
    expect(() => assertTikTokUploadTarget(target, uploadUrl)).toThrow();
  });
});
