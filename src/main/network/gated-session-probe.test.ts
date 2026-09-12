import { EventEmitter } from "node:events";
import type { Session } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBusinessNetwork, NetworkDormantError } from "./business-access";
import { gatedSessionProbe } from "./gated-session-probe";

const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", () => ({ net: { request: mocked.request } }));

const accountId = "synthetic-account";
const url = "https://api.bilibili.com/x/web-interface/nav";
const session = {} as Session;
const cleanups: Array<() => void> = [];

function fixture(initiallyAllowed = true) {
  let allowed = initiallyAllowed;
  const lease = new AbortController();
  const release = vi.fn();
  const check = vi.fn((_account: string, target?: string) => ({
    allowed: allowed && target !== "https://api.bilibili.com/denied",
    reason: "CHECKING" as const,
  }));
  cleanups.push(
    installBusinessNetwork({
      enforcement: "strict",
      check,
      acquire: () => ({ signal: lease.signal, isCurrent: () => !lease.signal.aborted, release }),
    }),
  );
  const request = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    abort: vi.fn(),
    followRedirect: vi.fn(),
  });
  mocked.request.mockReturnValue(request);
  return {
    request,
    release,
    check,
    revoke() {
      allowed = false;
      lease.abort();
    },
  };
}

function response(request: EventEmitter, status = 200, text = '{"code":0,"data":{"isLogin":true}}') {
  const incoming = Object.assign(new EventEmitter(), { statusCode: status });
  request.emit("response", incoming);
  if (text) incoming.emit("data", Buffer.from(text));
  incoming.emit("end");
  incoming.emit("close");
  return incoming;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("session probes with observed redirect targets", () => {
  it("does not construct a request while closed", async () => {
    fixture(false);
    await expect(gatedSessionProbe(accountId, session, url)).rejects.toBeInstanceOf(NetworkDormantError);
    expect(mocked.request).not.toHaveBeenCalled();
  });

  it("uses the exact Session and returns the initial target only with manual redirects", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = gatedSessionProbe(accountId, session, url);
    response(f.request);
    await expect(pending).resolves.toMatchObject({
      status: 200,
      url,
      text: expect.stringContaining('"isLogin":true'),
    });
    expect(mocked.request).toHaveBeenCalledWith(
      expect.objectContaining({
        session,
        url,
        credentials: "include",
        redirect: "manual",
        method: "GET",
        cache: "no-store",
        bypassCustomProtocolHandlers: true,
      }),
    );
    expect(f.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([301, 302, 303, 307, 308])(
    "tracks an actual same-origin %s and checks its next target",
    async (status) => {
      const f = fixture();
      const final = "https://api.bilibili.com/actual-final?fixture=yes";
      const pending = gatedSessionProbe(accountId, session, url);
      f.request.emit("redirect", status, "GET", final, {});
      expect(f.check).toHaveBeenCalledWith(accountId, final);
      expect(f.request.followRedirect).toHaveBeenCalledOnce();
      response(f.request);
      await expect(pending).resolves.toMatchObject({ status: 200, url: final });
    },
  );

  it.each([
    "https://passport.bilibili.com/positive",
    "http://api.bilibili.com/positive",
    "https://api.bilibili.com:444/positive",
    "https://user:secret@api.bilibili.com/positive",
    "not-an-absolute-url",
  ])("does not send a disallowed redirect target %s", async (location) => {
    const f = fixture();
    const pending = gatedSessionProbe(accountId, session, url);
    f.request.emit("redirect", 302, "GET", location, {});
    await expect(pending).resolves.toEqual({ status: 302, text: "", url });
    expect(f.request.followRedirect).not.toHaveBeenCalled();
    expect(f.request.abort).toHaveBeenCalled();
  });

  it("rejects an otherwise same-origin hop without current permission", async () => {
    const f = fixture();
    const pending = gatedSessionProbe(accountId, session, url);
    f.request.emit("redirect", 307, "GET", "https://api.bilibili.com/denied", {});
    await expect(pending).rejects.toBeInstanceOf(NetworkDormantError);
    expect(f.request.followRedirect).not.toHaveBeenCalled();
  });

  it("stops redirect loops after five approved hops", async () => {
    const f = fixture();
    const pending = gatedSessionProbe(accountId, session, url);
    for (let index = 0; index < 6; index++) f.request.emit("redirect", 302, "GET", url, {});
    await expect(pending).resolves.toEqual({ status: 302, text: "", url });
    expect(f.request.followRedirect).toHaveBeenCalledTimes(5);
  });

  it("preserves revocation while waiting for the response body", async () => {
    const f = fixture();
    const pending = gatedSessionProbe(accountId, session, url);
    const incoming = Object.assign(new EventEmitter(), { statusCode: 200 });
    f.request.emit("response", incoming);
    incoming.emit("data", Buffer.from('{"partial":'));
    expect(f.release).not.toHaveBeenCalled();
    f.revoke();
    incoming.emit("end");
    await expect(pending).rejects.toMatchObject({ code: "NETWORK_DORMANT", reason: "GATE_REVOKED" });
    expect(f.request.abort).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("honors caller cancellation without reporting a gate revocation", async () => {
    const f = fixture();
    const caller = new AbortController();
    const pending = gatedSessionProbe(accountId, session, url, { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("does not construct transport for an already-aborted caller", async () => {
    fixture();
    const signal = AbortSignal.abort();
    await expect(gatedSessionProbe(accountId, session, url, { signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mocked.request).not.toHaveBeenCalled();
  });

  it("times out an unanswered request and releases its lease", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = gatedSessionProbe(accountId, session, url);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(f.request.abort).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds body bytes and stops the transport when the limit is reached", async () => {
    const f = fixture();
    const pending = gatedSessionProbe(accountId, session, url);
    response(f.request, 200, "a".repeat(30_000));
    await expect(pending).resolves.toMatchObject({ status: 200, text: "" });
    expect(f.request.abort).toHaveBeenCalled();
  });

  it("rejects an aborted response instead of treating partial JSON as a successful probe", async () => {
    const f = fixture();
    const pending = gatedSessionProbe(accountId, session, url);
    const incoming = Object.assign(new EventEmitter(), { statusCode: 200 });
    f.request.emit("response", incoming);
    incoming.emit("data", Buffer.from('{"code":0,'));
    incoming.emit("aborted");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
