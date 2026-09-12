import { useState } from "react";
import { PlatformLogo } from "@renderer/components/ui/PlatformLogo";
import { Check, Fingerprint, QrCode, ShieldCheck } from "lucide-react";
import { PLATFORM_LIST, type PlatformId } from "@shared/platforms";
import { Button, Field, Modal, TextInput, cx } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { useAccounts, useToasts, useUi } from "@renderer/store";
import styles from "./accounts.module.css";

export function AddAccountModal() {
  const open = useUi((s) => s.addAccountOpen);
  const preselect = useUi((s) => s.metricsPlatform);
  if (!open) return null;
  // Remounting per open gives the form fresh state without effects.
  return <AddAccountForm key={preselect ?? "default"} initialPlatform={preselect ?? "douyin"} />;
}

function AddAccountForm({ initialPlatform }: { initialPlatform: PlatformId }) {
  const setOpen = useUi((s) => s.setAddAccountOpen);
  const openAccount = useUi((s) => s.openAccount);
  const [platformId, setPlatformId] = useState<PlatformId>(initialPlatform);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const platform = PLATFORM_LIST.find((p) => p.id === platformId)!;

  const submit = async () => {
    setBusy(true);
    try {
      const account = await api.accounts.create({ platformId, displayName: name.trim() || undefined });
      useAccounts.getState().upsert(account);
      setOpen(false);
      openAccount(account.id);
      useToasts.getState().push({
        kind: "success",
        title: "独立登录环境已创建",
        message: `请在右侧页面扫码登录 ${platform.name}`,
      });
    } catch (error) {
      useToasts
        .getState()
        .push({ kind: "error", title: "创建失败", message: String((error as Error).message ?? error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      title="添加账号"
      onClose={() => setOpen(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="primary" icon={QrCode} onClick={submit} loading={busy}>
            创建环境并去登录
          </Button>
        </>
      }
    >
      <Field label="选择平台">
        <div className={styles.platformGrid}>
          {PLATFORM_LIST.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cx(styles.platformCard, p.id === platformId && styles.selected)}
              onClick={() => setPlatformId(p.id)}
            >
              <PlatformLogo platformId={p.id} size={32} />
              <span className={styles.platformName}>{p.name}</span>
              <span className={styles.platformMethods}>
                {p.loginMethods.map((m) => ({ qr: "扫码", sms: "短信", password: "密码" })[m]).join(" / ")}
              </span>
              {p.id === platformId ? <Check size={14} className={styles.platformCheck} /> : null}
            </button>
          ))}
        </div>
      </Field>
      <Field label="账号名称" hint="可留空,登录成功后会自动识别平台昵称与头像。">
        <TextInput
          value={name}
          maxLength={60}
          placeholder={`${platform.shortName}账号`}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className={styles.assurance}>
        <div>
          <Fingerprint size={16} />
          <span>每个账号拥有独立的 Cookie、缓存与本地存储,互不串号。</span>
        </div>
        <div>
          <ShieldCheck size={16} />
          <span>登录在平台官方页面完成,应用不接触密码,也不做任何自动化互动。</span>
        </div>
      </div>
    </Modal>
  );
}
