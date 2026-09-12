// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@renderer/lib/api";
import { useUi } from "@renderer/store";
import { ViewHost } from "./ViewHost";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("ViewHost native visibility lifecycle", () => {
  let visible: string | null;
  let requests: Array<ReturnType<typeof deferred>>;
  beforeEach(() => {
    visible = null;
    requests = [];
    useUi.setState({ overlayCount: 0 });
    vi.spyOn(api.views, "show").mockImplementation(async (id) => {
      const request = deferred();
      requests.push(request);
      await request.promise;
      visible = id;
      return { accountId: id } as Awaited<ReturnType<typeof api.views.show>>;
    });
    vi.spyOn(api.views, "hide").mockImplementation(async (id) => {
      if (visible === id) visible = null;
    });
    vi.spyOn(api.views, "setBounds").mockResolvedValue(undefined);
    vi.spyOn(api.views, "navigate").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    cleanup();
    await act(async () => {
      requests.forEach((request) => request.resolve());
    });
    vi.restoreAllMocks();
    useUi.setState({ overlayCount: 0 });
  });

  it("hides a late show after leaving the domestic page instead of covering the new page", async () => {
    const onError = vi.fn();
    const host = render(<ViewHost accountId="domestic" onError={onError} />);
    await act(async () => undefined);
    expect(requests).toHaveLength(1);
    expect(api.views.show).toHaveBeenLastCalledWith("domestic", expect.any(Object), true);
    host.unmount();
    expect(api.views.hide).toHaveBeenCalledWith("domestic");

    await act(async () => requests[0].resolve());
    expect(visible).toBeNull();
    expect(api.views.hide).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("finishes an old account's hide before showing the newly selected account", async () => {
    const host = render(<ViewHost accountId="first" />);
    await act(async () => undefined);
    host.rerender(<ViewHost accountId="second" />);
    await act(async () => undefined);
    expect(api.views.show).toHaveBeenCalledTimes(1);

    await act(async () => requests[0].resolve());
    expect(requests).toHaveLength(2);
    expect(visible).toBeNull();
    expect(api.views.show).toHaveBeenLastCalledWith("second", expect.any(Object), true);
    await act(async () => requests[1].resolve());
    expect(visible).toBe("second");
  });

  it("does not let an old completion hide the same account after it is remounted", async () => {
    const old = render(<ViewHost accountId="one" />);
    await act(async () => undefined);
    old.unmount();
    render(<ViewHost accountId="one" />);
    await act(async () => undefined);
    expect(api.views.show).toHaveBeenCalledTimes(1);

    await act(async () => requests[0].resolve());
    expect(requests).toHaveLength(2);
    expect(api.views.show).toHaveBeenLastCalledWith("one", expect.any(Object), true);
    await act(async () => requests[1].resolve());
    expect(visible).toBe("one");
  });

  it("keeps a modal visible when an earlier show completes, then restores its account", async () => {
    render(<ViewHost accountId="one" />);
    await act(async () => undefined);
    act(() => useUi.setState({ overlayCount: 1 }));
    await act(async () => requests[0].resolve());
    expect(visible).toBeNull();

    act(() => useUi.setState({ overlayCount: 0 }));
    await act(async () => undefined);
    expect(requests).toHaveLength(2);
    expect(api.views.show).toHaveBeenLastCalledWith("one", expect.any(Object), false);
    await act(async () => requests[1].resolve());
    expect(visible).toBe("one");
  });

  it("allows the next account to show after the previous request failed", async () => {
    const oldError = vi.fn();
    const currentError = vi.fn();
    const host = render(<ViewHost accountId="first" onError={oldError} />);
    await act(async () => undefined);
    host.rerender(<ViewHost accountId="second" onError={currentError} />);
    await act(async () => requests[0].reject(new Error("view closed")));
    expect(oldError).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    await act(async () => requests[1].resolve());
    expect(visible).toBe("second");
    expect(currentError).toHaveBeenCalledExactlyOnceWith("");
  });

  it("retries the homepage entry after an unsuccessful first show", async () => {
    const host = render(<ViewHost accountId="one" />);
    await act(async () => undefined);
    await act(async () => requests[0].reject(new Error("network unavailable")));
    act(() => useUi.setState({ overlayCount: 1 }));
    act(() => useUi.setState({ overlayCount: 0 }));
    await act(async () => undefined);
    expect(api.views.show).toHaveBeenLastCalledWith("one", expect.any(Object), true);
    await act(async () => requests[1].resolve());
    host.unmount();
  });

  it("claims the foreground before opening a work and restores overlays without another navigation", async () => {
    const navigation = deferred();
    vi.mocked(api.views.navigate).mockImplementation(() => {
      expect(visible).toBe("owner");
      return navigation.promise;
    });
    render(<ViewHost accountId="owner" initialUrl="https://www.douyin.com/video/123" />);
    await act(async () => undefined);
    expect(api.views.navigate).not.toHaveBeenCalled();
    expect(api.views.show).toHaveBeenCalledExactlyOnceWith("owner", expect.any(Object), false);
    await act(async () => requests[0].resolve());
    expect(api.views.navigate).toHaveBeenCalledExactlyOnceWith("owner", "https://www.douyin.com/video/123");
    await act(async () => navigation.resolve());
    expect(api.views.show).toHaveBeenCalledTimes(1);
    act(() => useUi.setState({ overlayCount: 1 }));
    act(() => useUi.setState({ overlayCount: 0 }));
    await act(async () => undefined);
    expect(api.views.navigate).toHaveBeenCalledTimes(1);
    expect(api.views.show).toHaveBeenLastCalledWith("owner", expect.any(Object), false);
    await act(async () => requests[1].resolve());
  });

  it("does not start work navigation after its pending show was cancelled by an account switch", async () => {
    const old = render(<ViewHost accountId="owner" initialUrl="https://www.douyin.com/video/123" />);
    await act(async () => undefined);
    old.unmount();
    render(<ViewHost accountId="other" />);
    await act(async () => requests[0].resolve());
    expect(api.views.navigate).not.toHaveBeenCalled();
    expect(api.views.show).toHaveBeenLastCalledWith("other", expect.any(Object), true);
    await act(async () => requests[1].resolve());
    expect(visible).toBe("other");
  });

  it("finishes a cancelled work navigation before showing the next account", async () => {
    const navigation = deferred();
    vi.mocked(api.views.navigate).mockReturnValue(navigation.promise);
    const old = render(<ViewHost accountId="owner" initialUrl="https://www.douyin.com/video/123" />);
    await act(async () => undefined);
    await act(async () => requests[0].resolve());
    old.unmount();
    render(<ViewHost accountId="other" />);
    await act(async () => undefined);
    expect(api.views.show).toHaveBeenCalledTimes(1);
    await act(async () => navigation.resolve());
    expect(visible).toBeNull();
    expect(api.views.show).toHaveBeenLastCalledWith("other", expect.any(Object), true);
    await act(async () => requests[1].resolve());
    expect(visible).toBe("other");
  });

  it("retries a failed work navigation on restoration without requesting the homepage", async () => {
    const navigation = deferred();
    vi.mocked(api.views.navigate).mockReturnValueOnce(navigation.promise);
    const onError = vi.fn();
    render(<ViewHost accountId="owner" initialUrl="https://www.douyin.com/video/123" onError={onError} />);
    await act(async () => undefined);
    await act(async () => requests[0].resolve());
    await act(async () => navigation.reject(new Error("network unavailable")));
    expect(onError).toHaveBeenLastCalledWith("network unavailable");
    act(() => useUi.setState({ overlayCount: 1 }));
    act(() => useUi.setState({ overlayCount: 0 }));
    await act(async () => undefined);
    await act(async () => requests[1].resolve());
    expect(api.views.navigate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.views.show).mock.calls.every((args) => args[2] === false)).toBe(true);
    expect(onError).toHaveBeenLastCalledWith("");
  });
});
