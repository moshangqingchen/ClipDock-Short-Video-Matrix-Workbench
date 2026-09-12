// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAccounts, useUi, useViews, useToasts } from "@renderer/store";
import { useNetwork } from "@renderer/store/network";
import { checkingNetworkSnapshot, type AccountEgressLocation } from "@shared/network";
import type { Account, ViewState } from "@shared/types";
import { AccountSidebar } from "./AccountSidebar";
const mocks = vi.hoisted(() => ({ list: vi.fn(), check: vi.fn() }));
vi.mock("@renderer/lib/api", () => ({ api: { accounts: { list: mocks.list, checkStatus: mocks.check } } }));
vi.mock("@renderer/features/accounts/useAccountFollowers", () => ({ useAccountFollowers: () => ({}) }));
vi.mock("@renderer/features/accounts/AccountMenu", () => ({ AccountMenu: () => <div>账号操作菜单</div> }));
const account = {
  id: "one",
  platformId: "kuaishou",
  displayName: "测试创作者",
  externalId: "handle-123",
  status: "online",
  sortOrder: 0,
  createdAt: "2026-09-12",
  updatedAt: "2026-09-12",
} as Account;
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  useAccounts.setState({ accounts: [account], loaded: true });
  useUi.setState({ route: "creator", activeAccountId: null, addAccountOpen: false });
  useViews.setState({ states: {} });
  useNetwork.setState({ snapshot: checkingNetworkSnapshot() });
  useToasts.setState({ items: [] });
  mocks.list.mockResolvedValue([account]);
  mocks.check.mockResolvedValue(account);
});
afterEach(cleanup);
it("persists platform collapse; platform and handle search temporarily expand without changing the preference", () => {
  const first = render(<AccountSidebar />);
  const platform = screen.getByRole("button", { name: /快手\s*1/ });
  fireEvent.click(platform);
  expect(screen.queryByText(account.displayName)).not.toBeInTheDocument();
  const search = screen.getByPlaceholderText("搜索账号 / 平台");
  fireEvent.change(search, { target: { value: "快手" } });
  expect(screen.getByText(account.displayName)).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "handle-123" } });
  expect(screen.getByText(account.displayName)).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.queryByText(account.displayName)).not.toBeInTheDocument();
  first.unmount();
  render(<AccountSidebar />);
  expect(screen.queryByText(account.displayName)).not.toBeInTheDocument();
});
it("separates add/open/menu buttons and supports keyboard activation without nested click handlers", async () => {
  render(<AccountSidebar />);
  const user = userEvent.setup();
  const platform = screen.getByRole("button", { name: /快手\s*1/ });
  const add = screen.getByRole("button", { name: "添加快手账号" });
  add.focus();
  await user.keyboard("{Enter}");
  expect(platform).toHaveAttribute("aria-expanded", "true");
  expect(useUi.getState().addAccountOpen).toBe(true);
  const menu = screen.getByRole("button", { name: "更多操作" });
  menu.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByText("账号操作菜单")).toBeInTheDocument();
  expect(useUi.getState().activeAccountId).toBeNull();
  expect(document.querySelector("button button")).toBeNull();
});
it("refresh checks each account once and preserves its login status when the new check is inconclusive", async () => {
  let resolve!: (account: Account) => void;
  mocks.check.mockReturnValue(
    new Promise<Account>((done) => {
      resolve = done;
    }),
  );
  render(<AccountSidebar />);
  const refresh = screen.getByRole("button", { name: "刷新" });
  fireEvent.click(refresh);
  fireEvent.click(refresh);
  await waitFor(() => expect(mocks.check).toHaveBeenCalledOnce());
  expect(refresh).toBeDisabled();
  await act(async () =>
    resolve({
      ...account,
      checkInfo: { state: "unconfirmed", reason: "页面待核实", attemptedAt: new Date().toISOString() },
    }),
  );
  expect(screen.queryByText("待核实")).not.toBeInTheDocument();
  const status = screen.getByTitle(/页面待核实/);
  expect(status).toHaveTextContent("在线");
  expect(status).toHaveAttribute("title", expect.stringContaining("上次确认：在线 · 尚未确认"));
  expect(refresh).not.toBeDisabled();
});
it("keeps newer pushes while merging an older list and removes loaded labels after recycling", async () => {
  let resolve!: (accounts: Account[]) => void;
  mocks.list.mockReturnValue(
    new Promise<Account[]>((done) => {
      resolve = done;
    }),
  );
  const load = useAccounts.getState().load();
  useAccounts.getState().upsert({ ...account, displayName: "较新的状态" });
  resolve([account, { ...account, id: "two" }]);
  await load;
  expect(useAccounts.getState().byId("one")?.displayName).toBe("较新的状态");
  expect(useAccounts.getState().byId("two")).toBeDefined();
  useViews.getState().set({ accountId: "one", lifecycle: "ready", revision: 1 } as ViewState);
  render(<AccountSidebar />);
  expect(screen.getAllByLabelText("网页已加载")).toHaveLength(1);
  act(() => useViews.getState().set({ accountId: "one", lifecycle: "destroyed", revision: 3 } as ViewState));
  act(() => useViews.getState().set({ accountId: "one", lifecycle: "ready", revision: 2 } as ViewState));
  expect(screen.queryByLabelText("网页已加载")).not.toBeInTheDocument();
});
it("reports list failures and enables retry", async () => {
  mocks.list.mockRejectedValue(new Error("synthetic network failure"));
  render(<AccountSidebar />);
  const refresh = screen.getByRole("button", { name: "刷新" });
  fireEvent.click(refresh);
  await waitFor(() => expect(useToasts.getState().items.some((t) => t.kind === "error")).toBe(true));
  expect(refresh).not.toBeDisabled();
});

it("binds the location badge to its account and keeps badge clicks and keyboard opening on the account", async () => {
  const location: AccountEgressLocation = {
    state: "ready", route: "direct", ip: "203.0.113.8",
    country: "中国", region: "广东省", city: "深圳市", checkedAt: "2026-09-12T03:00:00.000Z",
  };
  const networkAccount = {
    state: "allowed" as const, reason: "READY" as const, generation: 1,
    checkedAt: location.checkedAt, proofExpiresAt: "2026-09-12T03:00:15.000Z",
  };
  useAccounts.setState({ accounts: [{ ...account, status: "offline" }] });
  useNetwork.setState({ snapshot: {
    ...checkingNetworkSnapshot(),
    accounts: [
      { ...networkAccount, accountId: "another-account", egressLocation: { ...location, city: "上海市" } },
      { ...networkAccount, accountId: account.id, egressLocation: location },
    ],
  } });
  render(<AccountSidebar />);
  const badge = screen.getByLabelText("直连出口位置：深圳市");
  const open = badge.closest("button")!;
  expect(open).toHaveTextContent(account.displayName);
  expect(open).toHaveTextContent("未登录");
  expect(screen.queryByText("上海市")).not.toBeInTheDocument();
  fireEvent.click(badge);
  expect(useUi.getState().activeAccountId).toBe(account.id);
  act(() => useUi.setState({ activeAccountId: null }));
  open.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(useUi.getState().activeAccountId).toBe(account.id);
  expect(document.querySelector("button button")).toBeNull();
  expect(screen.getByRole("button", { name: "更多操作" })).toBeInTheDocument();
});

it("updates only the measured badge when the network snapshot changes or the sample disappears", () => {
  render(<AccountSidebar />);
  expect(screen.getByLabelText("直连出口位置：位置未知")).toBeInTheDocument();
  const networkAccount = {
    accountId: account.id, state: "allowed" as const, reason: "READY" as const, generation: 1,
    checkedAt: null, proofExpiresAt: null,
    egressLocation: {
      state: "checking" as const, route: "direct" as const,
      ip: null, country: null, region: null, city: null, checkedAt: null,
    },
  };
  act(() => useNetwork.setState({ snapshot: { ...checkingNetworkSnapshot(), accounts: [networkAccount] } }));
  expect(screen.getByLabelText("直连出口位置：检测中")).toBeInTheDocument();
  expect(screen.getByTitle(/上次确认：在线/)).toHaveTextContent("在线");
  act(() => useNetwork.setState({ snapshot: checkingNetworkSnapshot() }));
  expect(screen.getByLabelText("直连出口位置：位置未知")).toBeInTheDocument();
  expect(useAccounts.getState().byId(account.id)?.status).toBe("online");
});
