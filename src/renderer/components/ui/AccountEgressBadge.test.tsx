// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AccountEgressLocation } from "@shared/network";
import { AccountEgressBadge } from "./AccountEgressBadge";

const location: AccountEgressLocation = {
  state: "ready",
  route: "direct",
  ip: "203.0.113.8",
  country: "中国",
  region: "广东省",
  city: "深圳市",
  checkedAt: "2026-09-12T03:15:00.000Z",
};

afterEach(cleanup);

it("shows the measured city and keeps IP, full location and measured time in the tooltip", () => {
  render(<AccountEgressBadge location={location} />);
  const badge = screen.getByLabelText("直连出口位置：深圳市");
  expect(badge).toHaveTextContent("深圳市");
  expect(badge).not.toHaveTextContent(location.ip!);
  expect(badge.title).toContain("直连出口 IP：203.0.113.8");
  expect(badge.title).toContain("归属地：中国 · 广东省 · 深圳市");
  expect(badge.title).toContain("2026/9/12");
  expect(badge.title).toContain("IP归属地估测，可能与平台显示不同");
  expect(badge.tagName).toBe("SPAN");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it.each([
  [{ city: null }, "广东省"],
  [{ city: " ", region: null }, "中国"],
  [{ city: null, region: null, country: null }, "位置未知"],
] as const)("falls back only to measured region/country when the city is absent", (patch, label) => {
  render(<AccountEgressBadge location={{ ...location, ...patch }} />);
  expect(screen.getByLabelText(`直连出口位置：${label}`)).toHaveTextContent(label);
});

it.each([
  ["checking", "检测中"],
  ["unavailable", "位置未知"],
] as const)("does not present stale location values while %s", (state, label) => {
  render(<AccountEgressBadge location={{ ...location, state }} />);
  const badge = screen.getByLabelText(`直连出口位置：${label}`);
  expect(badge.title).toContain("直连出口 IP：未知");
  expect(badge.title).not.toContain("深圳");
  expect(badge.title).not.toContain(location.ip!);
});

it("keeps missing or invalid detection times unknown rather than inventing a sample", () => {
  const { rerender } = render(<AccountEgressBadge />);
  expect(screen.getByLabelText("直连出口位置：位置未知").title).toContain("检测时间：尚未检测");
  rerender(<AccountEgressBadge location={{ ...location, checkedAt: "invalid" }} />);
  expect(screen.getByLabelText("直连出口位置：深圳市").title).toContain("检测时间：尚未检测");
});

it("renders arbitrary place text safely and keeps long IPv6 addresses out of the name line", () => {
  const city = "<img src=x onerror=alert(1)>".repeat(10);
  const ip = "2001:db8:1234:5678:90ab:cdef:1234:5678";
  const { container } = render(<AccountEgressBadge location={{ ...location, city, ip }} />);
  const badge = screen.getByLabelText(`直连出口位置：${city}`);
  expect(badge).toHaveTextContent(city);
  expect(badge).not.toHaveTextContent(ip);
  expect(badge.title).toContain(ip);
  expect(container.querySelector("img")).toBeNull();
});
