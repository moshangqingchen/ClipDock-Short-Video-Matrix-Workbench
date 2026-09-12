import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAccountView } from "./close-account-view";

afterEach(() => vi.useRealTimers());
function contents() {
  const events = new EventEmitter();
  let destroyed = false;
  return Object.assign(events, {
    isDestroyed: () => destroyed,
    stop: vi.fn(),
    close: vi.fn(),
    destroy: () => {
      destroyed = true;
      events.emit("destroyed");
    },
  });
}

describe("closeAccountView", () => {
  it("stops and forces close immediately, but does not finish before destroyed", async () => {
    const wc = contents();
    const completed = vi.fn();
    const pending = closeAccountView(wc as never).then(completed);
    expect(wc.stop).toHaveBeenCalledTimes(1);
    expect(wc.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    wc.destroy();
    await pending;
    expect(completed).toHaveBeenCalledTimes(1);
    expect(wc.listenerCount("destroyed")).toBe(0);
  });
  it("reports closure failure after a bounded wait instead of pretending success", async () => {
    vi.useFakeTimers();
    const wc = contents();
    const pending = closeAccountView(wc as never);
    const result = expect(pending).rejects.toThrow("ACCOUNT_VIEW_CLOSE_FAILED");
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(wc.listenerCount("destroyed")).toBe(0);
  });
  it("still closes if stop fails, and does not expose native error details", async () => {
    const wc = contents();
    wc.stop.mockImplementation(() => {
      throw new Error("native-url?secret");
    });
    wc.close.mockImplementation(() => {
      throw new Error("native-url?secret");
    });
    await expect(closeAccountView(wc as never)).rejects.toThrow(/^ACCOUNT_VIEW_CLOSE_FAILED$/);
    expect(wc.close).toHaveBeenCalledTimes(1);
  });
  it("does not touch already destroyed contents", async () => {
    const wc = contents();
    wc.destroy();
    await closeAccountView(wc as never);
    expect(wc.stop).not.toHaveBeenCalled();
    expect(wc.close).not.toHaveBeenCalled();
  });
});
