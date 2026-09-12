import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnonymousProofProbe,
  ANONYMOUS_TLS_FACTORY_ID,
  type AnonymousTlsObserverContext,
  type AnonymousTlsObserverTiming,
} from "./anonymous-proof-probe";

const electron = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  hasSwitch: vi.fn(),
  listeners: new Set<(...args: any[]) => void>(),
  defaultSessionAccess: vi.fn(() => {
    throw new Error("Must not use default/account Session");
  }),
}));
vi.mock("electron", () => ({
  app: {
    commandLine: { hasSwitch: electron.hasSwitch },
    on: (_event: string, listener: (...args: any[]) => void) => electron.listeners.add(listener),
    off: (_event: string, listener: (...args: any[]) => void) => electron.listeners.delete(listener),
  },
  session: {
    fromPartition: electron.fromPartition,
    get defaultSession() {
      return electron.defaultSessionAccess();
    },
  },
}));

type RequestDetails = { id: number; url: string; method: string };
type BeforeRequest = (details: RequestDetails, cb: (reply: { cancel: boolean }) => void) => void;
type BeforeHeaders = (
  details: RequestDetails & { requestHeaders: Record<string, string> },
  cb: (reply: { requestHeaders: Record<string, string> }) => void,
) => void;
type ReceivedHeaders = (
  details: RequestDetails & { statusCode: number; responseHeaders: Record<string, string[]> },
  cb: (reply: { responseHeaders: Record<string, string[]> }) => void,
) => void;
type StartedResponse = (details: RequestDetails & { fromCache: boolean }) => void;
interface Reply {
  status?: number;
  fromCache?: boolean;
  skipHeaders?: boolean;
  skipStarted?: boolean;
  eventId?: number;
  responseHeaders?: Record<string, string[]>;
  body?: ReadableStream<Uint8Array>;
}
interface RequestAtReceiver {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

const probes: AnonymousProofProbe[] = [];
const releasePending: Array<() => void> = [];
beforeEach(() => {
  electron.fromPartition.mockReset();
  electron.hasSwitch.mockReset().mockReturnValue(false);
  electron.defaultSessionAccess.mockClear();
});
afterEach(async () => {
  releasePending.splice(0).forEach((release) => release());
  await Promise.allSettled(probes.splice(0).map((probe) => probe.dispose()));
  await flush();
  expect(electron.listeners.size).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function probe(options?: ConstructorParameters<typeof AnonymousProofProbe>[0]) {
  const instance = new AnonymousProofProbe(options);
  probes.push(instance);
  return instance;
}

function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  releasePending.push(() => resolve(cleanupValue));
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

/** Simulates Chromium's hook order and a receiver, instead of returning fetch success directly. */
function fixture(
  options: {
    reply?: (request: RequestAtReceiver) => Promise<Reply>;
    honorAbort?: boolean;
    beforeProxy?: () => Promise<void>;
    beforeClose?: () => Promise<void>;
    beforeResolverClear?: () => Promise<void>;
    ambientHeaders?: Record<string, string>;
    initialCookies?: Array<{ name: string; value: string }>;
    failStorage?: boolean;
    beforeStorage?: () => Promise<void>;
    beforeAuth?: () => Promise<void>;
  } = {},
) {
  const sequence: string[] = [];
  const receiver: RequestAtReceiver[] = [];
  const bodiesCancelled: string[] = [];
  const responseHeadersAtClient: Array<Record<string, string[]>> = [];
  let nextId = 0;
  const sessions: Array<ReturnType<typeof makeSession>> = [];

  function makeSession(partition: string) {
    let beforeRequest!: BeforeRequest;
    let beforeHeaders!: BeforeHeaders;
    let receivedHeaders!: ReceivedHeaders;
    let responseStarted!: StartedResponse;
    let cookieJar = [...(options.initialCookies ?? [])];
    const check = (details: RequestDetails) => {
      const callback = vi.fn();
      beforeRequest(details, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      return callback.mock.calls[0][0] as { cancel: boolean };
    };
    const dispatch = async (url: string, init: RequestInit = {}, id = ++nextId): Promise<Response> => {
      const details = { id, url, method: init.method ?? "GET" };
      if (check(details).cancel) throw new Error("ERR_BLOCKED_BY_CLIENT private-provider-url");
      const headersCallback = vi.fn();
      const requestHeaders = {
        Accept: "*/*",
        ...options.ambientHeaders,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      };
      beforeHeaders({ ...details, requestHeaders }, headersCallback);
      expect(headersCallback).toHaveBeenCalledTimes(1);
      const received: RequestAtReceiver = {
        url,
        method: details.method,
        headers: headersCallback.mock.calls[0][0].requestHeaders,
        signal: init.signal as AbortSignal,
      };
      receiver.push(received);
      sequence.push("receiver:" + partition);
      const pending = options.reply?.(received) ?? Promise.resolve({});
      const reply =
        options.honorAbort === false
          ? await pending
          : await new Promise<Reply>((resolve, reject) => {
              const aborted = () => reject(new Error("request aborted private-provider-detail"));
              received.signal.addEventListener("abort", aborted, { once: true });
              if (received.signal.aborted) aborted();
              pending
                .then(resolve, reject)
                .finally(() => received.signal.removeEventListener("abort", aborted));
            });
      const responseDetails = { ...details, id: reply.eventId ?? details.id };
      let sanitizedHeaders = reply.responseHeaders ?? { "Content-Type": ["text/plain"] };
      if (!reply.skipHeaders) {
        const callback = vi.fn();
        receivedHeaders(
          {
            ...responseDetails,
            statusCode: reply.status ?? 200,
            responseHeaders: sanitizedHeaders,
          },
          callback,
        );
        expect(callback).toHaveBeenCalledTimes(1);
        sanitizedHeaders = callback.mock.calls[0][0].responseHeaders;
      }
      responseHeadersAtClient.push(sanitizedHeaders);
      // Chromium would persist an incoming Set-Cookie if the response hook left it intact.
      for (const [key, values] of Object.entries(sanitizedHeaders))
        if (key.toLowerCase() === "set-cookie")
          cookieJar.push(...values.map((value) => ({ name: "response-cookie", value })));
      if (!reply.skipStarted) responseStarted({ ...responseDetails, fromCache: reply.fromCache ?? false });
      const location = Object.entries(sanitizedHeaders).find(
        ([key]) => key.toLowerCase() === "location",
      )?.[1][0];
      if (location && init.redirect !== "manual" && init.redirect !== "error")
        return dispatch(location, init);
      const body =
        reply.body ??
        new ReadableStream<Uint8Array>({
          cancel() {
            bodiesCancelled.push(partition);
          },
        });
      return new Response(body, { status: reply.status ?? 200 });
    };
    const value = {
      partition,
      netLog: { startLogging: vi.fn(async () => {}), stopLogging: vi.fn(async () => {}) },
      allowNTLMCredentialsForDomains: vi.fn(),
      setCertificateVerifyProc: vi.fn(),
      clearAuthCache: vi.fn(async () => {
        await options.beforeAuth?.();
      }),
      webRequest: {
        onBeforeRequest: vi.fn((listener: BeforeRequest) => {
          beforeRequest = listener;
        }),
        onBeforeSendHeaders: vi.fn((listener: BeforeHeaders) => {
          beforeHeaders = listener;
        }),
        onHeadersReceived: vi.fn((listener: ReceivedHeaders) => {
          receivedHeaders = listener;
        }),
        onResponseStarted: vi.fn((listener: StartedResponse) => {
          responseStarted = listener;
        }),
      },
      setProxy: vi.fn(async (config: unknown) => {
        sequence.push("proxy:" + partition);
        expect(config).toEqual({ mode: "direct" });
        await options.beforeProxy?.();
      }),
      closeAllConnections: vi.fn(async () => {
        sequence.push("close:" + partition);
        await options.beforeClose?.();
      }),
      clearHostResolverCache: vi.fn(async () => {
        await options.beforeResolverClear?.();
      }),
      cookies: { get: vi.fn(async () => [...cookieJar]) },
      clearStorageData: vi.fn(async () => {
        sequence.push("clear:" + partition);
        await options.beforeStorage?.();
        if (options.failStorage) throw new Error("private-cookie-storage-detail");
        cookieJar = [];
      }),
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        sequence.push("fetch:" + partition);
        return dispatch(url, init);
      }),
      attempt: (url: string, method = "GET", id = ++nextId) => check({ id, url, method }),
    };
    return value;
  }
  electron.fromPartition.mockImplementation((partition: string, config: unknown) => {
    expect(config).toEqual({ cache: false });
    const ses = makeSession(partition);
    sessions.push(ses);
    return ses;
  });
  return { sequence, receiver, sessions, bodiesCancelled, responseHeadersAtClient };
}

const target = { host: "creator.douyin.com", port: 443 };
const freshSignal = () => new AbortController().signal;

describe("AnonymousProofProbe private observation transaction", () => {
  it("starts tracing only after direct, resolver, auth and empty-cookie checks, without exposing Session or Response", async () => {
    const f = fixture();
    const stages: string[] = [];
    let actualContext: AnonymousTlsObserverContext | undefined;
    const result = await probe().probeTls(target, freshSignal(), {
      async beforeSend(context) {
        actualContext = context;
        const ses = f.sessions[0];
        expect(ses.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: "direct" });
        expect(ses.closeAllConnections).toHaveBeenCalledOnce();
        expect(ses.clearHostResolverCache).toHaveBeenCalledTimes(2);
        expect(ses.clearAuthCache).toHaveBeenCalledOnce();
        expect(ses.cookies.get).toHaveBeenCalledExactlyOnceWith({});
        expect(ses.allowNTLMCredentialsForDomains).toHaveBeenCalledWith("");
        expect(ses.setCertificateVerifyProc).toHaveBeenCalledWith(null);
        expect(f.receiver).toHaveLength(0);
        expect(context.trace.netLog).toBe(ses.netLog);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.origin)).toBe(true);
        expect(Object.isFrozen(context.trace)).toBe(true);
        expect(Object.isFrozen(context.trace.netLog)).toBe(false);
        expect(Object.keys(context).sort()).toEqual(
          ["factoryId", "origin", "transportContextId", "signal", "trace"].sort(),
        );
        expect(Object.keys(context.trace)).toEqual(["netLog"]);
        // The observer cannot issue an extra request while no factory GET is reserved.
        expect(ses.attempt("https://creator.douyin.com/robots.txt")).toEqual({ cancel: true });
        stages.push("before");
      },
      headers(context, timing) {
        expect(context).toBe(actualContext);
        expect(Object.isFrozen(timing)).toBe(true);
        expect(Object.keys(timing).sort()).toEqual(
          [
            "requestId",
            "sentAtMono",
            "sentAtWall",
            "headersAtMono",
            "headersAtWall",
            "statusCode",
            "responseFromCache",
          ].sort(),
        );
        expect(timing.requestId).toBeGreaterThan(0);
        expect(timing.statusCode).toBe(200);
        expect(timing.responseFromCache).toBe(false);
        expect(timing.headersAtMono).toBeGreaterThanOrEqual(timing.sentAtMono);
        expect(timing.headersAtWall).toBeGreaterThanOrEqual(timing.sentAtWall);
        expect(f.bodiesCancelled).toHaveLength(0);
        stages.push("headers");
      },
      cleanup(context) {
        expect(context).toBe(actualContext);
        expect(f.bodiesCancelled).toHaveLength(1);
        stages.push("cleanup");
      },
    });
    expect(result.available).toBe(true);
    expect(stages).toEqual(["before", "headers", "cleanup"]);
    expect(f.receiver).toHaveLength(1);
    if (result.available)
      expect(result.observation.transportContextId).toBe(actualContext?.transportContextId);
    expect(JSON.stringify(result)).not.toMatch(/trace|netLog|requestId|sentAtWall/);
  });

  it("preserves actual send/header times while a callback holds the original response", async () => {
    let mono = 100;
    let wall = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => mono);
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    const held = deferred<void>(undefined);
    const f = fixture({
      reply: async () => {
        mono = 130;
        wall = 10_030;
        return {};
      },
    });
    let timing: AnonymousTlsObserverTiming | undefined;
    const pending = probe().probeTls(target, freshSignal(), {
      beforeSend() {
        mono = 120;
        wall = 10_020;
      },
      async headers(_context, captured) {
        timing = captured;
        await held.promise;
      },
    });
    await flush();
    expect(timing).toMatchObject({
      sentAtMono: 120,
      sentAtWall: 10_020,
      headersAtMono: 130,
      headersAtWall: 10_030,
    });
    expect(f.bodiesCancelled).toHaveLength(0);
    mono = 700;
    wall = 10_600;
    held.resolve();
    const result = await pending;
    expect(result.available).toBe(true);
    if (result.available)
      expect(result.observation).toMatchObject({ startedAtMono: 100, completedAtMono: 130 });
    expect(timing?.headersAtMono).toBe(130);
    expect(f.bodiesCancelled).toHaveLength(1);
  });

  it.each(["beforeSend", "headers", "cleanup"] as const)(
    "returns a fixed failure and cleans once after %s throws",
    async (stage) => {
      const f = fixture();
      const cleanup = vi.fn(() => {
        if (stage === "cleanup") throw new Error("synthetic-secret");
      });
      const headers = vi.fn(() => {
        if (stage === "headers") throw new Error("synthetic-secret");
      });
      const result = await probe().probeTls(target, freshSignal(), {
        beforeSend() {
          if (stage === "beforeSend") throw new Error("synthetic-secret");
        },
        headers,
        cleanup,
      });
      expect(result).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(f.receiver).toHaveLength(stage === "beforeSend" ? 0 : 1);
      expect(headers).toHaveBeenCalledTimes(stage === "beforeSend" ? 0 : 1);
    },
  );

  it.each([{ fromCache: true }, { skipStarted: true }, { skipHeaders: true }, { eventId: 9999 }])(
    "does not expose invalid/cached headers to the transaction: %j",
    async (reply) => {
      fixture({ reply: async () => reply });
      const headers = vi.fn(),
        cleanup = vi.fn();
      const result = await probe().probeTls(target, freshSignal(), { headers, cleanup });
      expect(result.available).toBe(false);
      expect(headers).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );

  it.each(["cookies", "resolver", "auth"])(
    "does not start an observer before failed %s privacy preparation",
    async (stage) => {
      const f = fixture({
        initialCookies: stage === "cookies" ? [{ name: "synthetic", value: "private" }] : [],
        beforeResolverClear: async () => {
          if (stage === "resolver") throw new Error();
        },
        beforeAuth: async () => {
          if (stage === "auth") throw new Error();
        },
      });
      const beforeSend = vi.fn(),
        headers = vi.fn(),
        cleanup = vi.fn();
      expect(
        (await probe().probeTls(target, freshSignal(), { beforeSend, headers, cleanup })).available,
      ).toBe(false);
      expect(beforeSend).not.toHaveBeenCalled();
      expect(headers).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(f.receiver).toHaveLength(0);
    },
  );

  it("does not send after beforeSend synchronously revokes its operation", async () => {
    const f = fixture();
    const cancel = new AbortController();
    const cleanup = vi.fn();
    expect(
      await probe().probeTls(target, cancel.signal, {
        beforeSend() {
          cancel.abort();
        },
        cleanup,
      }),
    ).toEqual({
      available: false,
      reason: "PROBE_CANCELLED",
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.receiver).toHaveLength(0);
  });

  it.each(["beforeSend", "headers", "cleanup"] as const)(
    "retains an undrained %s slot after timeout and disposal waits for the real hook",
    async (stage) => {
      vi.useFakeTimers();
      const held = deferred<void>(undefined);
      const f = fixture();
      const p = probe({ concurrency: 1, timeoutMs: 100 });
      const cleanup = vi.fn(async () => {
        if (stage === "cleanup") await held.promise;
      });
      let observedSignal: AbortSignal | undefined;
      const pending = p.probeTls(target, freshSignal(), {
        async beforeSend(context) {
          observedSignal = context.signal;
          if (stage === "beforeSend") await held.promise;
        },
        async headers() {
          if (stage === "headers") await held.promise;
        },
        cleanup,
      });
      await flush();
      await vi.advanceTimersByTimeAsync(2100);
      expect(await pending).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
      expect(observedSignal?.aborted).toBe(true);
      expect(await p.probeTls(target, freshSignal())).toEqual({ available: false, reason: "PROBE_BUSY" });
      expect(electron.fromPartition).toHaveBeenCalledOnce();
      let idle = false;
      const idleWait = p.whenIdle().then(() => {
        idle = true;
      });
      await flush();
      expect(idle).toBe(false);
      let drained = false;
      const disposal = p.dispose().then(() => {
        drained = true;
      });
      await flush();
      expect(drained).toBe(false);
      expect(cleanup).toHaveBeenCalledTimes(stage === "cleanup" ? 1 : 0);
      held.resolve();
      await disposal;
      await idleWait;
      expect(idle).toBe(true);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(f.receiver).toHaveLength(stage === "beforeSend" ? 0 : 1);
    },
  );

  it("whenIdle waits for the outer Session cleanup after a held observer without revoking it", async () => {
    const held = deferred<void>(undefined),
      storage = deferred<void>(undefined);
    const f = fixture({ beforeStorage: () => storage.promise });
    const p = probe({ concurrency: 1 });
    let observerSignal: AbortSignal | undefined;
    const pending = p.probeTls(target, freshSignal(), {
      async headers(context) {
        observerSignal = context.signal;
        await held.promise;
      },
    });
    await flush();
    let idle = false;
    const idleWait = p.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    expect(observerSignal?.aborted).toBe(false);
    held.resolve();
    await flush();
    expect(f.sessions[0].clearStorageData).toHaveBeenCalledOnce();
    expect(idle).toBe(false);
    storage.resolve();
    expect((await pending).available).toBe(true);
    await idleWait;
    expect(idle).toBe(true);
  });

  it("whenIdle includes another observation slot created while its first snapshot drains", async () => {
    fixture();
    const firstHold = deferred<void>(undefined),
      secondHold = deferred<void>(undefined);
    const p = probe({ concurrency: 2 });
    const first = p.probeTls(target, freshSignal(), { headers: () => firstHold.promise });
    await flush();
    let idle = false;
    const idleWait = p.whenIdle().then(() => {
      idle = true;
    });
    const second = p.probeTls({ host: "cp.kuaishou.com", port: 443 }, freshSignal(), {
      headers: () => secondHold.promise,
    });
    await flush();
    firstHold.resolve();
    expect((await first).available).toBe(true);
    await flush();
    expect(idle).toBe(false);
    secondHold.resolve();
    expect((await second).available).toBe(true);
    await idleWait;
    expect(idle).toBe(true);
  });

  it("revokes synchronously but waits for a held header hook before cleanup or Session reuse", async () => {
    const held = deferred<void>(undefined);
    const f = fixture();
    const p = probe({ concurrency: 1 });
    let observedSignal: AbortSignal | undefined;
    const cleanup = vi.fn();
    const pending = p.probeTls(target, freshSignal(), {
      async headers(context) {
        observedSignal = context.signal;
        await held.promise;
      },
      cleanup,
    });
    await flush();
    let drained = false;
    const invalidation = p.invalidate().then(() => {
      drained = true;
    });
    expect(observedSignal?.aborted).toBe(true);
    await flush();
    expect(drained).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await p.probeTls(target, freshSignal())).toEqual({ available: false, reason: "PROBE_BUSY" });
    held.resolve();
    await invalidation;
    expect(await pending).toEqual({ available: false, reason: "PROBE_CANCELLED" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await p.probeTls(target, freshSignal())).available).toBe(true);
    expect(f.sessions).toHaveLength(1);
  });

  it("never reuses a Session whose trace cleanup failed", async () => {
    fixture();
    const p = probe({ concurrency: 1 });
    expect(
      (
        await p.probeTls(target, freshSignal(), {
          cleanup() {
            throw new Error();
          },
        })
      ).available,
    ).toBe(false);
    expect(await p.probeTls(target, freshSignal())).toEqual({ available: false, reason: "PROBE_BUSY" });
    expect(electron.fromPartition).toHaveBeenCalledOnce();
  });
});

describe("AnonymousProofProbe transport isolation", () => {
  it.each(["failure", "cancel"])("does not fetch when resolver clearing ends in %s", async (mode) => {
    const dns = deferred<void>(undefined);
    const f = fixture({
      beforeResolverClear: async () => {
        await dns.promise;
        if (mode === "failure") throw new Error("private-resolver-detail");
      },
    });
    const cancel = new AbortController();
    const result = probe().probeTls(target, cancel.signal);
    await flush();
    expect(f.sessions[0].clearHostResolverCache).toHaveBeenCalledOnce();
    expect(f.receiver).toHaveLength(0);
    if (mode === "cancel") cancel.abort();
    dns.resolve();
    expect((await result).available).toBe(false);
    expect(f.receiver).toHaveLength(0);
  });
  it("uses a bounded anonymous Session, closes old connections after setProxy, and GETs only robots", async () => {
    const proxyReady = deferred<void>(undefined);
    const closeReady = deferred<void>(undefined);
    const f = fixture({ beforeProxy: () => proxyReady.promise, beforeClose: () => closeReady.promise });
    const result = probe().probeTls({ ...target, port: 8443 }, freshSignal());
    await flush();
    expect(f.sessions).toHaveLength(1);
    expect(f.receiver).toHaveLength(0);
    expect(f.sessions[0].closeAllConnections).not.toHaveBeenCalled();
    proxyReady.resolve(undefined);
    await flush();
    expect(f.sessions[0].closeAllConnections).toHaveBeenCalledTimes(1);
    expect(f.sessions[0].fetch).not.toHaveBeenCalled();
    closeReady.resolve(undefined);
    const reply = await result;
    expect(reply.available).toBe(true);
    if (!reply.available) return;
    expect(f.receiver.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "https://creator.douyin.com:8443/robots.txt", method: "GET" },
    ]);
    expect(f.sessions[0].fetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
    });
    expect(f.sessions[0].partition).toMatch(/^sv-proof-probe-[0-9a-f-]+$/);
    expect(f.sessions[0].partition).not.toMatch(/^persist:|sv-account/);
    expect(electron.defaultSessionAccess).not.toHaveBeenCalled();
    expect(f.sessions[0].allowNTLMCredentialsForDomains).toHaveBeenCalledWith("");
    expect(f.sessions[0].setCertificateVerifyProc).toHaveBeenCalledWith(null);
    expect(f.sessions[0].clearAuthCache).toHaveBeenCalledTimes(2);
    expect(f.sequence.slice(0, 4)).toEqual([
      "proxy:" + f.sessions[0].partition,
      "close:" + f.sessions[0].partition,
      "fetch:" + f.sessions[0].partition,
      "receiver:" + f.sessions[0].partition,
    ]);
    expect(reply.observation).toMatchObject({
      factoryId: ANONYMOUS_TLS_FACTORY_ID,
      origin: { host: "creator.douyin.com", port: 8443 },
      responseFromCache: false,
      certificateValidation: "chromium-default",
      credentials: "omit",
    });
    expect(Object.keys(reply.observation).sort()).toEqual(
      [
        "factoryId",
        "origin",
        "transportContextId",
        "startedAtMono",
        "completedAtMono",
        "statusCode",
        "responseFromCache",
        "certificateValidation",
        "credentials",
      ].sort(),
    );
    expect(f.bodiesCancelled).toEqual([f.sessions[0].partition]);
  });

  it("strips authentication headers before the receiver and Set-Cookie before browser storage", async () => {
    const f = fixture({
      ambientHeaders: {
        Cookie: "synthetic-cookie",
        cOOkie: "second-cookie",
        Authorization: "Bearer synthetic-token",
        "pRoXy-AuThOrIzAtIoN": "Basic synthetic-password",
        "User-Agent": "Chromium-fixture",
      },
      reply: async () => ({
        responseHeaders: { "sEt-CoOkIe": ["synthetic=value"], "Content-Type": ["text/plain"] },
      }),
    });
    const result = await probe().probeTls(target, freshSignal());
    expect(result.available).toBe(true);
    expect(f.receiver[0].headers).toEqual({ Accept: "*/*", "User-Agent": "Chromium-fixture" });
    expect(f.responseHeadersAtClient).toEqual([{ "Content-Type": ["text/plain"] }]);
    expect(await f.sessions[0].cookies.get()).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-cookie|synthetic-token|synthetic-password|synthetic=value/,
    );
  });

  it("cancels unknown hosts, paths, methods, queries and secondary request IDs before receiver delivery", async () => {
    const server = deferred<Reply>({});
    const f = fixture({ reply: () => server.promise });
    const p = probe();
    const pending = p.probeTls(target, freshSignal());
    await flush();
    expect(f.receiver).toHaveLength(1);
    for (const [url, method] of [
      ["https://other.example.test/robots.txt", "GET"],
      ["https://creator.douyin.com/web/api/media/user/info/", "GET"],
      ["https://creator.douyin.com/robots.txt?token=synthetic", "GET"],
      ["https://creator.douyin.com/robots.txt", "POST"],
      ["https://creator.douyin.com/robots.txt", "GET"],
    ])
      expect(f.sessions[0].attempt(url, method)).toEqual({ cancel: true });
    expect(f.receiver).toHaveLength(1);
    server.resolve({});
    expect((await pending).available).toBe(true);
    expect(f.sessions[0].attempt("https://creator.douyin.com/robots.txt")).toEqual({ cancel: true });
  });

  it("does not follow an HTTP redirect or expose its signed location; it reports only the original TLS reply", async () => {
    const f = fixture({
      reply: async () => ({
        status: 302,
        responseHeaders: { Location: ["https://other.example.test/private?signature=synthetic-token"] },
      }),
    });
    const result = await probe().probeTls(target, freshSignal());
    expect(result.available).toBe(true);
    if (result.available) expect(result.observation.statusCode).toBe(302);
    expect(f.receiver).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/other.example|signature|synthetic-token|private/);
  });

  it.each([{ fromCache: true }, { skipStarted: true }, { skipHeaders: true }, { eventId: 987654 }])(
    "does not turn cached or uncorrelated response events into current TLS evidence: %j",
    async (reply) => {
      fixture({ reply: async () => reply });
      await expect(probe().probeTls(target, freshSignal())).resolves.toEqual({
        available: false,
        reason: "PROBE_UNAVAILABLE",
      });
    },
  );

  it("refuses a contaminated anonymous cookie jar without issuing any request", async () => {
    const f = fixture({ initialCookies: [{ name: "synthetic", value: "private" }] });
    await expect(probe().probeTls(target, freshSignal())).resolves.toEqual({
      available: false,
      reason: "PROBE_UNAVAILABLE",
    });
    expect(f.receiver).toEqual([]);
    expect(f.sessions[0].fetch).not.toHaveBeenCalled();
    expect(await f.sessions[0].cookies.get()).toEqual([]);
  });

  it.each(["ignore-certificate-errors", "ignore-certificate-errors-spki-list"])(
    "does not produce an observation when Chromium validation is disabled by %s",
    async (flag) => {
      fixture();
      electron.hasSwitch.mockImplementation((name: string) => name === flag);
      await expect(probe().probeTls(target, freshSignal())).resolves.toEqual({
        available: false,
        reason: "PROBE_UNAVAILABLE",
      });
      expect(electron.fromPartition).not.toHaveBeenCalled();
    },
  );

  it("rejects business URLs or invalid origins instead of parsing them into probe paths", async () => {
    fixture();
    const p = probe();
    for (const host of [
      "creator.douyin.com/profile?token=synthetic",
      "user:password@creator.douyin.com",
      "https://creator.douyin.com",
      "*.douyin.com",
      "127.0.0.1",
    ])
      await expect(p.probeTls({ host, port: 443 }, freshSignal())).resolves.toEqual({
        available: false,
        reason: "PROBE_UNAVAILABLE",
      });
    expect(electron.fromPartition).not.toHaveBeenCalled();
  });
});

describe("AnonymousProofProbe cancellation and bounded lifetime", () => {
  it.each(["response", "cleanup"])(
    "rejects a monotonic deadline crossed during %s before the timer is dispatched",
    async (stage) => {
      let mono = 0;
      vi.spyOn(performance, "now").mockImplementation(() => mono);
      fixture({
        reply: async () => {
          if (stage === "response") mono = 100;
          return {};
        },
        beforeStorage: async () => {
          if (stage === "cleanup") mono = 100;
        },
      });
      expect(await probe({ timeoutMs: 100 }).probeTls(target, freshSignal())).toEqual({
        available: false,
        reason: "PROBE_UNAVAILABLE",
      });
    },
  );

  it("bounds a fetch that ignores cancellation, poisons its slot and discards the late response", async () => {
    vi.useFakeTimers();
    const response = deferred<Reply>({});
    const f = fixture({ reply: () => response.promise, honorAbort: false });
    const p = probe({ concurrency: 1, timeoutMs: 100 });
    const pending = p.probeTls(target, freshSignal());
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    expect(await pending).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    expect(await p.probeTls(target, freshSignal())).toEqual({ available: false, reason: "PROBE_BUSY" });
    response.resolve({});
    await flush();
    expect(f.receiver).toHaveLength(1);
  });

  it("bounds a body cancellation that never settles and cannot publish its header observation", async () => {
    vi.useFakeTimers();
    const cleanup = deferred<void>(undefined);
    fixture({ reply: async () => ({ body: new ReadableStream({ cancel: () => cleanup.promise }) }) });
    const p = probe({ concurrency: 1 });
    const pending = p.probeTls(target, freshSignal());
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    expect(await p.probeTls(target, freshSignal())).toEqual({ available: false, reason: "PROBE_BUSY" });
    cleanup.resolve();
  });

  it("never sends after HTTP auth cache clearing fails and still attempts all final cleanup", async () => {
    const f = fixture({
      beforeAuth: async () => {
        throw new Error("synthetic-private-auth");
      },
    });
    expect(await probe().probeTls(target, freshSignal())).toEqual({
      available: false,
      reason: "PROBE_UNAVAILABLE",
    });
    expect(f.receiver).toHaveLength(0);
    expect(f.sessions[0].closeAllConnections).toHaveBeenCalledTimes(2);
    expect(f.sessions[0].clearStorageData).toHaveBeenCalled();
  });

  it("rejects only the currently reserved robots client-certificate event and never chooses a certificate", async () => {
    const response = deferred<Reply>({});
    const f = fixture({ reply: () => response.promise });
    const pending = probe().probeTls(target, freshSignal());
    await flush();
    const event = { preventDefault: vi.fn() },
      callback = vi.fn();
    for (const listener of electron.listeners) {
      listener(event, null, "https://creator.douyin.com/business", [], callback);
      listener(event, { session: {} }, "https://creator.douyin.com/robots.txt", [], callback);
    }
    expect(callback).not.toHaveBeenCalled();
    for (const listener of electron.listeners)
      listener(event, null, "https://creator.douyin.com/robots.txt", [{ identity: "synthetic" }], callback);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    expect((await pending).available).toBe(false);
    expect(f.receiver[0].signal.aborted).toBe(true);
    response.resolve({});
  });

  it("returns cancellation before allocating a Session and aborts an active receiver request", async () => {
    const server = deferred<Reply>({});
    const f = fixture({ reply: () => server.promise });
    const p = probe();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(p.probeTls(target, cancelled.signal)).resolves.toEqual({
      available: false,
      reason: "PROBE_CANCELLED",
    });
    expect(electron.fromPartition).not.toHaveBeenCalled();
    const abort = new AbortController();
    const pending = p.probeTls(target, abort.signal);
    await flush();
    expect(f.receiver).toHaveLength(1);
    abort.abort();
    await expect(pending).resolves.toEqual({ available: false, reason: "PROBE_CANCELLED" });
    expect(f.receiver[0].signal.aborted).toBe(true);
  });

  it("times out a live request without returning stale TLS success", async () => {
    vi.useFakeTimers();
    const server = deferred<Reply>({});
    const f = fixture({ reply: () => server.promise });
    const pending = probe({ timeoutMs: 100 }).probeTls(target, freshSignal());
    await flush();
    expect(f.receiver).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    expect(f.receiver[0].signal.aborted).toBe(true);
  });

  it("does not start GET after cancellation during direct Session initialization", async () => {
    const initializing = deferred<void>(undefined);
    const f = fixture({ beforeProxy: () => initializing.promise });
    const abort = new AbortController();
    const pending = probe().probeTls(target, abort.signal);
    await flush();
    abort.abort();
    initializing.resolve(undefined);
    await expect(pending).resolves.toEqual({ available: false, reason: "PROBE_CANCELLED" });
    expect(f.sessions[0].fetch).not.toHaveBeenCalled();
    expect(f.receiver).toEqual([]);
  });

  it("discards late completion after invalidate and reuses the same Session only after cleanup", async () => {
    const server = deferred<Reply>({});
    const f = fixture({ reply: () => server.promise, honorAbort: false });
    const p = probe({ concurrency: 1 });
    const pending = p.probeTls(target, freshSignal());
    await flush();
    await p.invalidate();
    expect(f.receiver[0].signal.aborted).toBe(true);
    await expect(p.probeTls(target, freshSignal())).resolves.toEqual({
      available: false,
      reason: "PROBE_BUSY",
    });
    server.resolve({});
    await expect(pending).resolves.toEqual({ available: false, reason: "PROBE_CANCELLED" });
    const next = await p.probeTls(target, freshSignal());
    expect(next.available).toBe(true);
    expect(electron.fromPartition).toHaveBeenCalledTimes(1);
    expect(f.sessions[0].closeAllConnections).toHaveBeenCalledTimes(4);
  });

  it("does not reuse a slot selected while revocation cleanup later fails", async () => {
    const cleanup = deferred<void>(undefined);
    let closes = 0;
    const f = fixture({
      beforeClose: async () => {
        if (++closes <= 2) return;
        await cleanup.promise;
        throw new Error("private-connection-cleanup-detail");
      },
    });
    const p = probe({ concurrency: 1 });
    expect((await p.probeTls(target, freshSignal())).available).toBe(true);
    const invalidation = p.invalidate();
    await flush();
    const next = p.probeTls(target, freshSignal());
    await flush();
    expect(f.receiver).toHaveLength(1);
    cleanup.resolve(undefined);
    await invalidation;
    await expect(next).resolves.toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    expect(f.receiver).toHaveLength(1);
    expect(electron.fromPartition).toHaveBeenCalledTimes(1);
  });

  it("caps concurrent requests and reuses a fixed pool through repeated successful probes", async () => {
    const server = deferred<Reply>({});
    const f = fixture({ reply: () => server.promise });
    const p = probe({ concurrency: 2 });
    const first = p.probeTls(target, freshSignal());
    const second = p.probeTls({ host: "cp.kuaishou.com", port: 443 }, freshSignal());
    await flush();
    expect(f.receiver).toHaveLength(2);
    await expect(p.probeTls(target, freshSignal())).resolves.toEqual({
      available: false,
      reason: "PROBE_BUSY",
    });
    expect(electron.fromPartition).toHaveBeenCalledTimes(2);
    server.resolve({});
    expect((await Promise.all([first, second])).every((result) => result.available)).toBe(true);
    for (let i = 0; i < 8; i++) expect((await p.probeTls(target, freshSignal())).available).toBe(true);
    expect(electron.fromPartition).toHaveBeenCalledTimes(2);
    expect(f.sessions.every((ses) => ses.webRequest.onBeforeRequest.mock.calls.length === 1)).toBe(true);
  });

  it("poisons a slot after failed cookie cleanup rather than silently allocating an unbounded replacement", async () => {
    const f = fixture({ failStorage: true });
    const p = probe({ concurrency: 1 });
    await expect(p.probeTls(target, freshSignal())).resolves.toEqual({
      available: false,
      reason: "PROBE_UNAVAILABLE",
    });
    await expect(p.probeTls(target, freshSignal())).resolves.toEqual({
      available: false,
      reason: "PROBE_BUSY",
    });
    expect(f.receiver).toHaveLength(1);
    expect(electron.fromPartition).toHaveBeenCalledTimes(1);
  });

  it("counts a Session whose hook installation failed against the pool instead of allocating endlessly", async () => {
    const f = fixture();
    const create = electron.fromPartition.getMockImplementation()!;
    electron.fromPartition.mockImplementation((...args: unknown[]) => {
      const ses = create(...args);
      ses.webRequest.onHeadersReceived.mockImplementation(() => {
        throw new Error("private-hook-provider-detail");
      });
      return ses;
    });
    const p = probe({ concurrency: 1 });
    await expect(p.probeTls(target, freshSignal())).resolves.toEqual({
      available: false,
      reason: "PROBE_UNAVAILABLE",
    });
    const retries = [];
    for (let attempt = 0; attempt < 3; attempt++) retries.push(await p.probeTls(target, freshSignal()));
    expect(electron.fromPartition).toHaveBeenCalledTimes(1);
    expect(retries).toEqual(Array.from({ length: 3 }, () => ({ available: false, reason: "PROBE_BUSY" })));
    expect(f.receiver).toEqual([]);
  });

  it("does not allow a late result or a new request after disposal", async () => {
    const server = deferred<Reply>({});
    const f = fixture({ reply: () => server.promise, honorAbort: false });
    const p = probe();
    const pending = p.probeTls(target, freshSignal());
    await flush();
    await p.dispose();
    server.resolve({});
    await expect(pending).resolves.toEqual({ available: false, reason: "PROBE_CANCELLED" });
    await expect(p.probeTls(target, freshSignal())).resolves.toEqual({
      available: false,
      reason: "PROBE_UNAVAILABLE",
    });
    expect(f.receiver).toHaveLength(1);
  });

  it.each(["fetch", "setProxy", "session-factory", "certificate-switch"])(
    "returns only a fixed failure when %s throws an error containing a private URL",
    async (stage) => {
      const secret = "https://provider.example.test/private?token=synthetic-secret";
      const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
      fixture({
        reply: async () => {
          if (stage === "fetch") throw new Error(secret);
          return {};
        },
        beforeProxy: async () => {
          if (stage === "setProxy") throw new Error(secret);
        },
      });
      if (stage === "session-factory")
        electron.fromPartition.mockImplementation(() => {
          throw new Error(secret);
        });
      if (stage === "certificate-switch")
        electron.hasSwitch.mockImplementation(() => {
          throw new Error(secret);
        });
      await expect(probe().probeTls(target, freshSignal())).resolves.toEqual({
        available: false,
        reason: "PROBE_UNAVAILABLE",
      });
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    },
  );
});
