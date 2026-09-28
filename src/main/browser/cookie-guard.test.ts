import { describe, expect, it, vi } from "vitest";
import type { Cookie } from "electron";
import { CookieGuard, flushCookieGuards } from "./cookie-guard";

interface Listener {
  (event: unknown, cookie: Cookie, cause: string, removed: boolean): void;
}

function fakeSession() {
  const listeners = new Set<Listener>();
  const jar = new Map<string, Cookie>();
  const key = (cookie: Cookie) => `${cookie.domain}\n${cookie.path ?? "/"}\n${cookie.name}`;
  const emit = (cookie: Cookie, removed = false) => {
    if (removed) jar.delete(key(cookie));
    else jar.set(key(cookie), cookie);
    listeners.forEach((l) => l({}, cookie, "explicit", removed));
  };
  const set = vi.fn(async (details: Electron.CookiesSetDetails) => {
    emit({ ...details, domain: details.domain ?? new URL(details.url).hostname,
      hostOnly: !details.domain, session: details.expirationDate === undefined } as Cookie);
  });
  const flushStore = vi.fn(async () => undefined);
  const get = vi.fn(async () => [...jar.values()]);
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
    emit,
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
  it.each(["sessionid", "__Host-session"])("preserves host-only scope for %s", async (name) => {
    const fake = fakeSession(), guard = new CookieGuard(fake.session, "weixin_channels");
    fake.emit({ ...sessionCookie("channels.weixin.qq.com", name), hostOnly: true });
    await guard.flush();
    expect(fake.set.mock.calls[0][0]).not.toHaveProperty("domain");
    expect(fake.set.mock.calls[0][0]).toMatchObject({ path: "/", secure: true, httpOnly: true, sameSite: "lax" });
    guard.dispose();
  });
  it("drains an already-issued native write after view disposal before flushing/reset", async () => {
    const fake = fakeSession(), guard = new CookieGuard(fake.session, "weixin_channels");
    let finish!: () => void;
    fake.set.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    fake.emit(sessionCookie(".weixin.qq.com", "sessionid"));
    guard.dispose();
    const flushed = flushCookieGuards(fake.session);
    await Promise.resolve();
    expect(fake.flushStore).not.toHaveBeenCalled();
    finish();
    expect(await flushed).toBe(true);
    expect(fake.flushStore).toHaveBeenCalledOnce();
  });
  it("does not resurrect cookies from a late startup read after dispose", async () => {
    const fake = fakeSession(), guard = new CookieGuard(fake.session, "weixin_channels");
    let finish!: (cookies: Cookie[]) => void;
    fake.get.mockImplementationOnce(() => new Promise<Cookie[]>((resolve) => { finish = resolve; }));
    const restored = guard.persistExisting();
    guard.dispose();
    finish([sessionCookie(".weixin.qq.com", "sessionid")]);
    await restored;
    expect(fake.set).not.toHaveBeenCalled();
  });
  it("ignores a stale startup value when the same cookie has rotated", async () => {
    const fake = fakeSession(), guard = new CookieGuard(fake.session, "weixin_channels");
    let finish!: (cookies: Cookie[]) => void;
    fake.get.mockImplementationOnce(() => new Promise<Cookie[]>((resolve) => { finish = resolve; }));
    const restored = guard.persistExisting();
    fake.emit({ ...sessionCookie(".weixin.qq.com", "sessionid"), value: "new" });
    finish([{ ...sessionCookie(".weixin.qq.com", "sessionid"), value: "old" }]);
    await restored;
    expect(fake.set).toHaveBeenCalledOnce();
    expect(fake.set.mock.calls[0][0]).toMatchObject({ value: "new" });
    guard.dispose();
  });
  it("reports native failure without including the cookie value or error message", async () => {
    const fake = fakeSession(), diagnostic = vi.fn();
    const guard = new CookieGuard(fake.session, "weixin_channels", { onDiagnostic: diagnostic });
    fake.set.mockRejectedValueOnce(new Error("secret failure"));
    fake.emit({ ...sessionCookie(".weixin.qq.com", "sessionid"), value: "SECRET_COOKIE" });
    expect(await guard.flush()).toBe(false);
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ phase: "persist", outcome: "failed" }));
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ phase: "flush", outcome: "failed" }));
    expect(await flushCookieGuards(fake.session)).toBe(false);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/SECRET_COOKIE|secret failure|"value"/);
    fake.emit(sessionCookie(".weixin.qq.com", "sessionid"), true);
    guard.dispose();
  });
  it("retains unresolved failures after view disposal until the current cookie is removed", async () => {
    const fake = fakeSession(), guard = new CookieGuard(fake.session, "weixin_channels");
    const cookie = sessionCookie("channels.weixin.qq.com", "sessionid");
    fake.set.mockRejectedValueOnce(new Error("write failed"));
    fake.emit(cookie);
    expect(await guard.flush()).toBe(false);
    guard.dispose();
    expect(await flushCookieGuards(fake.session)).toBe(false);
    fake.emit(cookie, true);
    expect(await flushCookieGuards(fake.session)).toBe(true);
    fake.flushStore.mockClear();
    expect(await flushCookieGuards(fake.session)).toBe(true);
    expect(fake.flushStore).not.toHaveBeenCalled();
  });
  it("does not let a disposed guard's late failure poison a persistent replacement in the same session", async () => {
    const fake = fakeSession(), old = new CookieGuard(fake.session, "weixin_channels");
    const cookie = sessionCookie("channels.weixin.qq.com", "sessionid");
    let rejectOld!: (error: Error) => void;
    fake.set.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
    fake.emit(cookie);
    old.dispose();
    const current = new CookieGuard(fake.session, "weixin_channels");
    fake.emit({ ...cookie, value: "new", session: false, expirationDate: Date.now() / 1000 + 86400 });
    const flushed = flushCookieGuards(fake.session);
    rejectOld(new Error("old write failed"));
    expect(await flushed).toBe(true);
    expect(await flushCookieGuards(fake.session)).toBe(true);
    current.dispose();
  });
  it("waits for the replacement guard's pending write before judging an old guard's failure", async () => {
    const fake = fakeSession(), old = new CookieGuard(fake.session, "weixin_channels");
    const cookie = sessionCookie("channels.weixin.qq.com", "sessionid");
    fake.set.mockRejectedValueOnce(new Error("write failed"));
    fake.emit(cookie);
    expect(await old.flush()).toBe(false);
    old.dispose();
    const current = new CookieGuard(fake.session, "weixin_channels");
    let finish!: () => void;
    fake.set.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    fake.emit({ ...cookie, value: "rotated" });
    fake.flushStore.mockClear();
    const flushed = flushCookieGuards(fake.session);
    await Promise.resolve();
    expect(fake.flushStore).not.toHaveBeenCalled();
    fake.emit({ ...cookie, value: "rotated", session: false, expirationDate: Date.now() / 1000 + 86400 });
    finish();
    expect(await flushed).toBe(true);
    current.dispose();
  });
  it.each([false, true])("does not clear a new failed rotation with a stale jar snapshot (replacement guard: %s)", async (replace) => {
    const fake = fakeSession(), old = new CookieGuard(fake.session, "weixin_channels");
    const cookie = sessionCookie("channels.weixin.qq.com", "sessionid");
    fake.set.mockRejectedValue(new Error("write failed"));
    fake.emit(cookie);
    expect(await old.flush()).toBe(false);
    if (replace) old.dispose();
    let finishRead!: (cookies: Cookie[]) => void;
    fake.get.mockImplementationOnce(() => new Promise<Cookie[]>((resolve) => { finishRead = resolve; }));
    const flushed = old.flush();
    await Promise.resolve();
    const current = replace ? new CookieGuard(fake.session, "weixin_channels") : old;
    fake.emit({ ...cookie, value: "new-failed-value" });
    await Promise.resolve();
    finishRead([]);
    expect(await flushed).toBe(false);
    expect(await flushCookieGuards(fake.session)).toBe(false);
    fake.emit(cookie, true);
    expect(await flushCookieGuards(fake.session)).toBe(true);
    current.dispose();
  });
  it("retains disposed failures when reading the current jar fails", async () => {
    const fake = fakeSession(), guard = new CookieGuard(fake.session, "weixin_channels");
    const cookie = sessionCookie("channels.weixin.qq.com", "sessionid");
    fake.set.mockRejectedValueOnce(new Error("write failed"));
    fake.emit(cookie);
    expect(await guard.flush()).toBe(false);
    guard.dispose();
    fake.get.mockRejectedValueOnce(new Error("read failed"));
    expect(await flushCookieGuards(fake.session)).toBe(false);
    expect(await flushCookieGuards(fake.session)).toBe(false);
    fake.emit(cookie, true);
    expect(await flushCookieGuards(fake.session)).toBe(true);
  });
  it("recovers a failed persistence result when the same cookie is saved successfully", async () => {
    const fake = fakeSession(), guard = new CookieGuard(fake.session, "weixin_channels");
    fake.set.mockRejectedValueOnce(new Error("write failed"));
    fake.emit(sessionCookie("channels.weixin.qq.com", "sessionid"));
    expect(await guard.flush()).toBe(false);
    fake.emit({ ...sessionCookie("channels.weixin.qq.com", "sessionid"), value: "rotated" });
    expect(await guard.flush()).toBe(true);
    guard.dispose();
  });
  it("clears only the failure superseded by a platform deletion", async () => {
    const fake = fakeSession(), guard = new CookieGuard(fake.session, "weixin_channels");
    fake.set.mockRejectedValue(new Error("write failed"));
    const first = sessionCookie("channels.weixin.qq.com", "sessionid");
    const second = sessionCookie("channels.weixin.qq.com", "wxuin");
    fake.emit(first);
    fake.emit(second);
    expect(await guard.flush()).toBe(false);
    fake.emit(first, true);
    expect(await guard.flush()).toBe(false);
    fake.emit(second, true);
    expect(await guard.flush()).toBe(true);
    guard.dispose();
  });
  it("ignores a late rejected write after a newer persistent cookie arrives", async () => {
    const fake = fakeSession(), guard = new CookieGuard(fake.session, "weixin_channels");
    let reject!: (error: Error) => void;
    fake.set.mockImplementationOnce(() => new Promise<void>((_resolve, no) => { reject = no; }));
    const cookie = sessionCookie("channels.weixin.qq.com", "sessionid");
    fake.emit(cookie);
    fake.emit({ ...cookie, session: false, expirationDate: Date.now() / 1000 + 86400 });
    reject(new Error("old write failed"));
    expect(await guard.flush()).toBe(true);
    guard.dispose();
  });
  it("bounds a stalled flush and reports timeout", async () => {
    vi.useFakeTimers();
    const fake = fakeSession(), diagnostic = vi.fn();
    const guard = new CookieGuard(fake.session, "weixin_channels", { onDiagnostic: diagnostic });
    fake.flushStore.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = guard.flush(50);
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toBe(false);
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: "timeout" }));
    guard.dispose();
    vi.useRealTimers();
  });
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
