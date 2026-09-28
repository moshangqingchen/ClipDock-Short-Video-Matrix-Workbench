// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Account, AccountMetricsView, CollectRun, OverviewView, PlatformSummaryView, Work } from "@shared/types";
import { METRIC_NAMES } from "@shared/types";
import { api } from "@renderer/lib/api";
import { useAccounts, useUi } from "@renderer/store";
import { MetricsPage } from "./MetricsPage";
import { OverviewPage } from "../dashboard/OverviewPage";
import { METRIC_LABELS, RUN_LABELS } from "./metric-presentation";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: ReactNode }) => <div data-testid="trend-chart">{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Area: ({ dataKey }: { dataKey: string }) => <span data-testid="trend-series">{dataKey}</span>,
  Line: () => null, CartesianGrid: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));
const account = { id: "owner", platformId: "douyin", displayName: "测试账号", status: "online" } as Account;
const at = "2026-09-28T01:00:00.000Z";
function accountView(status: CollectRun["status"] = "partial"): AccountMetricsView {
  return { accountId: "owner", platformId: "douyin", capturedAt: at, collectedWorkCount: 51,
    metrics: Object.fromEntries(METRIC_NAMES.map((metric, index) => [metric, { current: index, day: 0, week: null, month: null, origin: "official", capturedAt: at }])),
    trend: [{ date: "2026-09-28", followers: 0, likes: 2, plays: 4, following: 1, comments: 3, shares: 5, favorites: 6, works: 7 }],
    lastRun: { accountId: "owner", platformId: "douyin", startedAt: at, finishedAt: at, status,
      trigger: "manual", message: "部分作品仍等待官方页面", metricsWritten: 8, worksWritten: 30 },
    workTotals: { plays: 0, shares: 8 }, workCoverage: { plays: { observed: 1, legacy: 0, capturedAt: at } } };
}
function platformView(): PlatformSummaryView {
  const view = accountView();
  return { platformId: "douyin", accountCount: 1, onlineCount: 1,
    totals: Object.fromEntries(METRIC_NAMES.map((metric, index) => [metric, index])), dayDelta: {},
    coverage: Object.fromEntries(METRIC_NAMES.map(metric => [metric, 1])),
    accounts: [{ accountId: "owner", displayName: "测试账号", status: "online", metrics: view.metrics,
      spark: [], capturedAt: at, lastRun: view.lastRun }] };
}
const work = { id: "video", accountId: "owner", platformId: "douyin", title: "作品A", url: "https://www.douyin.com/video/123",
  remoteId: "123", plays: 0, likes: 0, comments: 0, shares: 8, favorites: 0, fetchedAt: at,
  observations: { plays: { origin: "official", capturedAt: at }, shares: { origin: "page", capturedAt: at } } } as Work;

beforeEach(() => {
  useAccounts.setState({ accounts: [account] });
  useUi.setState({ route: "metrics", metricsAccountId: "owner", metricsPlatform: "douyin" });
  vi.spyOn(api, "on").mockImplementation(() => () => undefined);
  vi.spyOn(api.metrics, "account").mockResolvedValue(accountView());
  vi.spyOn(api.metrics, "platform").mockResolvedValue(platformView());
  vi.spyOn(api.works, "list").mockResolvedValue([work]);
  vi.spyOn(api.metrics, "collectNow").mockResolvedValue([]);
  vi.spyOn(api.metrics, "jobs").mockResolvedValue([]);
  vi.spyOn(api.metrics, "overview").mockResolvedValue({ accountCount: 1, onlineCount: 1, attentionCount: 0,
    totals: platformView().totals, dayDelta: {}, coverage: platformView().coverage, dayCoverage: {},
    platforms: [platformView()], attention: [], trend: accountView().trend } as OverviewView);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("complete metrics observation surfaces", () => {
  it("offers all eight trend metrics and distinguishes a measured zero from missing work fields", async () => {
    render(<MetricsPage />);
    await screen.findByText("部分作品仍等待官方页面");
    const select = screen.getByRole("combobox", { name: "趋势指标" });
    expect(within(select).getAllByRole("option")).toHaveLength(8);
    for (const metric of METRIC_NAMES) {
      fireEvent.change(select, { target: { value: metric } });
      expect(screen.getByText(`${METRIC_LABELS[metric]}趋势 · 最近 30 天`)).toBeInTheDocument();
      expect(screen.getByTestId("trend-series")).toHaveTextContent(metric);
    }
    const card = screen.getByRole("button", { name: "打开作品：作品A" });
    expect(within(card).getByText("0")).toBeInTheDocument();
    expect(within(card).getByText("8")).toBeInTheDocument();
    expect(within(card).getAllByText("未取得")).toHaveLength(3);
    expect(within(card).getByText(/官方接口/)).toBeInTheDocument();
    expect(within(card).getByText(/页面读取/)).toBeInTheDocument();
    expect(within(card).getByText("收藏")).toBeInTheDocument();
    expect(screen.getByText(/合计仅覆盖已采作品/)).toBeInTheDocument();
  });

  it.each(["success", "partial", "failed", "skipped"] as const)("shows the latest %s run and reason", async status => {
    vi.mocked(api.metrics.account).mockResolvedValue(accountView(status));
    render(<MetricsPage />);
    expect(await screen.findByText(RUN_LABELS[status])).toBeInTheDocument();
    expect(screen.getByText("部分作品仍等待官方页面")).toBeInTheDocument();
  });

  it("keeps account observations visible when only the works request fails, and retries works independently", async () => {
    vi.mocked(api.works.list).mockRejectedValueOnce(new Error("LOCAL_FAILURE"));
    render(<MetricsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("作品列表读取失败");
    expect(screen.getByText("部分完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(await screen.findByRole("button", { name: "打开作品：作品A" })).toBeInTheDocument();
    expect(api.metrics.account).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(api.works.list).toHaveBeenLastCalledWith("owner", 50, 50));
    expect(api.metrics.account).toHaveBeenCalledTimes(1);
  });

  it("exposes all eight platform columns and all-platform collection through the existing queue", async () => {
    useUi.setState({ metricsAccountId: null });
    render(<MetricsPage />);
    await screen.findByText("测试账号");
    for (const metric of METRIC_NAMES) expect(screen.getByRole("columnheader", { name: METRIC_LABELS[metric] })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "最近采集" })).toBeInTheDocument();
    expect(screen.getByText("部分完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "采集全部平台" }));
    await waitFor(() => expect(api.metrics.collectNow).toHaveBeenCalledExactlyOnceWith());
  });

  it("recovers from a platform read error and explicitly describes an empty platform", async () => {
    useUi.setState({ metricsAccountId: null });
    vi.mocked(api.metrics.platform).mockRejectedValueOnce(new Error("LOCAL_FAILURE"))
      .mockResolvedValue({ ...platformView(), totals: {}, coverage: {} });
    render(<MetricsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("平台数据读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(await screen.findByText(/该平台尚未取得指标/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows all eight overview totals and restores overview after a failed read", async () => {
    vi.mocked(api.metrics.overview).mockRejectedValueOnce(new Error("LOCAL_FAILURE"));
    render(<OverviewPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("总览读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    await screen.findByText("所有账号状态正常");
    for (const metric of METRIC_NAMES) expect(screen.getByText(`总${METRIC_LABELS[metric]}`)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "趋势指标" }), { target: { value: "favorites" } });
    expect(screen.getByTestId("trend-series")).toHaveTextContent("favorites");
    expect(screen.getAllByText("1/1 个账号有值")).toHaveLength(16);
  });

  it("does not allow an old account request to overwrite the selected account", async () => {
    let resolveOld!: (value: AccountMetricsView) => void;
    vi.mocked(api.metrics.account).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    useAccounts.setState({ accounts: [account, { ...account, id: "other", displayName: "另一个账号" }] });
    render(<MetricsPage />);
    await waitFor(() => expect(api.metrics.account).toHaveBeenCalledWith("owner", 30));
    await act(async () => useUi.setState({ metricsAccountId: "other" }));
    await screen.findByText("部分完成");
    await act(async () => resolveOld({ ...accountView("failed"), lastRun: { ...accountView("failed").lastRun!, message: "过时账号失败" } }));
    expect(screen.queryByText("过时账号失败")).not.toBeInTheDocument();
    expect(screen.getByText("另一个账号")).toBeInTheDocument();
  });
});
