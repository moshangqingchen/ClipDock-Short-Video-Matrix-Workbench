import type { GlobalUploadErrorCode } from "@shared/global-uploads";
import type { GlobalTokenEnvelope } from "./global-token-store";
import type { ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";
import { issueTikTokUploadTarget, validTikTokUploadUrl } from "./proxy-target-policy";

export class GlobalUploadError extends Error {
  constructor(readonly code: GlobalUploadErrorCode) {
    super(code);
    this.name = "GlobalUploadError";
  }
}
function fail(code: GlobalUploadErrorCode): never {
  throw new GlobalUploadError(code);
}
export const TIKTOK_MAX_BYTES = 4 * 1024 ** 3;
export const TIKTOK_CHUNK_BYTES = 8 * 1024 ** 2;
export function tiktokChunks(size: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > TIKTOK_MAX_BYTES)
    fail("GLOBAL_UPLOAD_FILE_UNSUPPORTED");
  const chunkSize = Math.min(size, TIKTOK_CHUNK_BYTES),
    count = Math.max(1, Math.floor(size / chunkSize));
  return Object.freeze({
    size,
    chunkSize,
    count,
    parts: Object.freeze(
      Array.from({ length: count }, (_, i) =>
        Object.freeze({ start: i * chunkSize, end: i === count - 1 ? size - 1 : (i + 1) * chunkSize - 1 }),
      ),
    ),
  });
}
export interface TikTokDraftSession {
  publishId: string;
  uploadUrl: string;
  expiresAt: string;
}
export interface TikTokDraftContext {
  token: GlobalTokenEnvelope;
  signal: AbortSignal;
  assertCurrent(): void;
}
export interface TikTokDraftStatus {
  state: "uploading" | "inbox" | "published" | "failed";
  uploadedBytes: number | null;
}
function validId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_.~-]{1,64}$/.test(id);
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function parsed(response: ProxyTransportResponse): Record<string, unknown> {
  let payload: Record<string, unknown> | null = null;
  try {
    if (response.body.byteLength <= 65_536) payload = object(JSON.parse(response.body.toString("utf8")));
  } catch {
    /* fixed failure */
  }
  const error = object(payload?.error)?.code;
  if (error === "scope_not_authorized") fail("GLOBAL_UPLOAD_SCOPE_MISSING");
  if (response.status === 401 || error === "access_token_invalid") fail("GLOBAL_UPLOAD_REAUTHORIZE");
  if (response.status === 429 || error === "rate_limit_exceeded") fail("GLOBAL_UPLOAD_RATE_LIMITED");
  if (response.status === 403 || (typeof error === "string" && error.startsWith("spam_risk")))
    fail("GLOBAL_UPLOAD_FORBIDDEN");
  if (response.status !== 200 || error !== "ok") fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
  return object(payload?.data) ?? fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
}
/** FILE_UPLOAD only. No Direct Post, URL pulling, redirects, hidden retries or renderer URLs. */
export class TikTokDraftAdapter {
  constructor(
    private readonly transport: { request(input: ProxyTransportRequest): Promise<ProxyTransportResponse> },
  ) {}
  private current(ctx: TikTokDraftContext): void {
    ctx.assertCurrent();
    if (ctx.signal.aborted) fail("GLOBAL_UPLOAD_CANCELLED");
    if (ctx.token.platformId !== "tiktok" || !ctx.token.scopes.includes("video.upload"))
      fail("GLOBAL_UPLOAD_SCOPE_MISSING");
    if (Date.parse(ctx.token.expiresAt) <= Date.now()) fail("GLOBAL_UPLOAD_REAUTHORIZE");
  }
  private async api(ctx: TikTokDraftContext, path: string, body: object): Promise<Record<string, unknown>> {
    this.current(ctx);
    const response = await this.transport.request({
      platformId: "tiktok",
      url: `https://open.tiktokapis.com${path}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.token.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    this.current(ctx);
    return parsed(response);
  }
  async initialize(ctx: TikTokDraftContext, size: number): Promise<TikTokDraftSession> {
    const plan = tiktokChunks(size),
      started = Date.now();
    const data = await this.api(ctx, "/v2/post/publish/inbox/video/init/", {
      source_info: {
        source: "FILE_UPLOAD",
        video_size: size,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.count,
      },
    });
    if (!validId(data.publish_id) || !validTikTokUploadUrl(data.upload_url))
      fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    return {
      publishId: data.publish_id,
      uploadUrl: data.upload_url,
      expiresAt: new Date(started + 3_600_000).toISOString(),
    };
  }
  async upload(
    ctx: TikTokDraftContext,
    session: TikTokDraftSession,
    size: number,
    start: number,
    mime: string,
    body: Uint8Array,
  ): Promise<void> {
    this.current(ctx);
    const plan = tiktokChunks(size),
      part = plan.parts.find((item) => item.start === start);
    if (
      !part ||
      body.byteLength !== part.end - part.start + 1 ||
      !["video/mp4", "video/quicktime", "video/webm"].includes(mime) ||
      !validId(session.publishId)
    )
      fail("GLOBAL_UPLOAD_INVALID");
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 3_600_000) fail("GLOBAL_UPLOAD_EXPIRED");
    let target;
    try {
      target = issueTikTokUploadTarget(session.uploadUrl, performance.now() + remaining, () =>
        this.current(ctx),
      );
    } catch {
      return fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    }
    const response = await this.transport.request({
      platformId: "tiktok",
      url: session.uploadUrl,
      method: "PUT",
      uploadTarget: target,
      timeoutMs: 120_000,
      signal: ctx.signal,
      headers: { "Content-Type": mime, "Content-Range": `bytes ${part.start}-${part.end}/${size}` },
      body,
    });
    this.current(ctx);
    if (response.status === 403) fail("GLOBAL_UPLOAD_EXPIRED");
    if (response.status === 416) fail("GLOBAL_UPLOAD_PROGRESS_MISMATCH");
    if (response.status !== (part.end === size - 1 ? 201 : 206)) fail("GLOBAL_UPLOAD_UNCERTAIN");
  }
  async status(ctx: TikTokDraftContext, publishId: string, size: number): Promise<TikTokDraftStatus> {
    tiktokChunks(size);
    if (!validId(publishId)) fail("GLOBAL_UPLOAD_INVALID");
    const data = await this.api(ctx, "/v2/post/publish/status/fetch/", { publish_id: publishId });
    const states = {
      PROCESSING_UPLOAD: "uploading",
      SEND_TO_USER_INBOX: "inbox",
      PUBLISH_COMPLETE: "published",
      FAILED: "failed",
    } as const;
    if (typeof data.status !== "string" || !Object.hasOwn(states, data.status))
      fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    const state = states[data.status as keyof typeof states];
    if (
      data.uploaded_bytes !== undefined &&
      (!Number.isSafeInteger(data.uploaded_bytes) ||
        (data.uploaded_bytes as number) < 0 ||
        (data.uploaded_bytes as number) > size)
    )
      fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    return { state, uploadedBytes: (data.uploaded_bytes as number) ?? null };
  }
}
