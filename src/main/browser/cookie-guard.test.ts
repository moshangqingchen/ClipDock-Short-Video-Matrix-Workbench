import { describe, expect, it, vi } from "vitest";
import type { Cookie } from "electron";
import { CookieGuard } from "./cookie-guard";

interface Listener {
  (event: unknown, cookie: Cookie, cause: string, removed: boolean): void;
}

function fakeSession() {
  const listeners = new Set<Listener>();
  const set = vi.fn(async () => undefined);
  const flushStore = vi.fn(async () => undefined);
  const get = vi.fn(async () => [] as Cookie[]);
  return {
    session: {
      cookies: {
        on: (_event: string, listener: Listener) => listeners.add(listener),
        removeListener: (_event: string, listener: Listener) => listeners.delete(listener),
        set,
        get,
        flushStore,
      },
    } as never,
    emit: (cookie: Cookie, removed = false) => listeners.forEach((l) => l({}, cookie, "explicit", removed)),
    set,
    flushStore,
    get,
  };
}

const sessionCookie = (domain: string, name: string): Cookie =>
  ({
    domain,
    name,
    value: "v",
    path: "/",
    secure: true,
    httpOnly: true,
    session: true,
    hostOnly: false,
    sameSite: "lax",
  }) as Cookie;

describe("CookieGuard", () => {
  it("re-sets session cookies on login domains with an expiry", async () => {
    const fake = fakeSession();
    const guard = new CookieGuard(fake.session, "weixin_channels");
    fake.emit(sessionCookie("channels.weixin.qq.com", "sessionid"));
    await Promise.resolve();
    expect(fake.set).toHaveBeenCalledTimes(1);
    const arg = fake.set.mock.calls[0][0] as unknown as { name: string; expirationDate: number; url: string };
    expect(arg.name).toBe("sessionid");
    expect(arg.url).toBe("https://channels.weixin.qq.com/");
    expect(arg.expirationDate).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
    guard.dispose();
  });

  it("ignores persistent cookies, removals and unrelated domains", async () => {
    const fake = fakeSession();
    const guard = new CookieGuard(fake.session, "douyin");
    fake.emit({ ...sessionCookie(".douyin.com", "sessionid_ss"), session: false } as Cookie);
    fake.emit(sessionCookie(".douyin.com", "sessionid_ss"), true);
    fake.emit(sessionCookie(".tracker.example", "sessionid_ss"));
    await Promise.resolve();
    expect(fake.set).not.toHaveBeenCalled();
    guard.dispose();
  });

  it("debounces flushStore after changes", async () => {
    vi.useFakeTimers();
    const fake = fakeSession();
    const guard = new CookieGuard(fake.session, "bilibili");
    fake.emit(sessionCookie(".bilibili.com", "SESSDATA"));
    fake.emit(sessionCookie(".bilibili.com", "bili_jct"));
    expect(fake.flushStore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fake.flushStore).toHaveBeenCalledTimes(1);
    guard.dispose();
    vi.useRealTimers();
  });

  it("persistExisting converts already-present session cookies", async () => {
    const fake = fakeSession();
    fake.get.mockResolvedValueOnce([
      sessionCookie(".kuaishou.com", "kuaishou.web.cp.api_ph"),
      { ...sessionCookie(".kuaishou.com", "did"), session: false } as Cookie,
    ]);
    const guard = new CookieGuard(fake.session, "kuaishou");
    await guard.persistExisting();
    expect(fake.set).toHaveBeenCalledTimes(1);
    expect(fake.flushStore).toHaveBeenCalled();
    guard.dispose();
  });
});
