// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GlobalAccount } from "@shared/global-accounts";
import type { WebObservation } from "@shared/global-web-observation";
import type { GlobalWork, WebCollectJob } from "@shared/global-workspace";
import { useGlobalAccounts, useUi } from "@renderer/store";
import { GlobalMetricsPage } from "./GlobalMetricsPage";

const mock = vi.hoisted(() => ({
  observation: vi.fn(),
  jobs: vi.fn(),
  works: vi.fn(),
  collect: vi.fn(),
  cancel: vi.fn(),
  listeners: new Set<(accountId: string) => void>(),
}));
vi.mock("@renderer/lib/api", () => ({
  hasBridge: true,
  api: {
    globalWeb: { observation: mock.observation },
    globalWorkspace: {
      jobs: mock.jobs,
      works: mock.works,
      collect: mock.collect,
      cancelJob: mock.cancel,
      onChanged: (listener: (accountId: string) => void) => {
        mock.listeners.add(listener);
        return () => mock.listeners.delete(listener);
      },
    },
  },
}));
vi.mock("./GlobalWebObservationPanel", () => ({ GlobalWebObservationPanel: () => <div>账号观测详情</div> }));

const first: GlobalAccount = {
  id: "00000000-0000-4000-8000-000000000001",
  platformId: "youtube",
  displayName: "测试频道 A",
  remoteId: null,
  authStatus: "unauthorized",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};
const second: GlobalAccount = {
  ...first,
  id: "00000000-0000-4000-8000-000000000002",
  displayName: "测试频道 B",
};
function snapshot(value = "120", account = first): WebObservation {
  return {
    accountId: account.id,
    platformId: account.platformId,
    source: "webpage",
    subjectId: "subject-a",
    engine: "chrome",
    capturedAt: "2026-10-20T00:00:00Z",
    page: "YouTube Studio",
    period: "最近 28 天",
    metrics: [{ key: "followers", label: "当前订阅者", value }],
  };
}
function work(account = first): GlobalWork {
  return {
    accountId: account.id,
    platformId: account.platformId,
    subjectId: "subject-a",
    remoteId: `work-${account.id}`,
    title: `${account.displayName} 的作品`,
    url: "https://www.youtube.com/watch?v=test",
    publishedAt: null,
    metrics: { views: "0" },
    capturedAt: "2026-10-20T00:00:00Z",
  };
}
function job(message = "等待完成登录"): WebCollectJob {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    accountId: first.id,
    state: "waiting-login",
    trigger: "manual",
    message,
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    attempts: 1,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function changed() {
  act(() => {
    for (const listener of mock.listeners) listener(first.id);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.listeners.clear();
  mock.observation.mockReset().mockResolvedValue(snapshot());
  mock.jobs.mockReset().mockResolvedValue([job()]);
  mock.works.mockReset().mockImplementation(async (id: string) => [work(id === first.id ? first : second)]);
  useGlobalAccounts.setState({ accounts: [first], identities: {}, loaded: true, error: null });
  useUi.setState({
    activeGlobalAccountId: first.id,
    creatorMode: "global",
    route: "metrics",
    globalMetricsDetail: true,
  });
});
afterEach(cleanup);

describe("GlobalMetricsPage read accuracy", () => {
  it("distinguishes loading and failed account lists from a confirmed empty list", async () => {
    useGlobalAccounts.setState({ accounts: [], loaded: false });
    render(<GlobalMetricsPage overview />);
    expect(screen.getByText("正在读取国外账号…")).toBeInTheDocument();
    expect(screen.queryByText("还没有国外账号")).not.toBeInTheDocument();
    act(() => useGlobalAccounts.setState({ loaded: true, error: "读取失败" }));
    expect(screen.getByRole("alert")).toHaveTextContent("无法确认账号列表");
    expect(screen.queryByText("还没有国外账号")).not.toBeInTheDocument();
    act(() => useGlobalAccounts.setState({ error: null }));
    expect(screen.getByText("还没有国外账号")).toBeInTheDocument();
    await waitFor(() => expect(mock.jobs).toHaveBeenCalled());
  });

  it("does not present failed first reads as empty observations or zero tasks", async () => {
    mock.observation.mockRejectedValue(new Error("disk unavailable"));
    mock.jobs.mockRejectedValue(new Error("disk unavailable"));
    mock.works.mockRejectedValue(new Error("disk unavailable"));
    render(<GlobalMetricsPage overview />);
    await screen.findByRole("alert");
    expect(screen.getByText("已读取的观测记录").previousElementSibling).toHaveTextContent("—");
    expect(screen.getByText("需要关注的任务").previousElementSibling).toHaveTextContent("—");
    expect(screen.getByText("任务读取失败，暂时无法确认采集队列。")).toBeInTheDocument();
    expect(screen.queryByText("尚未采集")).not.toBeInTheDocument();
  });

  it("preserves successful observations and jobs on failure, then accepts confirmed empty reads", async () => {
    render(<GlobalMetricsPage overview />);
    await screen.findByText("120");
    expect(screen.getByText("等待完成登录")).toBeInTheDocument();
    mock.observation.mockRejectedValue(new Error("temporary failure"));
    mock.jobs.mockRejectedValue(new Error("temporary failure"));
    changed();
    await screen.findByRole("alert");
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("等待完成登录")).toBeInTheDocument();
    expect(screen.getByText(/上次结果/)).toBeInTheDocument();
    mock.observation.mockResolvedValue(null);
    mock.jobs.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByText("120")).not.toBeInTheDocument();
    expect(screen.queryByText("等待完成登录")).not.toBeInTheDocument();
    expect(screen.getByText("尚未采集")).toBeInTheDocument();
  });

  it("discards an older refresh that completes after a newer observation and queue", async () => {
    const oldSnapshot = deferred<WebObservation>();
    const oldQueue = deferred<WebCollectJob[]>();
    mock.observation.mockReturnValueOnce(oldSnapshot.promise).mockResolvedValue(snapshot("222"));
    mock.jobs.mockReturnValueOnce(oldQueue.promise).mockResolvedValue([job("较新的队列状态")]);
    render(<GlobalMetricsPage overview />);
    changed();
    await screen.findByText("222");
    await act(async () => {
      oldSnapshot.resolve(snapshot("111"));
      oldQueue.resolve([job("旧队列状态")]);
    });
    expect(screen.getByText("222")).toBeInTheDocument();
    expect(screen.queryByText("111")).not.toBeInTheDocument();
    expect(screen.getByText("较新的队列状态")).toBeInTheDocument();
    expect(screen.queryByText("旧队列状态")).not.toBeInTheDocument();
  });

  it("keeps successful works on refresh failure and removes them immediately on account switch", async () => {
    useGlobalAccounts.setState({ accounts: [first, second] });
    mock.observation.mockImplementation(async (id: string) =>
      snapshot("120", id === first.id ? first : second),
    );
    render(<GlobalMetricsPage />);
    await screen.findByText("测试频道 A 的作品");
    mock.works.mockRejectedValue(new Error("temporary failure"));
    changed();
    await screen.findByRole("alert");
    expect(screen.getByText("测试频道 A 的作品")).toBeInTheDocument();
    const pending = deferred<GlobalWork[]>();
    mock.works.mockReturnValue(pending.promise);
    act(() => useUi.getState().selectGlobalAccount(second.id));
    expect(screen.queryByText("测试频道 A 的作品")).not.toBeInTheDocument();
    expect(screen.getByText("正在读取该账号的作品…")).toBeInTheDocument();
    await act(async () => pending.resolve([work(second)]));
    expect(screen.getByText("测试频道 B 的作品")).toBeInTheDocument();
  });

  it("rejects responses belonging to a different account", async () => {
    mock.observation.mockResolvedValue(snapshot("99999", second));
    mock.works.mockResolvedValue([work(second)]);
    render(<GlobalMetricsPage overview />);
    await screen.findByRole("alert");
    expect(screen.queryByText("99999")).not.toBeInTheDocument();
    expect(screen.queryByText("尚未采集")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: first.displayName }));
    // The explicit overview remains visible, so render the detail route separately.
    cleanup();
    render(<GlobalMetricsPage />);
    await screen.findByRole("alert");
    expect(screen.queryByText("测试频道 B 的作品")).not.toBeInTheDocument();
    expect(screen.getByText("作品读取失败，暂时无法确认记录，请重试读取。")).toBeInTheDocument();
  });

  it("hides works from a previous platform identity without waiting for a new request", async () => {
    render(<GlobalMetricsPage />);
    await screen.findByText("测试频道 A 的作品");
    act(() =>
      useGlobalAccounts.setState({
        identities: {
          [first.id]: {
            subjectId: "subject-b",
            status: "online",
            displayName: "新身份",
            checkedAt: "2026-10-21T00:00:00Z",
          },
        },
      }),
    );
    expect(screen.queryByText("测试频道 A 的作品")).not.toBeInTheDocument();
    expect(screen.getByText(/还没有当前账号身份的可用作品记录/)).toBeInTheDocument();
  });
});
