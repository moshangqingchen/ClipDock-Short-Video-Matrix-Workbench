// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { checkingNetworkSnapshot } from "@shared/network";
import type { GlobalAccount } from "@shared/global-accounts";
import { useNetwork } from "@renderer/store/network";
import { useUi, useGlobalAccounts, useToasts } from "@renderer/store";
import { GlobalAccountModalHost } from "./GlobalAccountModalHost";
import { GlobalAccountsPage } from "./GlobalAccountsPage";
vi.mock("./GlobalAppsPanel", () => ({ GlobalAppsPanel: () => null }));
vi.mock("./GlobalWebsiteWorkspace", async () => {
  const { GlobalWebControls } = await import("./GlobalWebControls");
  return {
    GlobalWebsiteWorkspace: ({
      account,
      onConfigureApi,
    }: {
      account: GlobalAccount;
      onConfigureApi(): void;
    }) => (
      <section aria-label={`${account.displayName} 官网工作区`}>
        <button onClick={onConfigureApi}>官方 API（可选）</button>
        <h2>{account.displayName}</h2>
        <GlobalWebControls account={account} />
      </section>
    ),
  };
});

const mock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  disconnect: vi.fn(),
  viewShow: vi.fn(),
  domesticCreate: vi.fn(),
  oauthState: vi.fn(),
  oauthStart: vi.fn(),
  oauthCancel: vi.fn(),
  oauthOnState: vi.fn(),
  readGet: vi.fn(),
  readRefresh: vi.fn(),
  readCancel: vi.fn(),
  jobList: vi.fn(),
  jobOnChanged: vi.fn(),
  uploadList: vi.fn(),
  uploadOnChanged: vi.fn(),
  uploadSubmit: vi.fn(),
  assetsList: vi.fn(),
  webState: vi.fn(),
  webOpen: vi.fn(),
  webClose: vi.fn(),
  webChanged: vi.fn(),
}));
vi.mock("@renderer/lib/api", () => ({
  hasBridge: true,
  api: {
    globalWeb: { state: mock.webState, open: mock.webOpen, close: mock.webClose, onChanged: mock.webChanged },
    globalAccounts: {
      list: mock.list,
      create: mock.create,
      delete: mock.delete,
      disconnect: mock.disconnect,
    },
    accounts: { create: mock.domesticCreate },
    views: { show: mock.viewShow },
    globalOAuth: {
      state: mock.oauthState,
      start: mock.oauthStart,
      cancel: mock.oauthCancel,
      onState: mock.oauthOnState,
    },
    globalRead: { get: mock.readGet },
    globalUploads: { list: mock.uploadList, onChanged: mock.uploadOnChanged, submit: mock.uploadSubmit },
    assets: { list: mock.assetsList },
    globalJobs: {
      submit: mock.readRefresh,
      cancel: mock.readCancel,
      list: mock.jobList,
      onChanged: mock.jobOnChanged,
    },
  },
}));
const account: GlobalAccount = {
  id: "8e65b156-a2ee-48ac-957e-2f990141c207",
  platformId: "youtube",
  displayName: "海外频道",
  remoteId: null,
  authStatus: "unauthorized",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

function renderApi() {
  const result = render(
    <>
      <GlobalAccountsPage />
      <GlobalAccountModalHost />
    </>,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "官方 API（可选）", hidden: true })[0]);
  return result;
}
describe("international accounts remain separate and truthful", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.list.mockResolvedValue([]);
    mock.create.mockResolvedValue(account);
    mock.delete.mockResolvedValue(undefined);
    mock.disconnect.mockResolvedValue(account);
    mock.oauthState.mockImplementation(async (id: string) => ({
      accountId: id,
      platformId: "youtube",
      transactionId: null,
      phase: "idle",
      errorCode: null,
    }));
    mock.oauthOnState.mockReturnValue(() => undefined);
    mock.readGet.mockResolvedValue(null);
    mock.uploadList.mockResolvedValue([]);
    mock.uploadOnChanged.mockReturnValue(() => undefined);
    mock.assetsList.mockResolvedValue([]);
    mock.webState.mockImplementation(async (id: string) => ({
      accountId: id,
      phase: "closed",
      errorCode: null,
    }));
    mock.webOpen.mockImplementation(async (id: string) => ({
      accountId: id,
      phase: "open",
      errorCode: null,
    }));
    mock.webClose.mockImplementation(async (id: string) => ({
      accountId: id,
      phase: "closed",
      errorCode: null,
    }));
    mock.webChanged.mockReturnValue(() => undefined);
    mock.jobList.mockResolvedValue([]);
    mock.jobOnChanged.mockReturnValue(() => undefined);
    mock.readCancel.mockResolvedValue(undefined);
    useNetwork.setState({ snapshot: checkingNetworkSnapshot() });
    useUi.setState({ overlayCount: 0, activeGlobalAccountId: null });
    useGlobalAccounts.setState({ accounts: [], states: {}, identities: {}, loaded: false });
  });
  afterEach(cleanup);
  it.each(["overseas", "dual"] as const)("opens on user action in %s without claiming website authentication", async (state) => {
    mock.list.mockResolvedValue([account]);
    const snapshot = checkingNetworkSnapshot();
    snapshot.policy = state === "dual" ? "rule-split" : "exclusive";
    snapshot.switching = { ...snapshot.switching!, proxy: "on", state };
    useNetwork.setState({ snapshot });
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    await screen.findByText("官网窗口未打开");
    expect(mock.webOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Chrome/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/验证代理通路|独立的 Chrome 窗口/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开官网" }));
    await screen.findByText("官网窗口已打开");
    expect(mock.webOpen).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(mock.oauthStart).not.toHaveBeenCalled();
    expect(screen.queryByText("已登录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    await screen.findByText("官网窗口未打开");
    expect(mock.webClose).toHaveBeenCalledExactlyOnceWith(account.id);
  });
  it("defaults to independent web accounts without requesting or inferring API authorization", async () => {
    mock.list.mockResolvedValue([{ ...account, authStatus: "authorized", remoteId: "synthetic-api-user" }]);
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    await screen.findByRole("heading", { name: "海外频道" });
    expect(screen.queryByText("已有授权记录")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("国际账号名称")).not.toBeInTheDocument();
    await screen.findByText("官网窗口未打开");
    expect(screen.getByRole("button", { name: "打开官网" })).toBeDisabled();
    expect(screen.getByText("国外平台已休眠；开启代理后可点击“打开官网”。")).toBeVisible();
    expect(mock.oauthState).not.toHaveBeenCalled();
    expect(mock.readGet).not.toHaveBeenCalled();
    expect(mock.uploadList).not.toHaveBeenCalled();
    expect(mock.viewShow).not.toHaveBeenCalled();
    expect(screen.queryByText("已有授权记录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "官方 API（可选）" }));
    await screen.findByText("已有授权记录");
    expect(mock.oauthStart).not.toHaveBeenCalled();
  });
  it("selects the first account for the workspace without opening its website", async () => {
    mock.list.mockResolvedValue([account]);
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    await screen.findByRole("heading", { name: "海外频道" });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "海外频道 官网工作区" })).toBeInTheDocument(),
    );
    expect(mock.webOpen).not.toHaveBeenCalled();
  });
  it("keeps embedded opening errors inside the app without offering an external browser", async () => {
    mock.list.mockResolvedValue([account]);
    const snapshot = checkingNetworkSnapshot();
    snapshot.switching = { ...snapshot.switching!, proxy: "on", state: "overseas" };
    useNetwork.setState({ snapshot });
    mock.webOpen.mockRejectedValue(new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE"));
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "打开官网" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "打开官网" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("软件内网页暂时无法打开，请重试。");
    expect(screen.queryByText(/Chrome|验证代理通路/)).not.toBeInTheDocument();
    expect(mock.oauthStart).not.toHaveBeenCalled();
  });
  it("selects the sidebar account as the only workspace and leaves API cards collapsed", async () => {
    const second = {
      ...account,
      id: "77777777-7777-4777-8777-777777777777",
      platformId: "tiktok" as const,
      displayName: "TikTok 账号",
    };
    mock.list.mockResolvedValue([account, second]);
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    await screen.findByRole("heading", { name: account.displayName });
    expect(screen.queryByRole("heading", { name: second.displayName })).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent("clipdock:select-global-account", { detail: second.id })));
    await screen.findByRole("heading", { name: second.displayName });
    expect(screen.queryByRole("heading", { name: account.displayName })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "国际账号记录" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "官方 API（可选）" }));
    await screen.findByRole("region", { name: "国际账号记录" });
    act(() =>
      window.dispatchEvent(new CustomEvent("clipdock:select-global-account", { detail: account.id })),
    );
    await screen.findByRole("region", { name: `${account.displayName} 官网工作区` });
    expect(screen.queryByRole("region", { name: "国际账号记录" })).not.toBeInTheDocument();
    expect(mock.domesticCreate).not.toHaveBeenCalled();
    expect(mock.webOpen).not.toHaveBeenCalled();
  });
  it("mounts the real data panel for an authorized account without starting a platform read", async () => {
    mock.list.mockResolvedValue([{ ...account, authStatus: "authorized", remoteId: "UC_synthetic" }]);
    mock.readRefresh.mockRejectedValue(new Error("GLOBAL_READ_WAITING_PROXY"));
    renderApi();
    await screen.findByRole("region", { name: "海外频道 的平台数据" });
    await waitFor(() => expect(mock.readGet).toHaveBeenCalledExactlyOnceWith(account.id));
    expect(mock.readRefresh).not.toHaveBeenCalled();
    expect(mock.uploadSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "读取数据" }));
    await screen.findByText("等待有效代理，任务会在验证通过后执行。");
    expect(mock.readRefresh).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(mock.oauthStart).not.toHaveBeenCalled();
    expect(mock.viewShow).not.toHaveBeenCalled();
  });
  it("creates only an unauthorized global account in a card dialog and keeps it when the proxy is off", async () => {
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "添加国外账号" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(useUi.getState().overlayCount).toBe(1);
    for (const name of ["YouTube", "TikTok", "X"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("国际账号名称"), { target: { value: "海外频道" } });
    fireEvent.click(screen.getByRole("button", { name: "创建环境并去登录" }));
    await screen.findByRole("heading", { name: "海外频道" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useUi.getState().overlayCount).toBe(0);
    expect(mock.create).toHaveBeenCalledExactlyOnceWith({ platformId: "youtube", displayName: "海外频道" });
    expect(screen.getByRole("status")).toHaveTextContent("账号已添加；国外平台正在休眠");
    expect(mock.webOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "官方 API（可选）" }));
    await screen.findByText("未授权");
    await waitFor(() => expect(screen.getByRole("button", { name: "官方授权" })).toBeEnabled());
    expect(mock.oauthStart).not.toHaveBeenCalled();
    expect(mock.domesticCreate).not.toHaveBeenCalled();
    expect(mock.viewShow).not.toHaveBeenCalled();
  });
  it.each(["overseas", "dual"] as const)("creates once with its default name and opens the site in %s", async (state) => {
    const created = { ...account, platformId: "tiktok" as const, displayName: "TikTok账号 1" };
    mock.create.mockResolvedValue(created);
    useNetwork.setState({
      snapshot: {
        ...checkingNetworkSnapshot(),
        policy: state === "dual" ? "rule-split" : "exclusive",
        switching: { ...checkingNetworkSnapshot().switching!, state, proxy: "on" },
      },
    });
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    await screen.findByRole("button", { name: "添加国外账号" });
    act(() => window.dispatchEvent(new CustomEvent("clipdock:focus-global-create", { detail: "tiktok" })));
    expect(screen.getByRole("button", { name: "TikTok" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "创建环境并去登录" }));
    await screen.findByRole("heading", { name: created.displayName });
    expect(mock.create).toHaveBeenCalledExactlyOnceWith({ platformId: "tiktok" });
    expect(mock.webOpen).toHaveBeenCalledExactlyOnceWith(created.id);
    expect(useToasts.getState().items.at(-1)?.title).toContain("独立登录环境已创建");
    expect(mock.oauthStart).not.toHaveBeenCalled();
  });
  it("keeps the saved account after an embedded opening failure without inviting duplicate creation", async () => {
    useNetwork.setState({
      snapshot: {
        ...checkingNetworkSnapshot(),
        switching: { ...checkingNetworkSnapshot().switching!, state: "overseas", proxy: "on" },
      },
    });
    mock.webOpen.mockRejectedValue(new Error("private provider details"));
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "添加国外账号" }));
    fireEvent.click(screen.getByRole("button", { name: "创建环境并去登录" }));
    await screen.findByRole("heading", { name: account.displayName });
    expect(screen.getByRole("status")).toHaveTextContent("账号已添加，官网暂时无法打开");
    expect(screen.getByRole("status")).toHaveTextContent("无需重复添加");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/private provider details/)).not.toBeInTheDocument();
    expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it("holds the dialog while creation is pending and prevents duplicate submissions", async () => {
    let resolve!: (value: GlobalAccount) => void;
    mock.create.mockReturnValue(
      new Promise<GlobalAccount>((done) => {
        resolve = done;
      }),
    );
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "添加国外账号" }));
    fireEvent.click(screen.getByRole("button", { name: "TikTok" }));
    fireEvent.click(screen.getByRole("button", { name: "创建环境并去登录" }));
    fireEvent.keyDown(screen.getByLabelText("国际账号名称"), { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => window.dispatchEvent(new CustomEvent("clipdock:focus-global-create")));
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "TikTok" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => resolve(account));
    await screen.findByRole("heading", { name: account.displayName });
  });
  it("allows retry only when account creation itself fails", async () => {
    mock.create.mockRejectedValueOnce(new Error("private persistence details"));
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "添加国外账号" }));
    fireEvent.click(screen.getByRole("button", { name: "创建环境并去登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("账号创建失败，请重试");
    expect(screen.queryByText(/private persistence details/)).not.toBeInTheDocument();
    expect(mock.webOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "创建环境并去登录" }));
    await screen.findByRole("heading", { name: account.displayName });
    expect(mock.create).toHaveBeenCalledTimes(2);
  });
  it.each(["overseas", "dual"] as const)("does not turn %s proxy availability into authorization or a running account", async (state) => {
    mock.list.mockResolvedValue([account]);
    useNetwork.setState({
      snapshot: {
        ...checkingNetworkSnapshot(),
        policy: state === "dual" ? "rule-split" : "exclusive",
        switching: {
          state,
          proxy: "on",
          reason: "PROXY_ENABLED",
          generation: 4,
          checkedAt: null,
          expiresAt: null,
        },
      },
    });
    renderApi();
    await screen.findByText("未授权");
    expect(screen.getByText(/仍需完成代理链路验证和官方授权/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "官方授权" })).toBeEnabled());
    expect(mock.oauthStart).not.toHaveBeenCalled();
    expect(mock.viewShow).not.toHaveBeenCalled();
  });
  it("keeps a row when deletion fails and exposes no provider error text", async () => {
    mock.list.mockResolvedValue([account]);
    mock.delete.mockRejectedValue(new Error("Bearer very-private-value"));
    renderApi();
    fireEvent.click(await screen.findByRole("button", { name: "删除 海外频道" }));
    expect(mock.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "海外频道" })).toBeInTheDocument();
    expect(screen.queryByText(/very-private-value/)).not.toBeInTheDocument();
  });
  it("refreshes persisted account metadata after a currently confirmed authorization event", async () => {
    mock.list.mockResolvedValueOnce([account]).mockResolvedValue([
      {
        ...account,
        authStatus: "authorized",
        remoteId: "synthetic-channel",
        updatedAt: "2026-09-08T00:01:00.000Z",
      },
    ]);
    renderApi();
    await screen.findByRole("heading", { name: "海外频道" });
    await waitFor(() => expect(mock.oauthOnState).toHaveBeenCalledTimes(1));
    const event = {
      accountId: account.id,
      platformId: "youtube",
      transactionId: "7036177a-2411-427a-a9b2-bbe2c51e3e4f",
      phase: "authorized",
      errorCode: null,
    };
    mock.oauthState.mockResolvedValue(event);
    act(() => mock.oauthOnState.mock.calls[0][0](event));
    await screen.findByText("已有授权记录");
    expect(mock.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mock.oauthStart).not.toHaveBeenCalled();
    expect(mock.viewShow).not.toHaveBeenCalled();
  });
  it("deletes the selected global UUID only after confirmation", async () => {
    mock.list.mockResolvedValue([account]);
    renderApi();
    fireEvent.click(await screen.findByRole("button", { name: "删除 海外频道" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "海外频道" })).not.toBeInTheDocument());
    expect(mock.delete).toHaveBeenCalledWith(account.id);
    expect(mock.viewShow).not.toHaveBeenCalled();
  });
  it("clears the website workspace when its selected account is deleted", async () => {
    mock.list.mockResolvedValue([account]);
    render(
      <>
        <GlobalAccountsPage />
        <GlobalAccountModalHost />
      </>,
    );
    await screen.findByRole("heading", { name: "海外频道" });
    act(() =>
      window.dispatchEvent(new CustomEvent("clipdock:select-global-account", { detail: account.id })),
    );
    await screen.findByRole("region", { name: "海外频道 的官网窗口" });
    fireEvent.click(screen.getByRole("button", { name: "官方 API（可选）" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 海外频道" }));
    expect(useUi.getState().overlayCount).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "海外频道 的官网窗口" })).not.toBeInTheDocument(),
    );
    expect(useUi.getState().overlayCount).toBe(0);
    expect(mock.delete).toHaveBeenCalledWith(account.id);
  });
  it("clears only the confirmed local grant and preserves the account record", async () => {
    mock.list.mockResolvedValue([{ ...account, remoteId: "synthetic-channel", authStatus: "authorized" }]);
    renderApi();
    fireEvent.click(await screen.findByRole("button", { name: "清除 海外频道 的本机授权" }));
    expect(mock.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText(/不会在平台端撤销应用授权/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认清除本机授权" }));
    await screen.findByText("未授权");
    expect(mock.disconnect).toHaveBeenCalledWith(account.id);
    expect(screen.getByRole("heading", { name: "海外频道" })).toBeInTheDocument();
    expect(mock.delete).not.toHaveBeenCalled();
    expect(mock.viewShow).not.toHaveBeenCalled();
  });
  it("keeps the grant and shows a fixed error inside the confirmation when disconnect fails", async () => {
    mock.list.mockResolvedValue([
      { ...account, remoteId: "synthetic-channel", authStatus: "reauthorization_required" },
    ]);
    mock.disconnect.mockRejectedValue(new Error("Bearer synthetic-private-token"));
    renderApi();
    fireEvent.click(await screen.findByRole("button", { name: "清除 海外频道 的本机授权" }));
    fireEvent.click(screen.getByRole("button", { name: "确认清除本机授权" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("清除本机授权失败");
    expect(screen.getByRole("dialog")).toContainElement(screen.getByRole("alert"));
    expect(screen.getByText("需要重新授权")).toBeInTheDocument();
    expect(screen.queryByText(/synthetic-private-token/)).not.toBeInTheDocument();
  });
});
