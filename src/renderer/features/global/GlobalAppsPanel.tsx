import { useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound, Settings2 } from "lucide-react";
import { GLOBAL_PLATFORM_IDS, type GlobalPlatformId } from "@shared/platforms";
import type { GlobalAppMetadata } from "@shared/global-apps";
import { Badge, Button, Card, Field, Modal, TextInput } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import styles from "./global-apps.module.css";

const NAMES: Record<GlobalPlatformId, string> = { youtube: "YouTube", tiktok: "TikTok", x: "X" };

function callbackAddress(port: number | null): string {
  if (port === null) return "填写回调端口后显示地址";
  if (port === 0) return "http://127.0.0.1:<动态端口>/oauth/callback";
  return `http://127.0.0.1:${port}/oauth/callback`;
}

function secretStatus(row: GlobalAppMetadata | undefined): string {
  if (!row?.clientSecret?.hasCredential) return "密钥未配置";
  return row.clientSecret.available ? "密钥已保存" : "密钥不可用，请重新填写";
}

function AppEditor({
  platformId,
  metadata,
  onSaved,
  onClose,
}: {
  platformId: GlobalPlatformId;
  metadata: GlobalAppMetadata | undefined;
  onSaved: (metadata: GlobalAppMetadata) => void;
  onClose: () => void;
}) {
  const [clientId, setClientId] = useState(metadata?.clientId ?? "");
  const [port, setPort] = useState(metadata?.redirectPort?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The password exists only in this temporary input and the configure IPC argument.
  // It is never a React/store draft, metadata value, or persistent renderer setting.
  const secretInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const input = secretInput.current;
    return () => {
      mounted.current = false;
      if (input) input.value = "";
    };
  }, []);
  const clearInput = () => {
    if (secretInput.current) secretInput.current.value = "";
  };
  const close = () => {
    clearInput();
    if (!busy) onClose();
  };
  const changedClient = Boolean(metadata?.clientId && clientId.trim() !== metadata.clientId);
  const canRetainSecret = !changedClient && Boolean(metadata?.clientSecret?.available);
  const numericPort = /^\d{1,5}$/.test(port) ? Number(port) : null;
  const validPort =
    numericPort !== null &&
    numericPort <= 65535 &&
    (numericPort >= 1024 || (platformId === "youtube" && numericPort === 0));
  const formId = `global-app-${platformId}`;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !hasBridge) return;
    const clientSecret = secretInput.current?.value ?? "";
    clearInput();
    setError(null);
    if (!/^[A-Za-z0-9._~-]{1,512}$/.test(clientId.trim())) {
      setError("请填写开发者平台提供的 Client ID / Client Key。");
      return;
    }
    if (!validPort || numericPort === null) {
      setError(
        platformId === "youtube"
          ? "请填写 1024–65535 的端口；Google 桌面应用也可使用 0。"
          : "请填写 1024–65535 的固定回调端口。",
      );
      return;
    }
    if (platformId === "tiktok" && !clientSecret.trim() && !canRetainSecret) {
      setError("TikTok 需要该应用的 Client Secret，请重新填写后保存。");
      return;
    }
    setBusy(true);
    try {
      const pending = api.globalApps.configure({
        platformId,
        clientId: clientId.trim(),
        redirectPort: numericPort,
        ...(platformId !== "x" && clientSecret ? { clientSecret } : {}),
      });
      const result = await pending;
      if (mounted.current) onSaved(result);
    } catch {
      if (mounted.current) setError("本机应用配置保存失败。密钥输入已清空，请检查配置后重试。");
    } finally {
      clearInput();
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`配置 ${NAMES[platformId]} 开发者应用`}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            取消
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} disabled={!hasBridge}>
            保存本机配置
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void save(event)}
        className={styles.form}
        noValidate
        autoComplete="off"
      >
        <p className={styles.hint}>
          填写你在官方开发者平台创建的应用信息。此处保存配置，不会打开授权页面或发起 API 请求。
        </p>
        <Field label={platformId === "tiktok" ? "Client Key" : "Client ID"}>
          <TextInput
            aria-label={`${NAMES[platformId]} Client ID`}
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="未配置"
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </Field>
        <Field
          label="回调端口"
          hint={
            platformId === "youtube"
              ? "请选择 Google 桌面应用类型；填 0 时，授权事务分配动态端口。"
              : "使用开发者平台登记的固定端口；本机接收器只监听 127.0.0.1。"
          }
        >
          <TextInput
            aria-label={`${NAMES[platformId]} 回调端口`}
            value={port}
            onChange={(event) => setPort(event.target.value)}
            type="number"
            min={platformId === "youtube" ? 0 : 1024}
            max={65535}
            step={1}
            placeholder="未配置"
            disabled={busy}
          />
        </Field>
        <div className={styles.callback}>
          <span>回调地址</span>
          <code>{callbackAddress(validPort ? numericPort : null)}</code>
        </div>
        {platformId !== "x" ? (
          <Field
            label={`Client Secret${platformId === "youtube" ? "（可选）" : "（必需）"}`}
            hint="密钥由主进程加密保存，不回显原值。保存或关闭时清空本次输入。"
          >
            <input
              ref={secretInput}
              className={styles.secretInput}
              aria-label={`${NAMES[platformId]} Client Secret`}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={65536}
              placeholder={canRetainSecret ? "已保存；留空保留" : "未配置"}
              disabled={busy}
            />
          </Field>
        ) : (
          <p className={styles.hint}>X 使用公共应用配置，不接收 Client Secret。</p>
        )}
        {changedClient ? (
          <p className={styles.warning}>
            更换 Client ID / Client Key
            会清除旧应用密钥，并使该平台账号需要重新授权。需要密钥的平台请填写新应用密钥。
          </p>
        ) : null}
        <p className={styles.hint}>
          配置变更可能使该平台账号需要重新授权。配置已保存不代表权限、配额或 API 接入已可用。
        </p>
        {error ? (
          <div role="alert" className={styles.error}>
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

export function GlobalAppsPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const [rows, setRows] = useState<GlobalAppMetadata[]>([]);
  const [loaded, setLoaded] = useState(!hasBridge);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<GlobalPlatformId | null>(null);
  const [clearing, setClearing] = useState<GlobalPlatformId | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const loadEpoch = useRef(0);
  const load = () => {
    const epoch = ++loadEpoch.current;
    return Promise.resolve()
      .then(() => api.globalApps.list())
      .then((result) => {
        if (mounted.current && epoch === loadEpoch.current) {
          setError(null);
          setRows(result);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (mounted.current && epoch === loadEpoch.current) {
          setError("开发者应用配置读取失败，请重试。");
          setLoaded(false);
        }
      });
  };
  useEffect(() => {
    mounted.current = true;
    if (hasBridge) void load();
    return () => {
      mounted.current = false;
    };
  }, []);
  const replace = (row: GlobalAppMetadata) =>
    setRows((previous) => [...previous.filter((entry) => entry.platformId !== row.platformId), row]);
  const saved = (row: GlobalAppMetadata) => {
    if (!mounted.current) return;
    replace(row);
    setEditing(null);
    setMessage(`${NAMES[row.platformId]} 本机配置已保存；可在账号卡中按需发起官方授权。`);
    onChanged?.();
  };
  const clearSecret = async () => {
    if (!clearing || busy || !hasBridge) return;
    const platformId = clearing;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const row = await api.globalApps.clearSecret(platformId);
      if (mounted.current) {
        replace(row);
        setClearing(null);
        setMessage(`${NAMES[platformId]} 应用密钥已清除，该平台账号需要重新授权。`);
        onChanged?.();
      }
    } catch {
      if (mounted.current) setError("应用密钥清除失败，请重试。");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section aria-label="国际开发者应用配置" className={styles.panel}>
      <div className={styles.heading}>
        <KeyRound size={19} aria-hidden />
        <h2>开发者应用配置</h2>
      </div>
      <p className={styles.hint}>
        没有开发者应用时可以保持未配置。这里只保存本机接入信息；配置齐全不等于官方授权、审核、配额或 API
        已上线。
      </p>
      {!hasBridge ? (
        <p className={styles.hint}>浏览器预览不接收或保存应用密钥，请在桌面工作台中配置。</p>
      ) : null}
      {error && !clearing ? (
        <div role="alert" className={styles.error}>
          {error}
          {!loaded ? (
            <Button size="sm" onClick={() => void load()}>
              重试读取配置
            </Button>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p role="status" className={styles.hint}>
          {message}
        </p>
      ) : null}
      {!loaded && !error ? <p className={styles.hint}>正在读取本机应用配置…</p> : null}
      <div className={styles.grid}>
        {GLOBAL_PLATFORM_IDS.map((platformId) => {
          const row = rows.find((entry) => entry.platformId === platformId);
          return (
            <Card key={platformId} className={styles.card}>
              <div className={styles.cardHead}>
                <h3>{NAMES[platformId]}</h3>
                <Badge>
                  {!loaded
                    ? "读取中"
                    : row?.configured
                      ? platformId === "tiktok" && !row.clientSecret?.available
                        ? row.clientSecret?.hasCredential
                          ? "密钥需重填"
                          : "缺少应用密钥"
                        : "本机配置已保存"
                      : "未配置"}
                </Badge>
              </div>
              <dl className={styles.metadata}>
                <div>
                  <dt>{platformId === "tiktok" ? "Client Key" : "Client ID"}</dt>
                  <dd>{row?.clientId ?? "未配置"}</dd>
                </div>
                <div>
                  <dt>回调地址</dt>
                  <dd>{callbackAddress(row?.redirectPort ?? null)}</dd>
                </div>
                <div>
                  <dt>应用密钥</dt>
                  <dd>{platformId === "x" ? "公共应用不使用密钥" : secretStatus(row)}</dd>
                </div>
              </dl>
              <div className={styles.actions}>
                <Button
                  icon={Settings2}
                  size="sm"
                  disabled={!loaded || busy || !hasBridge}
                  onClick={() => {
                    setMessage(null);
                    setEditing(platformId);
                  }}
                  aria-label={`配置 ${NAMES[platformId]} 应用`}
                >
                  配置应用
                </Button>
                {platformId !== "x" && row?.clientSecret?.hasCredential ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !hasBridge}
                    aria-label={`清除 ${NAMES[platformId]} 应用密钥`}
                    onClick={() => {
                      setError(null);
                      setClearing(platformId);
                    }}
                  >
                    清除密钥
                  </Button>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
      {editing ? (
        <AppEditor
          key={editing}
          platformId={editing}
          metadata={rows.find((row) => row.platformId === editing)}
          onSaved={saved}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {clearing ? (
        <Modal
          open
          title={`清除 ${NAMES[clearing]} 应用密钥`}
          onClose={() => {
            if (!busy) setClearing(null);
          }}
          footer={
            <>
              <Button disabled={busy} onClick={() => setClearing(null)}>
                取消
              </Button>
              <Button variant="danger" loading={busy} onClick={() => void clearSecret()}>
                确认清除密钥
              </Button>
            </>
          }
        >
          <p>
            将删除本机保存的 {NAMES[clearing]} Client Secret，并使该平台已有账号需要重新授权。Client ID
            和回调端口会保留。
          </p>
          {error ? (
            <div role="alert" className={styles.error}>
              {error}
            </div>
          ) : null}
        </Modal>
      ) : null}
    </section>
  );
}
