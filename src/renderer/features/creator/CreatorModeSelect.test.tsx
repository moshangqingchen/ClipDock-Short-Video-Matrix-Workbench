// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "@renderer/lib/api";
import { useUi } from "@renderer/store";
import { CreatorModeSelect } from "./CreatorModeSelect";

describe("CreatorModeSelect", () => {
  beforeEach(() => {
    useUi.setState({ route: "metrics", creatorMode: "global", activeAccountId: "domestic-account" });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the sidebar's actual scope even when another creator mode was remembered", () => {
    render(<CreatorModeSelect mode="domestic" />);
    expect(screen.getByRole("combobox", { name: "切换国内或国外平台" })).toHaveValue("domestic");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "国内短视频平台",
      "国外短视频平台",
    ]);
  });

  it("enters the chosen creator scope without changing account selection or proxy settings", () => {
    const settings = vi.spyOn(api.settings, "set");
    render(<CreatorModeSelect mode="domestic" />);
    fireEvent.change(screen.getByRole("combobox", { name: "切换国内或国外平台" }), {
      target: { value: "global" },
    });
    expect(useUi.getState()).toMatchObject({
      route: "metrics",
      creatorMode: "global",
      activeAccountId: "domestic-account",
    });
    expect(settings).not.toHaveBeenCalled();
  });
});
