// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnalyticsView } from "@shared/business-analytics";
import { api } from "@renderer/lib/api";
import { useToasts } from "@renderer/store";
import { BusinessAnalyticsPanel } from "./BusinessAnalyticsPanel";

const view: AnalyticsView = { accountId: "owner", platformId: "bilibili", enabled: false, records: [], states: [],
  requestedStart: "2026-09-01", requestedEnd: "2026-09-28", lastAttemptAt: null };
beforeEach(() => {
  vi.spyOn(api.analytics, "get").mockResolvedValue(view);
  vi.spyOn(api.analytics, "setEnabled").mockResolvedValue();
  vi.spyOn(api.views, "go").mockResolvedValue({} as never);
  vi.spyOn(api, "on").mockImplementation(() => () => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("shows all five advanced metrics and enables only the selected platform before opening its page", async () => {
  render(<BusinessAnalyticsPanel accountId="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "启用并打开官方分析页" }));
  await waitFor(() => expect(api.views.go).toHaveBeenCalledWith("owner", "analytics"));
  expect(api.analytics.setEnabled).toHaveBeenCalledExactlyOnceWith("bilibili", true);
  for (const name of ["完播率", "平均观看时长", "内容收益", "粉丝画像", "流量来源"]) expect(screen.getByRole("heading", { name })).toBeInTheDocument();
});
it("offers retry after a local read failure and reports official page navigation failures", async () => {
  vi.mocked(api.analytics.get).mockRejectedValueOnce(new Error("fixture"));
  const toast = vi.spyOn(useToasts.getState(), "push");
  render(<BusinessAnalyticsPanel accountId="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "重试经营分析" }));
  vi.mocked(api.views.go).mockRejectedValueOnce(new Error("页面加载失败"));
  fireEvent.click(await screen.findByRole("button", { name: "启用并打开官方分析页" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: "页面加载失败" })));
});
it("does not let an old account response replace the selected account", async () => {
  let resolve!: (value: AnalyticsView) => void;
  vi.mocked(api.analytics.get).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const rendered = render(<BusinessAnalyticsPanel accountId="old" />);
  vi.mocked(api.analytics.get).mockResolvedValue({ ...view, accountId: "new", enabled: true });
  rendered.rerender(<BusinessAnalyticsPanel accountId="new" />);
  await screen.findByRole("button", { name: "暂停此平台经营观测" });
  await act(async () => resolve({ ...view, accountId: "old" }));
  expect(screen.queryByRole("button", { name: "启用并打开官方分析页" })).not.toBeInTheDocument();
});
