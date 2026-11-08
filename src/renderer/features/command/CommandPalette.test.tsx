// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Account } from "@shared/types";
import type { GlobalAccount } from "@shared/global-accounts";
import { useAccounts, useGlobalAccounts, useUi } from "@renderer/store";
import { CommandPalette, CommandTrigger } from "./CommandPalette";

const domestic: Account = {
  id: "domestic-id",
  platformId: "douyin",
  displayName: "星河创作",
  handle: "@studio-cn",
  externalId: "100086",
  partition: "persist:domestic-id",
  status: "unknown",
  sortOrder: 0,
  note: "旅行剪辑",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const global: GlobalAccount = {
  id: "global-id",
  platformId: "youtube",
  displayName: "星河创作",
  remoteId: "channel-200",
  authStatus: "unauthorized",
  note: "Travel Studio",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function openPalette() {
  render(
    <>
      <CommandTrigger />
      <CommandPalette />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "搜索页面与账号" }));
  return screen.getByRole("combobox", { name: "搜索页面、平台或账号" });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    useUi.setState({
      searchOpen: false,
      overlayCount: 0,
      route: "overview",
      creatorMode: "domestic",
      activeAccountId: null,
      activeGlobalAccountId: null,
    });
    useAccounts.setState({ accounts: [domestic], loaded: true, loadError: null });
    useGlobalAccounts.setState({ accounts: [global], loaded: true, error: null });
  });
  afterEach(() => cleanup());

  it("opens with Ctrl+K, owns a native overlay and restores focus after Escape", () => {
    render(
      <>
        <CommandTrigger />
        <CommandPalette />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "搜索页面与账号" });
    trigger.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "快速前往" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(useUi.getState().overlayCount).toBe(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useUi.getState().overlayCount).toBe(0);
    expect(trigger).toHaveFocus();
  });

  it("does not open over another modal or during input method composition", () => {
    render(<CommandPalette />);
    act(() => useUi.setState({ overlayCount: 1 }));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => useUi.setState({ overlayCount: 0 }));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true, isComposing: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens same-named accounts by their real scope and ID", () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: "星河" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /YouTube/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useUi.getState()).toMatchObject({
      route: "creator",
      creatorMode: "global",
      activeGlobalAccountId: "global-id",
      activeAccountId: null,
      searchOpen: false,
    });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "100086" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(useUi.getState()).toMatchObject({
      route: "creator",
      creatorMode: "domestic",
      activeAccountId: "domestic-id",
      activeGlobalAccountId: "global-id",
    });
  });

  it("supports normalized multi-word search while preserving composition input", () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: "ＴＲＡＶＥＬ   youtube" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(useUi.getState().route).toBe("overview");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useUi.getState().activeGlobalAccountId).toBe("global-id");
  });

  it("navigates pages and wraps keyboard selection without changing account scope", () => {
    act(() => useUi.setState({ creatorMode: "global" }));
    const input = openPalette();
    fireEvent.change(input, { target: { value: "素材" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const selected = screen
      .getAllByRole("option")
      .find((option) => option.getAttribute("aria-selected") === "true");
    expect(input).toHaveAttribute("aria-activedescendant", selected?.id);
    fireEvent.change(input, { target: { value: "素材库" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useUi.getState()).toMatchObject({ route: "assets", creatorMode: "global" });
  });

  it("reflects live account removal and reports partial loading failures", () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: "星河" } });
    act(() => useAccounts.setState({ accounts: [], loadError: "读取失败" }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("国内账号读取失败");
    fireEvent.change(input, { target: { value: "不存在" } });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText("没有匹配的页面或账号")).toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useUi.getState().route).toBe("overview");
  });
});
