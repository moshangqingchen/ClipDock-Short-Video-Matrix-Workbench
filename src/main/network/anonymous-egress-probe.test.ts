import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnonymousEgressProbe,
  ANONYMOUS_EGRESS_FACTORY_ID,
  type AnonymousEgressObserverContext,
  type AnonymousEgressObserverTiming,
} from "./anonymous-egress-probe";
import { AnonymousProofProbe } from "./anonymous-proof-probe";

const electron = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  hasSwitch: vi.fn(),
  app: new Map<string, Set<(...args: any[]) => void>>(),
}));
vi.mock("electron", () => ({
  app: {
    commandLine: { hasSwitch: electron.hasSwitch },
    on: (event: string, listener: (...args: any[]) => void) => {
      if (!electron.app.has(event)) electron.app.set(event, new Set());
      electron.app.get(event)!.add(listener);
    },
    off: (event: string, listener: (...args: any[]) => void) => electron.app.get(event)?.delete(listener),
  },
  session: {
    fromPartition: electron.fromPartition,
    get defaultSession() {
      throw new Error("Account/default session is forbidden");
    },
  },
}));

interface Reply {
  body?: string | ReadableStream<Uint8Array>;
  status?: number;
  headers?: Record<string, string[]>;
  cached?: boolean;
  skip?: "headers" | "started";
  wrongId?: boolean;
}
interface Received {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}
const instances: Array<{ dispose(): Promise<void> }> = [];
const releases: Array<() => void> = [];
beforeEach(() => {
  electron.fromPartition.mockReset();
  electron.hasSwitch.mockReset().mockReturnValue(false);
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await flush();
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  expect(electron.app.get("select-client-certificate")?.size ?? 0).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function probe(options?: ConstructorParameters<typeof AnonymousEgressProbe>[0]) {
  const value = new AnonymousEgressProbe(options);
  instances.push(value);
  return value;
}
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  releases.push(() => resolve(fallback));
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
const signal = () => new AbortController().signal;
const ip4 = "203.0.113.9";
const ip6 = "2001:db8::9";
const geo = (ip = ip4, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    success: true,
    ip,
    country_code: "CN",
    connection: { asn: 64500 },
    ...extra,
  });

/** Local Chromium contract fixture: dispatches actual installed hooks before receiver/body. */
function fixture(
  options: {
    reply?: (request: Received) => Reply | Promise<Reply>;
    proxy?: () => Promise<void>;
    close?: () => Promise<void>;
    resolver?: () => Promise<void>;
    clear?: () => Promise<void>;
    auth?: () => Promise<void>;
    cookies?: Array<{ name: string; value: string }>;
  } = {},
) {
  const sequence: string[] = [];
  const received: Received[] = [];
  const returnedHeaders: Record<string, string[]>[] = [];
  let id = 0;
  const sessions: Array<ReturnType<typeof create>> = [];
  function create(partition: string) {
    const hooks = new EventEmitter();
    let cookieJar = [...(options.cookies ?? [])];
    const check = (url: string, method: string, requestId = ++id) => {
      const callback = vi.fn();
      hooks.emit("before", { id: requestId, url, method }, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      return callback.mock.calls[0][0];
    };
    return {
      partition,
      netLog: { startLogging: vi.fn(async () => {}), stopLogging: vi.fn(async () => {}) },
      hooks,
      check,
      allowNTLMCredentialsForDomains: vi.fn(),
      setCertificateVerifyProc: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn((listener) => hooks.on("before", listener)),
        onBeforeSendHeaders: vi.fn((listener) => hooks.on("send", listener)),
        onHeadersReceived: vi.fn((listener) => hooks.on("headers", listener)),
        onResponseStarted: vi.fn((listener) => hooks.on("started", listener)),
      },
      setProxy: vi.fn(async (config) => {
        sequence.push("proxy");
        expect(config).toEqual({ mode: "direct" });
        await options.proxy?.();
      }),
      closeAllConnections: vi.fn(async () => {
        sequence.push("close");
        await options.close?.();
      }),
      clearHostResolverCache: vi.fn(async () => {
        await options.resolver?.();
      }),
      clearAuthCache: vi.fn(async () => {
        sequence.push("auth");
        await options.auth?.();
      }),
      clearStorageData: vi.fn(async () => {
        sequence.push("clear");
        await options.clear?.();
        cookieJar = [];
      }),
      cookies: { get: vi.fn(async () => [...cookieJar]) },
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        const details = { id: ++id, url, method: init.method };
        if (check(url, init.method!, details.id).cancel) throw new Error("blocked provider secret");
        const sent = vi.fn();
        hooks.emit(
          "send",
          {
            ...details,
            requestHeaders: {
              Cookie: "synthetic_cookie=private",
              AUTHORIZATION: "Bearer private",
              "Proxy-Authorization": "Basic private",
              Referer: "https://account.test/private",
              Accept: "*/*",
            },
          },
          sent,
        );
        const request: Received = { url, init, headers: sent.mock.calls[0][0].requestHeaders };
        sequence.push("fetch");
        received.push(request);
        const reply = await (options.reply?.(request) ??
          (url.startsWith("https://ipwho.is/")
            ? { body: geo(decodeURIComponent(new URL(url).pathname.slice(1))) }
            : { body: url.includes("api6") ? ip6 : `当前 IP：${ip4} 来自于：美国` }));
        const responseDetails = { ...details, id: reply.wrongId ? details.id + 1000 : details.id };
        let headers = reply.headers ?? { "Content-Type": ["text/plain"], "Set-Cookie": ["bad=private"] };
        if (reply.skip !== "headers") {
          const cb = vi.fn();
          hooks.emit(
            "headers",
            { ...responseDetails, statusCode: reply.status ?? 200, responseHeaders: headers },
            cb,
          );
          headers = cb.mock.calls[0][0].responseHeaders;
        }
        returnedHeaders.push(headers);
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === "set-cookie") cookieJar.push({ name: "bad", value: headers[key][0] });
        if (reply.skip !== "started")
          hooks.emit("started", { ...responseDetails, fromCache: reply.cached ?? false });
        return new Response(reply.body ?? ip4, {
          status: reply.status ?? 200,
          headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, value.join(",")])),
        });
      }),
    };
  }
  electron.fromPartition.mockImplementation((partition: string, options: unknown) => {
    expect(options).toEqual({ cache: false });
    const value = create(partition);
    sessions.push(value);
    return value;
  });
  return { received, sequence, sessions, returnedHeaders };
}

describe("AnonymousEgressProbe per-request private observation", () => {
  it("exposes only origin/stage and private NetLog, with privacy checks completed and no geo IP path", async () => {
    const f = fixture();
    const contexts: AnonymousEgressObserverContext[] = [];
    const timings: AnonymousEgressObserverTiming[] = [];
    const sequence: string[] = [];
    const result = await probe().probe("ipify-ipv6", signal(), {
      beforeSend(context) {
        const ses = f.sessions[0];
        expect(ses.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: "direct" });
        expect(ses.closeAllConnections).toHaveBeenCalledOnce();
        expect(ses.clearHostResolverCache).toHaveBeenCalledOnce();
        expect(ses.clearAuthCache).toHaveBeenCalledOnce();
        expect(ses.cookies.get).toHaveBeenCalledExactlyOnceWith({});
        expect(ses.allowNTLMCredentialsForDomains).toHaveBeenCalledWith("");
        expect(ses.setCertificateVerifyProc).toHaveBeenCalledWith(null);
        expect(f.received).toHaveLength(context.stage === "echo" ? 0 : 1);
        expect(context.trace.netLog).toBe(ses.netLog);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.origin)).toBe(true);
        expect(Object.isFrozen(context.trace)).toBe(true);
        expect(Object.isFrozen(context.trace.netLog)).toBe(false);
        expect(Object.keys(context).sort()).toEqual(
          ["factoryId", "source", "stage", "origin", "transportContextId", "signal", "trace"].sort(),
        );
        expect(Object.keys(context.trace)).toEqual(["netLog"]);
        expect(ses.check("https://api6.ipify.org/", "GET")).toEqual({ cancel: true });
        contexts.push(context);
        sequence.push(`${context.stage}:before`);
      },
      headers(context, timing) {
        expect(context).toBe(contexts.at(-1));
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
        expect(timing).toMatchObject({ statusCode: 200, responseFromCache: false });
        expect(timing.headersAtMono).toBeGreaterThanOrEqual(timing.sentAtMono);
        expect(timing.headersAtWall).toBeGreaterThanOrEqual(timing.sentAtWall);
        timings.push(timing);
        sequence.push(`${context.stage}:headers`);
      },
      cleanup(context) {
        expect(context).toBe(contexts.at(-1));
        sequence.push(`${context.stage}:cleanup`);
      },
    });
    expect(result.available).toBe(true);
    expect(sequence).toEqual([
      "echo:before",
      "echo:headers",
      "echo:cleanup",
      "geo:before",
      "geo:headers",
      "geo:cleanup",
    ]);
    expect(contexts.map(({ origin }) => origin)).toEqual([
      { host: "api6.ipify.org", port: 443 },
      { host: "ipwho.is", port: 443 },
    ]);
    expect(contexts[0].transportContextId).toBe(contexts[1].transportContextId);
    expect(timings[0].requestId).not.toBe(timings[1].requestId);
    expect(JSON.stringify({ contexts, timings })).not.toMatch(
      /2001|db8|203\.0\.113|https:|pathname|requestHeaders|responseHeaders|body|fetch/,
    );
    expect(f.received[1].url).toBe("https://ipwho.is/2001%3Adb8%3A%3A9");
    expect(JSON.stringify(result)).not.toMatch(/netLog|sentAtWall|requestId/);
  });

  it("keeps original header and body times distinct and never retimes echo/geo after hook or Session cleanup", async () => {
    let mono = 100;
    vi.spyOn(performance, "now").mockImplementation(() => mono);
    vi.spyOn(Date, "now").mockImplementation(() => 10_000 + mono);
    fixture({
      reply: ({ url }) => {
        mono = url.includes("ipwho.is") ? 450 : 130;
        return { body: url.includes("ipwho.is") ? geo() : ip4 };
      },
      clear: async () => {
        mono = 1000;
      },
    });
    const timings: AnonymousEgressObserverTiming[] = [];
    const result = await probe().probe("ipip", signal(), {
      beforeSend(context) {
        mono = context.stage === "echo" ? 120 : 400;
      },
      async headers(context, timing) {
        timings.push(timing);
        mono = context.stage === "echo" ? 200 : 500;
        await Promise.resolve();
      },
      cleanup(context) {
        mono = context.stage === "echo" ? 300 : 900;
      },
    });
    expect(result.available).toBe(true);
    expect(timings).toMatchObject([
      { sentAtMono: 120, sentAtWall: 10120, headersAtMono: 130, headersAtWall: 10130 },
      { sentAtMono: 400, sentAtWall: 10400, headersAtMono: 450, headersAtWall: 10450 },
    ]);
    if (result.available)
      expect(result.observation).toMatchObject({
        startedAtMono: 120,
        observedAtMono: 200,
        completedAtMono: 500,
        echo: { startedAtMono: 120, completedAtMono: 200 },
        geo: { startedAtMono: 400, completedAtMono: 500 },
      });
    expect(mono).toBe(1000);
  });

  it.each(["echo", "geo"] as const)(
    "holds the actual %s Response before the factory reads its body",
    async (stage) => {
      const held = deferred<void>(undefined);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stage === "echo" ? ip4 : geo()));
          controller.close();
        },
      });
      const readBody = vi.spyOn(body, "getReader");
      const f = fixture({
        reply: ({ url }) => ({ body: (url.includes("ipwho.is") ? "geo" : "echo") === stage ? body : ip4 }),
      });
      const pending = probe().probe("ipip", signal(), {
        headers: (context) => (context.stage === stage ? held.promise : undefined),
      });
      await flush();
      expect(readBody).not.toHaveBeenCalled();
      expect(f.received).toHaveLength(stage === "echo" ? 1 : 2);
      held.resolve();
      const result = await pending;
      expect(readBody).toHaveBeenCalledOnce();
      // Echo test intentionally gives geo an invalid body; it cannot fabricate success.
      expect(result.available).toBe(stage === "geo");
    },
  );

  it.each([
    ["echo", "beforeSend"],
    ["echo", "headers"],
    ["echo", "cleanup"],
    ["geo", "beforeSend"],
    ["geo", "headers"],
    ["geo", "cleanup"],
  ] as const)(
    "fails closed when %s %s throws and cleans every entered context exactly once",
    async (stage, hook) => {
      const f = fixture();
      const cleaned: string[] = [];
      const fail = (context: AnonymousEgressObserverContext, phase: string) => {
        if (context.stage === stage && hook === phase) throw Error(`synthetic secret ${ip4}`);
      };
      const result = await probe().probe("ipip", signal(), {
        beforeSend: (context) => fail(context, "beforeSend"),
        headers: (context) => fail(context, "headers"),
        cleanup(context) {
          cleaned.push(context.stage);
          fail(context, "cleanup");
        },
      });
      expect(result).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
      expect(cleaned).toEqual(stage === "echo" ? ["echo"] : ["echo", "geo"]);
      expect(f.received).toHaveLength((stage === "echo" ? 1 : 2) - (hook === "beforeSend" ? 1 : 0));
    },
  );

  it.each([
    { cached: true },
    { wrongId: true },
    { skip: "headers" as const },
    { status: 401 },
    { headers: { "Content-Length": ["999999"] } },
  ])("does not pass rejected geo response facts into a headers hook: %j", async (reply) => {
    fixture({ reply: ({ url }) => (url.includes("ipwho.is") ? { body: geo(), ...reply } : { body: ip4 }) });
    const called: string[] = [],
      cleaned: string[] = [];
    const result = await probe().probe("ipip", signal(), {
      headers(context) {
        called.push(context.stage);
      },
      cleanup(context) {
        cleaned.push(context.stage);
      },
    });
    expect(result.available).toBe(false);
    expect(called).toEqual(["echo"]);
    expect(cleaned).toEqual(["echo", "geo"]);
  });

  it.each(["cookie", "resolver", "auth"])(
    "does not enter any observer request before failed %s preparation",
    async (stage) => {
      const f = fixture({
        cookies: stage === "cookie" ? [{ name: "synthetic", value: "private" }] : [],
        resolver: async () => {
          if (stage === "resolver") throw Error();
        },
        auth: async () => {
          if (stage === "auth") throw Error();
        },
      });
      const beforeSend = vi.fn(),
        headers = vi.fn(),
        cleanup = vi.fn();
      expect((await probe().probe("ipip", signal(), { beforeSend, headers, cleanup })).available).toBe(false);
      expect(beforeSend).not.toHaveBeenCalled();
      expect(headers).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.received).toHaveLength(0);
    },
  );

  it.each([
    ["echo", "beforeSend"],
    ["echo", "headers"],
    ["echo", "cleanup"],
    ["geo", "beforeSend"],
    ["geo", "headers"],
    ["geo", "cleanup"],
  ] as const)(
    "whenIdle and disposal wait for a timed-out %s %s hook after the public result",
    async (stage, hook) => {
      vi.useFakeTimers();
      const held = deferred<void>(undefined);
      const f = fixture();
      const p = probe({ concurrency: 1, timeoutMs: 100 });
      let observedSignal: AbortSignal | undefined;
      const cleaned: string[] = [];
      const maybeHold = (context: AnonymousEgressObserverContext, phase: string) => {
        observedSignal = context.signal;
        return context.stage === stage && hook === phase ? held.promise : undefined;
      };
      const pending = p.probe("ipip", signal(), {
        beforeSend: (context) => maybeHold(context, "beforeSend"),
        headers: (context) => maybeHold(context, "headers"),
        cleanup(context) {
          cleaned.push(context.stage);
          return maybeHold(context, "cleanup");
        },
      });
      await flush();
      await vi.advanceTimersByTimeAsync(2100);
      expect(await pending).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
      expect(observedSignal?.aborted).toBe(true);
      expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_BUSY" });
      let idle = false,
        disposed = false;
      const idleWait = p.whenIdle().then(() => {
        idle = true;
      });
      const disposal = p.dispose().then(() => {
        disposed = true;
      });
      await flush();
      expect(idle).toBe(false);
      expect(disposed).toBe(false);
      held.resolve();
      await Promise.all([idleWait, disposal]);
      expect(cleaned).toEqual(stage === "echo" ? ["echo"] : ["echo", "geo"]);
      expect(f.received).toHaveLength((stage === "echo" ? 1 : 2) - (hook === "beforeSend" ? 1 : 0));
      expect(f.sessions).toHaveLength(1);
    },
  );

  it("does not begin geo before echo cleanup, and whenIdle also waits for geo and outer cleanup without revoking", async () => {
    const echo = deferred<void>(undefined),
      geography = deferred<void>(undefined),
      storage = deferred<void>(undefined);
    const f = fixture({ clear: () => storage.promise });
    const p = probe();
    let observedSignal: AbortSignal | undefined;
    const pending = p.probe("ipip", signal(), {
      cleanup(context) {
        observedSignal = context.signal;
        return context.stage === "echo" ? echo.promise : geography.promise;
      },
    });
    await flush();
    let idle = false;
    const idleWait = p.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(observedSignal?.aborted).toBe(false);
    expect(idle).toBe(false);
    expect(f.received).toHaveLength(1);
    echo.resolve();
    await flush();
    expect(f.received).toHaveLength(2);
    expect(idle).toBe(false);
    expect(observedSignal?.aborted).toBe(false);
    geography.resolve();
    await flush();
    expect(f.sessions[0].clearStorageData).toHaveBeenCalledOnce();
    expect(idle).toBe(false);
    storage.resolve();
    expect((await pending).available).toBe(true);
    await idleWait;
    expect(idle).toBe(true);
  });

  it("rechecks revocation after beforeSend and never issues that request", async () => {
    const f = fixture();
    const abort = new AbortController();
    const cleaned: string[] = [];
    const result = await probe().probe("ipip", abort.signal, {
      beforeSend(context) {
        if (context.stage === "geo") abort.abort();
      },
      cleanup(context) {
        cleaned.push(context.stage);
      },
    });
    expect(result).toEqual({ available: false, reason: "PROBE_CANCELLED" });
    expect(f.received).toHaveLength(1);
    expect(cleaned).toEqual(["echo", "geo"]);
  });

  it("never reuses a trace slot whose per-request cleanup failed", async () => {
    const f = fixture();
    const p = probe({ concurrency: 1 });
    expect(
      (
        await p.probe("ipip", signal(), {
          cleanup() {
            throw Error();
          },
        })
      ).available,
    ).toBe(false);
    expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_BUSY" });
    expect(f.received).toHaveLength(1);
    expect(f.sessions).toHaveLength(1);
  });
});

describe("AnonymousEgressProbe fixed, anonymous observations", () => {
  it("constructs without Session allocation or traffic, and never accepts arbitrary destinations", async () => {
    const f = fixture();
    const p = probe();
    expect(electron.fromPartition).not.toHaveBeenCalled();
    for (const value of ["https://myip.ipip.net/", "constructor", "ipip?token=private", "toString"])
      expect(await p.probe(value as "ipip", signal())).toEqual({
        available: false,
        reason: "PROBE_UNAVAILABLE",
      });
    expect(f.received).toEqual([]);
    expect(electron.fromPartition).not.toHaveBeenCalled();
  });

  it.each(["failure", "cancel"])(
    "does not contact echo or geo while resolver clearing ends in %s",
    async (mode) => {
      const dns = deferred<void>(undefined);
      const f = fixture({
        resolver: async () => {
          await dns.promise;
          if (mode === "failure") throw new Error("private-resolver-detail");
        },
      });
      const cancel = new AbortController();
      const result = probe().probe("ipip", cancel.signal);
      await flush();
      expect(f.sessions[0].clearHostResolverCache).toHaveBeenCalledOnce();
      expect(f.received).toHaveLength(0);
      if (mode === "cancel") cancel.abort();
      dns.resolve();
      expect((await result).available).toBe(false);
      expect(f.received).toHaveLength(0);
    },
  );

  it("closes old connections immediately after direct setup, then emits only echo and exact-IP geo GETs", async () => {
    const proxyReady = deferred<void>(undefined);
    const closeReady = deferred<void>(undefined);
    const f = fixture({ proxy: () => proxyReady.promise, close: () => closeReady.promise });
    const pending = probe().probe("ipip", signal());
    await flush();
    expect(f.sequence).toEqual(["proxy"]);
    proxyReady.resolve();
    await flush();
    expect(f.sequence).toEqual(["proxy", "close"]);
    closeReady.resolve();
    const result = await pending;
    expect(result.available).toBe(true);
    expect(f.sessions[0].partition).toMatch(/^sv-egress-probe-[a-f\d-]{36}$/);
    expect(f.sessions[0].partition.startsWith("persist:")).toBe(false);
    expect(f.sessions[0].allowNTLMCredentialsForDomains).toHaveBeenCalledWith("");
    expect(f.sessions[0].setCertificateVerifyProc).toHaveBeenCalledWith(null);
    expect(f.received.map((request) => request.url)).toEqual([
      "https://myip.ipip.net/",
      `https://ipwho.is/${ip4}`,
    ]);
    for (const request of f.received) {
      expect(request.init).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect(request.headers).toEqual({ Accept: "*/*" });
    }
    expect(
      f.returnedHeaders.every((headers) => !Object.keys(headers).some((key) => /^set-cookie$/i.test(key))),
    ).toBe(true);
    expect(f.sessions[0].clearAuthCache).toHaveBeenCalledTimes(2);
    expect(f.sessions[0].closeAllConnections).toHaveBeenCalledTimes(2);
    expect(f.sessions[0].check("https://myip.ipip.net/", "GET")).toEqual({ cancel: true });
    if (!result.available) return;
    expect(result.observation).toMatchObject({
      factoryId: ANONYMOUS_EGRESS_FACTORY_ID,
      ip: ip4,
      source: "ipip",
      countryCode: "CN",
      asn: 64500,
      reportedAddressFamily: "ipv4",
    });
    expect(result.observation).not.toHaveProperty("addressFamily");
    expect(result.observation).not.toHaveProperty("applicabilityVerified");
    expect(result.observation).not.toHaveProperty("routeVerified");
  });

  it("does not refresh the echo timestamp while waiting for geography, nor use IPIP prose as country", async () => {
    let mono = 100;
    vi.spyOn(performance, "now").mockImplementation(() => mono);
    const geography = deferred<Reply>({ body: geo() });
    fixture({
      reply: ({ url }) => {
        if (url.includes("ipwho.is")) {
          mono = 900;
          return geography.promise;
        }
        mono = 200;
        return { body: `当前 IP：${ip4} 来自于：美国` };
      },
    });
    const pending = probe().probe("ipip", signal());
    await flush();
    mono = 1_000;
    geography.resolve({ body: geo(ip4, { country_code: "CN" }) });
    const result = await pending;
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.observation).toMatchObject({
      startedAtMono: 100,
      observedAtMono: 200,
      completedAtMono: 1000,
      countryCode: "CN",
    });
    expect(result.observation.echo.completedAtMono).toBe(200);
  });

  it("canonicalizes IPv6 and compares geography by address value without asserting socket family", async () => {
    const f = fixture({
      reply: ({ url }) =>
        url.includes("api6")
          ? { body: "2001:0DB8:0000:0:0:0:0:9\n" }
          : { body: geo("2001:db8:0:0::9", { country_code: "JP" }) },
    });
    const result = await probe().probe("ipify-ipv6", signal());
    expect(result.available).toBe(true);
    if (result.available)
      expect(result.observation).toMatchObject({ ip: ip6, countryCode: "JP", reportedAddressFamily: "ipv6" });
    expect(f.received[1].url).toBe("https://ipwho.is/2001%3Adb8%3A%3A9");
  });

  it.each([
    ["ipip", "bad 999.8.8.8"],
    ["ipip", `${ip4} 198.51.100.2`],
    ["ipip", "no ip"],
    ["ipify-ipv6", ip4],
    ["ipify-ipv6", "2001:db8::9%eth0"],
    ["ipify-ipv6", "https://evil.invalid"],
  ] as const)("rejects ambiguous/invalid %s echo %s without querying geo", async (provider, body) => {
    const f = fixture({ reply: () => ({ body }) });
    expect(await probe().probe(provider, signal())).toEqual({
      available: false,
      reason: "PROBE_UNAVAILABLE",
    });
    expect(f.received).toHaveLength(1);
  });

  it.each([
    geo("198.51.100.7"),
    geo(ip4, { success: false }),
    geo(ip4, { country_code: "cn" }),
    geo(ip4, { country_code: "China" }),
    "invalid json",
    "null",
  ])("requires a valid geo reply for the identical address", async (body) => {
    fixture({ reply: ({ url }) => ({ body: url.includes("ipwho.is") ? body : ip4 }) });
    expect(await probe().probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
  });

  it("keeps unsupported ASN auxiliary rather than inventing geography from its registration", async () => {
    fixture({
      reply: ({ url }) => ({
        body: url.includes("ipwho.is") ? geo(ip4, { country_code: "JP", connection: { asn: "CN-AS" } }) : ip4,
      }),
    });
    const result = await probe().probe("ipip", signal());
    if (!result.available) throw new Error("expected observation");
    expect(result.observation).toMatchObject({ countryCode: "JP", asn: null });
  });
});

describe("AnonymousEgressProbe real-response prerequisites", () => {
  it("cannot borrow another concurrent Session's successful response events for the same URL", async () => {
    const firstReply = deferred<Reply>({ body: ip4, skip: "headers" });
    let echoes = 0;
    const f = fixture({
      reply: ({ url }) => {
        if (url.includes("ipwho.is")) return { body: geo() };
        return ++echoes === 1 ? firstReply.promise : { body: ip4 };
      },
    });
    const first = probe().probe("ipip", signal());
    await flush();
    const second = await probe().probe("ipip", signal());
    expect(second.available).toBe(true);
    // The second session observed 200 for the identical echo URL, but the first
    // never observed its own headers. Session-local listeners must not share them.
    firstReply.resolve({ body: ip4, skip: "headers" });
    expect(await first).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    expect(f.sessions).toHaveLength(2);
    expect(f.received.filter(({ url }) => url.includes("ipwho.is"))).toHaveLength(1);
  });

  it.each([
    { cached: true },
    { skip: "headers" as const },
    { skip: "started" as const },
    { wrongId: true },
    { status: 302, headers: { Location: ["https://private.invalid/path?token=secret"] } },
    { status: 401 },
    { status: 500 },
  ])("rejects missing/mismatched hooks, cache, auth and redirects: %j", async (reply) => {
    const f = fixture({ reply: () => ({ body: ip4, ...reply }) });
    expect(await probe().probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    expect(f.received).toHaveLength(1);
  });

  it.each(["declared", "streamed", "invalid-utf8"])(
    "bounds %s response before parsing or geo",
    async (kind) => {
      const f = fixture({
        reply: () => ({
          body:
            kind === "invalid-utf8"
              ? new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array([255]));
                    controller.close();
                  },
                })
              : "x".repeat(101),
          headers: kind === "declared" ? { "Content-Length": ["101"] } : {},
        }),
      });
      expect(await probe({ maxBytes: 100 }).probe("ipip", signal())).toEqual({
        available: false,
        reason: "PROBE_UNAVAILABLE",
      });
      expect(f.received).toHaveLength(1);
    },
  );

  it("rejects preexisting Cookie state and certificate-bypass command lines before GET", async () => {
    const f = fixture({ cookies: [{ name: "auth", value: "synthetic" }] });
    expect((await probe().probe("ipip", signal())).available).toBe(false);
    expect(f.received).toEqual([]);
    const count = electron.fromPartition.mock.calls.length;
    electron.hasSwitch.mockReturnValue(true);
    expect((await probe().probe("ipip", signal())).available).toBe(false);
    expect(electron.fromPartition).toHaveBeenCalledTimes(count);
  });

  it("only allows the currently active fixed URL and request ID in a private session", async () => {
    const reply = deferred<Reply>({ body: ip4 });
    const f = fixture({ reply: () => reply.promise });
    const p = probe();
    const pending = p.probe("ipip", signal());
    await flush();
    for (const [url, method] of [
      ["https://myip.ipip.net/?token=x", "GET"],
      ["https://myip.ipip.net/", "POST"],
      ["https://other.invalid/", "GET"],
      ["https://myip.ipip.net/", "GET"],
    ])
      expect(f.sessions[0].check(url, method)).toEqual({ cancel: true });
    await p.invalidate();
    reply.resolve({ body: ip4 });
    expect(await pending).toEqual({ available: false, reason: "PROBE_CANCELLED" });
  });
});

describe("AnonymousEgressProbe lifecycle", () => {
  it.each(["geo", "cleanup"])(
    "rejects success after a monotonic deadline passed during %s even before its timer runs",
    async (stage) => {
      // Only the clock jumps. The real timer has not fired, modeling a busy event
      // loop whose expired timers have not yet been dispatched.
      let mono = 0;
      vi.spyOn(performance, "now").mockImplementation(() => mono);
      const f = fixture({
        reply: ({ url }) => {
          if (url.includes("ipwho.is")) {
            if (stage === "geo") mono = 100;
            return { body: geo() };
          }
          return { body: ip4 };
        },
        clear: async () => {
          if (stage === "cleanup") mono = 100;
        },
      });
      expect(await probe({ timeoutMs: 100 }).probe("ipip", signal())).toEqual({
        available: false,
        reason: "PROBE_UNAVAILABLE",
      });
      expect(f.received).toHaveLength(2);
    },
  );

  it("does not allocate a Session for an already cancelled request", async () => {
    fixture();
    const abort = new AbortController();
    abort.abort();
    expect(await probe().probe("ipip", abort.signal)).toEqual({
      available: false,
      reason: "PROBE_CANCELLED",
    });
    expect(electron.fromPartition).not.toHaveBeenCalled();
  });

  it("discards geography arriving after revocation instead of publishing a finished echo", async () => {
    const geography = deferred<Reply>({ body: geo() });
    const f = fixture({
      reply: ({ url }) => (url.includes("ipwho.is") ? geography.promise : { body: ip4 }),
    });
    const p = probe();
    const pending = p.probe("ipip", signal());
    await flush();
    expect(f.received).toHaveLength(2);
    await p.invalidate();
    geography.resolve({ body: geo() });
    expect(await pending).toEqual({ available: false, reason: "PROBE_CANCELLED" });
    expect(f.received[1].init.signal!.aborted).toBe(true);
  });

  it("bounds a hung cleanup and never reuses the poisoned Session", async () => {
    vi.useFakeTimers();
    const cleanup = deferred<void>(undefined);
    const f = fixture({ clear: () => cleanup.promise });
    const p = probe({ concurrency: 1 });
    const pending = p.probe("ipip", signal());
    await flush();
    expect(f.received).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_BUSY" });
    cleanup.resolve();
    await flush();
    expect(f.sessions).toHaveLength(1);
  });

  it("bounds the pool and reuses a cleaned slot with a stable independent context", async () => {
    const echo = deferred<Reply>({ body: ip4 });
    const f = fixture({ reply: ({ url }) => (url.includes("ipwho.is") ? { body: geo() } : echo.promise) });
    const p = probe({ concurrency: 1 });
    const first = p.probe("ipip", signal());
    await flush();
    expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_BUSY" });
    echo.resolve({ body: ip4 });
    const one = await first;
    const two = await p.probe("ipip", signal());
    expect(
      one.available &&
        two.available &&
        one.observation.transportContextId === two.observation.transportContextId,
    ).toBe(true);
    expect(f.sessions).toHaveLength(1);
  });

  it("returns caller cancellation, discards late echo, and never starts geo after revocation", async () => {
    const echo = deferred<Reply>({ body: ip4 });
    const f = fixture({ reply: () => echo.promise });
    const abort = new AbortController();
    const pending = probe().probe("ipip", abort.signal);
    await flush();
    abort.abort();
    echo.resolve({ body: ip4 });
    expect(await pending).toEqual({ available: false, reason: "PROBE_CANCELLED" });
    expect(f.received).toHaveLength(1);
    expect(f.received[0].init.signal!.aborted).toBe(true);
  });

  it("stops old work across initialization and does not send after dispose", async () => {
    const ready = deferred<void>(undefined);
    const f = fixture({ proxy: () => ready.promise });
    const p = probe();
    const pending = p.probe("ipip", signal());
    await flush();
    const stopped = p.dispose();
    ready.resolve();
    await stopped;
    expect(await pending).toEqual({ available: false, reason: "PROBE_CANCELLED" });
    expect(f.received).toHaveLength(0);
    expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
  });

  it("enforces a deadline even when a fetch ignores abort, poisons its slot, and ignores the late result", async () => {
    vi.useFakeTimers();
    const echo = deferred<Reply>({ body: ip4 });
    const f = fixture({ reply: () => echo.promise });
    const p = probe({ concurrency: 1, timeoutMs: 100 });
    const pending = p.probe("ipip", signal());
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    expect(await pending).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_BUSY" });
    echo.resolve({ body: ip4 });
    await flush();
    expect(f.received).toHaveLength(1);
  });

  it("times out a stalled response stream, cancels its body and does not query geo", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const f = fixture({ reply: () => ({ body: new ReadableStream({ cancel: cancelled }) }) });
    const pending = probe({ timeoutMs: 100 }).probe("ipip", signal());
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    expect(await pending).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    // This synthetic stream ignores the fetch signal; the poisoned slot remains bounded.
    expect(f.received).toHaveLength(1);
  });

  it.each(["storage", "connections", "auth"])(
    "a %s cleanup failure poisons the slot but attempts the other cleanups",
    async (failure) => {
      let closes = 0;
      let auth = 0;
      const f = fixture({
        close: async () => {
          if (++closes > 1 && failure === "connections") throw new Error("private");
        },
        clear: async () => {
          if (failure === "storage") throw new Error("private");
        },
        auth: async () => {
          if (++auth > 1 && failure === "auth") throw new Error("private");
        },
      });
      const p = probe({ concurrency: 1 });
      expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
      expect(f.sessions[0].clearStorageData).toHaveBeenCalled();
      expect(f.sessions[0].closeAllConnections).toHaveBeenCalledTimes(2);
      expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_BUSY" });
      expect(f.sessions).toHaveLength(1);
    },
  );

  it("does not return successful work before cleanup completes or accept it after an intervening revoke", async () => {
    const cleanup = deferred<void>(undefined);
    const f = fixture({ clear: () => cleanup.promise });
    const p = probe({ concurrency: 1 });
    let settled = false;
    const pending = p.probe("ipip", signal()).then((value) => {
      settled = true;
      return value;
    });
    await flush();
    expect(f.received).toHaveLength(2);
    expect(settled).toBe(false);
    const invalidated = p.invalidate();
    cleanup.resolve();
    await invalidated;
    expect(await pending).toEqual({ available: false, reason: "PROBE_CANCELLED" });
  });

  it("retains a partially created slot after hook failure instead of allocating unlimited Sessions", async () => {
    const f = fixture();
    const create = electron.fromPartition.getMockImplementation()!;
    electron.fromPartition.mockImplementation((...args) => {
      const ses = create(...args);
      ses.webRequest.onHeadersReceived.mockImplementation(() => {
        throw new Error("private");
      });
      return ses;
    });
    const p = probe({ concurrency: 1 });
    expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    expect(await p.probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_BUSY" });
    expect(f.sessions).toHaveLength(1);
    expect(f.received).toHaveLength(0);
  });

  it("never returns provider errors/bodies in failures or writes them to logs", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    fixture({
      reply: () => {
        throw new Error("https://private.invalid/?token=synthetic-secret");
      },
    });
    expect(await probe().probe("ipip", signal())).toEqual({ available: false, reason: "PROBE_UNAVAILABLE" });
    logs.forEach((log) => expect(log).not.toHaveBeenCalled());
  });
});

describe("AnonymousEgressProbe client certificate isolation", () => {
  it("shares one certificate handler with the TLS factory and revokes only matching fixed URLs", async () => {
    const reply = deferred<Reply>({ body: ip4 });
    const f = fixture({ reply: () => reply.promise });
    const tls = new AnonymousProofProbe();
    instances.push(tls);
    const first = tls.probeTls({ host: "myip.ipip.net", port: 443 }, signal());
    const second = probe().probe("ipip", signal());
    await flush();
    const listeners = electron.app.get("select-client-certificate")!;
    expect(listeners.size).toBe(1);
    const event = { preventDefault: vi.fn() },
      callback = vi.fn();
    for (const listener of listeners) listener(event, null, "https://myip.ipip.net/robots.txt", [], callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    expect(f.received.find(({ url }) => url.endsWith("robots.txt"))!.init.signal!.aborted).toBe(true);
    expect(f.received.find(({ url }) => url === "https://myip.ipip.net/")!.init.signal!.aborted).toBe(false);
    for (const listener of listeners) listener(event, null, "https://myip.ipip.net/", [], callback);
    expect(callback).toHaveBeenCalledTimes(2);
    reply.resolve({ body: ip4 });
    expect((await Promise.all([first, second])).every((result) => !result.available)).toBe(true);
  });

  it("documents fail-closed ambiguity: an ownerless event at a reserved URL denies selection once and revokes every matching probe", async () => {
    const reply = deferred<Reply>({ body: ip4 });
    const f = fixture({ reply: () => reply.promise });
    const first = probe().probe("ipip", signal());
    const second = probe().probe("ipip", signal());
    await flush();
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    // Electron has no owner field here. This could also be some other main
    // fetch; exact URL matching is a reserved-destination policy, not attribution.
    for (const listener of electron.app.get("select-client-certificate") ?? [])
      listener(event, null, "https://myip.ipip.net/", [], callback);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    expect(f.received.every(({ init }) => init.signal!.aborted)).toBe(true);
    reply.resolve({ body: ip4 });
    expect((await Promise.all([first, second])).every((result) => !result.available)).toBe(true);
  });

  it("rejects a fixed-target client certificate without selecting any OS identity", async () => {
    const echo = deferred<Reply>({ body: ip4 });
    const f = fixture({ reply: () => echo.promise });
    const pending = probe().probe("ipip", signal());
    await flush();
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    for (const listener of electron.app.get("select-client-certificate") ?? [])
      listener(event, null, "https://myip.ipip.net/", [{ privateCertificate: true }], callback);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    expect(f.received[0].init.signal!.aborted).toBe(true);
    echo.resolve({ body: ip4 });
    expect((await pending).available).toBe(false);
    expect(f.received).toHaveLength(1);
  });

  it("does not handle certificate selection for other URLs or an account WebContents, and shares one listener across instances", async () => {
    const echo = deferred<Reply>({ body: ip4 });
    fixture({ reply: () => echo.promise });
    const a = probe();
    const b = probe();
    const first = a.probe("ipip", signal());
    const second = b.probe("ipip", signal());
    await flush();
    const listeners = electron.app.get("select-client-certificate")!;
    expect(listeners.size).toBe(1);
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    for (const listener of listeners) {
      listener(event, null, "https://account.invalid/private", [], callback);
      listener(event, { session: {} }, "https://myip.ipip.net/", [], callback);
    }
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    await a.invalidate();
    expect(listeners.size).toBe(1);
    await b.invalidate();
    echo.resolve({ body: ip4 });
    await Promise.all([first, second]);
    expect(listeners.size).toBe(0);
  });
});
