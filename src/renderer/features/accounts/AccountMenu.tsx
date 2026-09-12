import { useState } from "react";
import { Bug, ExternalLink, Pencil, RefreshCcw, ShieldAlert, Trash2, UserRoundCheck } from "lucide-react";
import type { Account } from "@shared/types";
import { getPlatform } from "@shared/platforms";
import { Button, Field, Menu, MenuItem, MenuSeparator, Modal, TextInput } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { useAccounts, useToasts, useUi, useViews } from "@renderer/store";

export function AccountMenu({
  account,
  anchor,
  onClose,
}: {
  account: Account;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"menu" | "rename" | "reset" | "delete">("menu");

  if (mode === "rename") return <RenameModal account={account} onClose={onClose} />;
  if (mode === "reset") return <ResetModal account={account} onClose={onClose} />;
  if (mode === "delete") return <DeleteModal account={account} onClose={onClose} />;

  return (
    <Menu anchor={anchor} onClose={onClose}>
      <MenuItem icon={Pencil} onClick={() => setMode("rename")}>
        重命名
      </MenuItem>
      <MenuItem
        icon={UserRoundCheck}
        onClick={async () => {
          onClose();
          try {
            const updated = await api.accounts.checkStatus(account.id);
            useAccounts.getState().upsert(updated);
          } catch (error) {
            useToasts
              .getState()
              .push({ kind: "error", title: "检测失败", message: String((error as Error).message ?? error) });
          }
        }}
      >
        检测登录状态
      </MenuItem>
      <MenuItem
        icon={ExternalLink}
        onClick={() => {
          onClose();
          void api.app.openExternal(getPlatform(account.platformId).routes.home);
        }}
      >
        在系统浏览器打开平台
      </MenuItem>
      {hasBridge ? (
        <MenuItem
          icon={Bug}
          onClick={() => {
            onClose();
            void api.views.openDevTools(account.id);
          }}
        >
          打开页面调试工具
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={RefreshCcw} onClick={() => setMode("reset")}>
        重置登录环境…
      </MenuItem>
      <MenuItem icon={Trash2} danger onClick={() => setMode("delete")}>
        删除账号…
      </MenuItem>
    </Menu>
  );
}

function RenameModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const [name, setName] = useState(account.displayName);
  const [note, setNote] = useState(account.note ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const updated = await api.accounts.update(account.id, {
        displayName: name.trim(),
        note: note.trim() || null,
      });
      useAccounts.getState().upsert(updated);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="重命名账号"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            保存
          </Button>
        </>
      }
    >
      <Field label="显示名称">
        <TextInput
          autoFocus
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </Field>
      <Field label="备注" hint="仅自己可见,例如负责人、内容方向。">
        <TextInput
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          placeholder="可选"
        />
      </Field>
    </Modal>
  );
}

function ResetModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const updated = await api.accounts.resetEnvironment(account.id);
      useAccounts.getState().upsert(updated);
      useViews.getState().remove(account.id);
      onClose();
    } catch (error) {
      useToasts
        .getState()
        .push({ kind: "error", title: "重置失败", message: String((error as Error).message ?? error) });
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="重置登录环境"
      icon={<ShieldAlert size={20} color="var(--warning)" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" onClick={submit} loading={busy}>
            确认重置
          </Button>
        </>
      }
    >
      <p style={{ color: "var(--fg-muted)", lineHeight: 1.6 }}>
        将清空 <strong style={{ color: "var(--fg)" }}>{account.displayName}</strong> 的全部
        Cookie、本地存储与缓存,该账号需要重新扫码登录。 其他账号不受影响;历史数据快照会保留。
      </p>
    </Modal>
  );
}

function DeleteModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.accounts.delete(account.id);
      useViews.getState().remove(account.id);
      if (useUi.getState().activeAccountId === account.id) useUi.setState({ activeAccountId: null });
      await useAccounts.getState().load();
      onClose();
    } catch (error) {
      useToasts
        .getState()
        .push({ kind: "error", title: "删除失败", message: String((error as Error).message ?? error) });
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="删除账号"
      icon={<Trash2 size={20} color="var(--danger)" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" onClick={submit} loading={busy}>
            删除
          </Button>
        </>
      }
    >
      <p style={{ color: "var(--fg-muted)", lineHeight: 1.6 }}>
        删除 <strong style={{ color: "var(--fg)" }}>{account.displayName}</strong>{" "}
        会移除其登录环境、数据快照与作品记录,且不可恢复。素材库不受影响。
      </p>
    </Modal>
  );
}
