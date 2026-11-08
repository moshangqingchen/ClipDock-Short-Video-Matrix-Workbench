// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@renderer/lib/api", async () => {
  const { createUnavailableApi } = await import("@renderer/lib/unavailable-api");
  return { api: createUnavailableApi(), runtimeMode: "unavailable", hasBridge: false };
});
import App from "./App";
import { api } from "@renderer/lib/api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("shows the connection failure before mounting data views or bootstrap requests", () => {
  const list = vi.spyOn(api.accounts, "list");
  const settings = vi.spyOn(api.settings, "get");
  render(<App />);
  expect(screen.getByRole("heading", { name: "桌面连接不可用" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新加载工作台" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(screen.queryByText(/演示数据/)).not.toBeInTheDocument();
  expect(list).not.toHaveBeenCalled();
  expect(settings).not.toHaveBeenCalled();
});
