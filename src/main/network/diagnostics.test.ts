import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnonymousDiagnostics } from "./diagnostics";

const factory = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ session: { fromPartition: factory } }));

interface FakeSession {
  fetch: ReturnType<typeof vi.fn>;
  setProxy: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
  clearStorageData: ReturnType<typeof vi.fn>;
  clearHostResolverCache: ReturnType<typeof vi.fn>;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const settle = async () => {
  for (let n = 0; n < 40; n++) await Promise.resolve();
};
function fixture(
  reply: (url: string, options: RequestInit) => Promise<Response>,
  configure?: (ses: FakeSession, index: number) => void,
) {
  const events: string[] = [];
  const sessions: FakeSession[] = [];
  factory.mockImplementation((name: string) => {
    const ses = {
      setProxy: vi.fn(async () => {
        events.push(`proxy:${name}`);
      }),
      closeAllConnections: vi.fn(async () => {
        events.push(`close:${name}`);
      }),
      clearStorageData: vi.fn(async () => undefined),
      clearHostResolverCache: vi.fn(async () => undefined),
      fetch: vi.fn((url: string, options: RequestInit) => {
        events.push(`fetch:${name}`);
        return reply(url, options);
      }),
    };
    configure?.(ses, sessions.length);
    sessions.push(ses);
    return ses;
  });
  return { events, sessions };
}

beforeEach(() => factory.mockReset());

describe("anonymous diagnostic transport", () => {
  it("clears connection pools before anonymous requests and returns only masked, unverified evidence", async () => {
    const setup = fixture(async (url) => {
      if (url.includes("ipwho.is")) {
        const ip = new URL(url).pathname.slice(1);
        return Response.json({ success: true, ip, country_code: "CN", connection: { asn: 64500 } });
      }
      return new Response(url.includes("myip.ipip.net") ? "203.0.113.9" : "ip=198.51.100.7\n");
    });
    const diagnostics = new AnonymousDiagnostics();
    const result = await diagnostics.run(10090);
    expect(result.direct).toMatchObject({
      state: "reachable",
      country: "CN",
      maskedIp: "203.0.*.*",
      routeVerified: false,
    });
    expect(result.proxy.maskedIp).toBe("198.51.*.*");
    expect(JSON.stringify(result)).not.toContain("203.0.113.9");
    for (const [name] of factory.mock.calls) {
      expect(name).not.toMatch(/^persist:/);
      expect(setup.events.indexOf(`close:${name}`)).toBeGreaterThan(setup.events.indexOf(`proxy:${name}`));
      expect(setup.events.indexOf(`fetch:${name}`)).toBeGreaterThan(setup.events.indexOf(`close:${name}`));
    }
    for (const ses of setup.sessions)
      for (const [, options] of ses.fetch.mock.calls) {
        expect(options).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
        expect(options.headers).toBeUndefined();
      }
    diagnostics.stop();
  });

  it("aborts oversized response streams before IP lookup", async () => {
    const signals: AbortSignal[] = [];
    const urls: string[] = [];
    fixture(async (url, options) => {
      urls.push(url);
      signals.push(options.signal!);
      return new Response("x".repeat(32769));
    });
    const diagnostics = new AnonymousDiagnostics();
    const result = await diagnostics.run(10090);
    expect(result.direct.state).toBe("unavailable");
    expect(result.proxy.state).toBe("unavailable");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(urls.some((url) => url.includes("ipwho.is"))).toBe(false);
    diagnostics.stop();
  });

  it("does not start a second request after stopping a completed echo request", async () => {
    const urls: string[] = [];
    const diagnostics = new AnonymousDiagnostics();
    fixture(async (url) => {
      urls.push(url);
      const bytes = new TextEncoder().encode(
        url.includes("myip.ipip.net") ? "203.0.113.9" : "ip=198.51.100.7\n",
      );
      let emitted = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (!emitted) {
              emitted = true;
              controller.enqueue(bytes);
            } else {
              controller.close();
              diagnostics.stop();
            }
          },
        }),
      );
    });
    const result = await diagnostics.run(10090);
    expect(urls.some((url) => url.includes("ipwho.is"))).toBe(false);
    expect(result.direct.state).toBe("unavailable");
    expect(result.proxy.state).toBe("unavailable");
  });
});

describe("anonymous diagnostic pause and native drain", () => {
  it("closes new work synchronously, including before any Session exists, and resume does not run", async () => {
    fixture(async () => new Response("unavailable"));
    const d = new AnonymousDiagnostics();
    const paused = d.pause();
    expect((await d.run(10090)).direct.state).toBe("unavailable");
    expect(factory).not.toHaveBeenCalled();
    await paused;
    d.resume();
    expect(factory).not.toHaveBeenCalled();
    await d.run(10090);
    expect(factory).toHaveBeenCalledTimes(2);
    await d.pause();
  });

  it.each([0, 1])(
    "waits for late %s Session initialization and closes it again without fetching",
    async (index) => {
      const init = deferred();
      const f = fixture(
        async () => new Response("unavailable"),
        (ses, current) => {
          if (current === index) ses.setProxy.mockReturnValue(init.promise);
        },
      );
      const d = new AnonymousDiagnostics(),
        pending = d.run(10090);
      await settle();
      expect(f.sessions).toHaveLength(index + 1);
      let idle = false;
      const paused = d.pause().then(() => {
        idle = true;
      });
      await settle();
      expect(idle).toBe(false);
      expect((await d.run(7890)).direct.state).toBe("unavailable");
      init.resolve();
      expect((await pending).direct.state).toBe("unavailable");
      await paused;
      expect(idle).toBe(true);
      expect(f.sessions.every((ses) => ses.fetch.mock.calls.length === 0)).toBe(true);
      expect(factory).toHaveBeenCalledTimes(index + 1);
      for (const ses of f.sessions) {
        expect(ses.closeAllConnections.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(ses.clearStorageData).toHaveBeenCalledWith({ storages: ["cookies"] });
      }
    },
  );

  it("waits for a late native response and its actual body cancel before declaring pause complete", async () => {
    const response = deferred(),
      cancelled = deferred();
    const signals: AbortSignal[] = [];
    const f = fixture(async (_url, options) => {
      signals.push(options.signal!);
      await response.promise;
      return new Response(new ReadableStream({ cancel: () => cancelled.promise }));
    });
    const d = new AnonymousDiagnostics(),
      run = d.run(10090);
    await settle();
    expect(signals).toHaveLength(2);
    let idle = false;
    const paused = d.pause().then(() => {
      idle = true;
    });
    await settle();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(idle).toBe(false);
    // Separate bodies for the two responses, each retaining its real asynchronous cancel work.
    response.resolve();
    await settle();
    expect(idle).toBe(false);
    cancelled.resolve();
    await run;
    await paused;
    expect(idle).toBe(true);
    expect(f.sessions.flatMap((ses) => ses.fetch.mock.calls)).toHaveLength(2);
  });

  it("cancels an already pending stream read and waits for its asynchronous cancel", async () => {
    const cancel = deferred();
    const f = fixture(async () => new Response(new ReadableStream({ cancel: () => cancel.promise })));
    const d = new AnonymousDiagnostics(),
      run = d.run(10090);
    await settle();
    let idle = false;
    const paused = d.pause().then(() => {
      idle = true;
    });
    await settle();
    expect(idle).toBe(false);
    cancel.resolve();
    await run;
    await paused;
    expect(f.sessions.flatMap((ses) => ses.fetch.mock.calls)).toHaveLength(2);
  });

  it("retains the busy slot until final cookie and connection cleanup finishes", async () => {
    const clear = deferred(),
      f = fixture(
        async () => new Response("unavailable"),
        (ses) => {
          ses.clearStorageData.mockReturnValue(clear.promise);
        },
      );
    const d = new AnonymousDiagnostics(),
      run = d.run(10090);
    await settle();
    let idle = false;
    const paused = d.pause().then(() => {
      idle = true;
    });
    await settle();
    expect(idle).toBe(false);
    expect((await d.run(7890)).direct.state).toBe("unavailable");
    expect(factory).toHaveBeenCalledTimes(2);
    clear.resolve();
    await run;
    await paused;
    expect(f.sessions.every((ses) => ses.closeAllConnections.mock.calls.length > 1)).toBe(true);
  });

  it("drains an errored stream whose cancel rejects, then waits for verified native closure without poisoning it", async () => {
    const closed = deferred();
    const f = fixture(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("ordinary-response-abort"));
            },
          }),
        ),
      (ses) => {
        let calls = 0;
        ses.closeAllConnections.mockImplementation(async () => {
          if (++calls > 1) await closed.promise;
        });
      },
    );
    const d = new AnonymousDiagnostics(),
      run = d.run(10090);
    await settle();
    expect(f.sessions).toHaveLength(2);
    let idle = false;
    const pause = d.pause().then(() => {
      idle = true;
    });
    await settle();
    expect(idle).toBe(false);
    closed.resolve();
    expect((await run).direct.state).toBe("unavailable");
    await pause;
    await expect(d.whenIdle()).resolves.toBeUndefined();
    d.resume();
    await d.run(10090);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(f.sessions.every((ses) => ses.fetch.mock.calls.length === 2)).toBe(true);
    await d.pause();
  });

  it.each(["clearStorageData", "closeAllConnections"] as const)(
    "does not heal failed %s cleanup by creating new sessions",
    async (method) => {
      const f = fixture(async () => new Response("unavailable"));
      const d = new AnonymousDiagnostics();
      await d.run(10090);
      f.sessions[0][method].mockRejectedValue(Error("private-cleanup-error"));
      await expect(d.pause()).rejects.toThrow("DIAGNOSTICS_CLEANUP_FAILED");
      await expect(d.whenIdle()).rejects.toThrow("DIAGNOSTICS_CLEANUP_FAILED");
      d.resume();
      expect((await d.run(7890)).direct.state).toBe("unavailable");
      expect(factory).toHaveBeenCalledTimes(2);
    },
  );

  it("stop cancels one lifetime without permanently pausing future explicit diagnostics", async () => {
    fixture(async () => new Response("unavailable"));
    const d = new AnonymousDiagnostics();
    await d.run(10090);
    const calls = factory.mock.calls.length;
    d.stop();
    await d.whenIdle();
    await d.run(10090);
    expect(factory).toHaveBeenCalledTimes(calls);
    await d.pause();
  });
});
