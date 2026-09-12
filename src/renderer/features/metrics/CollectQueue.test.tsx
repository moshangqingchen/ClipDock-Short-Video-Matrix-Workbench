// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectJob } from "@shared/collect-jobs";

const mocks = vi.hoisted(() => ({
  jobs: vi.fn(),
  cancelJob: vi.fn(),
  listeners: new Map<string, () => void>(),
}));
vi.mock("@renderer/lib/api", () => ({
  api: {
    metrics: { jobs: mocks.jobs, cancelJob: mocks.cancelJob },
    on: (event: string, handler: () => void) => {
      mocks.listeners.set(event, handler);
      return () => mocks.listeners.delete(event);
    },
  },
}));
import { CollectQueue } from "./CollectQueue";
import { useAccounts } from "@renderer/store";

const job: CollectJob = {
  id: "00000000-0000-4000-8000-000000000001",
  accountId: "00000000-0000-4000-8000-000000000002",
  trigger: "manual",
  state: "waiting-network",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  message: "等待国内网络",
  runId: null,
  attempts: 0,
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listeners.clear();
  useAccounts.setState({ accounts: [] });
});

describe("CollectQueue", () => {
  it("shows waiting tasks and cancels without a navigation or collect retry", async () => {
    mocks.jobs.mockResolvedValue([job]);
    mocks.cancelJob.mockResolvedValue({ ...job, state: "cancelled", message: "已取消" });
    render(<CollectQueue />);
    await screen.findByRole("button", { name: "取消任务" });
    expect(screen.getByText(/1 个待完成/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "取消任务" })).not.toBeInTheDocument());
    expect(mocks.cancelJob).toHaveBeenCalledExactlyOnceWith(job.id);
    expect(screen.getByText(/0 个待完成/)).toBeInTheDocument();
  });
  it("does not let a late initial list resurrect a task after a newer event snapshot", async () => {
    let oldResolve!: (rows: CollectJob[]) => void;
    mocks.jobs.mockImplementationOnce(
      () =>
        new Promise<CollectJob[]>((resolve) => {
          oldResolve = resolve;
        }),
    );
    mocks.jobs.mockResolvedValueOnce([{ ...job, state: "cancelled", message: "已取消" }]);
    render(<CollectQueue />);
    await act(async () => {
      mocks.listeners.get("collect-job")!();
    });
    await screen.findByText(/0 个待完成/);
    await act(async () => oldResolve([job]));
    expect(screen.queryByRole("button", { name: "取消任务" })).not.toBeInTheDocument();
  });
});
