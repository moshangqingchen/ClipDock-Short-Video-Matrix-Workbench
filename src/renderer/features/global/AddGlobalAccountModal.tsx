import { useEffect, useRef, useState } from "react";
import { PlatformLogo } from "@renderer/components/ui/PlatformLogo";
import { Check, Fingerprint, Globe, ShieldCheck } from "lucide-react";
import type { GlobalAccount } from "@shared/global-accounts";
import type { GlobalPlatformId } from "@shared/platforms";
import { Button, Field, Modal, TextInput, cx } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { isGlobalProxyEnabled, useNetwork } from "@renderer/store/network";
import accountStyles from "@renderer/features/accounts/accounts.module.css";
import styles from "./global-accounts-page.module.css";

const PLATFORMS = [
  { id: "youtube", name: "YouTube", glyph: "▶", color: "#e11d48", login: "Google 账号登录" },
  { id: "tiktok", name: "TikTok", glyph: "♪", color: "#111827", login: "官方网页登录" },
  { id: "x", name: "X", glyph: "𝕏", color: "#111827", login: "官方网页登录" },
] as const;

export function AddGlobalAccountModal({
  initialPlatform = "youtube",
  onClose,
  onCreated,
  onNotice,
}: {
  initialPlatform?: GlobalPlatformId;
  onClose(): void;
  onCreated(account: GlobalAccount): void;
  onNotice(message: string): void;
}) {
  const [platformId, setPlatformId] = useState<GlobalPlatformId>(initialPlatform);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const live = useRef(true);
  const platform = PLATFORMS.find((item) => item.id === platformId)!;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    let account: GlobalAccount;
    try {
      account = await api.globalAccounts.create({
        platformId,
        ...(name.trim() ? { displayName: name.trim() } : {}),
      });
    } catch {
      if (live.current) {
        setError("账号创建失败，请重试。");
        setBusy(false);
        submitting.current = false;
      }
      return;
    }
    // Creation is committed before opening the website. An opening failure must
    // never invite a second creation or discard the saved independent account.
    window.dispatchEvent(new CustomEvent("clipdock:global-accounts-changed"));
    if (!live.current) return;
    onCreated(account);
    onClose();
    const switching = useNetwork.getState().snapshot.switching;
    if (!hasBridge) {
      onNotice("账号已添加，请在桌面软件中打开官网登录。");
      return;
    }
    if (!isGlobalProxyEnabled(switching)) {
      onNotice("账号已添加；国外平台正在休眠，开启代理后点击“打开官网”即可登录。");
      return;
    }
    try {
      const state = await api.globalWeb.open(account.id);
      onNotice(
        state.phase === "open"
          ? "独立登录环境已创建，请在软件内的官方页面完成登录。"
          : state.phase === "dormant" || state.errorCode === "GLOBAL_WEB_PROXY_UNVERIFIED"
            ? "账号已添加；开启代理后点击“打开官网”即可登录。"
            : "账号已添加，官网尚未打开。请在此账号的工作区重试，无需重复添加。",
      );
    } catch {
      onNotice("账号已添加，官网暂时无法打开。请在此账号的工作区重试，无需重复添加。");
    }
  };

  return (
    <Modal
      open
      wide
      title="添加国外账号"
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" icon={Globe} loading={busy} onClick={() => void submit()}>
            创建环境并去登录
          </Button>
        </>
      }
    >
      <Field label="选择平台">
        <div
          className={cx(accountStyles.platformGrid, styles.platformGrid)}
          role="group"
          aria-label="选择国外平台"
        >
          {PLATFORMS.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy}
              aria-pressed={platformId === item.id}
              aria-label={item.name}
              className={cx(accountStyles.platformCard, item.id === platformId && accountStyles.selected)}
              onClick={() => setPlatformId(item.id)}
            >
              <PlatformLogo platformId={item.id} size={32} />
              <span className={accountStyles.platformName}>{item.name}</span>
              <span className={accountStyles.platformMethods}>{item.login}</span>
              {item.id === platformId ? <Check size={14} className={accountStyles.platformCheck} /> : null}
            </button>
          ))}
        </div>
      </Field>
      <Field label="账号名称" hint="可留空，将使用平台默认账号名称；登录在官方页面完成。">
        <TextInput
          aria-label="国际账号名称"
          value={name}
          maxLength={60}
          disabled={busy}
          placeholder={`${platform.name}账号`}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
          }}
        />
      </Field>
      <div className={accountStyles.assurance}>
        <div>
          <Fingerprint size={16} />
          <span>每个账号独立保存 Cookie、缓存与本地存储，互不串号。</span>
        </div>
        <div>
          <ShieldCheck size={16} />
          <span>在软件内打开平台官方页面登录，无需配置开发者应用。</span>
        </div>
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
