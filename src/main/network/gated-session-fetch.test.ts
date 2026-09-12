import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessNetworkController } from "./business-access";
import { installBusinessNetwork, NetworkDormantError } from "./business-access";
import { gatedSessionFetch } from "./gated-session-fetch";

const accountId = "synthetic-account";
const target = "https://creator.douyin.com/web/api/media/user/info/";
const cleanups: Array<() => void> = [];

function gateFixture(initiallyAllowed = true) {
  let allowed = initiallyAllowed;
  let generation = 0;
  const leases: Array<{ abort: AbortController; release: ReturnType<typeof vi.fn> }> = [];
  const controller: BusinessNetworkController = {
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
  cleanups.push(installBusinessNetwork(controller));
  return {
    controller,
    leases,
    revoke() {
      allowed = false;
      generation += 1;
      for (const lease of leases) lease.abort.abort();
    },
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("gatedSessionFetch credential-bearing probes", () => {
  it("does not call session.fetch or acquire a lease while the gate is closed", async () => {
    const gate = gateFixture(false);
    const fetch = vi.fn(async () => new Response("unexpected"));
    await expect(gatedSessionFetch(accountId, { fetch }, target)).rejects.toBeInstanceOf(NetworkDormantError);
    expect(fetch).not.toHaveBeenCalled();
    expect(gate.controller.acquire).not.toHaveBeenCalled();
    expect(gate.controller.check).toHaveBeenCalledWith(accountId, target);
  });

  it("keeps the lease until a pending response body is aborted by revocation", async () => {
    vi.useFakeTimers();
    const gate = gateFixture();
    let markBodyWaiting!: () => void;
    const bodyWaiting = new Promise<void>((resolve) => {
      markBodyWaiting = resolve;
    });
    let sentSignal: AbortSignal | undefined;
    let observedTransportAbort = false;
    const fetch = vi.fn(async (_url: string, options?: RequestInit) => {
      sentSignal = options!.signal!;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"partial":'));
            sentSignal!.addEventListener(
              "abort",
              () => {
                observedTransportAbort = true;
                stream.error(new DOMException("fixture transport aborted", "AbortError"));
              },
              { once: true },
            );
          },
          pull() {
            markBodyWaiting();
          },
        }),
      );
    });
    const pending = gatedSessionFetch(accountId, { fetch }, target);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "NETWORK_DORMANT",
      reason: "GATE_REVOKED",
    });
    await bodyWaiting;
    expect(gate.leases[0].release).not.toHaveBeenCalled();
    expect(sentSignal?.aborted).toBe(false);
    gate.revoke();
    await rejected;
    expect(observedTransportAbort).toBe(true);
    expect(sentSignal?.aborted).toBe(true);
    expect(gate.leases[0].release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops headers returned after revocation even if the transport ignores abort", async () => {
    const gate = gateFixture();
    let resolveResponse!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const pending = gatedSessionFetch(accountId, { fetch }, target);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "NETWORK_DORMANT",
      reason: "GATE_REVOKED",
    });
    gate.revoke();
    resolveResponse(Response.json({ status_code: 0 }));
    await rejected;
    expect(gate.leases[0].release).toHaveBeenCalledOnce();
  });

  it("preserves a caller abort as transport cancellation while the gate remains valid", async () => {
    const gate = gateFixture();
    const caller = new AbortController();
    const fetch = vi.fn(
      (_url: string, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("fixture caller canceled", "AbortError")),
            { once: true },
          );
        }),
    );
    const pending = gatedSessionFetch(accountId, { fetch }, target, { signal: caller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    caller.abort();
    await rejected;
    expect(gate.leases[0].release).toHaveBeenCalledOnce();
  });

  it("returns a completed probe and releases its lease without leaving a timeout", async () => {
    vi.useFakeTimers();
    const gate = gateFixture();
    const fetch = vi.fn(async () => Response.json({ status_code: 0 }));
    const result = await gatedSessionFetch(accountId, { fetch }, target);
    expect(result).toMatchObject({ status: 200, text: '{"status_code":0}' });
    expect(fetch).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
    );
    expect(gate.leases[0].release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
