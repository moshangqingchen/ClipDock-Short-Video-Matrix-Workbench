import type { GlobalUploadErrorCode } from "@shared/global-uploads";
import {
  YOUTUBE_MAX_BYTES,
  YOUTUBE_UPLOAD_CHUNK_BYTES,
  YOUTUBE_UPLOAD_SCOPE,
  youtubeUploadMetadataSchema,
  youtubeVideoIdSchema,
  youtubePrivacySchema,
  type YouTubeUploadMetadata,
  type YouTubeUploadReceipt,
} from "@shared/youtube-upload";
import type { ProxyTransportRequest, ProxyTransportResponse } from "./proxy-transport";
import type { GlobalTokenEnvelope } from "./global-token-store";
import { GlobalUploadError } from "./tiktok-draft-adapter";
import { validYouTubeUploadUrl, issueYouTubeUploadTarget } from "./youtube-upload-target";

type Row = Record<string, unknown>;
function fail(code: GlobalUploadErrorCode): never {
  throw new GlobalUploadError(code);
}
function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}
function json(response: ProxyTransportResponse): Row {
  try {
    if (response.body.byteLength <= 65_536)
      return row(JSON.parse(response.body.toString("utf8"))) ?? fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
  } catch {
    /* private provider body stays here */
  }
  return fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
}
function checkError(response: ProxyTransportResponse): void {
  if (response.status < 400) return;
  let reason: unknown;
  try {
    const errors = row(json(response).error)?.errors;
    if (Array.isArray(errors)) reason = row(errors[0])?.reason;
  } catch {
    /* status still provides a fixed reason */
  }
  if (response.status === 401) fail("GLOBAL_UPLOAD_REAUTHORIZE");
  if (reason === "insufficientPermissions") fail("GLOBAL_UPLOAD_SCOPE_MISSING");
  if (
    response.status === 429 ||
    [
      "quotaExceeded",
      "dailyLimitExceeded",
      "uploadLimitExceeded",
      "rateLimitExceeded",
      "userRateLimitExceeded",
    ].includes(String(reason))
  )
    throw new YouTubeUploadRetryError("GLOBAL_UPLOAD_RATE_LIMITED", retryAfter(response));
  if (response.status === 403) fail("GLOBAL_UPLOAD_FORBIDDEN");
  if ([500, 502, 503, 504].includes(response.status))
    throw new YouTubeUploadRetryError("GLOBAL_UPLOAD_UNAVAILABLE", retryAfter(response));
  if (response.status === 404 || response.status === 410) fail("GLOBAL_UPLOAD_EXPIRED");
  fail("GLOBAL_UPLOAD_REJECTED");
}
function header(response: ProxyTransportResponse, key: string): string | undefined {
  const value = response.headers[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
  return value;
}
export class YouTubeUploadRetryError extends GlobalUploadError {
  constructor(
    code: "GLOBAL_UPLOAD_RATE_LIMITED" | "GLOBAL_UPLOAD_UNAVAILABLE",
    readonly retryAfterMs: number,
  ) {
    super(code);
  }
}
function retryAfter(response: ProxyTransportResponse): number {
  const retry = header(response, "retry-after");
  if (retry === undefined) return 0;
  const delay = /^[0-9]+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
  if (!Number.isFinite(delay) || delay > 86_400_000) fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
  return Math.max(0, delay);
}
export function youtubeUploadPlan(size: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > YOUTUBE_MAX_BYTES)
    fail("GLOBAL_UPLOAD_FILE_UNSUPPORTED");
  const chunkSize = YOUTUBE_UPLOAD_CHUNK_BYTES,
    count = Math.ceil(size / chunkSize);
  return Object.freeze({
    size,
    chunkSize,
    count,
    parts: Object.freeze(
      Array.from({ length: count }, (_, index) =>
        Object.freeze({
          start: index * chunkSize,
          end: Math.min(size, (index + 1) * chunkSize) - 1,
        }),
      ),
    ),
  });
}
export interface YouTubeUploadSession {
  uploadUrl: string;
  expiresAt: string;
  videoId: string | null;
}
export type YouTubeTransferResult =
  | { kind: "progress"; receivedBytes: number; retryAfterMs: number }
  | { kind: "complete"; receipt: YouTubeUploadReceipt };
export interface YouTubeUploadContext {
  token: GlobalTokenEnvelope;
  signal: AbortSignal;
  assertCurrent(): void;
}

/** Official resumable upload only. Returns actual acknowledged offsets; callers own durable retries. */
export class YouTubeUploadAdapter {
  constructor(
    private readonly transport: { request(input: ProxyTransportRequest): Promise<ProxyTransportResponse> },
  ) {}
  private current(ctx: YouTubeUploadContext): void {
    ctx.assertCurrent();
    if (ctx.signal.aborted) fail("GLOBAL_UPLOAD_CANCELLED");
    if (ctx.token.platformId !== "youtube" || !ctx.token.scopes.includes(YOUTUBE_UPLOAD_SCOPE))
      fail("GLOBAL_UPLOAD_SCOPE_MISSING");
    if (!Number.isFinite(Date.parse(ctx.token.expiresAt)) || Date.parse(ctx.token.expiresAt) <= Date.now())
      fail("GLOBAL_UPLOAD_REAUTHORIZE");
  }
  private receipt(ctx: YouTubeUploadContext, value: Row): YouTubeUploadReceipt {
    const id = youtubeVideoIdSchema.safeParse(value.id),
      status = row(value.status),
      snippet = row(value.snippet);
    const privacy = youtubePrivacySchema.safeParse(status?.privacyStatus);
    if (!id.success || !privacy.success || snippet?.channelId !== ctx.token.remoteId)
      fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    const stage = status?.uploadStatus;
    if (!["uploaded", "processed", "failed", "rejected", "deleted"].includes(String(stage)))
      fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    const processing = row(value.processingDetails)?.processingStatus;
    if (
      processing !== undefined &&
      !["processing", "succeeded", "failed", "terminated"].includes(String(processing))
    )
      fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    const failed = ["failed", "rejected", "deleted"].includes(String(stage)) || processing === "failed";
    if (!failed && processing === "terminated") fail("GLOBAL_UPLOAD_UNCERTAIN");
    const done = processing === "succeeded" || (stage === "processed" && processing === undefined);
    return {
      videoId: id.data,
      privacy: privacy.data,
      state: failed ? "failed" : !done ? "processing" : privacy.data === "public" ? "published" : "ready",
    };
  }
  async initialize(
    ctx: YouTubeUploadContext,
    size: number,
    mime: string,
    metadata: YouTubeUploadMetadata,
  ): Promise<YouTubeUploadSession> {
    this.current(ctx);
    youtubeUploadPlan(size);
    const parsed = youtubeUploadMetadataSchema.safeParse(metadata);
    if (!parsed.success || !/^video\/[a-z0-9.+-]{1,64}$/.test(mime)) fail("GLOBAL_UPLOAD_INVALID");
    const {
      title,
      description,
      categoryId,
      privacy,
      madeForKids,
      containsSyntheticMedia,
      notifySubscribers,
    } = parsed.data;
    const started = Date.now();
    const response = await this.transport.request({
      platformId: "youtube",
      method: "POST",
      url: `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus&notifySubscribers=${notifySubscribers}`,
      headers: {
        Authorization: `Bearer ${ctx.token.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime,
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({
        snippet: { title, description, categoryId },
        status: { privacyStatus: privacy, selfDeclaredMadeForKids: madeForKids, containsSyntheticMedia },
      }),
      signal: ctx.signal,
    });
    this.current(ctx);
    checkError(response);
    const url = header(response, "location");
    if (response.status !== 200 || !validYouTubeUploadUrl(url)) fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    return { uploadUrl: url, expiresAt: new Date(started + 86_400_000).toISOString(), videoId: null };
  }
  private async transfer(
    ctx: YouTubeUploadContext,
    session: YouTubeUploadSession,
    size: number,
    start: number | null,
    mime?: string,
    body = Buffer.alloc(0),
  ): Promise<YouTubeTransferResult> {
    this.current(ctx);
    youtubeUploadPlan(size);
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 86_400_000)
      fail("GLOBAL_UPLOAD_EXPIRED");
    let target;
    try {
      target = issueYouTubeUploadTarget(session.uploadUrl, performance.now() + remaining, () =>
        this.current(ctx),
      );
    } catch {
      return fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    }
    const response = await this.transport.request({
      platformId: "youtube",
      url: session.uploadUrl,
      method: "PUT",
      uploadTarget: target,
      headers: {
        Authorization: `Bearer ${ctx.token.accessToken}`,
        "Content-Range":
          start === null ? `bytes */${size}` : `bytes ${start}-${start + body.byteLength - 1}/${size}`,
        ...(mime ? { "Content-Type": mime } : {}),
      },
      body,
      signal: ctx.signal,
      timeoutMs: 120_000,
    });
    this.current(ctx);
    checkError(response);
    if (response.status === 201) {
      if (start !== null && start + body.byteLength !== size) fail("GLOBAL_UPLOAD_PROGRESS_MISMATCH");
      return { kind: "complete", receipt: this.receipt(ctx, json(response)) };
    }
    if (response.status !== 308 || header(response, "location") !== undefined)
      fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    const range = header(response, "range");
    const match = range === undefined ? null : /^bytes=0-(0|[1-9][0-9]*)$/.exec(range);
    if (range !== undefined && !match) fail("GLOBAL_UPLOAD_PROGRESS_MISMATCH");
    const receivedBytes = match ? Number(match[1]) + 1 : 0;
    if (
      !Number.isSafeInteger(receivedBytes) ||
      receivedBytes > size ||
      (start !== null && (receivedBytes < start || receivedBytes > start + body.byteLength))
    )
      fail("GLOBAL_UPLOAD_PROGRESS_MISMATCH");
    return { kind: "progress", receivedBytes, retryAfterMs: retryAfter(response) };
  }
  async upload(
    ctx: YouTubeUploadContext,
    session: YouTubeUploadSession,
    size: number,
    start: number,
    mime: string,
    bytes: Uint8Array,
  ): Promise<YouTubeTransferResult> {
    youtubeUploadPlan(size);
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start >= size ||
      bytes.byteLength !== Math.min(YOUTUBE_UPLOAD_CHUNK_BYTES, size - start) ||
      !/^video\/[a-z0-9.+-]{1,64}$/.test(mime)
    )
      fail("GLOBAL_UPLOAD_INVALID");
    return this.transfer(ctx, session, size, start, mime, Buffer.from(bytes));
  }
  query(
    ctx: YouTubeUploadContext,
    session: YouTubeUploadSession,
    size: number,
  ): Promise<YouTubeTransferResult> {
    return this.transfer(ctx, session, size, null);
  }
  async status(ctx: YouTubeUploadContext, videoId: string): Promise<YouTubeUploadReceipt> {
    this.current(ctx);
    if (!youtubeVideoIdSchema.safeParse(videoId).success) fail("GLOBAL_UPLOAD_INVALID");
    const response = await this.transport.request({
      platformId: "youtube",
      url: `https://www.googleapis.com/youtube/v3/videos?part=snippet%2Cstatus%2CprocessingDetails&id=${videoId}`,
      headers: { Authorization: `Bearer ${ctx.token.accessToken}` },
      signal: ctx.signal,
    });
    this.current(ctx);
    checkError(response);
    if (response.status !== 200) fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    const items = json(response).items;
    if (!Array.isArray(items) || items.length !== 1 || row(items[0])?.id !== videoId)
      fail("GLOBAL_UPLOAD_RESPONSE_INVALID");
    return this.receipt(ctx, row(items[0])!);
  }
}
