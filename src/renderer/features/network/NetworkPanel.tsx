import { useEffect, useState } from "react";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import { DEFAULT_NETWORK_SETTINGS, networkSettingsSchema, type NetworkSettings } from "@shared/network";
import type { CredentialMetadata, CredentialWriteInput } from "@shared/credentials";
import { api } from "@renderer/lib/api";
import { useNetwork } from "@renderer/store/network";
import { Badge, Button, Card, Field, TextInput, formatDateTime } from "@renderer/components/ui";
import { networkDisplay } from "./NetworkStatus";
import styles from "./network.module.css";
const CREDENTIAL_STATE_TEXT: Record<CredentialMetadata["state"], string> = {
  missing: "未保存",
  available: "已保存，可用",
  encryption_unavailable: "系统加密不可用，不能保存",
  decryption_failed: "现有凭据无法解密，请重新填写",
  unsupported_version: "现有凭据版本不受支持，请重新填写",
};

function CredentialField({ kind, label }: { kind: CredentialWriteInput["kind"]; label: string }) {
  const [metadata, setMetadata] = useState<CredentialMetadata | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    void api.credentials
      .meta({ kind, ownerId: "default" })
      .then((value) => {
        if (active) setMetadata(value);
      })
      .catch(() => {
        if (active) setMessage("无法读取凭据状态，请重试");
      });
    return () => {
      active = false;
    };
  }, [kind, retry]);

  async function save() {
    const input = secret;
    setSecret("");
    setMessage("");
    setBusy(true);
    try {
      const value = await api.credentials.set({ kind, ownerId: "default", secret: input });
      setMetadata(value);
      setMessage("凭据已加密保存");
    } catch {
      setMessage("保存失败，请检查系统加密状态并重新输入");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setSecret("");
    setMessage("");
    setBusy(true);
    try {
      setMetadata(await api.credentials.delete({ kind, ownerId: "default" }));
      setMessage("已删除保存的凭据");
    } catch {
      setMessage("删除失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.credential}>
      <Field label={label} hint={metadata ? CREDENTIAL_STATE_TEXT[metadata.state] : "读取保存状态中"}>
        <TextInput
          aria-label={label}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={secret}
          maxLength={65_536}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={metadata?.hasCredential ? "已保存；输入新值可替换" : "输入后加密保存"}
          disabled={busy || metadata?.encryptionAvailable === false}
        />
      </Field>
      <div className={styles.actions}>
        <Button
          size="sm"
          icon={Save}
          loading={busy}
          disabled={!metadata?.encryptionAvailable || !secret}
          onClick={() => void save()}
        >
          保存{label}
        </Button>
        <Button
          size="sm"
          icon={Trash2}
          disabled={busy || !metadata?.hasCredential}
          onClick={() => void remove()}
        >
          删除{label}
        </Button>
        {!metadata && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMessage("");
              setRetry((value) => value + 1);
            }}
          >
            重试读取{label}
          </Button>
        )}
      </div>
      {message && (
        <p className={styles.feedback} role="status">
          {message}
        </p>
      )}
    </div>
  );
}

export function NetworkPanel() {
  const { snapshot, startupPending, refreshing, error, refresh } = useNetwork();
  const [settings, setSettings] = useState<NetworkSettings>({ ...DEFAULT_NETWORK_SETTINGS });
  const [port, setPort] = useState(String(DEFAULT_NETWORK_SETTINGS.diagnosticProxyPort));
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const display = networkDisplay(snapshot, startupPending);
  const domestic = display.state === "domestic" || display.state === "dual";
  const overseas = display.state === "overseas" || display.state === "dual";
  const waiting = display.state === "unavailable" ? "暂不可用" : "等待切换";

  useEffect(() => {
    let active = true;
    void api.network
      .settings()
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setPort(String(value.diagnosticProxyPort));
        setSettingsLoaded(true);
      })
      .catch(() => {
        if (active) setMessage("无法读取网络配置，请重试");
      });
    return () => {
      active = false;
    };
  }, [retry]);

  async function saveSettings() {
    const parsed = networkSettingsSchema.safeParse({
      ...settings,
      diagnosticProxyPort: Number(port),
    });
    if (!parsed.success) {
      setMessage("请填写本机 HTTP 控制器地址和 1–65535 的代理端口，地址不能包含路径或凭据");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const value = await api.network.configure(parsed.data);
      setSettings(value);
      setPort(String(value.diagnosticProxyPort));
      setMessage("网络配置已保存，正在更新代理状态");
    } catch {
      setMessage("网络配置保存失败，请检查控制器地址和代理端口后重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={styles.panel}>
      <div className={styles.heading}>
        <div>
          <h3>国内／国外网络分流</h3>
          <p>规则模式下国内平台直连、国外平台代理，可同时使用。</p>
        </div>
        <Badge tone="info">{display.label}</Badge>
      </div>
      <div className={styles.modeGrid}>
        <div className={styles.modeCard} aria-label="国内平台运行状态">
          <strong>国内平台</strong>
          <Badge tone={domestic ? "success" : "neutral"}>
            {domestic ? "已启用" : overseas ? "已休眠" : waiting}
          </Badge>
          <p>通过直连访问国内平台</p>
        </div>
        <div className={styles.modeCard} aria-label="国外平台运行状态">
          <strong>国外平台</strong>
          <Badge tone={overseas ? "success" : "neutral"}>
            {overseas ? "已启用" : domestic ? "已休眠" : waiting}
          </Badge>
          <p>开启代理后通过代理访问</p>
        </div>
      </div>
      <div className={styles.summary}>
        <p>{display.reason}</p>
        <small>最近检查：{formatDateTime(snapshot.switching?.checkedAt ?? null)}</small>
        <Button size="sm" icon={RefreshCw} loading={refreshing} onClick={() => void refresh()}>
          重新检查网络
        </Button>
      </div>
      {error && (
        <p className={styles.feedback} role="alert">
          {error}
        </p>
      )}
      <div className={styles.explanation} aria-label="自动切换说明">
        <p>检测系统代理或 TUN 状态后自动分流。仅打开代理客户端窗口不会启用代理。</p>
        <p>关闭代理后国外平台休眠，账号和登录数据保留；连接情况以实际页面加载结果为准。</p>
      </div>
      <details className={styles.configurationDetails}>
        <summary>代理设置</summary>
        <div className={styles.configurationBody}>
          <div className={styles.configuration}>
            <Field label="Clash / Meta 控制器地址" hint="用于读取代理客户端状态，通常保持默认即可。">
              <TextInput
                aria-label="Clash / Meta 控制器地址"
                value={settings.controllerUrl}
                disabled={saving || !settingsLoaded}
                onChange={(event) =>
                  setSettings((value) => ({ ...value, controllerUrl: event.target.value }))
                }
              />
            </Field>
            <Field label="本机代理端口" hint="填写代理客户端的 HTTP 或 mixed 端口。">
              <TextInput
                aria-label="本机代理端口"
                inputMode="numeric"
                value={port}
                disabled={saving || !settingsLoaded}
                onChange={(event) => setPort(event.target.value)}
              />
            </Field>
          </div>
          <div className={styles.actions}>
            <Button
              size="sm"
              icon={Save}
              loading={saving}
              disabled={!settingsLoaded}
              onClick={() => void saveSettings()}
            >
              保存网络配置
            </Button>
            {!settingsLoaded && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMessage("");
                  setRetry((value) => value + 1);
                }}
              >
                重新读取网络配置
              </Button>
            )}
          </div>
          {message && (
            <p className={styles.feedback} role="status">
              {message}
            </p>
          )}
          <div className={styles.credentials}>
            <CredentialField kind="clash_secret" label="Clash 密钥" />
            <CredentialField kind="proxy_password" label="代理密码" />
          </div>
          <p className={styles.note}>密钥和密码在本机加密保存，不显示已保存的内容。</p>
        </div>
      </details>
    </Card>
  );
}
