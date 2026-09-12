// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  checkingNetworkSnapshot,
  DEFAULT_NETWORK_SETTINGS,
  type ExclusiveAccessSnapshot,
  type NetworkSnapshot,
} from "@shared/network";
import type { CredentialMetadata, CredentialRef } from "@shared/credentials";

const transport = vi.hoisted(() => ({
  settings: vi.fn(),
  configure: vi.fn(),
  directRules: vi.fn(),
  meta: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@renderer/lib/api", () => ({
  api: {
    network: {
      settings: transport.settings,
      configure: transport.configure,
      directRules: transport.directRules,
    },
    credentials: { meta: transport.meta, set: transport.set, delete: transport.delete },
  },
}));

import { useNetwork } from "@renderer/store/network";
import { NetworkPanel } from "./NetworkPanel";
import { NetworkStatus } from "./NetworkStatus";

function metadata(ref: CredentialRef, available = false): CredentialMetadata {
  return {
    ...ref,
    hasCredential: available,
    available,
    encryptionAvailable: true,
    state: available ? "available" : "missing",
    createdAt: null,
    updatedAt: null,
  };
}

function exclusiveSnapshot(state: ExclusiveAccessSnapshot["state"]): NetworkSnapshot {
  return {
    ...checkingNetworkSnapshot(),
    policy: state === "dual" ? "rule-split" : "exclusive",
    enforcement: "strict",
    // The exclusive UI must never reuse this historical two-path summary.
    state: "dual",
    switching: {
      state,
      proxy: state === "domestic" ? "off" : state === "overseas" || state === "dual" ? "on" : "unknown",
      reason: state === "domestic" || state === "dual" ? "READY" : state === "overseas" ? "PROXY_ENABLED" : "PROXY_STATE_UNKNOWN",
      generation: 2,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    },
    accounts: [
      {
        accountId: "test",
        state: "allowed",
        reason: "READY",
        generation: 2,
        checkedAt: null,
        proofExpiresAt: null,
      },
    ],
  };
}

function renderSettings() {
  const result = render(<NetworkPanel />);
  fireEvent.click(screen.getByText("代理设置"));
  return result;
}

describe("automatic network switching UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNetwork.setState({
      snapshot: checkingNetworkSnapshot(),
      startupPending: false,
      refreshing: false,
      error: null,
    });
    transport.settings.mockResolvedValue(DEFAULT_NETWORK_SETTINGS);
    transport.configure.mockImplementation(async (value) => value);
    transport.meta.mockImplementation(async (ref: CredentialRef) => metadata(ref));
    transport.set.mockImplementation(async (ref: CredentialRef) => metadata(ref, true));
    transport.delete.mockImplementation(async (ref: CredentialRef) => metadata(ref));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows domestic mode during background startup without claiming platforms are enabled", async () => {
    useNetwork.setState({ startupPending: true });
    render(
      <>
        <NetworkStatus />
        <NetworkPanel />
      </>,
    );
    await waitFor(() => expect(transport.settings).toHaveBeenCalledOnce());
    const status = screen.getByRole("status", { name: "网络状态" });
    expect(status).toHaveTextContent("国内模式");
    expect(status).toHaveTextContent("后台检测网络状态，确认后自动启用平台");
    expect(status).not.toHaveTextContent("代理已关闭");
    expect(screen.getByLabelText("国内平台运行状态")).toHaveTextContent("等待切换");
    expect(screen.getByLabelText("国外平台运行状态")).toHaveTextContent("等待切换");
    expect(useNetwork.getState().snapshot.state).toBe("checking");
    expect(useNetwork.getState().snapshot.accounts).toEqual([]);
    act(() => useNetwork.setState({ snapshot: exclusiveSnapshot("overseas"), startupPending: false }));
    expect(status).toHaveTextContent("代理模式");
    expect(screen.getByLabelText("国内平台运行状态")).toHaveTextContent("已休眠");
    expect(screen.getByLabelText("国外平台运行状态")).toHaveTextContent("已启用");
  });

  it.each([
    ["domestic", "国内模式", "代理已关闭，国内平台启用，国外平台休眠"],
    ["dual", "规则模式", "国内平台直连，国外平台代理，国内外可同时使用"],
    ["overseas", "代理模式", "代理已开启，国内平台休眠，国外平台启用"],
    ["checking", "检查中", "正在检测代理状态，请稍候"],
    ["unavailable", "网络不可用", "网络暂不可用，请检查网络连接"],
  ] as const)(
    "shows the current %s switch decision without making a connectivity claim",
    (state, label, reason) => {
      useNetwork.setState({ snapshot: exclusiveSnapshot(state) });
      render(<NetworkStatus />);
      const status = screen.getByRole("status", { name: "网络状态" });
      expect(status).toHaveTextContent(label);
      expect(status).toHaveTextContent(reason);
      expect(status).toHaveAttribute("title", reason);
      expect(status).not.toHaveTextContent(/双通路|直连合格|验证|已联网|已登录/);
    },
  );

  it("does not turn a historical observation or missing switch state into an enabled platform", () => {
    const snapshot = exclusiveSnapshot("domestic");
    delete snapshot.switching;
    useNetwork.setState({ snapshot });
    render(<NetworkStatus />);
    const status = screen.getByRole("status", { name: "网络状态" });
    expect(status).toHaveTextContent("检查中");
    expect(status).not.toHaveTextContent("平台启用");
    act(() => useNetwork.setState({ snapshot: { ...snapshot, policy: "rule-split" } }));
    expect(status).toHaveTextContent("检查中");
    expect(status).not.toHaveTextContent("平台启用");
    act(() =>
      useNetwork.setState({ snapshot: { ...exclusiveSnapshot("domestic"), enforcement: "observe" } }),
    );
    expect(status).toHaveTextContent("检查中");
    expect(status).not.toHaveTextContent("平台启用");
  });

  it("keeps expired state neutral until the main process supplies a fresh switch decision", () => {
    const snapshot = exclusiveSnapshot("checking");
    snapshot.switching!.reason = "PROOF_EXPIRED";
    useNetwork.setState({ snapshot });
    render(<NetworkStatus />);
    expect(screen.getByRole("status", { name: "网络状态" })).toHaveTextContent("正在更新代理状态，请稍候");
    expect(screen.queryByText(/网络证据|直连合格/)).not.toBeInTheDocument();
  });

  it.each([
    ["domestic", "已启用", "已休眠"],
    ["dual", "已启用", "已启用"],
    ["overseas", "已休眠", "已启用"],
    ["checking", "等待切换", "等待切换"],
  ] as const)(
    "shows separate platform states for %s and keeps proxy settings collapsed",
    async (state, domestic, overseas) => {
      useNetwork.setState({ snapshot: exclusiveSnapshot(state) });
      const { container } = render(<NetworkPanel />);
      await waitFor(() => expect(transport.settings).toHaveBeenCalledOnce());
      expect(screen.getByLabelText("国内平台运行状态")).toHaveTextContent(domestic);
      expect(screen.getByLabelText("国外平台运行状态")).toHaveTextContent(overseas);
      expect(screen.getByText("规则模式下国内平台直连、国外平台代理，可同时使用。")).toBeVisible();
      expect(screen.getByText(/账号和登录数据保留/)).toBeVisible();
      expect(screen.getByRole("button", { name: "重新检查网络" })).toBeVisible();
      expect(screen.getByRole("button", { name: "保存网络配置" })).not.toBeVisible();
      expect(screen.queryByLabelText("客户端配置来源目录")).not.toBeInTheDocument();
      expect(container.textContent).not.toMatch(/DIRECT|直连合格|逐|出口证据|目标规则|严格模式/);
      expect(transport.directRules).not.toHaveBeenCalled();
      expect(transport.configure).not.toHaveBeenCalled();
    },
  );

  it("refreshes the actual network state without changing proxy configuration", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useNetwork.setState({ snapshot: exclusiveSnapshot("checking"), refresh });
    render(<NetworkPanel />);
    await userEvent.setup().click(screen.getByRole("button", { name: "重新检查网络" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(transport.configure).not.toHaveBeenCalled();
  });

  it("preserves an existing hidden configuration source when saving the proxy port", async () => {
    const selectedClientResourcesPath = "D:\\Apps\\猫猫云\\resources";
    transport.settings.mockResolvedValue({ ...DEFAULT_NETWORK_SETTINGS, selectedClientResourcesPath });
    renderSettings();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存网络配置" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("本机代理端口"), { target: { value: "7890" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "保存网络配置" }));
    expect(transport.configure).toHaveBeenCalledWith({
      ...DEFAULT_NETWORK_SETTINGS,
      diagnosticProxyPort: 7890,
      selectedClientResourcesPath,
    });
  });
  it("sends secrets only to the write-only default credential endpoint and clears inputs immediately", async () => {
    let complete!: (value: CredentialMetadata) => void;
    transport.set.mockReturnValue(
      new Promise<CredentialMetadata>((resolve) => {
        complete = resolve;
      }),
    );
    const persist = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    const { container } = renderSettings();
    await waitFor(() => expect(screen.getAllByText("未保存")).toHaveLength(2));
    const input = screen.getByLabelText("Clash 密钥");
    await user.type(input, "sentinel-clash-secret");
    await user.click(screen.getByRole("button", { name: "保存Clash 密钥" }));
    expect(input).toHaveValue("");
    expect(transport.set).toHaveBeenCalledWith({
      kind: "clash_secret",
      ownerId: "default",
      secret: "sentinel-clash-secret",
    });
    expect(transport.configure).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain("sentinel-clash-secret");
    complete(metadata({ kind: "clash_secret", ownerId: "default" }, true));
    await screen.findByText("凭据已加密保存");
    expect(input).toHaveValue("");
  });

  it("does not echo a secret or raw error when saving proxy credentials fails", async () => {
    transport.set.mockRejectedValue(new Error("sentinel-proxy-secret failed"));
    const user = userEvent.setup();
    const { container } = renderSettings();
    await waitFor(() => expect(screen.getAllByText("未保存")).toHaveLength(2));
    const input = screen.getByLabelText("代理密码");
    await user.type(input, "sentinel-proxy-secret");
    await user.click(screen.getByRole("button", { name: "保存代理密码" }));
    await screen.findByText("保存失败，请检查系统加密状态并重新输入");
    expect(input).toHaveValue("");
    expect(container.innerHTML).not.toContain("sentinel-proxy-secret");
    expect(transport.set).toHaveBeenCalledWith({
      kind: "proxy_password",
      ownerId: "default",
      secret: "sentinel-proxy-secret",
    });
  });

  it("keeps stored secrets masked and permits deletion when decryption is unavailable", async () => {
    transport.meta.mockImplementation(async (ref: CredentialRef) => ({
      ...metadata(ref, true),
      available: false,
      state: "decryption_failed",
    }));
    const user = userEvent.setup();
    renderSettings();
    await waitFor(() => expect(screen.getAllByText("现有凭据无法解密，请重新填写")).toHaveLength(2));
    expect(screen.getByLabelText("Clash 密钥")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "删除Clash 密钥" }));
    expect(transport.delete).toHaveBeenCalledWith({ kind: "clash_secret", ownerId: "default" });
    await screen.findByText("已删除保存的凭据");
  });

  it("validates local controller settings and sends only public configuration", async () => {
    const user = userEvent.setup();
    renderSettings();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存网络配置" })).toBeEnabled());
    const controller = screen.getByLabelText("Clash / Meta 控制器地址");
    fireEvent.change(controller, { target: { value: "https://example.com/config?secret=bad" } });
    await user.click(screen.getByRole("button", { name: "保存网络配置" }));
    expect(transport.configure).not.toHaveBeenCalled();
    await screen.findByText(/请填写本机 HTTP 控制器地址/);
    fireEvent.change(controller, { target: { value: "http://127.0.0.1:9090/" } });
    fireEvent.change(screen.getByLabelText("本机代理端口"), { target: { value: "7890" } });
    await user.click(screen.getByRole("button", { name: "保存网络配置" }));
    expect(transport.configure).toHaveBeenCalledWith({
      controllerUrl: "http://127.0.0.1:9090",
      diagnosticProxyPort: 7890,
    });
  });
});
