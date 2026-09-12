import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import type { Account, Work } from "@shared/types";
import type { CnPlatformId } from "@shared/platforms";
import { createDomesticMediaAuthorization, normalizeDomesticMediaSource, type DomesticMediaAuthorizationOptions } from "./domestic-media-authorization";
import type { RemoteMediaOrigin, RemoteMediaSubject } from "./remote-media-service";

const AVATAR = { accountId: "account-a", kind: "avatar" } as const;
describe("legacy platform image references", () => {
  it("upgrades a known CDN to HTTPS without changing its host, path or signature", () => {
    expect(normalizeDomesticMediaSource("bilibili", "http://i0.hdslb.com/avatar/image.jpg?signature=synthetic"))
      .toBe("https://i0.hdslb.com/avatar/image.jpg?signature=synthetic");
  });
  it.each([
    "http://127.0.0.1/image", "http://i0.hdslb.com.evil.test/image", "http://i0.hdslb.com:8080/image",
    "http://user:secret@i0.hdslb.com/image", "https://www.bilibili.com/api", "data:image/png;base64,AAAA",
  ])("does not turn an unsupported source into a request: %s", (input) => {
    expect(normalizeDomesticMediaSource("bilibili", input)).toBeNull();
  });
});
const COVER = { accountId: "account-a", kind: "cover", workId: "work-a" } as const;
const origin = (host = "p3.douyinpic.com"): RemoteMediaOrigin => ({ protocol: "https:", host, port: 443 });
const request = (): RequestInit => ({
  method: "GET", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
  headers: { Accept: "image/png,image/jpeg,image/webp" },
});
function fixture(platformId: CnPlatformId = "douyin") {
  let exclusive = true, allowed = true;
  let account: Pick<Account, "id" | "platformId"> | null = { id: AVATAR.accountId, platformId };
  let work: Pick<Work, "id" | "accountId" | "platformId"> | null = { id: COVER.workId, accountId: AVATAR.accountId, platformId };
  const fetch = vi.fn<Session["fetch"]>(async () => new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } }));
  let session: Pick<Session, "fetch"> | null = { fetch };
  const abort = new AbortController();
  let released = false;
  const release = vi.fn(() => { released = true; });
  const network: DomesticMediaAuthorizationOptions["network"] = {
    enforcement: "strict",
    check: vi.fn(() => ({ allowed, reason: allowed ? "READY" : "CHECKING" })),
    acquire: vi.fn(() => ({ signal: abort.signal, isCurrent: () => !released && !abort.signal.aborted, release })),
  };
  const getSession = vi.fn(() => session);
  const authorize = createDomesticMediaAuthorization({
    exclusiveMode: () => exclusive,
    getAccount: () => account,
    getWork: () => work,
    getSession,
    network,
  });
  return {
    authorize, fetch, network, release, abort, getSession,
    setExclusive(value: boolean) { exclusive = value; },
    setAllowed(value: boolean) { allowed = value; },
    setAccount(value: typeof account) { account = value; },
    setWork(value: typeof work) { work = value; },
    replaceSession(value: typeof session) { session = value; },
  };
}
function grant(f: ReturnType<typeof fixture>, subject: RemoteMediaSubject = AVATAR, target = origin()) {
  const granted = f.authorize(subject, target);
  expect(granted.state).toBe("allowed");
  if (granted.state !== "allowed") throw new Error("expected media grant");
  return granted;
}

describe("exclusive domestic media authorization", () => {
  it.each([
    ["douyin", "p3.douyinpic.com"], ["kuaishou", "p2.yximgs.com"],
    ["xiaohongshu", "sns-avatar-qc.xhscdn.com"], ["bilibili", "i0.hdslb.com"],
    ["baijiahao", "pic.rmb.bdstatic.com"], ["weixin_channels", "wx.qlogo.cn"],
  ] as const)("uses only the configured %s account session for its approved media CDN", async (platformId, host) => {
    const f = fixture(platformId);
    const authorized = grant(f, COVER, origin(host));
    const url = `https://${host}/fixture-image?signature=synthetic`;
    await authorized.session.fetch(url, request());
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledWith(url, expect.objectContaining({
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal),
    }));
    expect(f.network.check).toHaveBeenCalledWith(AVATAR.accountId, url);
    authorized.lease.release();
    authorized.lease.release();
    expect(f.release).toHaveBeenCalledOnce();
    expect(authorized.lease.isCurrent()).toBe(false);
  });

  it.each(["proof policy", "observe mode"])("does not expand %s permissions", (mode) => {
    const f = fixture();
    if (mode === "proof policy") f.setExclusive(false);
    else Object.defineProperty(f.network, "enforcement", { value: "observe" });
    expect(f.authorize(AVATAR, origin()).state).toBe("unreviewed");
    expect(f.network.check).not.toHaveBeenCalled();
    expect(f.network.acquire).not.toHaveBeenCalled();
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it.each([
    origin("attacker.example"), origin("douyinpic.com.attacker.example"), origin("evildouyinpic.com"),
    origin("127.0.0.1"), origin("[::1]"), origin("localhost"), origin("p3.douyinpic.com."),
    origin("p3.douyinpic.com@attacker.example"), origin("sns-avatar.xhscdn.com"),
    origin("creator.douyin.com"), { ...origin(), protocol: "http:" }, { ...origin(), port: 8443 },
  ])("rejects arbitrary, cross-platform, API and malformed origin %j before gate/session access", (target) => {
    const f = fixture();
    expect(f.authorize(AVATAR, target as RemoteMediaOrigin).state).toBe("unreviewed");
    expect(f.network.check).not.toHaveBeenCalled();
    expect(f.network.acquire).not.toHaveBeenCalled();
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it.each(["missing account", "global platform", "missing work", "other account's work", "other platform's work"])(
    "requires current subject ownership: %s", (change) => {
      const f = fixture();
      if (change === "missing account") f.setAccount(null);
      else if (change === "global platform") f.setAccount({ id: AVATAR.accountId, platformId: "youtube" as CnPlatformId });
      else if (change === "missing work") f.setWork(null);
      else f.setWork({ id: COVER.workId, accountId: change === "other account's work" ? "other" : AVATAR.accountId,
        platformId: change === "other platform's work" ? "bilibili" : "douyin" });
      expect(f.authorize(COVER, origin()).state).toBe("unavailable");
      expect(f.network.check).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it("waits without creating a session or changing proxy settings when domestic access is closed", () => {
    const f = fixture();
    f.setAllowed(false);
    expect(f.authorize(AVATAR, origin()).state).toBe("waiting-network");
    expect(f.getSession).not.toHaveBeenCalled();
    expect(f.network.acquire).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("waits when no configured account session exists", () => {
    const f = fixture();
    f.replaceSession(null);
    expect(f.authorize(AVATAR, origin()).state).toBe("waiting-network");
    expect(f.network.acquire).not.toHaveBeenCalled();
  });

  it.each(["network revoked", "account deleted", "session replaced", "work deleted", "mode changed", "lease aborted"])(
    "retires a grant after %s", async (change) => {
      const f = fixture();
      const authorized = grant(f, COVER);
      if (change === "network revoked") f.setAllowed(false);
      else if (change === "account deleted") f.setAccount(null);
      else if (change === "session replaced") f.replaceSession({ fetch: vi.fn() });
      else if (change === "work deleted") f.setWork(null);
      else if (change === "mode changed") f.setExclusive(false);
      else f.abort.abort();
      expect(authorized.lease.isCurrent()).toBe(false);
      expect(authorized.lease.signal.aborted).toBe(true);
      await expect(authorized.session.fetch("https://p3.douyinpic.com/image", request())).rejects.toThrow();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["https://i0.hdslb.com/image", {}], ["https://user:secret@p3.douyinpic.com/image", {}],
    ["https://p3.douyinpic.com:8443/image", {}], ["https://p3.douyinpic.com/image#x", {}],
    ["http://p3.douyinpic.com/image", {}], ["https://p3.douyinpic.com/image", { credentials: "include" }],
    ["https://p3.douyinpic.com/image", { method: "POST" }],
    ["https://p3.douyinpic.com/image", { redirect: "follow" }],
    ["https://p3.douyinpic.com/image", { headers: { Cookie: "synthetic", Accept: "image/png,image/jpeg,image/webp" } }],
  ])("does not allow grant reuse for URL/options outside the approved anonymous image request", async (url, patch) => {
    const f = fixture();
    const authorized = grant(f);
    await expect(authorized.session.fetch(url as string, { ...request(), ...patch as RequestInit })).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    authorized.lease.release();
  });

  it("checks the exact full image URL again even if the origin was admitted", async () => {
    const f = fixture();
    const authorized = grant(f);
    vi.mocked(f.network.check).mockImplementation((_accountId, url) => ({
      allowed: url === "https://p3.douyinpic.com/", reason: "UNKNOWN_TARGET",
    }));
    await expect(authorized.session.fetch("https://p3.douyinpic.com/private-image", request())).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(authorized.lease.isCurrent()).toBe(false);
  });

  it("rejects a response completed after revocation", async () => {
    const f = fixture();
    let complete!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const authorized = grant(f);
    const pending = authorized.session.fetch("https://p3.douyinpic.com/image", request());
    f.setAllowed(false);
    complete(new Response(new Uint8Array([1])));
    await expect(pending).rejects.toThrow();
    expect(authorized.lease.signal.aborted).toBe(true);
  });
});
