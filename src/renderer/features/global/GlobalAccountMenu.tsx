import { useState } from "react";
import { Bug, ExternalLink, Pencil, RefreshCcw, Trash2, UserRoundCheck } from "lucide-react";
import type { GlobalAccount } from "@shared/global-accounts";
import { Button, Field, Menu, MenuItem, MenuSeparator, Modal, TextInput } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { useGlobalAccounts, useToasts, useUi } from "@renderer/store";

export function GlobalAccountMenu({
  account,
  anchor,
  onClose,
}: {
  account: GlobalAccount;
  anchor: DOMRect;
  onClose(): void;
}) {
  const [mode, setMode] = useState<"menu" | "rename" | "reset" | "delete">("menu");
  const [name, setName] = useState(account.displayName),
    [note, setNote] = useState(account.note ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = async (operation: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await useGlobalAccounts.getState().load();
      if (success) useToasts.getState().push({ kind: "success", title: success });
      onClose();
    } catch {
      setError("操作未完成，请检查网络和账号页面后重试");
    } finally {
      setBusy(false);
    }
  };
  if (mode !== "menu")
    return (
      <Modal
        open
        title={mode === "rename" ? "重命名账号" : mode === "reset" ? "重置登录环境" : "删除账号"}
        onClose={busy ? () => undefined : onClose}
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              variant={mode === "rename" ? "primary" : "danger"}
              loading={busy}
              disabled={mode === "rename" && !name.trim()}
              onClick={() =>
                void run(
                  async () => {
                    if (mode === "rename")
                      await api.globalAccounts.update(account.id, {
                        displayName: name.trim(),
                        note: note.trim() || null,
                      });
                    else if (mode === "reset") await api.globalWorkspace.resetEnvironment(account.id);
                    else {
                      await api.globalAccounts.delete(account.id);
                      if (useUi.getState().activeGlobalAccountId === account.id)
                        useUi.getState().selectGlobalAccount(null);
                    }
                  },
                  mode === "rename" ? "账号名称已更新" : mode === "reset" ? "登录环境已重置" : "账号已删除",
                )
              }
            >
              确认{mode === "rename" ? "保存" : mode === "reset" ? "重置" : "删除"}
            </Button>
          </>
        }
      >
        {mode === "rename" ? (
          <>
            <Field label="显示名称">
              <TextInput
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                autoFocus
              />
            </Field>
            <Field label="备注">
              <TextInput value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
            </Field>
          </>
        ) : (
          <p>
            {mode === "reset"
              ? `将清空「${account.displayName}」的 Chrome 与内置浏览器登录环境，需要重新登录。账号资料、观测历史和 API 授权保留。`
              : `将删除「${account.displayName}」及其登录环境、观测历史、作品和发布计划。素材库不受影响。`}
          </p>
        )}
        {error ? (
          <p role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
      </Modal>
    );
  return (
    <Menu anchor={anchor} onClose={onClose}>
      <MenuItem icon={Pencil} onClick={() => setMode("rename")}>
        重命名
      </MenuItem>
      <MenuItem
        icon={UserRoundCheck}
        onClick={() =>
          void run(async () => {
            const identity = await api.globalWorkspace.checkLogin(account.id);
            useToasts.getState().push({
              kind: identity.status === "online" ? "success" : "info",
              title:
                identity.status === "online"
                  ? "官网登录正常"
                  : identity.status === "needs_verification"
                    ? "请在官网完成验证"
                    : identity.status === "offline"
                      ? "请在官网完成登录"
                      : "暂未确认登录状态",
            });
          })
        }
      >
        检测登录状态
      </MenuItem>
      <MenuItem
        icon={ExternalLink}
        onClick={() => void run(() => api.globalWorkspace.openSystemBrowser(account.id))}
      >
        在系统浏览器打开平台
      </MenuItem>
      <MenuItem icon={Bug} onClick={() => void run(() => api.globalWorkspace.openDevTools(account.id))}>
        打开页面调试工具
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={RefreshCcw} onClick={() => setMode("reset")}>
        重置登录环境…
      </MenuItem>
      <MenuItem icon={Trash2} danger onClick={() => setMode("delete")}>
        删除账号…
      </MenuItem>
      {error ? (
        <p role="alert" style={{ padding: 12, color: "var(--danger)", fontSize: 12 }}>
          {error}
        </p>
      ) : null}
    </Menu>
  );
}
