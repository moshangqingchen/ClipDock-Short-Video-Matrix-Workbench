// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { unconfiguredGlobalApp, type GlobalAppMetadata } from "@shared/global-apps";
import { GLOBAL_PLATFORM_IDS, type GlobalPlatformId } from "@shared/platforms";
import { GlobalAppsPanel } from "./GlobalAppsPanel";

const mock = vi.hoisted(() => ({ bridge: true, list: vi.fn(), configure: vi.fn(), clearSecret: vi.fn() }));
vi.mock("@renderer/lib/api", () => ({
  get hasBridge() {
    return mock.bridge;
  },
  api: { globalApps: { list: mock.list, configure: mock.configure, clearSecret: mock.clearSecret } },
}));
function saved(platformId: GlobalPlatformId, hasSecret = false, available = hasSecret): GlobalAppMetadata {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    platformId,
    configured: true,
    clientId: `${platformId}-saved-client`,
    redirectPort: platformId === "youtube" ? 0 : 4567,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    clientSecret:
      platformId === "x"
        ? null
        : {
            kind: "oauth_client_secret",
            ownerId: "11111111-1111-4111-8111-111111111111",
            hasCredential: hasSecret,
            available,
            encryptionAvailable: true,
            state: available ? "available" : hasSecret ? "decryption_failed" : "missing",
            createdAt: null,
            updatedAt: null,
          },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function edit(platform: "YouTube" | "TikTok" | "X") {
  const button = await screen.findByRole("button", { name: `配置 ${platform} 应用` });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
function fill(platform: string, id: string, port: string, secret?: string) {
  fireEvent.change(screen.getByLabelText(`${platform} Client ID`), { target: { value: id } });
  fireEvent.change(screen.getByLabelText(`${platform} 回调端口`), { target: { value: port } });
  if (secret !== undefined)
    fireEvent.change(screen.getByLabelText(`${platform} Client Secret`), { target: { value: secret } });
}

describe("GlobalAppsPanel main-process configuration boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.bridge = true;
    mock.list.mockResolvedValue(GLOBAL_PLATFORM_IDS.map(unconfiguredGlobalApp));
    mock.configure.mockImplementation(async (input) => ({
      ...saved(input.platformId, Boolean(input.clientSecret)),
      clientId: input.clientId,
      redirectPort: input.redirectPort,
    }));
    mock.clearSecret.mockImplementation(async (platformId) => saved(platformId));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows unconfigured entries without invented client IDs, passwords or API readiness", async () => {
    render(<GlobalAppsPanel />);
    await edit("YouTube");
    expect(screen.getByLabelText("YouTube Client ID")).toHaveValue("");
    expect(screen.getByLabelText("YouTube 回调端口")).toHaveValue(null);
    expect(screen.getByLabelText("YouTube Client Secret")).toHaveValue("");
    expect(screen.getByLabelText("YouTube Client Secret")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("YouTube Client Secret")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByText(/没有开发者应用时可以保持未配置/)).toBeInTheDocument();
    expect(mock.configure).not.toHaveBeenCalled();
  });

  it("saves Google desktop configuration with dynamic port zero and no optional secret", async () => {
    const changed = vi.fn();
    render(<GlobalAppsPanel onChanged={changed} />);
    await edit("YouTube");
    fill("YouTube", "actual-google-client", "0");
    expect(screen.getByText("http://127.0.0.1:<动态端口>/oauth/callback")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存本机配置" }));
    await screen.findByRole("status");
    expect(mock.configure).toHaveBeenCalledWith({
      platformId: "youtube",
      clientId: "actual-google-client",
      redirectPort: 0,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("可在账号卡中按需发起官方授权");
  });

  it("clears the temporary password as soon as configure begins, and never persists a renderer draft", async () => {
    const pending = deferred<GlobalAppMetadata>();
    mock.configure.mockReturnValue(pending.promise);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const log = vi.spyOn(console, "log");
    render(<GlobalAppsPanel />);
    await edit("TikTok");
    fill("TikTok", "real-tiktok-client", "4567", "synthetic-sensitive-password");
    const input = screen.getByLabelText("TikTok Client Secret");
    expect(screen.getByText("http://127.0.0.1:4567/oauth/callback")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存本机配置" }));
    expect(input).toHaveValue("");
    expect(mock.configure).toHaveBeenCalledWith({
      platformId: "tiktok",
      clientId: "real-tiktok-client",
      redirectPort: 4567,
      clientSecret: "synthetic-sensitive-password",
    });
    expect(storage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    pending.resolve(saved("tiktok", true));
    await screen.findByRole("status");
    await edit("TikTok");
    expect(screen.getByLabelText("TikTok Client Secret")).toHaveValue("");
    expect(document.body.textContent).not.toContain("synthetic-sensitive-password");
  });

  it("clears even a detached password input on close and unmount", async () => {
    const mounted = render(<GlobalAppsPanel />);
    await edit("TikTok");
    const closed = screen.getByLabelText("TikTok Client Secret") as HTMLInputElement;
    fireEvent.change(closed, { target: { value: "close-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(closed.value).toBe("");
    await edit("TikTok");
    const removed = screen.getByLabelText("TikTok Client Secret") as HTMLInputElement;
    fireEvent.change(removed, { target: { value: "unmount-secret" } });
    mounted.unmount();
    expect(removed.value).toBe("");
    expect(mock.configure).not.toHaveBeenCalled();
  });

  it("does not disclose failed save details and does not restore the password", async () => {
    mock.configure.mockRejectedValue(new Error("client_secret=server-private-value"));
    render(<GlobalAppsPanel />);
    await edit("TikTok");
    fill("TikTok", "real-tiktok-client", "4567", "input-secret");
    fireEvent.click(screen.getByRole("button", { name: "保存本机配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByLabelText("TikTok Client Secret")).toHaveValue("");
    expect(document.body.textContent).not.toMatch(/server-private-value|input-secret/);
  });

  it("requires a usable TikTok secret and a fixed unprivileged callback port", async () => {
    render(<GlobalAppsPanel />);
    await edit("TikTok");
    fill("TikTok", "real-client", "0", "secret");
    fireEvent.click(screen.getByRole("button", { name: "保存本机配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1024–65535");
    fill("TikTok", "real-client", "4567");
    fireEvent.click(screen.getByRole("button", { name: "保存本机配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("需要该应用的 Client Secret");
    expect(mock.configure).not.toHaveBeenCalled();
  });

  it("preserves an available TikTok secret only for the same client", async () => {
    mock.list.mockResolvedValue([saved("tiktok", true)]);
    render(<GlobalAppsPanel />);
    await edit("TikTok");
    expect(screen.getByLabelText("TikTok Client Secret")).toHaveAttribute("placeholder", "已保存；留空保留");
    fireEvent.click(screen.getByRole("button", { name: "保存本机配置" }));
    await screen.findByRole("status");
    expect(mock.configure).toHaveBeenCalledWith({
      platformId: "tiktok",
      clientId: "tiktok-saved-client",
      redirectPort: 4567,
    });
  });

  it("does not silently reuse the previous app secret after Client Key changes", async () => {
    mock.list.mockResolvedValue([saved("tiktok", true)]);
    render(<GlobalAppsPanel />);
    await edit("TikTok");
    fill("TikTok", "different-client", "4567");
    expect(screen.getByText(/更换 Client ID.*会清除旧应用密钥/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存本机配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("需要该应用的 Client Secret");
    expect(mock.configure).not.toHaveBeenCalled();
  });

  it("keeps missing/decryption-failed TikTok credentials distinct from complete public settings", async () => {
    mock.list.mockResolvedValue([saved("tiktok", true, false)]);
    render(<GlobalAppsPanel />);
    await screen.findByText("密钥需重填");
    expect(screen.getByText("密钥不可用，请重新填写")).toBeInTheDocument();
    await edit("TikTok");
    fireEvent.click(screen.getByRole("button", { name: "保存本机配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("需要该应用的 Client Secret");
    expect(mock.configure).not.toHaveBeenCalled();
  });

  it("does not collect a client secret for an X public application", async () => {
    render(<GlobalAppsPanel />);
    await edit("X");
    expect(screen.queryByLabelText("X Client Secret")).not.toBeInTheDocument();
    fill("X", "real-x-client", "4568");
    fireEvent.click(screen.getByRole("button", { name: "保存本机配置" }));
    await screen.findByRole("status");
    expect(mock.configure).toHaveBeenCalledWith({
      platformId: "x",
      clientId: "real-x-client",
      redirectPort: 4568,
    });
  });

  it("clears a stored secret separately only after explaining account reauthorization", async () => {
    mock.list.mockResolvedValue([saved("tiktok", true)]);
    const changed = vi.fn();
    render(<GlobalAppsPanel onChanged={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: "清除 TikTok 应用密钥" }));
    expect(screen.getByText(/使该平台已有账号需要重新授权/)).toBeInTheDocument();
    expect(mock.clearSecret).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认清除密钥" }));
    await screen.findByRole("status");
    expect(mock.clearSecret).toHaveBeenCalledWith("tiktok");
    expect(screen.getByText("缺少应用密钥")).toBeInTheDocument();
    expect(screen.getByText("tiktok-saved-client")).toBeInTheDocument();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("does not pretend a rejected clear succeeded or echo its underlying error", async () => {
    mock.list.mockResolvedValue([saved("youtube", true)]);
    mock.clearSecret.mockRejectedValue(new Error("stored-token-private"));
    render(<GlobalAppsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "清除 YouTube 应用密钥" }));
    fireEvent.click(screen.getByRole("button", { name: "确认清除密钥" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("清除失败");
    expect(screen.getByText("密钥已保存")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("stored-token-private");
  });

  it("keeps forms unavailable until metadata is read and allows retry after failure", async () => {
    mock.list.mockRejectedValueOnce(new Error("private endpoint details"));
    render(<GlobalAppsPanel />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "配置 YouTube 应用" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("private endpoint details");
    fireEvent.click(screen.getByRole("button", { name: "重试读取配置" }));
    await edit("YouTube");
  });

  it("does not accept or persist secrets in browser preview", () => {
    mock.bridge = false;
    render(<GlobalAppsPanel />);
    expect(screen.getByText(/浏览器预览不接收或保存应用密钥/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配置 YouTube 应用" })).toBeDisabled();
    expect(mock.list).not.toHaveBeenCalled();
  });
});
