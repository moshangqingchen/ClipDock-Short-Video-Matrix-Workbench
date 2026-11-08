// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OverviewView } from "@shared/types";
import { ObservationHealth } from "./ObservationHealth";

const empty: OverviewView = {
  accountCount: 1, onlineCount: 0, attentionCount: 0,
  totals: {}, dayDelta: {}, coverage: {}, dayCoverage: {}, platforms: [], trend: [], attention: [],
};
afterEach(cleanup);

describe("observation coverage semantics", () => {
  it("keeps failed and pending reads distinct from a confirmed empty snapshot", () => {
    const result = render(<ObservationHealth data={null} loading />);
    expect(screen.getByText(/正在读取账号快照/)).toBeInTheDocument();
    expect(screen.queryByText(/尚无账号快照/)).not.toBeInTheDocument();
    result.rerender(<ObservationHealth data={null} loading={false} error />);
    expect(screen.getByText(/读取失败，暂时无法确认/)).toBeInTheDocument();
    expect(screen.queryByText(/尚无账号快照/)).not.toBeInTheDocument();
    result.rerender(<ObservationHealth data={empty} loading={false} />);
    expect(screen.getByText(/尚无账号快照/)).toBeInTheDocument();
  });

  it("counts absent keys in successful sparse coverage as zero, but does not invent missing coverage", () => {
    const result = render(<ObservationHealth data={empty} loading={false} />);
    expect(screen.getAllByText("0 / 1")).toHaveLength(8);
    result.rerender(<ObservationHealth data={{ ...empty, coverage: undefined }} loading={false} />);
    expect(screen.getAllByText("—")).toHaveLength(8);
    expect(screen.queryByText("0 / 1")).not.toBeInTheDocument();
  });

  it("preserves confirmed coverage while a refresh fails", () => {
    render(<ObservationHealth data={{ ...empty, coverage: { followers: 1 } }} loading={false} error />);
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(screen.getAllByText("0 / 1")).toHaveLength(7);
  });
});
