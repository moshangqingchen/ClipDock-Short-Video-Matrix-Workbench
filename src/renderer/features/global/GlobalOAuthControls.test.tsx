// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GlobalAccount } from "@shared/global-accounts";
import type { GlobalOAuthState } from "@shared/global-oauth";
import { GlobalOAuthControls } from "./GlobalOAuthControls";

const mock = vi.hoisted(() => ({
  bridge: true,
  state: vi.fn(),
  start: vi.fn(),
  startDraft: vi.fn(),
  startUpload: vi.fn(),
  cancel: vi.fn(),
  onState: vi.fn(),
  off: vi.fn(),
  listeners: new Set<(value: GlobalOAuthState) => void>(),
}));
vi.mock("@renderer/lib/api", () => ({
  get hasBridge() {
    return mock.bridge;
  },
  api: {
    globalOAuth: {
      state: mock.state,
      start: mock.start,
      startDraft: mock.startDraft,
      startUpload: mock.startUpload,
      cancel: mock.cancel,
      onState: mock.onState,
    },
  },
}));
const account: GlobalAccount = {
  id: "8e65b156-a2ee-48ac-957e-2f990141c207",
  platformId: "youtube",
  displayName: "海外频道",
  remoteId: null,
  authStatus: "unauthorized",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const tx = "7036177a-2411-427a-a9b2-bbe2c51e3e4f";
const tx2 = "da1838c8-ee59-44eb-b5b0-7a7a726e6518";
const state = (
  phase: GlobalOAuthState["phase"],
  transactionId: string | null = phase === "idle" || phase === "starting" ? null : tx,
): GlobalOAuthState => ({
  accountId: account.id,
  platformId: "youtube",
  transactionId,
  phase,
  errorCode: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function emit(value: unknown) {
  act(() => {
    for (const listener of mock.listeners) listener(value as GlobalOAuthState);
  });
}
async function setup() {
  const onAuthorized = vi.fn();
  const rendered = render(<GlobalOAuthControls account={account} onAuthorized={onAuthorized} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "官方授权" })).toBeEnabled());
  return { ...rendered, onAuthorized };
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.bridge = true;
  mock.listeners.clear();
  mock.state.mockResolvedValue(state("idle"));
  mock.start.mockResolvedValue(state("awaiting_user"));
  mock.cancel.mockResolvedValue({ ...state("cancelled"), errorCode: "GLOBAL_OAUTH_CANCELLED" });
  mock.onState.mockImplementation((listener) => {
    mock.listeners.add(listener);
    return () => {
      mock.off();
      mock.listeners.delete(listener);
    };
  });
});
afterEach(cleanup);
describe("explicit, memory-only OAuth controls", () => {
  it("uses the separate YouTube upload authorization only after its button is pressed", async () => {
    mock.startUpload.mockResolvedValue(state("awaiting_user"));
    await setup();
    expect(mock.startUpload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "授权视频上传" }));
    await screen.findByText("请在系统浏览器完成官方授权。");
    expect(mock.startUpload).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(mock.start).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "授权视频上传" })).toBeDisabled();
  });
  it("requests draft scope only from the explicit TikTok button and disables concurrent consent", async () => {
    mock.state.mockResolvedValue({ ...state("idle"), platformId: "tiktok" });
    mock.startDraft.mockResolvedValue({ ...state("awaiting_user"), platformId: "tiktok" });
    render(<GlobalOAuthControls account={{ ...account, platformId: "tiktok" }} onAuthorized={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "授权草稿上传" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(mock.startDraft).not.toHaveBeenCalled();
    fireEvent.click(button);
    await screen.findByText("请在系统浏览器完成官方授权。");
    expect(mock.startDraft).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(mock.start).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "官方授权" })).toBeDisabled();
  });
  it("reads state without starting authorization; only the user's button sends the account UUID", async () => {
    await setup();
    expect(mock.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    await screen.findByText("请在系统浏览器完成官方授权。");
    expect(mock.start).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(screen.getByRole("button", { name: "官方授权" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消授权" })).toBeEnabled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it("shows only fixed reasons when the main process refuses configuration or proxy eligibility", async () => {
    mock.start.mockRejectedValue(new Error("GLOBAL_OAUTH_NOT_CONFIGURED"));
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请先配置该平台的开发者应用");
    mock.start.mockRejectedValue(new Error("Bearer private-secret https://private.example/?code=x"));
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("授权服务暂不可用"));
    expect(document.body.textContent).not.toMatch(/private-secret|private\.example|Bearer/);
  });
  it("allows cancellation while start handoff is still pending and ignores its late authorized response", async () => {
    const pending = deferred<GlobalOAuthState>();
    mock.start.mockReturnValue(pending.promise);
    const f = await setup();
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    emit(state("awaiting_user"));
    fireEvent.click(screen.getByRole("button", { name: "取消授权" }));
    await screen.findByText("授权已取消。");
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith(account.id);
    await act(async () => {
      pending.resolve(state("authorized"));
    });
    mock.state.mockResolvedValue(state("authorized"));
    emit(state("authorized"));
    await act(async () => undefined);
    expect(screen.getByText("授权已取消。")).toBeInTheDocument();
    expect(f.onAuthorized).not.toHaveBeenCalled();
  });
  it("does not regress a live exchanging event when the start reply arrives with older awaiting state", async () => {
    const pending = deferred<GlobalOAuthState>();
    mock.start.mockReturnValue(pending.promise);
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    emit(state("exchanging"));
    await act(async () => {
      pending.resolve(state("awaiting_user"));
    });
    expect(screen.getByText("正在核对并保存官方授权…")).toBeInTheDocument();
  });
  it("does not let an old initial state query overwrite a current event", async () => {
    const pending = deferred<GlobalOAuthState>();
    mock.state.mockReturnValue(pending.promise);
    render(<GlobalOAuthControls account={account} onAuthorized={vi.fn()} />);
    emit(state("exchanging"));
    await act(async () => {
      pending.resolve(state("idle"));
    });
    expect(screen.getByText("正在核对并保存官方授权…")).toBeInTheDocument();
  });
  it("ignores an obsolete transaction after a new explicit start", async () => {
    const f = await setup();
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    await screen.findByText("请在系统浏览器完成官方授权。");
    fireEvent.click(screen.getByRole("button", { name: "取消授权" }));
    await screen.findByText("授权已取消。");
    mock.start.mockResolvedValue(state("awaiting_user", tx2));
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    await screen.findByText("请在系统浏览器完成官方授权。");
    mock.state.mockResolvedValue(state("authorized"));
    emit(state("authorized"));
    await act(async () => undefined);
    expect(f.onAuthorized).not.toHaveBeenCalled();
    expect(screen.getByText("请在系统浏览器完成官方授权。")).toBeInTheDocument();
  });
  it("confirms an authorized event with current main state and refreshes only once without rendering payload secrets", async () => {
    const f = await setup();
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    await screen.findByText("请在系统浏览器完成官方授权。");
    const result = {
      ...state("authorized"),
      token: "private-token",
      code: "private-code",
      authorizationUrl: "https://private.example/",
    };
    mock.state.mockResolvedValue(result);
    emit(result);
    await screen.findByText("官方授权已完成。");
    emit(result);
    await act(async () => undefined);
    expect(f.onAuthorized).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toMatch(/private-|https:/);
    emit({ ...state("failed"), errorCode: "private-token" });
    expect(document.body.textContent).not.toContain("private-token");
  });
  it("does not resurrect cleared authorization from a queued event on a newly mounted account revision", async () => {
    const f = await setup();
    const oldListener = [...mock.listeners][0];
    f.rerender(
      <GlobalOAuthControls
        account={{ ...account, updatedAt: "2026-09-08T00:01:00.000Z" }}
        onAuthorized={f.onAuthorized}
      />,
    );
    await waitFor(() => expect(mock.state).toHaveBeenCalledTimes(2));
    act(() => oldListener(state("authorized")));
    emit(state("authorized")); // Current main still reports idle after local clear.
    await act(async () => undefined);
    expect(f.onAuthorized).not.toHaveBeenCalled();
    expect(screen.queryByText("官方授权已完成。")).not.toBeInTheDocument();
  });
  it("unsubscribes and ignores late callbacks and start completion after unmount", async () => {
    const pending = deferred<GlobalOAuthState>();
    mock.start.mockReturnValue(pending.promise);
    const f = await setup();
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    const oldListener = [...mock.listeners][0];
    f.unmount();
    act(() => oldListener(state("authorized")));
    await act(async () => {
      pending.resolve(state("authorized"));
    });
    expect(mock.off).toHaveBeenCalledTimes(1);
    expect(f.onAuthorized).not.toHaveBeenCalled();
  });
  it("keeps preview authorization unavailable without starting a listener or pretending success", () => {
    mock.bridge = false;
    render(<GlobalOAuthControls account={account} onAuthorized={vi.fn()} />);
    expect(screen.getByRole("button", { name: "官方授权" })).toBeDisabled();
    expect(screen.getByText("浏览器预览不能发起真实授权。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "官方授权" }));
    expect(mock.state).not.toHaveBeenCalled();
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.onState).not.toHaveBeenCalled();
  });
});
