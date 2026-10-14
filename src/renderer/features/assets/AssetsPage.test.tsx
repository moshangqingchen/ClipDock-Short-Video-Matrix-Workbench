// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Asset } from "@shared/types";
import { api } from "@renderer/lib/api";
import { useUi } from "@renderer/store";
import { AssetGrid, AssetsPage } from "./AssetsPage";

const asset = (i: number): Asset => ({ id: `asset-${i}`, fileName: `素材-${i}.mp4`, kind: "video", filePath: `C:/素材-${i}.mp4`,
  mimeType: "video/mp4", sizeBytes: 2048, sha256: "x", createdAt: "2026-10-12T00:00:00Z", thumbnailPath: null });
beforeEach(() => { useUi.setState({ selectedAssetIds: [] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps existing assets when refreshing fails and recovers through the error action", async () => {
  vi.spyOn(api.assets, "list").mockResolvedValueOnce([asset(1)]).mockRejectedValueOnce(new Error("read failed")).mockResolvedValueOnce([asset(1), asset(2)]);
  vi.spyOn(api.assets, "import").mockResolvedValue([]);
  render(<AssetsPage />);
  await screen.findByText("素材-1.mp4");
  fireEvent.click(screen.getByRole("button", { name: "导入素材" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已保留上次列表");
  expect(screen.getByText("素材-1.mp4")).toBeInTheDocument();
  expect(screen.queryByText("素材库为空")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试读取素材" }));
  expect(await screen.findByText("素材-2.mp4")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("allows reveal and removal while selection is enabled and clears the removed selection", async () => {
  vi.spyOn(api.assets, "list").mockResolvedValue([asset(1)]);
  vi.spyOn(api.assets, "reveal").mockResolvedValue(undefined);
  vi.spyOn(api.assets, "remove").mockResolvedValue(undefined);
  render(<AssetsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "选择素材：素材-1.mp4" }));
  expect(useUi.getState().selectedAssetIds).toEqual(["asset-1"]);
  fireEvent.click(screen.getByRole("button", { name: "在文件夹中显示：素材-1.mp4" }));
  expect(api.assets.reveal).toHaveBeenCalledWith("asset-1");
  fireEvent.click(screen.getByRole("button", { name: "移出素材库：素材-1.mp4" }));
  await waitFor(() => expect(useUi.getState().selectedAssetIds).toEqual([]));
  expect(api.assets.remove).toHaveBeenCalledWith("asset-1");
});

it("bounds rendered assets and searches the entire library while preserving selections across pages", () => {
  render(<AssetGrid assets={Array.from({ length: 50 }, (_, i) => asset(i))} onChanged={() => undefined} selectable selected={["asset-49"]} />);
  expect(screen.getAllByRole("button", { name: /^选择素材/ })).toHaveLength(24);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("第 2 / 3 页")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索素材" }), { target: { value: "素材-49" } });
  expect(screen.getByRole("button", { name: "选择素材：素材-49.mp4" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "下一页" })).not.toBeInTheDocument();
});
