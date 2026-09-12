// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GlobalAccount } from "@shared/global-accounts";
import type { GlobalReadSnapshot } from "@shared/global-read";
import type { GlobalJob } from "@shared/global-jobs";
import { GlobalReadPanel } from "./GlobalReadPanel";

const mock = vi.hoisted(() => ({
  bridge: true,
  get: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  list: vi.fn(),
  onChanged: vi.fn(),
  off: vi.fn(),
}));
vi.mock("@renderer/lib/api", () => ({
  get hasBridge() {
    return mock.bridge;
  },
  api: {
    globalRead: { get: mock.get },
    globalJobs: { submit: mock.submit, cancel: mock.cancel, list: mock.list, onChanged: mock.onChanged },
  },
}));
const account: GlobalAccount = {
  id: "8e65b156-a2ee-48ac-957e-2f990141c207",
  platformId: "youtube",
  displayName: "海外频道",
  remoteId: "UC_synthetic",
  authStatus: "authorized",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const snapshot: GlobalReadSnapshot = {
  accountId: account.id,
  platformId: "youtube",
  remoteId: "UC_synthetic",
  fetchedAt: "2026-09-08T08:00:00.000Z",
  profile: { displayName: "平台合成名称", username: null },
  totals: { followers: "0", following: null, works: "20", views: "9007199254740993123", likes: null },
  works: [
    {
      id: "video_1",
      kind: "video",
      title: "合成作品",
      publishedAt: null,
      views: null,
      likes: "0",
      comments: null,
      reposts: null,
    },
  ],
  hasMoreWorks: true,
  capabilities: { readProfile: "ready", readMetrics: "scope_required", listWorks: "ready" },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup() {
  const onAccountChanged = vi.fn();
  const view = render(<GlobalReadPanel account={account} onAccountChanged={onAccountChanged} />);
  await waitFor(() => expect(screen.queryByText("正在读取本机快照…")).not.toBeInTheDocument());
  return { ...view, onAccountChanged };
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.bridge = true;
  mock.get.mockResolvedValue(null);
  mock.submit.mockResolvedValue(job);
  mock.list.mockResolvedValue([]);
  mock.onChanged.mockImplementation((handler) => {
    receive = handler;
    return mock.off;
  });
  mock.cancel.mockResolvedValue({
    ...job,
    state: "cancelled",
    errorCode: "GLOBAL_READ_CANCELLED",
    revision: 3,
    finishedAt: job.updatedAt,
  });
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

const job: GlobalJob = {
  id: "8e65b156-a2ee-48ac-957e-2f990141c208",
  accountId: account.id,
  platformId: account.platformId,
  kind: "read",
  state: "waiting-proxy",
  errorCode: "GLOBAL_READ_WAITING_PROXY",
  revision: 1,
  attempts: 0,
  createdAt: "2026-09-08T10:00:00.000Z",
  updatedAt: "2026-09-08T10:00:00.000Z",
  finishedAt: null,
};
let receive: (value: GlobalJob) => void;
async function event(patch: Partial<GlobalJob>) {
  await act(async () => receive({ ...job, ...patch }));
}
async function submit() {
  fireEvent.click(screen.getByRole("button", { name: "读取数据" }));
  await screen.findByText(/等待代理 · 任务/);
}

describe("persistent international read queue in the account card", () => {
  it("mounts local snapshots and history only, then immediately shows an explicit waiting task", async () => {
    await setup();
    expect(mock.get).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(mock.list).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(mock.submit).not.toHaveBeenCalled();
    expect(screen.getByText("本机上次读取：—")).toBeInTheDocument();
    await submit();
    expect(mock.submit).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(screen.getByRole("button", { name: "读取数据" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消读取" })).toBeEnabled();
    expect(screen.getByText(/离开页面或重启应用会保留任务/)).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it("reads the resulting local snapshot after completion with exact counts, nulls and scopes", async () => {
    await setup();
    await submit();
    mock.get.mockResolvedValue(snapshot);
    await event({ state: "running", errorCode: null, revision: 2, attempts: 1 });
    expect(screen.getByText(/正在通过官方 API 读取/)).toBeInTheDocument();
    await event({ state: "done", errorCode: null, revision: 3, attempts: 1, finishedAt: job.updatedAt });
    expect(await screen.findByText("平台合成名称")).toBeInTheDocument();
    expect(screen.getByText("9007199254740993123")).toBeInTheDocument();
    expect(screen.getByText("缺少授权范围")).toBeInTheDocument();
    expect(screen.getByText("用户名：—")).toBeInTheDocument();
    expect(document.querySelector("time")?.dateTime).toBe(snapshot.fetchedAt);
    expect(mock.submit).toHaveBeenCalledTimes(1);
  });
  it("shows cached partial capabilities without claiming a new request", async () => {
    mock.get.mockResolvedValue({
      ...snapshot,
      works: [],
      capabilities: { readProfile: "ready", readMetrics: "forbidden", listWorks: "rate_limited" },
    });
    await setup();
    expect(screen.getByText("权限或套餐不允许")).toBeInTheDocument();
    expect(screen.getByText("请求额度受限")).toBeInTheDocument();
    expect(screen.getByText("本次没有可用的作品数据。")).toBeInTheDocument();
    expect(mock.submit).not.toHaveBeenCalled();
  });
  it("renders at most the returned twenty works with no remote images or pagination calls", async () => {
    mock.get.mockResolvedValue({
      ...snapshot,
      works: Array.from({ length: 20 }, (_, n) => ({
        ...snapshot.works[0],
        id: `work_${n}`,
        title: `合成标题${n}`,
      })),
    });
    await setup();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(21);
    expect(document.querySelectorAll("img,a,iframe")).toHaveLength(0);
    expect(mock.submit).not.toHaveBeenCalled();
  });
  it("retains a waiting task across navigation and subscribes again without re-submitting it", async () => {
    const f = await setup();
    await submit();
    f.unmount();
    expect(mock.cancel).not.toHaveBeenCalled();
    expect(mock.off).toHaveBeenCalledOnce();
    mock.list.mockResolvedValue([job]);
    await setup();
    expect(await screen.findByText(/等待代理 · 任务/)).toBeInTheDocument();
    expect(mock.submit).toHaveBeenCalledTimes(1);
  });
  it("explicitly cancels by task UUID and ignores an older completion event", async () => {
    mock.get.mockResolvedValue(snapshot);
    await setup();
    await submit();
    fireEvent.click(screen.getByRole("button", { name: "取消读取" }));
    await screen.findByText("本次读取已取消。");
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith(job.id);
    const gets = mock.get.mock.calls.length;
    await event({ state: "done", revision: 2, errorCode: null, finishedAt: job.updatedAt });
    expect(mock.get).toHaveBeenCalledTimes(gets);
    expect(screen.getByText("平台合成名称")).toBeInTheDocument();
    expect(screen.getByText("本次读取已取消。")).toBeInTheDocument();
  });
  it("keeps the cancellation transaction disabled until its reply arrives", async () => {
    const pending = deferred<GlobalJob>();
    mock.cancel.mockReturnValue(pending.promise);
    await setup();
    await submit();
    fireEvent.click(screen.getByRole("button", { name: "取消读取" }));
    expect(screen.getByText("正在取消读取…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消读取" })).toBeDisabled();
    await act(async () =>
      pending.resolve({
        ...job,
        state: "cancelled",
        revision: 3,
        errorCode: "GLOBAL_READ_CANCELLED",
        finishedAt: job.updatedAt,
      }),
    );
    expect(screen.getByText("本次读取已取消。")).toBeInTheDocument();
  });
  it("does not let delayed local history regress a newer event", async () => {
    const initial = deferred<GlobalJob[]>();
    mock.list.mockReturnValue(initial.promise);
    await setup();
    await event({ state: "running", revision: 2, errorCode: null, attempts: 1 });
    await act(async () => initial.resolve([job]));
    expect(screen.getByText(/正在通过官方 API 读取/)).toBeInTheDocument();
    expect(screen.queryByText(/等待代理 · 任务/)).not.toBeInTheDocument();
  });
  it("does not let a slow initial local snapshot overwrite the completed task snapshot", async () => {
    const old = deferred<GlobalReadSnapshot | null>();
    mock.get.mockReturnValueOnce(old.promise).mockResolvedValue(snapshot);
    render(<GlobalReadPanel account={account} />);
    await submit();
    await event({ state: "done", revision: 3, errorCode: null, finishedAt: job.updatedAt });
    await screen.findByText("平台合成名称");
    await act(async () =>
      old.resolve({ ...snapshot, profile: { ...snapshot.profile, displayName: "旧本地名称" } }),
    );
    expect(screen.queryByText("旧本地名称")).not.toBeInTheDocument();
  });
  it.each(["auth", "remote", "revision"])(
    "ignores a late submit response after account %s changes without navigation cancelling intent",
    async (kind) => {
      const late = deferred<GlobalJob>();
      mock.submit.mockReturnValue(late.promise);
      const f = await setup();
      fireEvent.click(screen.getByRole("button", { name: "读取数据" }));
      const changed =
        kind === "auth"
          ? { ...account, authStatus: "unauthorized" as const, remoteId: null }
          : kind === "remote"
            ? { ...account, remoteId: "different" }
            : { ...account, updatedAt: "2026-09-08T01:00:00.000Z" };
      f.rerender(<GlobalReadPanel account={changed} />);
      await act(async () => late.resolve(job));
      expect(mock.cancel).not.toHaveBeenCalled();
      expect(screen.queryByText(/等待代理 · 任务/)).not.toBeInTheDocument();
    },
  );
  it("does not cancel an accepted task when unmounting before its submission reply", async () => {
    const late = deferred<GlobalJob>();
    mock.submit.mockReturnValue(late.promise);
    const f = await setup();
    fireEvent.click(screen.getByRole("button", { name: "读取数据" }));
    f.unmount();
    await act(async () => late.resolve(job));
    expect(mock.cancel).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("等待代理");
  });
  it.each([
    ["GLOBAL_READ_WAITING_PROXY", "等待有效代理"],
    ["GLOBAL_READ_RATE_LIMITED", "平台请求额度受限"],
    ["GLOBAL_READ_FORBIDDEN", "平台拒绝读取"],
    ["private-secret Bearer token https://private.invalid/?code=x", "读取暂不可用"],
  ])("projects safe submission failure %s", async (message, text) => {
    mock.submit.mockRejectedValue(new Error(message));
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "读取数据" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(document.body.textContent).not.toMatch(/private-secret|Bearer|private\.invalid/);
  });
  it("clears stale data and updates the account projection for a real job reauthorization failure", async () => {
    mock.get.mockResolvedValue(snapshot);
    const f = await setup();
    await submit();
    await event({
      state: "failed",
      errorCode: "GLOBAL_READ_REAUTHORIZE",
      revision: 3,
      finishedAt: job.updatedAt,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("授权需要更新");
    expect(screen.queryByText("平台合成名称")).not.toBeInTheDocument();
    expect(f.onAccountChanged).toHaveBeenCalledOnce();
  });
  it.each(["identity", "secret", "work-limit"])("rejects invalid %s snapshot fields", async (kind) => {
    mock.get.mockResolvedValue(
      kind === "identity"
        ? { ...snapshot, remoteId: "different" }
        : kind === "secret"
          ? { ...snapshot, accessToken: "private-secret" }
          : { ...snapshot, works: Array.from({ length: 21 }, () => snapshot.works[0]) },
    );
    await setup();
    await screen.findByRole("alert");
    expect(screen.queryByText("平台合成名称")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("private-secret");
  });
  it("ignores other accounts' events and rejects malformed local job data", async () => {
    await setup();
    await event({ accountId: job.id });
    expect(screen.queryByText(/等待代理 · 任务/)).not.toBeInTheDocument();
    await act(async () => receive({ ...job, accessToken: "private-secret" } as GlobalJob));
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain("private-secret");
  });
  it("does not read snapshots or queue jobs for an unauthorized account", () => {
    render(<GlobalReadPanel account={{ ...account, authStatus: "unauthorized", remoteId: null }} />);
    expect(screen.getByRole("button", { name: "读取数据" })).toBeDisabled();
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.list).not.toHaveBeenCalled();
    expect(mock.submit).not.toHaveBeenCalled();
  });
  it("keeps preview disabled without fabricating platform data", () => {
    mock.bridge = false;
    render(<GlobalReadPanel account={account} />);
    expect(screen.getByRole("button", { name: "读取数据" })).toBeDisabled();
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.submit).not.toHaveBeenCalled();
    expect(screen.getByText("浏览器预览不读取平台数据。")).toBeInTheDocument();
  });
});
