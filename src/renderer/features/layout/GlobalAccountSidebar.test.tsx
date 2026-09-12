// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import type { GlobalAccount } from "@shared/global-accounts";
import type { GlobalWebState } from "@shared/global-web";
import { useGlobalAccounts, subscribeGlobalAccounts } from "@renderer/store/global-accounts";
import { GlobalAccountSidebar } from "./GlobalAccountSidebar";

const mock = vi.hoisted(() => ({
  list: vi.fn(),
  state: vi.fn(),
  onChanged: vi.fn(),
}));
vi.mock("@renderer/lib/api", () => ({
  api: { globalAccounts: { list: mock.list }, globalWeb: { state: mock.state, onChanged: mock.onChanged } },
}));

const accounts: GlobalAccount[] = [
  {
    id: "8e65b156-a2ee-48ac-957e-2f990141c207",
    platformId: "youtube",
    displayName: "海外频道",
    remoteId: null,
    authStatus: "unauthorized",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  },
  {
    id: "77777777-7777-4777-8777-777777777777",
    platformId: "tiktok",
    displayName: "TikTok 账号",
    remoteId: null,
    authStatus: "unauthorized",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("GlobalAccountSidebar", () => {
  let off: () => void;
  beforeEach(() => {
    vi.resetAllMocks();
    useGlobalAccounts.setState({ accounts: [], states: {}, identities: {}, loaded: false, error: null });
    mock.list.mockResolvedValue(accounts);
    mock.state.mockImplementation(async (accountId: string) => ({
      accountId,
      phase: "closed",
      errorCode: null,
    }));
    mock.onChanged.mockReturnValue(() => undefined);
    off = subscribeGlobalAccounts();
  });
  afterEach(() => {
    cleanup();
    off();
  });

  it("groups global accounts and emits the selected account id", async () => {
    const selected = vi.fn();
    window.addEventListener("clipdock:select-global-account", selected);
    render(<GlobalAccountSidebar />);
    const sidebar = await screen.findByRole("complementary", { name: "国外账号列表" });
    expect(within(sidebar).getByText("YouTube")).toBeInTheDocument();
    expect(within(sidebar).getByText("TikTok")).toBeInTheDocument();
    expect(within(sidebar).getByText("X")).toBeInTheDocument();
    fireEvent.click(await within(sidebar).findByText("海外频道"));
    await waitFor(() => expect(selected).toHaveBeenCalled());
    expect(selected.mock.calls[0][0]).toMatchObject({ detail: accounts[0].id });
    window.removeEventListener("clipdock:select-global-account", selected);
  });

  it("does not let a delayed window read replace a newer dormant event", async () => {
    const pending = deferred<GlobalWebState>();
    mock.list.mockResolvedValue([accounts[0]]);
    mock.state.mockReturnValue(pending.promise);
    render(<GlobalAccountSidebar />);
    await waitFor(() => expect(mock.state).toHaveBeenCalledWith(accounts[0].id));
    const changed = mock.onChanged.mock.calls[0][0] as (state: GlobalWebState) => void;
    act(() =>
      changed({ accountId: accounts[0].id, phase: "dormant", errorCode: "GLOBAL_WEB_PROXY_UNVERIFIED" }),
    );
    expect(screen.getByText("休眠")).toBeInTheDocument();
    await act(async () => pending.resolve({ accountId: accounts[0].id, phase: "open", errorCode: null }));
    expect(screen.getByText("休眠")).toBeInTheDocument();
    expect(screen.queryByText("已打开")).not.toBeInTheDocument();
  });

  it("keeps a removed account absent when an older refresh and later window event arrive", async () => {
    const pending = deferred<GlobalAccount[]>();
    mock.list.mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    render(<GlobalAccountSidebar />);
    await waitFor(() => expect(mock.list).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "刷新国外账号" }));
    await screen.findByText("还没有国外账号，点击下方按钮添加。");
    await act(async () => pending.resolve(accounts));
    const changed = mock.onChanged.mock.calls[0][0] as (state: GlobalWebState) => void;
    act(() => changed({ accountId: accounts[0].id, phase: "open", errorCode: null }));
    expect(screen.queryByText("海外频道")).not.toBeInTheDocument();
    expect(screen.getByText("窗口")).toHaveTextContent("0窗口");
    expect(mock.state).not.toHaveBeenCalled();
  });
});
