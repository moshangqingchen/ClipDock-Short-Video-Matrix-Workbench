// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Account, AccountMetricsView, Work } from "@shared/types";
import { api } from "@renderer/lib/api";
import { useAccounts, useUi } from "@renderer/store";
import { MetricsPage } from "./MetricsPage";
import { DataDrawer } from "@renderer/features/browser/DataDrawer";
import { ObservePanel } from "@renderer/features/browser/ObservePanel";

const account = { id: "owner", platformId: "douyin", displayName: "测试账号", status: "online" } as Account;
const work = {
  id: "video", accountId: "owner", platformId: "douyin", title: "可打开的作品",
  url: "https://www.douyin.com/video/123", plays: 100, likes: 5, comments: 2, shares: 1,
} as Work;
beforeEach(() => {
  useAccounts.setState({ accounts: [account] });
  useUi.setState({ route: "metrics", metricsAccountId: "owner", metricsPlatform: "douyin", accountEntryUrl: null });
  vi.spyOn(api.metrics, "account").mockResolvedValue({ metrics: {}, trend: [] } as unknown as AccountMetricsView);
  vi.spyOn(api.works, "list").mockResolvedValue([work, { ...work, id: "missing", title: "没有作品链接", url: null }]);
  vi.spyOn(api, "on").mockImplementation(() => () => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["metrics", "drawer", "observe"] as const)("makes the %s work list operable with missing links disabled", async (surface) => {
  render(surface === "metrics" ? <MetricsPage /> : surface === "drawer"
    ? <DataDrawer account={account} onClose={() => undefined} />
    : <ObservePanel account={account} onClose={() => undefined} />);
  const card = await screen.findByRole("button", { name: "打开作品：可打开的作品" });
  expect(screen.getByRole("button", { name: "打开作品：没有作品链接" })).toBeDisabled();
  await userEvent.click(card);
  expect(useUi.getState()).toMatchObject({ route: "creator", activeAccountId: "owner", accountEntryUrl: work.url });
});
