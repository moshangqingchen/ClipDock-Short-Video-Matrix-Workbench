// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "@renderer/lib/api";
import App from "./App";

describe("App (browser preview mode)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it("renders the shell with navigation, account tree and overview", async () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "国内账号列表" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "总览" })).toBeInTheDocument());
    // preview data populates the platform groups
    await waitFor(() => expect(screen.getAllByText(/品牌官方号/).length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /短视频创作者平台/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /短视频创作者平台/ }));
    const hideDomesticViews = vi.spyOn(api.views, "hideAll");
    fireEvent.change(screen.getByRole("combobox", { name: "切换国内或国外平台" }), {
      target: { value: "global" },
    });
    await screen.findByRole("complementary", { name: "国外账号列表" });
    expect(hideDomesticViews).toHaveBeenCalled();
    expect(screen.queryByRole("complementary", { name: "国内账号列表" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "国外账号列表" })).toBeInTheDocument();
    const globalSidebar = screen.getByRole("complementary", { name: "国外账号列表" });
    expect(within(globalSidebar).getByText("YouTube")).toBeInTheDocument();
    expect(within(globalSidebar).getByText("TikTok")).toBeInTheDocument();
    expect(within(globalSidebar).getByText("X")).toBeInTheDocument();
    expect(within(globalSidebar).getByRole("combobox", { name: "切换国内或国外平台" })).toHaveValue("global");
    expect(screen.queryByRole("tablist", { name: "创作者平台区域" })).not.toBeInTheDocument();
    const create = vi.fn();
    window.addEventListener("clipdock:focus-global-create", create);
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(create).toHaveBeenCalledOnce();
    window.removeEventListener("clipdock:focus-global-create", create);
    fireEvent.change(within(globalSidebar).getByRole("combobox", { name: "切换国内或国外平台" }), {
      target: { value: "domestic" },
    });
    expect(screen.getByRole("complementary", { name: "国内账号列表" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "国外账号列表" })).not.toBeInTheDocument();
  });
});
