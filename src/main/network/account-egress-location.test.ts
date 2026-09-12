import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountEgressLocationService,
  type AccountEgressLocationContext,
  type AccountEgressLocationOptions,
} from "./account-egress-location";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const cleanups: (() => Promise<void>)[] = [];
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
beforeEach(() =>
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"],
  }),
);
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const context = (): AccountEgressLocationContext => ({
  mode: "direct",
  generation: 1,
  networkHash: hash("network"),
  controllerUrl: "http://127.0.0.1:9790",
  proxyPort: 10090,
  credentialRevision: hash("credential"),
  controllerFingerprint: hash("controller"),
});
const result = (city = "杭州") => ({
  ip: "110.43.50.20",
  location: { country: "中国", region: "浙江", city },
  observedAtMono: performance.now(),
});
function fixture() {
  let current: AccountEgressLocationContext | null = context();
  const sample = vi.fn(async (_signal: AbortSignal) => result()),
    dispose = vi.fn(async () => {});
  const createClient = vi.fn(() => ({ sample, dispose }));
  const onChanged = vi.fn();
  const source = new AccountEgressLocationService({
    readContext: () => current,
    getSecret: () => null,
    createClient,
    onChanged,
  });
  cleanups.push(() => source.dispose());
  return {
    source,
    sample,
    dispose,
    createClient,
    onChanged,
    set: (value: AccountEgressLocationContext | null) => {
      current = value;
    },
  };
}
describe("account egress location observer", () => {
  it("publishes informational direct location, caches for ten minutes and keeps reads side-effect free", async () => {
    const f = fixture();
    f.source.start();
    await settle();
    expect(f.source.read()).toMatchObject({ state: "ready", route: "direct", country: "中国", city: "杭州" });
    const changes = f.onChanged.mock.calls.length;
    for (let i = 0; i < 20; i++) f.source.read();
    expect(f.onChanged).toHaveBeenCalledTimes(changes);
    await vi.advanceTimersByTimeAsync(599999);
    expect(f.sample).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sample).toHaveBeenCalledTimes(2);
    expect(f.dispose).toHaveBeenCalledTimes(2);
  });
  it("waits sixty seconds after failure instead of repeatedly probing", async () => {
    const f = fixture();
    f.sample.mockResolvedValue(null as never);
    f.source.start();
    await settle();
    expect(f.source.read().state).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(59999);
    expect(f.sample).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sample).toHaveBeenCalledTimes(2);
  });
  it("clears a mismatched context in pure reads without emitting and refreshes only on sync", async () => {
    const f = fixture();
    f.source.start();
    await settle();
    const changes = f.onChanged.mock.calls.length;
    f.set({ ...context(), networkHash: hash("new-network") });
    expect(f.source.read()).toMatchObject({ state: "unavailable", ip: null, city: null });
    expect(f.onChanged).toHaveBeenCalledTimes(changes);
    expect(f.sample).toHaveBeenCalledTimes(1);
    f.source.sync();
    await settle();
    expect(f.sample).toHaveBeenCalledTimes(2);
  });
  it("cancels old work and ignores its late location after a network change", async () => {
    const f = fixture();
    let finish!: (sample: ReturnType<typeof result>) => void;
    f.sample.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.source.start();
    await settle();
    const oldSignal = f.sample.mock.calls[0][0];
    f.set({ ...context(), networkHash: hash("new-network") });
    f.source.sync();
    expect(oldSignal.aborted).toBe(true);
    expect(f.source.read()).toMatchObject({ state: "checking", city: null });
    finish(result("旧城"));
    await settle();
    expect(f.source.read()).toMatchObject({ state: "ready", city: "杭州" });
    expect(f.sample).toHaveBeenCalledTimes(2);
  });
  it("waits for cancelled client cleanup before starting the next context", async () => {
    const f = fixture();
    let finishCleanup!: () => void;
    f.dispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    f.source.start();
    await settle();
    f.set({ ...context(), networkHash: hash("new-network") });
    f.source.sync();
    await settle();
    expect(f.createClient).toHaveBeenCalledTimes(1);
    expect(f.source.read()).toMatchObject({ state: "checking", city: null });
    finishCleanup();
    await settle();
    expect(f.createClient).toHaveBeenCalledTimes(2);
    expect(f.source.read()).toMatchObject({ state: "ready", city: "杭州" });
  });
  it("clears expired display data from read without relying on a timer or emitting", async () => {
    const f = fixture();
    f.source.start();
    await settle();
    const changes = f.onChanged.mock.calls.length;
    vi.spyOn(performance, "now").mockReturnValue(600001);
    expect(f.source.read()).toMatchObject({ state: "checking", ip: null, city: null });
    expect(f.onChanged).toHaveBeenCalledTimes(changes);
    expect(f.sample).toHaveBeenCalledTimes(1);
  });
  it("isolates display callback failures from probe completion", async () => {
    const f = fixture();
    f.onChanged.mockImplementation(() => {
      throw Error("UI callback failed");
    });
    f.source.start();
    await settle();
    expect(f.source.read()).toMatchObject({ state: "ready", city: "杭州" });
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it("has no sampling authority when the main-process context is unavailable or invalid", async () => {
    const f = fixture();
    f.set(null);
    f.source.start();
    await settle();
    expect(f.createClient).not.toHaveBeenCalled();
    f.set({ ...context(), mode: "rule", controllerUrl: "https://example.com" });
    f.source.sync();
    await settle();
    expect(f.createClient).not.toHaveBeenCalled();
    f.set({ ...context(), mode: "rule" });
    f.source.sync();
    await settle();
    expect(f.createClient.mock.calls[0][0]).toMatchObject({ mode: "rule" });
    expect(f.source.read().state).toBe("ready");
  });
  it("does not restart or publish a late result after disposal", async () => {
    const f = fixture();
    let finish!: (sample: ReturnType<typeof result>) => void;
    f.sample.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.source.start();
    await settle();
    const changes = f.onChanged.mock.calls.length,
      disposal = f.source.dispose();
    expect(f.sample.mock.calls[0][0].aborted).toBe(true);
    finish(result());
    await disposal;
    f.source.start();
    f.source.sync();
    expect(f.onChanged).toHaveBeenCalledTimes(changes);
    expect(f.source.read().state).toBe("unavailable");
  });
});

function directFixture(reply: { status?: number; body?: Buffer; hold?: boolean } = {}) {
  const options: https.RequestOptions[] = [];
  vi.spyOn(https, "request").mockImplementation(((
    input: https.RequestOptions,
    callback: (value: unknown) => void,
  ) => {
    options.push(input);
    let closed = false;
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn(() => {
        if (!closed) {
          closed = true;
          queueMicrotask(() => request.emit("close"));
        }
      }),
      end: vi.fn(() => {
        if (reply.hold) return;
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), {
            statusCode: reply.status ?? 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
            complete: true,
          });
          callback(response);
          if (!response.destroyed)
            response.end(reply.body ?? Buffer.from("当前 IP： 110.43.50.20 来自于： 中国 浙江 杭州 电信\n"));
        });
      }),
    });
    return request;
  }) as typeof https.request);
  const source = new AccountEgressLocationService({ readContext: context, getSecret: () => null });
  cleanups.push(() => source.dispose());
  return { source, options };
}
describe("fixed anonymous direct location request", () => {
  it("uses only fixed HTTPS GET with normal TLS verification and no account credentials", async () => {
    const f = directFixture();
    f.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.options).toHaveLength(1);
    expect(f.options[0]).toMatchObject({
      hostname: "myip.ipip.net",
      path: "/",
      port: 443,
      method: "GET",
      agent: false,
      rejectUnauthorized: true,
    });
    expect(JSON.stringify(f.options[0].headers)).not.toMatch(/cookie|authorization/i);
    expect(f.source.read()).toMatchObject({ state: "ready", city: "杭州" });
  });
  it.each([302, 403, 500])("does not follow status %s to another host", async (status) => {
    const f = directFixture({ status });
    f.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.options).toHaveLength(1);
    expect(f.source.read().state).toBe("unavailable");
  });
  it("rejects oversized responses", async () => {
    const f = directFixture({ body: Buffer.alloc(16385, 65) });
    f.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.source.read().state).toBe("unavailable");
  });
  it("ends an unresponsive request at eight seconds", async () => {
    const f = directFixture({ hold: true });
    f.source.start();
    await settle();
    await vi.advanceTimersByTimeAsync(7999);
    expect(f.source.read().state).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    expect(f.source.read().state).toBe("unavailable");
  });
});
