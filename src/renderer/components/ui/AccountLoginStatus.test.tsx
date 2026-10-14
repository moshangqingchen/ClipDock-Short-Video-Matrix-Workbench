// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Account, AccountCheckInfo, AccountStatus } from "@shared/types";
import { AccountLoginStatus } from "./AccountLoginStatus";
import styles from "./ui.module.css";

const confirmedAt = "2026-09-12T03:00:00.000Z";
const attemptedAt = "2026-09-12T03:30:00.000Z";
const account = {
  id: "one",
  platformId: "douyin",
  displayName: "测试创作者",
  status: "online",
  sortOrder: 0,
  lastCheckedAt: confirmedAt,
  createdAt: confirmedAt,
  updatedAt: confirmedAt,
} as Account;

afterEach(cleanup);

it("keeps compact account rows to one status while retaining the check explanation", () => {
  const checked = { ...account, checkInfo: { state: "paused" as const, reason: "本次检查等待网络恢复", attemptedAt } };
  const { rerender } = render(<AccountLoginStatus compact account={checked} />);
  expect(screen.getByText("在线")).toHaveAttribute("title", expect.stringContaining("本次检查等待网络恢复"));
  expect(screen.queryByText("网络暂停")).not.toBeInTheDocument();
  rerender(<AccountLoginStatus detailed account={checked} />);
  expect(screen.getByText("在线")).toBeInTheDocument();
  expect(screen.getByText("网络暂停")).toBeInTheDocument();
});

it("shows an online homepage alongside an offline creator console and the independent check result", () => {
  render(<AccountLoginStatus detailed account={{ ...account, platformId: "kuaishou", checkInfo: {
    state: "paused", reason: "网络正在恢复", attemptedAt,
    creatorConfirmation: { kind: "offline", observedAt: Date.parse(confirmedAt) },
  } }} />);
  expect(screen.getByText("在线")).toBeInTheDocument();
  expect(screen.getByText("网络暂停")).toBeInTheDocument();
  expect(screen.getByText(/管理后台：需要登录/)).toBeInTheDocument();
  expect(screen.getByText(/主页最近确认/)).toHaveTextContent(new Date(confirmedAt).toLocaleString());
});

it.each<[AccountStatus, string]>([
  ["online", "在线"],
  ["expiring", "即将过期"],
  ["offline", "未登录"],
  ["needs_verification", "需验证"],
  ["network_error", "网络异常"],
])("keeps the established %s status through checks that have no new login conclusion", (status, label) => {
  const { rerender } = render(<AccountLoginStatus account={{ ...account, status }} />);
  for (const state of ["checking", "unconfirmed", "paused", "network_error"] as const) {
    rerender(
      <AccountLoginStatus account={{
        ...account,
        status,
        checkInfo: { state, reason: `本次检查：${state}`, attemptedAt },
      }} />,
    );
    const shown = screen.getByText(label);
    expect(shown.firstElementChild).toHaveClass(styles[status]);
    expect(shown).toHaveAttribute("title", [
      `本次检查：${state}`,
      `最近检查：${new Date(attemptedAt).toLocaleString()}`,
      `上次确认：${label} · ${new Date(confirmedAt).toLocaleString()}`,
    ].join("\n"));
  }
});

it.each<[AccountCheckInfo["state"], string, AccountStatus]>([
  ["unconfirmed", "待核实", "unknown"],
  ["checking", "检测中", "unknown"],
  ["paused", "网络暂停", "unknown"],
  ["network_error", "网络异常", "network_error"],
])("shows %s when the account has never had a login conclusion", (state, label, dotStatus) => {
  render(<AccountLoginStatus account={{
    ...account,
    status: "unknown",
    lastCheckedAt: null,
    checkInfo: { state, reason: "尚未获得登录结果", attemptedAt },
  }} />);
  const shown = screen.getByText(label);
  expect(shown.firstElementChild).toHaveClass(styles[dotStatus]);
  expect(shown.title).toContain("尚未确认");
  expect(screen.queryByText("在线")).not.toBeInTheDocument();
});

it("leaves an unchecked account pending without inventing a check or confirmation time", () => {
  render(<AccountLoginStatus account={{ ...account, status: "unknown", lastCheckedAt: null }} />);
  const shown = screen.getByText("待检测");
  expect(shown.title).toContain("最近检查：尚未检查");
  expect(shown.title).toContain("尚未确认");
});
