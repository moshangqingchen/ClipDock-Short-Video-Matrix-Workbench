import { afterEach, expect, it, vi } from "vitest";
import { WindowsReadBatch } from "./windows-read-batch";
afterEach(() => vi.useRealTimers());
it("uses one process for same-round proxy/network reads without caching later samples", async () => {
  vi.useFakeTimers();
  const runner = vi.fn(async () => JSON.stringify({ 0: "network", 1: "proxy" }));
  const batch = new WindowsReadBatch(runner);
  const network = batch.read("fixed-network"),
    proxy = batch.read("fixed-proxy");
  await vi.advanceTimersByTimeAsync(20);
  expect(await network).toBe("network");
  expect(await proxy).toBe("proxy");
  expect(runner).toHaveBeenCalledOnce();
  const later = batch.read("fixed-network");
  await vi.advanceTimersByTimeAsync(20);
  await later;
  expect(runner).toHaveBeenCalledTimes(2);
});
it("revocation cancels the combined process and does not publish a partial sample", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const runner = vi.fn(async (_script, signal) => {
    abort.abort();
    expect(signal.aborted).toBe(true);
    return '{"0":"old","1":"old"}';
  });
  const batch = new WindowsReadBatch(runner);
  const pending = Promise.allSettled([batch.read("fixed-network"), batch.read("fixed-proxy", abort.signal)]);
  await vi.advanceTimersByTimeAsync(20);
  expect((await pending).every((r) => r.status === "rejected")).toBe(true);
});
