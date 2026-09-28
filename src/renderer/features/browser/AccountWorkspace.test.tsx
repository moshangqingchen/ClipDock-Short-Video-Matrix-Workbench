// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@renderer/lib/api";
import type * as ApiModule from "@renderer/lib/api";
import { useAccounts, useToasts, useUi, useViews } from "@renderer/store";
import { platformEntryUrl, type PlatformId } from "@shared/platforms";
import type { Account, ViewState } from "@shared/types";
import { AccountWorkspace } from "./AccountWorkspace";

vi.mock("@renderer/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  hasBridge: true,
}));

type MessageResult = Awaited<ReturnType<typeof api.views.openMessages>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("account workspace entry and management navigation", () => {
  let accounts: Account[];
  beforeEach(async () => {
    accounts = await api.accounts.list();
    useAccounts.setState({ accounts });
    useViews.setState({ states: {} });
    useToasts.setState({ items: [] });
    useUi.setState({ activeAccountId: null, accountEntryRevision: 0, accountEntryUrl: null, drawerOpen: false, overlayCount: 0 });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(api.views, "show").mockImplementation(async (id) => ({ accountId: id }) as never);
    vi.spyOn(api.views, "hide").mockResolvedValue(undefined);
    vi.spyOn(api.views, "setBounds").mockResolvedValue(undefined);
    vi.spyOn(api.views, "go").mockResolvedValue(undefined);
    vi.spyOn(api.views, "navigate").mockResolvedValue(undefined);
    vi.spyOn(api.views, "openMessages").mockResolvedValue({ opened: true, guidance: "请在官方对话框回复。" });
  });
  afterEach(async () => {
    cleanup();
    await act(async () => undefined);
    vi.restoreAllMocks();
  });

  function open(platformId: PlatformId) {
    const account = accounts.find((item) => item.platformId === platformId) ?? {
      ...accounts[0], id: `test-${platformId}`, platformId,
      displayName: `${platformId} 测试账号`, partition: `persist:test-${platformId}`,
    };
    if (!accounts.some((item) => item.id === account.id)) {
      accounts = [...accounts, account];
      useAccounts.setState({ accounts });
    }
    useUi.getState().openAccount(account.id);
    render(<AccountWorkspace />);
    return account;
  }

  function viewState(account: Account, messageMode = false): ViewState {
    return {
      accountId: account.id, attached: true, visible: true, messageMode,
      url: platformEntryUrl(account.platformId), title: "官方页面", loading: false,
      canGoBack: false, canGoForward: false, isLoginPage: false, isVerificationPage: false,
    };
  }

  it("opens the homepage on entry and reaches management only through its button", async () => {
    const account = open("xiaohongshu");
    await waitFor(() => expect(api.views.show).toHaveBeenCalledWith(account.id, expect.any(Object), true));
    expect(screen.getByRole("textbox", { name: "页面地址" })).toHaveAttribute(
      "placeholder", platformEntryUrl("xiaohongshu"),
    );
    expect(api.views.go).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    expect(api.views.go).toHaveBeenLastCalledWith(account.id, "home");
    fireEvent.click(screen.getByRole("button", { name: "主页" }));
    expect(api.views.go).toHaveBeenLastCalledWith(account.id, "site");
  });

  it("keeps management as the entry for platforms without a public homepage", async () => {
    const account = open("weixin_channels");
    await waitFor(() => expect(api.views.show).toHaveBeenCalledWith(account.id, expect.any(Object), true));
    expect(screen.queryByRole("button", { name: "主页" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "页面地址" })).toHaveAttribute(
      "placeholder", platformEntryUrl("weixin_channels"),
    );
  });

  it("keeps the native host mounted when selecting the same account or updating scan metadata", async () => {
    const account = open("xiaohongshu");
    await waitFor(() => expect(api.views.show).toHaveBeenCalledTimes(1));
    act(() => useAccounts.getState().upsert({ ...account, displayName: "更新后的账号资料" }));
    await act(async () => undefined);
    expect(api.views.show).toHaveBeenCalledTimes(1);
    act(() => useUi.getState().openAccount(account.id));
    await act(async () => undefined);
    expect(api.views.show).toHaveBeenCalledTimes(1);
    expect(api.views.hide).not.toHaveBeenCalled();
    expect(api.views.navigate).not.toHaveBeenCalled();
  });

  it("opens a selected work without the default homepage replacing it", async () => {
    const account = accounts.find((item) => item.platformId === "douyin")!;
    useUi.getState().openWork(account.id, "https://www.douyin.com/video/123");
    render(<AccountWorkspace />);
    await waitFor(() => expect(api.views.show).toHaveBeenCalledWith(account.id, expect.any(Object), false));
    expect(api.views.navigate).toHaveBeenCalledExactlyOnceWith(account.id, "https://www.douyin.com/video/123");
    act(() => useUi.getState().openAccount(account.id));
    await waitFor(() => expect(api.views.show).toHaveBeenCalledTimes(2));
    expect(api.views.show).toHaveBeenLastCalledWith(account.id, expect.any(Object), false);
    expect(api.views.navigate).toHaveBeenCalledTimes(1);
    act(() => useUi.getState().openWork(account.id, "https://www.douyin.com/video/456"));
    await waitFor(() => expect(api.views.navigate).toHaveBeenCalledTimes(2));
    expect(api.views.navigate).toHaveBeenLastCalledWith(account.id, "https://www.douyin.com/video/456");
  });

  it.each<PlatformId>(["douyin", "kuaishou", "xiaohongshu", "bilibili", "baijiahao", "weixin_channels"])(
    "opens %s messages only through the selected account's official-page bridge",
    async (platformId) => {
      const account = open(platformId);
      await waitFor(() => expect(api.views.show).toHaveBeenCalledTimes(1));
      act(() => useViews.getState().set(viewState(account)));
      fireEvent.click(screen.getByRole("button", { name: "消息" }));
      expect(api.views.openMessages).toHaveBeenCalledExactlyOnceWith(account.id);
      await act(async () => undefined);
      act(() => useViews.getState().set(viewState(account, true)));
      expect(screen.getByRole("region", { name: "消息与对话" })).toHaveTextContent(account.displayName);
      expect(screen.getByText("请在官方对话框回复。")).toBeInTheDocument();
      expect(api.views.go).not.toHaveBeenCalled();
      expect(api.views.navigate).not.toHaveBeenCalled();
      // The native page owns the conversation and composer; the renderer only exposes navigation.
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      expect(screen.getByRole("textbox", { name: "页面地址" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
    },
  );

  it("coalesces repeated message clicks while the official page is opening", async () => {
    const pending = deferred<MessageResult>();
    vi.mocked(api.views.openMessages).mockReturnValue(pending.promise);
    const account = open("douyin");
    fireEvent.click(screen.getByRole("button", { name: "消息" }));
    fireEvent.click(screen.getByRole("button", { name: "正在打开消息" }));
    fireEvent.click(screen.getByRole("button", { name: "正在打开消息" }));
    expect(api.views.openMessages).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(screen.getByRole("region", { name: "消息与对话" })).toHaveTextContent("正在打开当前账号的官方消息入口");
    await act(async () => pending.resolve({ opened: false, guidance: "请在官方主页手动打开消息。" }));
    expect(screen.getByRole("button", { name: "消息" })).toBeInTheDocument();
    act(() => useViews.getState().set(viewState(account, true)));
    expect(screen.getByText("请在官方主页手动打开消息。")).toBeInTheDocument();
  });

  it.each(["success", "failure"] as const)(
    "ignores an old account's late %s without changing the new account's pending message state",
    async (outcome) => {
      const first = deferred<MessageResult>(), second = deferred<MessageResult>();
      vi.mocked(api.views.openMessages).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const oldAccount = open("douyin");
      fireEvent.click(screen.getByRole("button", { name: "消息" }));
      const newAccount = { ...accounts.find((item) => item.platformId === "bilibili")!, displayName: "当前 B 站账号" };
      act(() => {
        useAccounts.getState().upsert(newAccount);
        useUi.getState().openAccount(newAccount.id);
        useViews.getState().set(viewState(newAccount, true));
      });
      fireEvent.click(screen.getByRole("button", { name: "消息" }));
      await act(async () => {
        if (outcome === "success") first.resolve({ opened: true, guidance: "旧抖音账号的提示，不应出现" });
        else first.reject(new Error("旧抖音账号打开失败，不应提示"));
      });
      expect(api.views.openMessages).toHaveBeenNthCalledWith(1, oldAccount.id);
      expect(api.views.openMessages).toHaveBeenNthCalledWith(2, newAccount.id);
      expect(screen.getByRole("button", { name: "正在打开消息" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "消息与对话" })).toHaveTextContent("当前 B 站账号");
      expect(screen.queryByText("旧抖音账号的提示，不应出现")).not.toBeInTheDocument();
      expect(useToasts.getState().items).toHaveLength(0);
      await act(async () => second.resolve({ opened: true, guidance: "当前 B 站会话已就绪" }));
      expect(screen.getByText("当前 B 站会话已就绪")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "消息" })).toBeInTheDocument();
    },
  );

  it.each(["主页", "离开消息"])("leaves messages through %s and ignores an earlier pending result", async (label) => {
    const pending = deferred<MessageResult>();
    vi.mocked(api.views.openMessages).mockReturnValue(pending.promise);
    const account = open("douyin");
    fireEvent.click(screen.getByRole("button", { name: "消息" }));
    act(() => useViews.getState().set(viewState(account, true)));
    vi.mocked(api.views.go).mockImplementation(async () => { useViews.getState().set(viewState(account)); });
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(api.views.go).toHaveBeenCalledExactlyOnceWith(account.id, "site");
    expect(screen.queryByRole("region", { name: "消息与对话" })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ opened: true, guidance: "迟到的消息入口提示" }));
    expect(screen.queryByRole("region", { name: "消息与对话" })).not.toBeInTheDocument();
    expect(screen.queryByText("迟到的消息入口提示")).not.toBeInTheDocument();
    expect(useToasts.getState().items).toHaveLength(0);
  });

  it("closes the data drawer before opening the official conversation page", async () => {
    useUi.setState({ drawerOpen: true });
    const account = open("bilibili");
    expect(screen.getByRole("heading", { name: "账号数据" })).toBeInTheDocument();
    vi.mocked(api.views.openMessages).mockImplementation(async (id) => {
      expect(id).toBe(account.id);
      expect(useUi.getState().drawerOpen).toBe(false);
      return { opened: true, guidance: "官方会话已打开" };
    });
    fireEvent.click(screen.getByRole("button", { name: "消息" }));
    await act(async () => undefined);
    expect(screen.queryByRole("heading", { name: "账号数据" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开数据面板" })).toBeInTheDocument();
    expect(api.views.openMessages).toHaveBeenCalledExactlyOnceWith(account.id);
  });

  it("reports a current-account opening failure and allows a retry", async () => {
    const push = vi.spyOn(useToasts.getState(), "push").mockImplementation(() => undefined);
    vi.mocked(api.views.openMessages)
      .mockRejectedValueOnce(new Error("请在官方页面完成登录后重试"))
      .mockResolvedValueOnce({ opened: true, guidance: "重试已打开官方会话" });
    const account = open("bilibili");
    fireEvent.click(screen.getByRole("button", { name: "消息" }));
    await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith({
      kind: "error", title: "消息页面未打开", message: "请在官方页面完成登录后重试",
    }));
    expect(screen.getByRole("button", { name: "消息" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "消息" }));
    await act(async () => undefined);
    expect(api.views.openMessages).toHaveBeenCalledTimes(2);
    expect(api.views.openMessages).toHaveBeenLastCalledWith(account.id);
    act(() => useViews.getState().set(viewState(account, true)));
    expect(screen.getByText("重试已打开官方会话")).toBeInTheDocument();
  });
});
