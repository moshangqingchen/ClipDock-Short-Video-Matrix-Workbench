import { globalAccountIdSchema } from "@shared/global-accounts";
import {
  GLOBAL_READ_ERRORS,
  globalReadDataSchema,
  type GlobalReadCapabilityState,
  type GlobalReadData,
  type GlobalReadErrorCode,
} from "@shared/global-read";
import type { GlobalTokenEnvelope } from "./global-token-store";
import { ProxyTransportError, type ProxyTransport, type ProxyTransportRequest } from "./proxy-transport";

type Row = Record<string, unknown>;
type Work = GlobalReadData["works"][number];
export interface GlobalReadAdapterOptions {
  transport: Pick<ProxyTransport, "request">;
  now?: () => number;
}
export interface GlobalReadAdapterInput {
  token: GlobalTokenEnvelope;
  signal: AbortSignal;
  assertCurrent(): void;
}
export class GlobalReadAdapterError extends Error {
  constructor(readonly code: GlobalReadErrorCode) {
    super(code);
    this.name = "GlobalReadAdapterError";
  }
}
function fail(code: GlobalReadErrorCode): never {
  throw new GlobalReadAdapterError(code);
}
function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("GLOBAL_READ_RESPONSE_INVALID");
  return value as Row;
}
function optionalRecord(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
function rows(value: unknown, max = 20): Row[] {
  if (!Array.isArray(value) || value.length > max) fail("GLOBAL_READ_RESPONSE_INVALID");
  return value.map(record);
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{1,256}$/.test(value))
    fail("GLOBAL_READ_RESPONSE_INVALID");
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > 100_000) fail("GLOBAL_READ_RESPONSE_INVALID");
  return value.slice(0, max);
}
function optionalText(value: unknown, max: number): string | null {
  return typeof value === "string" ? text(value, max) : null;
}
/** Do not stringify a rounded JSON int64. Provider strings preserve precision; unsafe numbers are unknown. */
function count(value: unknown): string | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,39})$/.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}
function aliasCount(row: Row, first: string, second: string): string | null {
  const a = count(row[first]);
  const b = count(row[second]);
  return row[first] !== undefined && row[second] !== undefined ? (a === b ? a : null) : (a ?? b);
}
function date(value: unknown, unixSeconds = false): string | null {
  const ms = unixSeconds
    ? typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value * 1000
      : NaN
    : typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)
      ? Date.parse(value)
      : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}
function empty(remoteId: string): GlobalReadData {
  return {
    remoteId,
    profile: { displayName: "", username: null },
    totals: { followers: null, following: null, works: null, views: null, likes: null },
    works: [],
    hasMoreWorks: null,
    capabilities: { readProfile: "ready", readMetrics: "scope_required", listWorks: "scope_required" },
  };
}
function unique(works: Work[]): Work[] {
  if (new Set(works.map((work) => work.id)).size !== works.length) fail("GLOBAL_READ_RESPONSE_INVALID");
  return works;
}
function baseWork(id: string, kind: Work["kind"], title: string, publishedAt: string | null): Work {
  return { id, kind, title, publishedAt, views: null, likes: null, comments: null, reposts: null };
}
function sameIdentity(value: unknown, expected: string): void {
  if (identity(value) !== expected) fail("GLOBAL_READ_IDENTITY_MISMATCH");
}
function hasNext(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "string" || value.length > 4096) fail("GLOBAL_READ_RESPONSE_INVALID");
  return value.length > 0;
}
function scope(token: GlobalTokenEnvelope, ...required: string[]): boolean {
  return required.every((value) => token.scopes.includes(value));
}

/** Fixed, bounded API reads. No browser, media fetch, refresh, pagination loop or transport fallback. */
export class GlobalReadAdapter {
  private readonly now: () => number;
  constructor(private readonly options: GlobalReadAdapterOptions) {
    this.now = options.now ?? Date.now;
  }

  async read(input: GlobalReadAdapterInput): Promise<GlobalReadData> {
    let token: GlobalTokenEnvelope;
    const signal = input?.signal;
    const assertCurrent = input?.assertCurrent;
    try {
      token = structuredClone(input.token);
      if (
        !globalAccountIdSchema.safeParse(token.accountId).success ||
        token.version !== 1 ||
        !["youtube", "tiktok", "x"].includes(token.platformId) ||
        token.tokenType !== "Bearer" ||
        typeof token.accessToken !== "string" ||
        !/^[\x21-\x7e]{1,16384}$/.test(token.accessToken) ||
        typeof token.remoteId !== "string" ||
        !/^[A-Za-z0-9._~-]{1,256}$/.test(token.remoteId) ||
        (token.platformId === "x" && !/^[0-9]{1,19}$/.test(token.remoteId)) ||
        !Number.isFinite(Date.parse(token.expiresAt)) ||
        !Array.isArray(token.scopes) ||
        token.scopes.length > 64 ||
        token.scopes.some((value) => typeof value !== "string" || value.length > 256) ||
        !signal ||
        typeof signal.addEventListener !== "function" ||
        typeof assertCurrent !== "function"
      )
        fail("GLOBAL_READ_INPUT_INVALID");
    } catch {
      fail("GLOBAL_READ_INPUT_INVALID");
    }
    const check = () => {
      if (signal.aborted) fail("GLOBAL_READ_CANCELLED");
      try {
        assertCurrent();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        fail(GLOBAL_READ_ERRORS.find((code) => code === message) ?? "GLOBAL_READ_CANCELLED");
      }
      if (signal.aborted) fail("GLOBAL_READ_CANCELLED");
      const now = this.now();
      if (!Number.isFinite(now) || Date.parse(token.expiresAt) <= now) fail("GLOBAL_READ_REAUTHORIZE");
      if (signal.aborted) fail("GLOBAL_READ_CANCELLED");
    };
    let requests = 0;
    const request = async (url: string, body?: Row): Promise<Row> => {
      check();
      if (++requests > 4) fail("GLOBAL_READ_RESPONSE_INVALID");
      const options: ProxyTransportRequest = {
        platformId: token.platformId,
        url,
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      };
      let response;
      try {
        response = await this.options.transport.request(options);
      } catch (error) {
        check();
        if (error instanceof ProxyTransportError) {
          if (["AUTHORIZATION_REQUIRED", "AUTHORIZATION_DENIED", "LEASE_REVOKED"].includes(error.code))
            fail("GLOBAL_READ_WAITING_PROXY");
          if (error.code === "REQUEST_ABORTED") fail("GLOBAL_READ_CANCELLED");
        }
        fail("GLOBAL_READ_UNAVAILABLE");
      }
      check();
      if (response.status === 401) fail("GLOBAL_READ_REAUTHORIZE");
      if (response.status === 403) fail("GLOBAL_READ_FORBIDDEN");
      if (response.status === 429) fail("GLOBAL_READ_RATE_LIMITED");
      if (response.status !== 200) fail("GLOBAL_READ_UNAVAILABLE");
      let parsed: Row;
      try {
        if (!Buffer.isBuffer(response.body) || response.body.length > 2 * 1024 * 1024)
          fail("GLOBAL_READ_RESPONSE_INVALID");
        parsed = record(JSON.parse(response.body.toString("utf8")));
      } catch {
        fail("GLOBAL_READ_RESPONSE_INVALID");
      }
      if (token.platformId === "tiktok") {
        const code = record(parsed.error).code;
        if (code === "access_token_invalid") fail("GLOBAL_READ_REAUTHORIZE");
        if (code === "scope_not_authorized") fail("GLOBAL_READ_FORBIDDEN");
        if (code === "rate_limit_exceeded") fail("GLOBAL_READ_RATE_LIMITED");
        if (code !== "ok") fail("GLOBAL_READ_RESPONSE_INVALID");
      }
      check();
      return parsed;
    };
    // Only provider access/rate responses in an optional segment may yield a partial snapshot.
    // Transport failures, cancellation, malformed data and identity changes remain fatal.
    const optional = async (work: () => Promise<void>): Promise<GlobalReadCapabilityState> => {
      try {
        await work();
        check();
        return "ready";
      } catch (error) {
        check();
        if (error instanceof GlobalReadAdapterError && error.code === "GLOBAL_READ_FORBIDDEN")
          return "forbidden";
        if (error instanceof GlobalReadAdapterError && error.code === "GLOBAL_READ_RATE_LIMITED")
          return "rate_limited";
        throw error;
      }
    };
    check();
    const result = empty(token.remoteId);
    if (token.platformId === "youtube") {
      if (!scope(token, "https://www.googleapis.com/auth/youtube.readonly")) fail("GLOBAL_READ_UNAUTHORIZED");
      const response = await request(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true&maxResults=2",
      );
      const channels = rows(response.items, 2);
      if (channels.length !== 1) fail("GLOBAL_READ_IDENTITY_MISMATCH");
      const channel = channels[0];
      sameIdentity(channel.id, token.remoteId);
      const snippet = record(channel.snippet);
      result.profile = {
        displayName: text(snippet.title, 256),
        username: optionalText(snippet.customUrl, 256),
      };
      const metrics = optionalRecord(channel.statistics);
      result.totals.followers =
        metrics.hiddenSubscriberCount === true ? null : count(metrics.subscriberCount);
      result.totals.works = count(metrics.videoCount);
      result.totals.views = count(metrics.viewCount);
      result.capabilities.readMetrics = channel.statistics ? "ready" : "unavailable";
      const uploads = optionalRecord(optionalRecord(channel.contentDetails).relatedPlaylists).uploads;
      if (typeof uploads !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uploads)) {
        result.capabilities.listWorks = "unavailable";
      } else {
        result.capabilities.listWorks = await optional(async () => {
          const page = await request(
            `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=20&playlistId=${encodeURIComponent(uploads)}`,
          );
          const items = rows(page.items);
          const ids = items.map((item) => identity(record(item.contentDetails).videoId));
          if (new Set(ids).size !== ids.length) fail("GLOBAL_READ_RESPONSE_INVALID");
          // A subsequent lookup is necessary: playlist item IDs and insertion dates are not video IDs/publication dates.
          const videos = ids.length
            ? rows(
                (
                  await request(
                    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ids.map(encodeURIComponent).join(",")}`,
                  )
                ).items,
              )
            : [];
          const works = unique(
            videos.map((video) => {
              const id = identity(video.id);
              if (!ids.includes(id)) fail("GLOBAL_READ_IDENTITY_MISMATCH");
              const snip = record(video.snippet);
              sameIdentity(snip.channelId, token.remoteId);
              const stat = optionalRecord(video.statistics);
              return {
                ...baseWork(id, "video", text(snip.title, 1000), date(snip.publishedAt)),
                views: count(stat.viewCount),
                likes: count(stat.likeCount),
                comments: count(stat.commentCount),
              };
            }),
          );
          result.works = works.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
          result.hasMoreWorks = hasNext(page.nextPageToken);
        });
      }
    } else if (token.platformId === "tiktok") {
      if (!scope(token, "user.info.basic")) fail("GLOBAL_READ_UNAUTHORIZED");
      const fields = `open_id,display_name${scope(token, "user.info.profile") ? ",username" : ""}`;
      const user = record(
        record((await request(`https://open.tiktokapis.com/v2/user/info/?fields=${fields}`)).data).user,
      );
      sameIdentity(user.open_id, token.remoteId);
      result.profile = {
        displayName: text(user.display_name, 256),
        username: optionalText(user.username, 256),
      };
      if (scope(token, "user.info.stats")) {
        result.capabilities.readMetrics = await optional(async () => {
          const stats = record(
            record(
              (
                await request(
                  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,follower_count,following_count,likes_count,video_count",
                )
              ).data,
            ).user,
          );
          sameIdentity(stats.open_id, token.remoteId);
          result.totals = {
            followers: count(stats.follower_count),
            following: count(stats.following_count),
            works: count(stats.video_count),
            likes: count(stats.likes_count),
            views: null,
          };
        });
      }
      if (scope(token, "video.list")) {
        result.capabilities.listWorks = await optional(async () => {
          const page = record(
            (
              await request(
                "https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,view_count,like_count,comment_count,share_count",
                { max_count: 20 },
              )
            ).data,
          );
          if (typeof page.has_more !== "boolean") fail("GLOBAL_READ_RESPONSE_INVALID");
          const works = unique(
            rows(page.videos).map((video) => ({
              ...baseWork(
                identity(video.id),
                "video",
                text(video.title, 1000),
                date(video.create_time, true),
              ),
              views: count(video.view_count),
              likes: count(video.like_count),
              comments: count(video.comment_count),
              reposts: count(video.share_count),
            })),
          );
          result.works = works;
          result.hasMoreWorks = page.has_more;
        });
      }
    } else {
      if (!scope(token, "users.read", "tweet.read")) fail("GLOBAL_READ_UNAUTHORIZED");
      const profile = await request(
        "https://api.x.com/2/users/me?user.fields=id,name,username,public_metrics",
      );
      if (Array.isArray(profile.errors) && profile.errors.length > 0) fail("GLOBAL_READ_RESPONSE_INVALID");
      const user = record(profile.data);
      sameIdentity(user.id, token.remoteId);
      result.profile = { displayName: text(user.name, 256), username: optionalText(user.username, 256) };
      const metrics = optionalRecord(user.public_metrics);
      result.totals.followers = count(metrics.followers_count);
      result.totals.following = count(metrics.following_count);
      // X's current generated reference uses post_count; its v2 data dictionary still uses tweet_count.
      result.totals.works = aliasCount(metrics, "tweet_count", "post_count");
      result.capabilities.readMetrics = user.public_metrics ? "ready" : "unavailable";
      result.capabilities.listWorks = await optional(async () => {
        const page = await request(
          `https://api.x.com/2/users/${encodeURIComponent(token.remoteId)}/tweets?max_results=20&tweet.fields=id,text,author_id,created_at,public_metrics&exclude=retweets`,
        );
        const meta = record(page.meta);
        const posts = page.data === undefined && meta.result_count === 0 ? [] : rows(page.data);
        if (Array.isArray(page.errors) && page.errors.length > 0) fail("GLOBAL_READ_RESPONSE_INVALID");
        const works = unique(
          posts.map((post) => {
            sameIdentity(post.author_id, token.remoteId);
            const stat = optionalRecord(post.public_metrics);
            return {
              ...baseWork(identity(post.id), "post", text(post.text, 1000), date(post.created_at)),
              views: count(stat.impression_count),
              likes: count(stat.like_count),
              comments: count(stat.reply_count),
              reposts: aliasCount(stat, "retweet_count", "repost_count"),
            };
          }),
        );
        result.works = works;
        result.hasMoreWorks = hasNext(meta.next_token);
      });
    }
    check();
    const parsed = globalReadDataSchema.safeParse(result);
    if (!parsed.success) fail("GLOBAL_READ_RESPONSE_INVALID");
    check();
    return parsed.data;
  }
}
