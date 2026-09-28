// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@renderer/lib/api";
import { useMetricResource } from "./use-metric-resource";

const listeners = new Map<string, Set<(payload: never) => void>>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(api, "on").mockImplementation((event, listener) => {
    const handlers = listeners.get(event) ?? new Set();
    handlers.add(listener); listeners.set(event, handlers);
    return () => handlers.delete(listener);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); listeners.clear(); });
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach(listener => listener(payload as never));

it("ends a hanging read after a bounded wait, permits retry and ignores its late response", async () => {
  let resolveOld!: (value: string) => void;
  const load = vi.fn<() => Promise<string>>().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue("fresh");
  const { result } = renderHook(() => useMetricResource(load));
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(result.current).toMatchObject({ loading: false, error: true, data: null });
  await act(async () => result.current.retry());
  expect(result.current).toMatchObject({ loading: false, error: false, data: "fresh" });
  await act(async () => resolveOld("late"));
  expect(result.current.data).toBe("fresh");
});

it("filters other accounts, coalesces event bursts and refreshes failed collection results without new metrics", async () => {
  const load = vi.fn().mockResolvedValue("saved");
  const { unmount } = renderHook(() => useMetricResource(load, "owner"));
  await act(async () => Promise.resolve());
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { emit("metrics-updated", { accountId: "other" }); await vi.advanceTimersByTimeAsync(500); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    for (let index = 0; index < 20; index++) emit("metrics-updated", { accountId: "owner" });
    emit("collect-run", { accountId: "owner", status: "failed" });
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(load).toHaveBeenCalledTimes(2);
  unmount();
  expect([...listeners.values()].every(handlers => handlers.size === 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not stack concurrent local reads when updates arrive during a slow response", async () => {
  let resolve!: (value: string) => void;
  const load = vi.fn<() => Promise<string>>().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue("updated");
  const { result } = renderHook(() => useMetricResource(load, "owner"));
  await act(async () => {
    for (let index = 0; index < 4; index++) {
      emit("metrics-updated", { accountId: "owner" });
      await vi.advanceTimersByTimeAsync(300);
    }
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { resolve("initial"); await vi.advanceTimersByTimeAsync(250); });
  expect(load).toHaveBeenCalledTimes(2);
  expect(result.current.data).toBe("updated");
});

it("never exposes the previous account's data in any render of a new account, before effects run", async () => {
  const load = vi.fn<() => Promise<string>>().mockResolvedValueOnce("owner-data").mockImplementation(() => new Promise(() => undefined));
  const renders: Array<{ accountId: string; data: string | null; loading: boolean }> = [];
  const { rerender } = renderHook(({ accountId }) => {
    const resource = useMetricResource(load, accountId);
    renders.push({ accountId, data: resource.data, loading: resource.loading });
    return resource;
  }, { initialProps: { accountId: "owner" } });
  await act(async () => Promise.resolve());
  expect(renders.some(render => render.accountId === "owner" && render.data === "owner-data")).toBe(true);
  rerender({ accountId: "other" });
  const nextRenders = renders.filter(render => render.accountId === "other");
  expect(nextRenders.length).toBeGreaterThan(0);
  expect(nextRenders.every(render => render.data === null && render.loading)).toBe(true);
});
