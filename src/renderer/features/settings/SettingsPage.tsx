import { useEffect, useState } from "react";
import { Download, Minus, Monitor, Moon, Plus, Sun, Upload } from "lucide-react";
import type { AppInfo } from "@shared/ipc";
import type { AppSettings, AuditEvent } from "@shared/types";
import { Button, Card, Field, Modal, Switch, TextInput, cx, formatDateTime } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { useAccounts, useSettings, useToasts } from "@renderer/store";
import layout from "@renderer/features/layout/layout.module.css";
import styles from "./settings.module.css";
import { NetworkPanel } from "@renderer/features/network/NetworkPanel";
import { GlobalAppsPanel } from "@renderer/features/global/GlobalAppsPanel";

export function SettingsPage() {
  const settings = useSettings((s) => s.settings);
  const patch = useSettings((s) => s.patch);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [backupMode, setBackupMode] = useState<"export" | "import" | null>(null);

  useEffect(() => {
    void api.app
      .info()
      .then(setInfo)
      .catch(() => undefined);
    void api.audit
      .list(50)
      .then(setAudit)
      .catch(() => undefined);
  }, []);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    void patch({ [key]: value } as Partial<AppSettings>);

  return (
    <div className={layout.page}>
      <div className={layout.pageHead}>
        <div>
          <span className={layout.eyebrow}>SETTINGS</span>
          <h1>设置</h1>
          <p>外观、后台采集、通知与备份。所有设置立即生效。</p>
        </div>
      </div>

      <div className={styles.sections}>
        <NetworkPanel />
        <GlobalAppsPanel />
        <Card>
          <div className={styles.sectionHead}>
            <h3>外观</h3>
          </div>
          <Row title="主题" description="跟随系统或固定亮/暗色。">
            <div className={styles.themeRow}>
              {(
                [
                  ["light", "浅色", Sun],
                  ["dark", "深色", Moon],
                  ["system", "跟随系统", Monitor],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  className={cx(styles.themeOpt, settings.theme === value && styles.active)}
                  onClick={() => set("theme", value)}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </Row>
        </Card>

        <Card>
          <div className={styles.sectionHead}>
            <h3>浏览器环境</h3>
            <p>
              每个账号的页面常驻内存,切换零加载;超过上限时最久未用且不在登录页的页面会被释放(登录态不受影响)。
            </p>
          </div>
          <Row title="同时常驻的账号页面数" description="每个页面约占用 150–300 MB 内存。内存充足可调高。">
            <Stepper
              value={settings.maxLiveViews}
              min={2}
              max={12}
              onChange={(v) => set("maxLiveViews", v)}
            />
          </Row>
        </Card>

        <Card>
          <div className={styles.sectionHead}>
            <h3>数据采集与保活</h3>
            <p>采集在账号自己的登录会话内以只读方式进行,与你在页面里点开数据页等价。</p>
          </div>
          <Row
            title="自动采集账号数据"
            description="登录成功后立即采集一次,之后按间隔在后台采集(带随机抖动,不会整点同时请求)。"
          >
            <Switch checked={settings.collectEnabled} onChange={(v) => set("collectEnabled", v)} />
          </Row>
          <Row title="采集间隔(小时)">
            <Stepper
              value={settings.collectIntervalHours}
              min={1}
              max={48}
              onChange={(v) => set("collectIntervalHours", v)}
              disabled={!settings.collectEnabled}
            />
          </Row>
          <Row
            title="会话保活"
            description="定期检查登录状态；视频号会在不打断当前操作时访问管理首页复核，实际登录有效期由平台决定。"
          >
            <Switch checked={settings.keepaliveEnabled} onChange={(v) => set("keepaliveEnabled", v)} />
          </Row>
          <Row title="保活间隔(小时)">
            <Stepper
              value={settings.keepaliveIntervalHours}
              min={2}
              max={72}
              onChange={(v) => set("keepaliveIntervalHours", v)}
              disabled={!settings.keepaliveEnabled}
            />
          </Row>
        </Card>

        <Card>
          <div className={styles.sectionHead}>
            <h3>通知</h3>
          </div>
          <Row
            title="账号掉线时系统通知"
            description="检测到登录态失效时弹出系统通知,即使窗口最小化也能看到。"
          >
            <Switch checked={settings.notifyOnOffline} onChange={(v) => set("notifyOnOffline", v)} />
          </Row>
          <Row title="登录态即将过期时提醒">
            <Switch checked={settings.notifyOnExpiring} onChange={(v) => set("notifyOnExpiring", v)} />
          </Row>
        </Card>

        <Card>
          <div className={styles.sectionHead}>
            <h3>备份与恢复</h3>
            <p>
              备份包含账号列表、数据快照、作品、素材引用与发布记录;不包含 Cookie
              与浏览器数据,恢复后需要重新登录。
            </p>
          </div>
          <Row title="导出备份" description="可选设置密码进行 AES-256-GCM 加密。">
            <Button icon={Download} onClick={() => setBackupMode("export")} disabled={!hasBridge}>
              导出…
            </Button>
          </Row>
          <Row title="导入备份" description="合并模式保留现有数据;替换模式会先清空当前数据。">
            <Button icon={Upload} onClick={() => setBackupMode("import")} disabled={!hasBridge}>
              导入…
            </Button>
          </Row>
        </Card>

        <Card>
          <div className={styles.sectionHead}>
            <h3>关于</h3>
          </div>
          <dl className={styles.info}>
            <dt>版本</dt>
            <dd>{info?.version ?? "—"}</dd>
            <dt>Electron / Chrome</dt>
            <dd>
              {info?.electron ?? "—"} / {info?.chrome ?? "—"}
            </dd>
            <dt>账号页面 UA</dt>
            <dd>{info?.userAgent ?? "—"}</dd>
            <dt>数据目录</dt>
            <dd>{info?.userDataPath ?? "—"}</dd>
          </dl>
        </Card>

        <Card>
          <div className={styles.sectionHead}>
            <h3>最近操作记录</h3>
          </div>
          {audit.length === 0 ? (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>暂无记录</p>
          ) : (
            <div style={{ display: "grid", gap: 6, fontSize: "var(--text-xs)" }}>
              {audit.map((event) => (
                <div key={event.id} style={{ display: "flex", gap: 12, color: "var(--fg-muted)" }}>
                  <span style={{ flex: "0 0 110px" }}>{formatDateTime(event.createdAt)}</span>
                  <span style={{ color: "var(--fg)", fontFamily: "var(--font-mono)" }}>{event.action}</span>
                  <span className="truncate">{event.details ? JSON.stringify(event.details) : ""}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {backupMode ? <BackupModal mode={backupMode} onClose={() => setBackupMode(null)} /> : null}
    </div>
  );
}

function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div>
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

function Stepper({
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.stepper} style={{ opacity: disabled ? 0.5 : 1 }}>
      <button
        type="button"
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
        aria-label="减少"
      >
        <Minus size={14} />
      </button>
      <span className="num">{value}</span>
      <button
        type="button"
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
        aria-label="增加"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function BackupModal({ mode, onClose }: { mode: "export" | "import"; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useAccounts((s) => s.load);

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "export") {
        const meta = await api.backup.export({ password: password || undefined });
        if (meta)
          useToasts.getState().push({
            kind: "success",
            title: "备份已导出",
            message: `${meta.accountCount + (meta.globalAccountCount ?? 0)} 个账号${meta.encrypted ? " · 已加密" : ""}`,
          });
      } else {
        const result = await api.backup.import({
          password: password || undefined,
          mode: replace ? "replace" : "merge",
        });
        if (result) {
          useToasts.getState().push({
            kind: "success",
            title: "备份已导入",
            message: `${result.accountsImported} 个账号,请重新登录`,
          });
          await load();
        }
      }
      onClose();
    } catch (error) {
      useToasts.getState().push({
        kind: "error",
        title: mode === "export" ? "导出失败" : "导入失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={mode === "export" ? "导出备份" : "导入备份"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {mode === "export" ? "选择保存位置" : "选择备份文件"}
          </Button>
        </>
      }
    >
      <Field label={mode === "export" ? "备份密码(可选,至少 8 位)" : "备份密码(加密备份需要)"}>
        <TextInput
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === "export" ? "留空则不加密" : "未加密可留空"}
        />
      </Field>
      {mode === "import" ? (
        <Row title="替换现有数据" description="开启后先清空当前账号、数据与记录,再写入备份内容。">
          <Switch checked={replace} onChange={setReplace} />
        </Row>
      ) : null}
    </Modal>
  );
}
