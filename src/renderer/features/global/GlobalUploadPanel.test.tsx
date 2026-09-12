// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalAccount } from "@shared/global-accounts";
import type { GlobalUploadJob } from "@shared/global-uploads";
import { GlobalUploadPanel } from "./GlobalUploadPanel";
const mock = vi.hoisted(() => ({
  list: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  check: vi.fn(),
  onChanged: vi.fn(),
  assets: vi.fn(),
  importFiles: vi.fn(),
}));
vi.mock("@renderer/lib/api", () => ({
  hasBridge: true,
  api: {
    globalUploads: {
      list: mock.list,
      submit: mock.submit,
      cancel: mock.cancel,
      check: mock.check,
      onChanged: mock.onChanged,
    },
    assets: { list: mock.assets, import: mock.importFiles },
  },
}));
const account: GlobalAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  platformId: "tiktok",
  displayName: "测试 TikTok",
  authStatus: "authorized",
  remoteId: "synthetic-user",
  createdAt: "2026-09-08T10:00:00Z",
  updatedAt: "2026-09-08T10:00:00Z",
};
const asset = {
  id: "33333333-3333-4333-8333-333333333333",
  kind: "video",
  fileName: "chosen.mp4",
  mimeType: "video/mp4",
  sizeBytes: 100,
};
const job: GlobalUploadJob = {
  id: "22222222-2222-4222-8222-222222222222",
  accountId: account.id,
  assetId: asset.id,
  platformId: "tiktok",
  fileName: asset.fileName,
  state: "waiting-proxy",
  sentBytes: 0,
  totalBytes: 100,
  revision: 1,
  errorCode: "GLOBAL_UPLOAD_WAITING_PROXY",
  createdAt: "2026-09-08T10:00:00Z",
  updatedAt: "2026-09-08T10:00:00Z",
};
let event: (raw: unknown) => void, off: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  off = vi.fn();
  mock.onChanged.mockImplementation((handler) => {
    event = handler;
    return off;
  });
  mock.list.mockResolvedValue([]);
  mock.assets.mockResolvedValue([asset]);
  mock.submit.mockResolvedValue(job);
  mock.cancel.mockResolvedValue({
    ...job,
    revision: 2,
    state: "cancelled",
    errorCode: "GLOBAL_UPLOAD_CANCELLED",
  });
  mock.check.mockResolvedValue({ ...job, revision: 3 });
});
afterEach(cleanup);
describe("TikTok draft task UI", () => {
  it("mounts local data only and requires a chosen video before an explicit submit", async () => {
    render(<GlobalUploadPanel account={account} />);
    await screen.findByRole("option", { name: asset.fileName });
    const submit = screen.getByRole("button", { name: "上传到 TikTok 收件箱" });
    expect(submit).toBeDisabled();
    expect(mock.submit).not.toHaveBeenCalled();
    expect(mock.check).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("待上传视频"), { target: { value: asset.id } });
    fireEvent.click(submit);
    await screen.findByText(`任务 ${job.id}`);
    expect(mock.submit).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, assetId: asset.id });
    expect(screen.getByRole("status")).toHaveTextContent("等待有效代理");
  });
  it("an unauthorized account cannot submit a draft", async () => {
    render(<GlobalUploadPanel account={{ ...account, authStatus: "unauthorized", remoteId: null }} />);
    await screen.findByRole("option", { name: asset.fileName });
    fireEvent.change(screen.getByLabelText("待上传视频"), { target: { value: asset.id } });
    expect(screen.getByRole("button", { name: "上传到 TikTok 收件箱" })).toBeDisabled();
  });
  it("does not label a fully transferred file as published before an official result", async () => {
    mock.list.mockResolvedValue([{ ...job, state: "processing", sentBytes: 100, errorCode: null }]);
    render(<GlobalUploadPanel account={account} />);
    await screen.findByText("视频已传完，等待 TikTok 处理");
    expect(screen.queryByText("TikTok 确认你已完成发布")).not.toBeInTheDocument();
    expect(mock.check).not.toHaveBeenCalled();
    act(() => event({ ...job, revision: 2, state: "inbox", sentBytes: 100, errorCode: null }));
    await screen.findByText("已送达 TikTok 收件箱，待你编辑和发布");
    expect(screen.queryByText("TikTok 确认你已完成发布")).not.toBeInTheDocument();
  });
  it("cancels by task ID and ignores a delayed lower-revision running event", async () => {
    mock.list.mockResolvedValue([job]);
    render(<GlobalUploadPanel account={account} />);
    fireEvent.click(await screen.findByRole("button", { name: "取消上传任务" }));
    await screen.findByText("已停止本机上传");
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith(job.id);
    act(() => event({ ...job, state: "uploading", errorCode: null }));
    expect(screen.getByRole("status")).toHaveTextContent("已停止本机上传");
  });
  it("queries an uncertain result only after a user click", async () => {
    mock.list.mockResolvedValue([
      { ...job, state: "uncertain", errorCode: "GLOBAL_UPLOAD_UNCERTAIN", revision: 2 },
    ]);
    render(<GlobalUploadPanel account={account} />);
    const check = await screen.findByRole("button", { name: "查询 TikTok 结果" });
    expect(mock.check).not.toHaveBeenCalled();
    fireEvent.click(check);
    await waitFor(() => expect(mock.check).toHaveBeenCalledExactlyOnceWith(job.id));
    expect(mock.submit).not.toHaveBeenCalled();
  });
  it("page exit unsubscribes but does not cancel a persisted upload", async () => {
    const view = render(<GlobalUploadPanel account={account} />);
    await screen.findByRole("option", { name: asset.fileName });
    view.unmount();
    expect(off).toHaveBeenCalledOnce();
    expect(mock.cancel).not.toHaveBeenCalled();
    act(() => event(job));
  });
  it("an initial stale list cannot replace a newer progress event", async () => {
    let resolve!: (value: GlobalUploadJob[]) => void;
    mock.list.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<GlobalUploadPanel account={account} />);
    act(() => event({ ...job, state: "inbox", sentBytes: 100, revision: 3, errorCode: null }));
    await act(async () => {
      resolve([{ ...job, state: "uploading", revision: 2 }]);
    });
    expect(screen.getByRole("status")).toHaveTextContent("已送达 TikTok 收件箱");
  });
  it("shows only fixed user-facing failures, without the returned signed URL", async () => {
    mock.submit.mockRejectedValue(new Error("upload_token=private-signed-url"));
    render(<GlobalUploadPanel account={account} />);
    await screen.findByRole("option", { name: asset.fileName });
    fireEvent.change(screen.getByLabelText("待上传视频"), { target: { value: asset.id } });
    fireEvent.click(screen.getByRole("button", { name: "上传到 TikTok 收件箱" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("上传服务暂不可用");
    expect(document.body.textContent).not.toContain("private-signed-url");
  });
  it("does not render TikTok upload actions for other platforms", () => {
    render(<GlobalUploadPanel account={{ ...account, platformId: "x" }} />);
    expect(mock.list).not.toHaveBeenCalled();
    expect(screen.queryByText("TikTok 草稿上传")).not.toBeInTheDocument();
  });
});
describe("YouTube upload consent and receipt UI", () => {
  const youtubeAccount = { ...account, platformId: "youtube" as const, displayName: "测试 YouTube" };
  const metadata = {
    title: "测试视频",
    description: "",
    categoryId: "22",
    privacy: "private" as const,
    madeForKids: false,
    containsSyntheticMedia: true,
    notifySubscribers: false,
  };
  const youtubeJob: GlobalUploadJob = { ...job, platformId: "youtube", youtube: metadata };
  async function fill() {
    await screen.findByRole("option", { name: asset.fileName });
    fireEvent.change(screen.getByLabelText("待上传视频"), { target: { value: asset.id } });
    fireEvent.change(screen.getByLabelText("视频标题"), { target: { value: "测试视频" } });
    fireEvent.change(screen.getByLabelText("是否专为儿童制作"), { target: { value: "no" } });
    fireEvent.change(screen.getByLabelText("是否包含需披露的逼真合成或修改内容"), {
      target: { value: "yes" },
    });
  }
  it("defaults private, requires both declarations and submits explicit intent only on click", async () => {
    mock.submit.mockResolvedValue(youtubeJob);
    render(<GlobalUploadPanel account={youtubeAccount} />);
    await screen.findByRole("option", { name: asset.fileName });
    expect(screen.getByLabelText("可见性")).toHaveValue("private");
    expect(screen.getByLabelText("是否专为儿童制作")).toHaveValue("");
    expect(screen.getByLabelText("是否包含需披露的逼真合成或修改内容")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("待上传视频"), { target: { value: asset.id } });
    fireEvent.change(screen.getByLabelText("视频标题"), { target: { value: "测试视频" } });
    expect(screen.getByRole("button", { name: "上传到 YouTube" })).toBeDisabled();
    expect(mock.submit).not.toHaveBeenCalled();
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "上传到 YouTube" }));
    await screen.findByText(`任务 ${job.id}`);
    expect(mock.submit).toHaveBeenCalledExactlyOnceWith({
      accountId: account.id,
      assetId: asset.id,
      youtube: metadata,
    });
  });
  it("names the public action explicitly and preserves that selection", async () => {
    mock.submit.mockResolvedValue({ ...youtubeJob, youtube: { ...metadata, privacy: "public" } });
    render(<GlobalUploadPanel account={youtubeAccount} />);
    await fill();
    fireEvent.change(screen.getByLabelText("可见性"), { target: { value: "public" } });
    fireEvent.click(screen.getByRole("button", { name: "上传并请求公开到 YouTube" }));
    await waitFor(() =>
      expect(mock.submit).toHaveBeenCalledExactlyOnceWith({
        accountId: account.id,
        assetId: asset.id,
        youtube: { ...metadata, privacy: "public" },
      }),
    );
  });
  it("shows the actual private receipt and does not call a requested public upload published", async () => {
    mock.list.mockResolvedValue([
      {
        ...youtubeJob,
        youtube: { ...metadata, privacy: "public" },
        state: "ready",
        sentBytes: 100,
        errorCode: null,
        receipt: { videoId: "abcdefghijk", privacy: "private", state: "ready" },
      },
    ]);
    render(<GlobalUploadPanel account={youtubeAccount} />);
    expect(await screen.findByRole("status")).toHaveTextContent("YouTube 已处理完成");
    expect(screen.getByText(/YouTube 实际可见性：私密/)).toBeInTheDocument();
    expect(screen.queryByText("YouTube 确认已公开")).not.toBeInTheDocument();
    expect(mock.check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查询 YouTube 结果" }));
    await waitFor(() => expect(mock.check).toHaveBeenCalledExactlyOnceWith(job.id));
    expect(mock.submit).not.toHaveBeenCalled();
  });
  it("does not expose another platform's job even when the account ID matches", async () => {
    mock.list.mockResolvedValue([job]);
    render(<GlobalUploadPanel account={youtubeAccount} />);
    await fill();
    act(() => event(job));
    expect(screen.queryByText(`任务 ${job.id}`)).not.toBeInTheDocument();
  });
  it("does not enable unauthorized upload after metadata is filled", async () => {
    render(<GlobalUploadPanel account={{ ...youtubeAccount, authStatus: "unauthorized", remoteId: null }} />);
    await fill();
    expect(screen.getByRole("button", { name: "上传到 YouTube" })).toBeDisabled();
    expect(mock.submit).not.toHaveBeenCalled();
  });
  it("refuses excessive UTF-8 descriptions before sending upload intent", async () => {
    render(<GlobalUploadPanel account={youtubeAccount} />);
    await fill();
    fireEvent.change(screen.getByLabelText("视频描述"), { target: { value: "字".repeat(1700) } });
    expect(screen.getByRole("button", { name: "上传到 YouTube" })).toBeDisabled();
    expect(mock.submit).not.toHaveBeenCalled();
  });
});
