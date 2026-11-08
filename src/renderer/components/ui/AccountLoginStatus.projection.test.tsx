// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Account } from "@shared/types";
import { createMediaProjection } from "../../../main/services/media-projection";
import { AccountLoginStatus } from "./AccountLoginStatus";

afterEach(cleanup);

it("carries independent login evidence through the real renderer DTO without exporting internal observation fields", () => {
  const homepageAt = Date.parse("2026-09-12T03:00:00.000Z");
  const creatorAt = homepageAt + 2000;
  const attemptedAt = "2026-09-12T03:01:00.000Z";
  const privateMetadata = "internal-observation-must-not-reach-renderer";
  const checkInfo = {
    state: "unconfirmed" as const,
    reason: "保留上次主页登录结论，等待主页自动复核；管理后台不用于确认主页登录",
    attemptedAt,
    retainedHomepage: true as const,
    homepageConfirmation: { kind: "online" as const, observedAt: homepageAt, rawResponse: privateMetadata },
    creatorConfirmation: { kind: "online" as const, observedAt: creatorAt, endpoint: privateMetadata, subject: privateMetadata },
    token: privateMetadata,
  };
  const stored: Account = {
    id: "projection-account",
    platformId: "xiaohongshu",
    displayName: "测试创作者",
    partition: "persist:projection-account",
    status: "online",
    lastCheckedAt: new Date(homepageAt).toISOString(),
    sortOrder: 0,
    createdAt: attemptedAt,
    updatedAt: attemptedAt,
    checkInfo,
  };
  const projection = createMediaProjection({ enforcement: "strict" });
  const projected = projection.projectAccount(stored);
  expect(projected.checkInfo).toEqual({
    state: "unconfirmed",
    reason: checkInfo.reason,
    attemptedAt,
    retainedHomepage: true,
    homepageConfirmation: { kind: "online", observedAt: homepageAt },
    creatorConfirmation: { kind: "online", observedAt: creatorAt },
  });
  expect(JSON.stringify(projected)).not.toContain(privateMetadata);

  const { rerender } = render(<AccountLoginStatus detailed account={projected} />);
  expect(screen.getByText("在线")).toBeInTheDocument();
  expect(screen.getByText(/管理后台：已登录/)).toHaveAttribute("title", `最近确认：${new Date(creatorAt).toLocaleString()}`);
  expect(screen.queryByText("待核实")).not.toBeInTheDocument();
  expect(screen.getByText(/主页最近确认/)).toHaveTextContent(new Date(homepageAt).toLocaleString());

  // Clearing only the backend observation must cross the same DTO boundary;
  // the retained homepage can never manufacture a creator login.
  rerender(<AccountLoginStatus detailed account={projection.projectAccount({
    ...stored, checkInfo: { ...checkInfo, creatorConfirmation: null },
  })} />);
  expect(screen.getByText("在线")).toBeInTheDocument();
  expect(screen.getByText(/管理后台：尚未确认/)).toBeInTheDocument();
  expect(screen.queryByText(/管理后台：已登录/)).not.toBeInTheDocument();
});
