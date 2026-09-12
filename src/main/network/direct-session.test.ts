import { describe, expect, it, vi } from "vitest";
import { ensureDirectSession, isDirectSessionReady, type DirectSessionLike } from "./direct-session";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("ensureDirectSession", () => {
  it("waits for direct mode, immediate connection closure, and DNS clearing before readiness", async () => {
    const proxy = deferred();
    const connections = deferred();
    const dns = deferred();
    const session: DirectSessionLike = {
      setProxy: vi.fn(() => proxy.promise),
      closeAllConnections: vi.fn(() => connections.promise),
      clearHostResolverCache: vi.fn(() => dns.promise),
    };
    const initialization = ensureDirectSession(session);
    await Promise.resolve();
    expect(session.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    expect(session.closeAllConnections).not.toHaveBeenCalled();
    expect(isDirectSessionReady(session)).toBe(false);

    proxy.resolve();
    await Promise.resolve();
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(isDirectSessionReady(session)).toBe(false);
    connections.resolve();
    await Promise.resolve();
    expect(session.clearHostResolverCache).toHaveBeenCalledOnce();
    expect(isDirectSessionReady(session)).toBe(false);
    dns.resolve();
    await initialization;
    expect(isDirectSessionReady(session)).toBe(true);
  });

  it("shares one initialization for concurrent callers and remains idempotent after success", async () => {
    const proxy = deferred();
    const session: DirectSessionLike = {
      setProxy: vi.fn(() => proxy.promise),
      closeAllConnections: vi.fn(async () => undefined),
      clearHostResolverCache: vi.fn(async () => undefined),
    };
    const first = ensureDirectSession(session);
    const second = ensureDirectSession(session);
    expect(second).toBe(first);
    proxy.resolve();
    await Promise.all([first, second]);
    await ensureDirectSession(session);
    expect(session.setProxy).toHaveBeenCalledTimes(1);
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(session.clearHostResolverCache).toHaveBeenCalledTimes(1);
  });

  it("does not close or grant readiness after a failed setProxy and can retry", async () => {
    const session: DirectSessionLike = {
      setProxy: vi
        .fn()
        .mockRejectedValueOnce(new Error("private-provider-detail"))
        .mockResolvedValue(undefined),
      closeAllConnections: vi.fn(async () => undefined),
      clearHostResolverCache: vi.fn(async () => undefined),
    };
    await expect(ensureDirectSession(session)).rejects.toThrow(/^DIRECT_SESSION_INITIALIZATION_FAILED$/);
    expect(session.closeAllConnections).not.toHaveBeenCalled();
    expect(session.clearHostResolverCache).not.toHaveBeenCalled();
    expect(isDirectSessionReady(session)).toBe(false);
    await ensureDirectSession(session);
    expect(session.setProxy).toHaveBeenCalledTimes(2);
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(isDirectSessionReady(session)).toBe(true);
  });

  it("retries both ordered steps when closing old connections failed", async () => {
    const session: DirectSessionLike = {
      setProxy: vi.fn(async () => undefined),
      closeAllConnections: vi
        .fn()
        .mockRejectedValueOnce(new Error("close-failed"))
        .mockResolvedValue(undefined),
      clearHostResolverCache: vi.fn(async () => undefined),
    };
    const first = ensureDirectSession(session);
    const concurrent = ensureDirectSession(session);
    const failures = await Promise.allSettled([first, concurrent]);
    expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(isDirectSessionReady(session)).toBe(false);
    expect(session.clearHostResolverCache).not.toHaveBeenCalled();
    await ensureDirectSession(session);
    expect(session.setProxy).toHaveBeenCalledTimes(2);
    expect(session.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(isDirectSessionReady(session)).toBe(true);
  });

  it("tracks separate sessions independently", async () => {
    const make = (): DirectSessionLike => ({
      setProxy: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
      clearHostResolverCache: vi.fn(async () => undefined),
    });
    const first = make();
    const second = make();
    await ensureDirectSession(first);
    expect(isDirectSessionReady(second)).toBe(false);
    await ensureDirectSession(second);
    expect(second.setProxy).toHaveBeenCalledTimes(1);
  });

  it("does not publish readiness after DNS clearing fails and repeats the full sequence on retry", async () => {
    const order: string[] = [];
    const session: DirectSessionLike = {
      setProxy: vi.fn(async () => {
        order.push("direct");
      }),
      closeAllConnections: vi.fn(async () => {
        order.push("close");
      }),
      clearHostResolverCache: vi
        .fn(async () => {
          order.push("dns");
        })
        .mockImplementationOnce(async () => {
          order.push("dns");
          throw new Error("private-dns-error");
        }),
    };
    await expect(ensureDirectSession(session)).rejects.toThrow(/^DIRECT_SESSION_INITIALIZATION_FAILED$/);
    expect(isDirectSessionReady(session)).toBe(false);
    await ensureDirectSession(session);
    expect(order).toEqual(["direct", "close", "dns", "direct", "close", "dns"]);
    expect(isDirectSessionReady(session)).toBe(true);
  });
});
