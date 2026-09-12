import type { Session } from "electron";
import type { Account, Work } from "@shared/types";
import { isCnPlatformId, type CnPlatformId } from "@shared/platforms";
import type { BusinessNetworkController, BusinessNetworkLease } from "@main/network/business-access";
import { normalizeExactOrigin } from "@main/network/operation-catalog";
import type { RemoteMediaOrigin, RemoteMediaServiceOptions, RemoteMediaSubject } from "./remote-media-service";
import { RemoteMediaUnavailableError } from "./remote-media-download";

type MediaSession = Pick<Session, "fetch">;
type MediaAccount = Pick<Account, "id" | "platformId">;
type MediaWork = Pick<Work, "id" | "accountId" | "platformId">;

export interface DomesticMediaAuthorizationOptions {
  /** Main-process policy selection only. The route-proof policy is deliberately not admitted here. */
  exclusiveMode(): boolean;
  getAccount(accountId: string): MediaAccount | null | undefined;
  getWork(workId: string): MediaWork | null | undefined;
  /** Return the already configured account Session; never create or borrow a default/global Session. */
  getSession(accountId: string): MediaSession | null | undefined;
  network: Pick<BusinessNetworkController, "enforcement" | "check" | "acquire">;
}

// Purpose-specific media families, intentionally narrower than first-party navigation hosts.
// A match does not grant a route: the account's existing gate and lease remain authoritative.
const MEDIA_HOSTS: Readonly<Record<CnPlatformId, readonly string[]>> = {
  douyin: ["byteimg.com", "douyinpic.com", "douyinstatic.com", "bytetos.com", "bytecdn.cn"],
  kuaishou: ["kwimgs.com", "yximgs.com", "kwaicdn.com"],
  xiaohongshu: ["xhscdn.com", "xhsstatic.com"],
  bilibili: ["hdslb.com", "bilicdn1.com", "bilicdn2.com"],
  baijiahao: ["bdstatic.com", "bdimg.com", "baidustatic.com", "bcebos.com", "baiducontent.com"],
  weixin_channels: ["qpic.cn", "qlogo.cn", "gtimg.com", "wxqcloud.qq.com"],
};

function reviewedOrigin(platformId: CnPlatformId, input: RemoteMediaOrigin): RemoteMediaOrigin | null {
  const origin = normalizeExactOrigin(input);
  if (!origin || origin.protocol !== "https:" || origin.port !== 443 || origin.host !== input.host)
    return null;
  return MEDIA_HOSTS[platformId].some((root) => origin.host === root || origin.host.endsWith(`.${root}`))
    ? origin : null;
}

/** Upgrade legacy HTTP image references only within the same approved platform CDN. */
export function normalizeDomesticMediaSource(platformId: CnPlatformId, input: string): string | null {
  try {
    if (!isCnPlatformId(platformId) || typeof input !== "string" || input.length > 8192 ||
        /[\u0000-\u0020\u007f\\]/.test(input)) return null;
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.port || url.username || url.password) return null;
    url.protocol = "https:";
    url.hash = "";
    if (!reviewedOrigin(platformId, { protocol: "https:", host: url.hostname, port: 443 })) return null;
    return url.href;
  } catch { return null; }
}

/** Media-only admission for the current domestic exclusive policy. No operation/catalog mutation. */
export function createDomesticMediaAuthorization(
  options: DomesticMediaAuthorizationOptions,
): RemoteMediaServiceOptions["authorize"] {
  return (inputSubject, requestedOrigin) => {
    let acquired: BusinessNetworkLease | null = null;
    try {
      if (!options.exclusiveMode() || options.network.enforcement !== "strict") return { state: "unreviewed" };
      if (!inputSubject || (inputSubject.kind !== "avatar" && inputSubject.kind !== "cover"))
        return { state: "unavailable" };
      const subject: RemoteMediaSubject = inputSubject.kind === "avatar"
        ? { accountId: inputSubject.accountId, kind: "avatar" }
        : { accountId: inputSubject.accountId, kind: "cover", workId: inputSubject.workId };
      const account = options.getAccount(subject.accountId);
      if (!account || account.id !== subject.accountId || !isCnPlatformId(account.platformId))
        return { state: "unavailable" };
      const platformId = account.platformId;
      const origin = reviewedOrigin(platformId, requestedOrigin);
      if (!origin) return { state: "unreviewed" };
      const originUrl = `https://${origin.host}/`;
      const ownsSubject = (candidate: RemoteMediaSubject) => {
        const current = options.getAccount(candidate.accountId);
        if (!current || current.id !== account.id || current.platformId !== platformId) return false;
        if (candidate.kind === "avatar") return true;
        if (candidate.kind !== "cover") return false;
        const work = options.getWork(candidate.workId);
        return Boolean(work && work.id === candidate.workId && work.accountId === account.id && work.platformId === platformId);
      };
      if (!ownsSubject(subject)) return { state: "unavailable" };
      if (!options.network.check(account.id, originUrl).allowed) return { state: "waiting-network" };
      const session = options.getSession(account.id);
      if (!session) return { state: "waiting-network" };
      acquired = options.network.acquire(account.id);
      if (!acquired) return { state: "waiting-network" };
      const source = acquired;
      const abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, source.signal]);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        abort.abort();
        try { source.release(); } catch { /* Local result authority is already retired. */ }
      };
      const current = (url = originUrl): boolean => {
        try {
          if (!released && !signal.aborted && options.exclusiveMode() && options.network.enforcement === "strict" &&
              ownsSubject(subject) && options.getSession(account.id) === session && source.isCurrent() &&
              options.network.check(account.id, url).allowed) return true;
        } catch { /* Failure never becomes media permission. */ }
        release();
        return false;
      };
      if (!current()) return { state: "waiting-network" };
      const fetch: Session["fetch"] = async (input, init) => {
        // This wrapper cannot be reused to navigate, call APIs or send account credentials.
        if (typeof input !== "string" || input.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(input))
          throw new RemoteMediaUnavailableError();
        let url: URL;
        try { url = new URL(input); } catch { throw new RemoteMediaUnavailableError(); }
        if (url.protocol !== "https:" || url.hostname !== origin.host || url.port || url.username || url.password ||
            url.hash || init?.method !== "GET" || init.credentials !== "omit" || init.redirect !== "error" ||
            init.referrerPolicy !== "no-referrer" || init.cache !== "no-store" || init.body || init.referrer)
          throw new RemoteMediaUnavailableError();
        const headers = new Headers(init.headers);
        if ([...headers.keys()].some((name) => name !== "accept") ||
            headers.get("accept") !== "image/png,image/jpeg,image/webp" || !current(url.href))
          throw new RemoteMediaUnavailableError();
        const response = await session.fetch(url.href, {
          ...init,
          signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
        });
        if (!current(url.href)) {
          void response.body?.cancel().catch(() => undefined);
          throw new RemoteMediaUnavailableError();
        }
        return response;
      };
      return { state: "allowed", session: { fetch }, lease: { signal, isCurrent: () => current(), release } };
    } catch {
      try { acquired?.release(); } catch { /* No grant escapes a failed authorization. */ }
      return { state: "unavailable" };
    }
  };
}
