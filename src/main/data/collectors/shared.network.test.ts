import vm from "node:vm";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindAccountWebContents,
  BusinessTaskCancelledError,
  installBusinessNetwork,
  NetworkDormantError,
  withBusinessTaskSignal,
  type BusinessNetworkController,
} from "@main/network/business-access";
import { firstJson, pageFetch } from "./shared";

const cleanup: Array<() => void> = [];

function fixture(initiallyAllowed = true) {
  let allowed = initiallyAllowed;
  let generation = 0;
  const leases: Array<{ abort: AbortController; release: ReturnType<typeof vi.fn> }> = [];
  const gate: BusinessNetworkController = {
    enforcement: "strict",
    check: vi.fn(() => ({ allowed, reason: allowed ? "READY" : "CHECKING" })),
    acquire: vi.fn(() => {
      if (!allowed) return null;
      const epoch = generation;
      const abort = new AbortController();
      let released = false;
      const release = vi.fn(() => {
        released = true;
      });
      leases.push({ abort, release });
      return { signal: abort.signal, isCurrent: () => epoch === generation && !released, release };
    }),
  };
  cleanup.push(installBusinessNetwork(gate));
  const fetch = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(async () =>
    Response.json({ accepted: true }),
  );
  // Execute the production injected code in a persistent browser-shaped realm.
  // Only the transport is controlled; pageFetch, its cancellation injection,
  // firstJson and the business task/gate wrappers are the actual implementation.
  const context = vm.createContext({ AbortController, fetch });
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => "https://creator.douyin.com/creator-micro/home"),
    executeJavaScript: vi.fn<(script: string, userGesture?: boolean) => Promise<unknown>>(async (script) =>
      vm.runInContext(script, context),
    ),
  });
  const wc = contents as unknown as WebContents;
  cleanup.push(bindAccountWebContents(wc, "account-one"));
  return {
    wc,
    contents,
    context,
    fetch,
    gate,
    leases,
    revoke() {
      allowed = false;
      generation += 1;
      for (const lease of leases) lease.abort.abort();
    },
    pendingCount: () =>
      vm.runInContext('globalThis[Symbol.for("clipdock.collect.aborts")]?.size ?? 0', context) as number,
  };
}

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

/** An unresolved executeJavaScript must not hold the main task indefinitely. */
async function boundedRejection(promise: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => ({ unexpectedSuccess: true }),
        (error: unknown) => error,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ mainTaskStillPending: true }), 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("page collector network and task cancellation", () => {
  it("does not execute page code or fetch while the gate is closed", async () => {
    const f = fixture(false);
    await expect(pageFetch(f.wc, "/fixture-data")).rejects.toBeInstanceOf(NetworkDormantError);
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.gate.acquire).not.toHaveBeenCalled();
    expect(f.gate.check).toHaveBeenCalledWith("account-one", "https://creator.douyin.com/fixture-data");
  });

  it("does not acquire or execute anything for a task already canceled", async () => {
    const f = fixture();
    const task = new AbortController();
    task.abort();
    const pending = withBusinessTaskSignal(task.signal, () => pageFetch(f.wc, "/fixture-data"));
    await expect(pending).rejects.toBeInstanceOf(BusinessTaskCancelledError);
    expect(f.gate.acquire).not.toHaveBeenCalled();
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["gate", "task"])(
    "settles the main task on %s cancellation even if executeJavaScript never settles",
    async (cause) => {
      const f = fixture();
      const task = new AbortController();
      // This models the actual Electron failure: both the request evaluation
      // and best-effort cancellation injection may remain permanently pending.
      f.contents.executeJavaScript.mockImplementation(() => new Promise<never>(() => {}));
      const pending = withBusinessTaskSignal(task.signal, () => pageFetch(f.wc, "/never-settles"));
      const outcome = boundedRejection(pending);
      expect(f.contents.executeJavaScript).toHaveBeenCalledOnce();
      if (cause === "gate") f.revoke();
      else task.abort();
      const error = await outcome;
      expect(error).toBeInstanceOf(cause === "gate" ? NetworkDormantError : BusinessTaskCancelledError);
      if (cause === "gate") expect(error).toMatchObject({ code: "NETWORK_DORMANT", reason: "GATE_REVOKED" });
      expect(f.leases[0].release).toHaveBeenCalledOnce();
      expect(f.contents.listenerCount("destroyed")).toBe(0);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it("terminates a pending evaluation when WebContents is destroyed while the gate remains allowed", async () => {
    const f = fixture();
    f.contents.executeJavaScript.mockImplementation(() => new Promise<never>(() => {}));
    const pending = pageFetch(f.wc, "/destroyed-view");
    const outcome = boundedRejection(pending);
    f.contents.isDestroyed.mockReturnValue(true);
    f.contents.emit("destroyed");
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NetworkDormantError);
    expect(error).not.toBeInstanceOf(BusinessTaskCancelledError);
    expect((error as Error).message).toMatch(/destroy/i);
    expect(f.gate.check("account-one").allowed).toBe(true);
    expect(f.leases[0].release).toHaveBeenCalledOnce();
    expect(f.contents.listenerCount("destroyed")).toBe(0);
  });

  it.each(["task", "gate"])(
    "actually aborts an in-page fetch on %s cancellation and does not try the next candidate",
    async (cause) => {
      const f = fixture();
      const task = new AbortController();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let requestSignal: AbortSignal | undefined;
      const transportAbort = vi.fn();
      f.fetch.mockImplementation(
        (_url, options) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = options!.signal!;
            requestSignal.addEventListener(
              "abort",
              () => {
                transportAbort();
                reject(new DOMException("fixture canceled", "AbortError"));
              },
              { once: true },
            );
            markStarted();
          }),
      );
      const pending = withBusinessTaskSignal(task.signal, () =>
        firstJson(f.wc, [{ url: "/first" }, { url: "/must-not-start" }], () => true),
      );
      const rejected = expect(pending).rejects.toBeInstanceOf(
        cause === "task" ? BusinessTaskCancelledError : NetworkDormantError,
      );
      await started;
      expect(requestSignal?.aborted).toBe(false);
      expect(f.pendingCount()).toBe(1);
      if (cause === "task") task.abort();
      else f.revoke();
      await rejected;
      expect(transportAbort).toHaveBeenCalledOnce();
      expect(requestSignal?.aborted).toBe(true);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.fetch).toHaveBeenCalledWith(
        "/first",
        expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
      );
      expect(f.pendingCount()).toBe(0);
      expect(f.leases[0].release).toHaveBeenCalledOnce();
    },
  );

  it("aborts an in-page response body after headers arrive, without classifying user cancellation as dormancy", async () => {
    const f = fixture();
    const task = new AbortController();
    let markBodyWaiting!: () => void;
    const bodyWaiting = new Promise<void>((resolve) => {
      markBodyWaiting = resolve;
    });
    const transportAbort = vi.fn();
    f.fetch.mockImplementation(
      async (_url, options) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"unfinished":'));
              options!.signal!.addEventListener(
                "abort",
                () => {
                  transportAbort();
                  stream.error(new DOMException("fixture body canceled", "AbortError"));
                },
                { once: true },
              );
            },
            pull() {
              markBodyWaiting();
            },
          }),
        ),
    );
    const pending = withBusinessTaskSignal(task.signal, () => pageFetch(f.wc, "/body-stream"));
    const outcome = pending.catch((error: unknown) => error);
    await bodyWaiting;
    expect(f.leases[0].release).not.toHaveBeenCalled();
    task.abort();
    const error = await outcome;
    expect(error).toBeInstanceOf(BusinessTaskCancelledError);
    expect(error).not.toBeInstanceOf(NetworkDormantError);
    expect(transportAbort).toHaveBeenCalledOnce();
    // Main termination now deliberately wins the race; renderer body cleanup
    // follows independently and must not be a prerequisite for releasing work.
    expect(f.leases[0].release).toHaveBeenCalledOnce();
    await f.contents.executeJavaScript.mock.results[0].value;
    expect(f.pendingCount()).toBe(0);
  });

  it("remembers cancellation that arrives before the request script executes", async () => {
    const f = fixture();
    const task = new AbortController();
    let releaseScript!: () => void;
    f.contents.executeJavaScript.mockImplementation((script, userGesture) => {
      if (!userGesture) return Promise.resolve(vm.runInContext(script, f.context));
      return new Promise<unknown>((resolve, reject) => {
        releaseScript = () => {
          Promise.resolve(vm.runInContext(script, f.context)).then(resolve, reject);
        };
      });
    });
    const requestSent = vi.fn();
    f.fetch.mockImplementation(async (_url, options) => {
      if (options!.signal!.aborted) throw new DOMException("already aborted before transport", "AbortError");
      requestSent();
      return Response.json({ accepted: true });
    });
    const pending = withBusinessTaskSignal(task.signal, () => pageFetch(f.wc, "/delayed-script"));
    const rejected = expect(pending).rejects.toBeInstanceOf(BusinessTaskCancelledError);
    task.abort();
    expect(f.pendingCount()).toBe(1);
    releaseScript();
    await rejected;
    expect(requestSent).not.toHaveBeenCalled();
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(f.pendingCount()).toBe(0);
  });

  it("still tries a second candidate after an ordinary nonmatching JSON result", async () => {
    const f = fixture();
    f.fetch
      .mockResolvedValueOnce(Response.json({ accepted: false }))
      .mockResolvedValueOnce(Response.json({ accepted: true, value: 42 }));
    const result = await firstJson<{ accepted: boolean; value: number }>(
      f.wc,
      [{ url: "/first" }, { url: "/second" }],
      (json) => json.accepted === true,
    );
    expect(result).toEqual({ accepted: true, value: 42 });
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual(["/first", "/second"]);
    expect(f.pendingCount()).toBe(0);
    expect(f.leases.every((lease) => lease.release.mock.calls.length === 1)).toBe(true);
  });
});
