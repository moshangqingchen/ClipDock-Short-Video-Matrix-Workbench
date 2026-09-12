// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalAccount } from "@shared/global-accounts";
import type { GlobalWebState } from "@shared/global-web";
import { checkingNetworkSnapshot } from "@shared/network";
import { useToasts, useUi } from "@renderer/store";
import { useNetwork } from "@renderer/store/network";
import { GlobalWebsiteWorkspace } from "./GlobalWebsiteWorkspace";

const mock = vi.hoisted(() => ({
  observation: vi.fn(),
  observationHistory: vi.fn(),
  readPage: vi.fn(),
  state: vi.fn(),
  open: vi.fn(),
  openChrome: vi.fn(),
  close: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  go: vi.fn(),
  command: vi.fn(),
  changed: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  jobsChanged: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("@renderer/lib/api", () => ({
  hasBridge: true,
  api: {
    globalWeb: {
      observation: mock.observation,
      observationHistory: mock.observationHistory,
      readPage: mock.readPage,
      state: mock.state,
      open: mock.open,
      openChrome: mock.openChrome,
      close: mock.close,
      show: mock.show,
      hide: mock.hide,
      go: mock.go,
      command: mock.command,
      onChanged: mock.changed,
    },
    globalRead: { get: mock.get },
    globalJobs: { list: mock.list, onChanged: mock.jobsChanged, submit: mock.submit },
  },
}));
const account: GlobalAccount = {
  id: "8e65b156-a2ee-48ac-957e-2f990141c207",
  platformId: "youtube",
  displayName: "频道甲",
  remoteId: null,
  authStatus: "unauthorized",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const state = (phase: GlobalWebState["phase"], id = account.id): GlobalWebState => ({
  accountId: id,
  phase,
  errorCode: null,
  embedded: true,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let emit: (value: GlobalWebState) => void;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  useUi.setState({ overlayCount: 0, creatorMode: "global" });
  useToasts.setState({ items: [] });
  useNetwork.setState({
    snapshot: {
      ...checkingNetworkSnapshot(),
      policy: "exclusive",
      state: "overseas",
      switching: {
        proxy: "on",
        state: "overseas",
        reason: "PROXY_ENABLED",
        generation: 1,
        checkedAt: new Date().toISOString(),
        expiresAt: null,
      },
    },
  });
  mock.state.mockImplementation(async (id) => state("closed", id));
  mock.open.mockImplementation(async (id) => state("open", id));
  mock.openChrome.mockImplementation(async (id) => ({ ...state("open", id), engine: "chrome" }));
  mock.close.mockImplementation(async (id) => state("closed", id));
  mock.show.mockResolvedValue(undefined);
  mock.hide.mockResolvedValue(undefined);
  mock.go.mockResolvedValue(undefined);
  mock.command.mockResolvedValue(undefined);
  mock.changed.mockImplementation((listener) => {
    emit = listener;
    return () => undefined;
  });
  mock.get.mockResolvedValue(null);
  mock.observation.mockResolvedValue(null);
  mock.observationHistory.mockResolvedValue([]);
  mock.list.mockResolvedValue([]);
  mock.jobsChanged.mockReturnValue(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 250,
    y: 80,
    left: 250,
    top: 80,
    right: 1250,
    bottom: 780,
    width: 1000,
    height: 700,
    toJSON: () => ({}),
  });
});
afterEach(async () => {
  cleanup();
  await act(async () => undefined);
  vi.restoreAllMocks();
  useUi.setState({ overlayCount: 0, creatorMode: "global" });
});

describe("global website toolbar and isolated viewport", () => {
  it("keeps global page controls available in rule mode and hides the page when the proxy turns off", async () => {
    const snapshot = useNetwork.getState().snapshot;
    useNetwork.setState({ snapshot: {
      ...snapshot, policy: "rule-split", state: "dual",
      switching: { ...snapshot.switching!, state: "dual", proxy: "on" },
    } });
    mock.state.mockResolvedValue(state("open"));
    render(<GlobalWebsiteWorkspace account={account} />);
    await waitFor(() => expect(mock.show).toHaveBeenCalledWith(account.id, expect.any(Object)));
    const upload = screen.getByRole("button", { name: "上传" });
    expect(upload).toBeEnabled();
    fireEvent.click(upload);
    await waitFor(() => expect(mock.go).toHaveBeenCalledWith(account.id, "upload"));
    act(() => useNetwork.setState({ snapshot: {
      ...snapshot, policy: "rule-split", state: "domestic",
      switching: { ...snapshot.switching!, state: "domestic", proxy: "off" },
    } }));
    expect(upload).toBeDisabled();
    expect(mock.hide).toHaveBeenCalledWith(account.id);
  });
  it("navigates official upload in the current account and sends publishing to the shared composer", async () => {
    render(<GlobalWebsiteWorkspace account={account} />);
    await screen.findByText("未打开");
    fireEvent.click(screen.getByRole("button", { name: "上传" }));
    await waitFor(() => expect(mock.go).toHaveBeenCalledWith(account.id, "upload"));
    expect(mock.open).toHaveBeenCalledExactlyOnceWith(account.id);
    fireEvent.click(screen.getByRole("button", { name: "发布" }));
    expect(useUi.getState()).toMatchObject({
      route: "publish",
      creatorMode: "global",
      activeGlobalAccountId: account.id,
    });
    expect(mock.submit).not.toHaveBeenCalled();
  });
  it("preserves a newer lifecycle event against a delayed initial read", async () => {
    const read = deferred<GlobalWebState>();
    mock.state.mockReturnValueOnce(read.promise);
    render(<GlobalWebsiteWorkspace account={account} />);
    act(() => emit(state("open")));
    await waitFor(() => expect(mock.show).toHaveBeenCalledWith(account.id, expect.any(Object)));
    await act(async () => read.resolve(state("closed")));
    expect(screen.getByText("官网已打开")).toBeTruthy();
  });
  it("does not navigate an old account after selection changes during open", async () => {
    const read = deferred<GlobalWebState>();
    mock.open.mockReturnValueOnce(read.promise);
    const host = render(<GlobalWebsiteWorkspace account={account} />);
    await screen.findByText("未打开");
    fireEvent.click(screen.getByRole("button", { name: "上传" }));
    host.rerender(
      <GlobalWebsiteWorkspace
        account={{ ...account, id: "8e65b156-a2ee-48ac-957e-2f990141c208", displayName: "频道乙" }}
      />,
    );
    await act(async () => read.resolve(state("open")));
    expect(mock.go).not.toHaveBeenCalled();
    expect(screen.getByText("频道乙")).toBeTruthy();
  });
  it("opens the standalone metrics module without navigating or reading the visible page", async () => {
    mock.state.mockResolvedValue(state("open"));
    const host = render(<GlobalWebsiteWorkspace account={account} />);
    await screen.findByText("官网已打开");
    fireEvent.click(screen.getByRole("button", { name: "数据观测" }));
    expect(useUi.getState()).toMatchObject({ route: "metrics", activeGlobalAccountId: account.id });
    expect(mock.go).not.toHaveBeenCalled();
    expect(mock.readPage).not.toHaveBeenCalled();
    host.unmount();
    await waitFor(() => expect(mock.hide).toHaveBeenCalledWith(account.id));
  });
  it("hides the native page for menus and restores it after Escape", async () => {
    mock.state.mockResolvedValue(state("open"));
    render(<GlobalWebsiteWorkspace account={account} />);
    await waitFor(() => expect(mock.show).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "浏览器选项" }));
    expect(useUi.getState().overlayCount).toBe(1);
    expect(mock.hide).toHaveBeenCalledWith(account.id);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUi.getState().overlayCount).toBe(0);
    await waitFor(() => expect(mock.show.mock.calls.length).toBeGreaterThan(1));
  });
  it("shows the current address and honors back/forward availability", async () => {
    mock.state.mockResolvedValue({
      ...state("open"),
      displayUrl: "https://studio.youtube.com/channel/test",
      canGoBack: false,
      canGoForward: true,
    });
    render(<GlobalWebsiteWorkspace account={account} />);
    await screen.findByText("https://studio.youtube.com/channel/test");
    expect(screen.getByRole("button", { name: "后退" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "前进" }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledWith(account.id, "forward"));
  });
  it("exposes API configuration as an optional menu action", async () => {
    const configure = vi.fn();
    render(<GlobalWebsiteWorkspace account={account} onConfigureApi={configure} />);
    fireEvent.click(screen.getByRole("button", { name: "浏览器选项" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "官方 API（可选）" }));
    expect(configure).toHaveBeenCalledOnce();
    expect(mock.get).not.toHaveBeenCalled();
  });
});
