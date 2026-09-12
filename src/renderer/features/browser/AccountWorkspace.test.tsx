// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@renderer/lib/api";
import type * as ApiModule from "@renderer/lib/api";
import { useAccounts, useUi, useViews } from "@renderer/store";
import { platformEntryUrl, type PlatformId } from "@shared/platforms";
import type { Account } from "@shared/types";
import { AccountWorkspace } from "./AccountWorkspace";

vi.mock("@renderer/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  hasBridge: true,
}));

describe("account workspace entry and management navigation", () => {
  let accounts: Account[];
  beforeEach(async () => {
    accounts = await api.accounts.list();
    useAccounts.setState({ accounts });
    useViews.setState({ states: {} });
    useUi.setState({ activeAccountId: null, accountEntryRevision: 0, accountEntryUrl: null, drawerOpen: false, overlayCount: 0 });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(api.views, "show").mockImplementation(async (id) => ({ accountId: id }) as never);
    vi.spyOn(api.views, "hide").mockResolvedValue(undefined);
    vi.spyOn(api.views, "setBounds").mockResolvedValue(undefined);
    vi.spyOn(api.views, "go").mockResolvedValue(undefined);
    vi.spyOn(api.views, "navigate").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    cleanup();
    await act(async () => undefined);
    vi.restoreAllMocks();
  });

  function open(platformId: PlatformId) {
    const account = accounts.find((item) => item.platformId === platformId)!;
    useUi.getState().openAccount(account.id);
    render(<AccountWorkspace />);
    return account;
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

  it("re-enters the same selected account while scan metadata updates preserve its current page", async () => {
    const account = open("xiaohongshu");
    await waitFor(() => expect(api.views.show).toHaveBeenCalledTimes(1));
    act(() => useAccounts.getState().upsert({ ...account, displayName: "更新后的账号资料" }));
    await act(async () => undefined);
    expect(api.views.show).toHaveBeenCalledTimes(1);
    act(() => useUi.getState().openAccount(account.id));
    await waitFor(() => expect(api.views.show).toHaveBeenCalledTimes(2));
    expect(api.views.show).toHaveBeenLastCalledWith(account.id, expect.any(Object), true);
  });

  it("opens a selected work without the default homepage replacing it", async () => {
    const account = accounts.find((item) => item.platformId === "douyin")!;
    useUi.getState().openWork(account.id, "https://www.douyin.com/video/123");
    render(<AccountWorkspace />);
    await waitFor(() => expect(api.views.show).toHaveBeenCalledWith(account.id, expect.any(Object), false));
    expect(api.views.navigate).toHaveBeenCalledExactlyOnceWith(account.id, "https://www.douyin.com/video/123");
    act(() => useUi.getState().openAccount(account.id));
    await waitFor(() => expect(api.views.show).toHaveBeenLastCalledWith(account.id, expect.any(Object), true));
    expect(api.views.navigate).toHaveBeenCalledTimes(1);
  });
});
