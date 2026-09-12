import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Globe, Plus, RefreshCw, Trash2, Unplug, X } from "lucide-react";
import { GLOBAL_PLATFORM_IDS, type GlobalPlatformId } from "@shared/platforms";
import type { GlobalAccount } from "@shared/global-accounts";
import { Badge, Button, Card, IconButton, Modal } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { useUi, useGlobalAccounts } from "@renderer/store";
import { isGlobalProxyEnabled, useNetwork } from "@renderer/store/network";
import styles from "./global.module.css";
import pageStyles from "./global-accounts-page.module.css";
import { AddGlobalAccountModal } from "./AddGlobalAccountModal";
import { GlobalAppsPanel } from "./GlobalAppsPanel";
import { GlobalOAuthControls } from "./GlobalOAuthControls";
import { GlobalReadPanel } from "./GlobalReadPanel";
import { GlobalUploadPanel } from "./GlobalUploadPanel";
import { GlobalWebsiteWorkspace } from "./GlobalWebsiteWorkspace";

const NAMES: Record<GlobalPlatformId, string> = { youtube: "YouTube", tiktok: "TikTok", x: "X" };
const AUTH_LABELS: Record<GlobalAccount["authStatus"], string> = {
  unauthorized: "未授权",
  authorized: "已有授权记录",
  reauthorization_required: "需要重新授权",
};

export function GlobalAccountsPage() {
  const accounts = useGlobalAccounts((s) => s.accounts);
  const setAccounts = (value: GlobalAccount[] | ((rows: GlobalAccount[]) => GlobalAccount[])) =>
    useGlobalAccounts.setState((state) => ({
      accounts: typeof value === "function" ? value(state.accounts) : value,
    }));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<GlobalAccount | null>(null);
  const [disconnecting, setDisconnecting] = useState<GlobalAccount | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<"web" | "api">("web");
  const [filter, setFilter] = useState<GlobalPlatformId | "all">("all");
  const [adding, setAdding] = useState<{ platformId: GlobalPlatformId } | null>(null);
  const selectedId = useUi((s) => s.activeGlobalAccountId);
  const setSelectedId = useUi((s) => s.selectGlobalAccount);
  const switching = useNetwork((state) => state.snapshot.switching);
  const revision = useRef(0);
  const mounted = useRef(true);
  const selected = accounts.find((account) => account.id === selectedId) ?? accounts[0] ?? null;

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const initialRevision = ++revision.current;
    void api.globalAccounts
      .list()
      .then((rows) => {
        if (active && initialRevision === revision.current) {
          setAccounts(rows);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active && initialRevision === revision.current) {
          setError("国外账号读取失败，请重试。");
          setLoaded(true);
        }
      });
    return () => {
      active = false;
      mounted.current = false;
      revision.current += 1;
    };
  }, []);
  useEffect(() => {
    const select = (event: Event) => {
      useUi.getState().selectGlobalAccount((event as CustomEvent<string>).detail);
      setMode("web");
      setMessage(null);
    };
    window.addEventListener("clipdock:select-global-account", select);
    return () => {
      window.removeEventListener("clipdock:select-global-account", select);
    };
  }, []);

  const refresh = async () => {
    const current = ++revision.current;
    setBusy(true);
    setError(null);
    try {
      const rows = await api.globalAccounts.list();
      if (mounted.current && current === revision.current) {
        setAccounts(rows);
        setLoaded(true);
      }
    } catch {
      if (mounted.current && current === revision.current) setError("国外账号读取失败，请重试。");
    } finally {
      if (mounted.current && current === revision.current) setBusy(false);
    }
  };
  const created = (account: GlobalAccount) => {
    revision.current += 1;
    setAccounts((rows) => [...rows.filter((row) => row.id !== account.id), account]);
    setLoaded(true);
    setBusy(false);
    setError(null);
    setSelectedId(account.id);
    setMode("web");
    window.dispatchEvent(new CustomEvent("clipdock:select-global-account", { detail: account.id }));
    // A shortcut can open the dialog before the initial list has returned.
    // Refresh after committing so existing accounts are not lost from this view.
    if (!loaded) void refresh();
  };
  const remove = async () => {
    if (!deleting || busy) return;
    revision.current += 1;
    setBusy(true);
    setError(null);
    try {
      await api.globalAccounts.delete(deleting.id);
      setAccounts((rows) => rows.filter((account) => account.id !== deleting.id));
      if (selected?.id === deleting.id) setSelectedId(null);
      window.dispatchEvent(new CustomEvent("clipdock:global-accounts-changed"));
      setDeleting(null);
    } catch {
      setError("国外账号删除失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!disconnecting || busy) return;
    revision.current += 1;
    setBusy(true);
    setDisconnectError(null);
    try {
      const saved = await api.globalAccounts.disconnect(disconnecting.id);
      setAccounts((rows) => rows.map((row) => (row.id === saved.id ? saved : row)));
      setDisconnecting(null);
      setMessage("本机授权已清除，账号记录已保留。平台端的应用授权未被撤销。");
    } catch {
      setDisconnectError("清除本机授权失败，原记录已保留，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.utilityBar} hidden={mode === "web"}>
        {mode === "api" ? (
          <Button icon={ArrowLeft} variant="ghost" size="sm" onClick={() => setMode("web")}>
            返回官网
          </Button>
        ) : (
          <span className={pageStyles.utilityLabel}>独立账号 · 官方网页登录</span>
        )}
        <Button
          icon={Plus}
          variant="ghost"
          size="sm"
          disabled={!loaded || busy}
          onClick={() => setAdding({ platformId: selected?.platformId ?? "youtube" })}
        >
          添加账号
        </Button>
        <IconButton
          icon={RefreshCw}
          label="刷新国外账号列表"
          size="sm"
          disabled={busy}
          onClick={() => void refresh()}
        />
        <Button
          variant={mode === "api" ? "soft" : "ghost"}
          size="sm"
          aria-pressed={mode === "api"}
          onClick={() => setMode(mode === "api" ? "web" : "api")}
        >
          官方 API（可选）
        </Button>
        {mode === "web" && selected ? (
          <IconButton
            icon={Trash2}
            label={`删除 ${selected.displayName}`}
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              setDeleting(selected);
            }}
          />
        ) : null}
      </div>
      {message ? (
        <div className={pageStyles.notice} role="status">
          <p>{message}</p>
          <IconButton icon={X} label="关闭提示" size="sm" onClick={() => setMessage(null)} />
        </div>
      ) : null}
      {error && !deleting ? (
        <p role="alert" className={pageStyles.error}>
          {error}
        </p>
      ) : null}
      {mode === "web" ? (
        <div className={pageStyles.workspace}>
          {selected ? (
            <GlobalWebsiteWorkspace
              key={selected.id}
              account={selected}
              onConfigureApi={() => setMode("api")}
              onAccountChanged={() => void refresh()}
            />
          ) : (
            <div className={pageStyles.empty}>
              <div className={pageStyles.emptyIcon}>
                <Globe size={26} />
              </div>
              <h2>{loaded ? "添加你的第一个国外账号" : "正在读取国外账号…"}</h2>
              {loaded ? (
                <>
                  <p>选择 YouTube、TikTok 或 X，在软件内打开官方页面登录。每个账号保留独立的登录环境。</p>
                  <Button icon={Plus} variant="primary" onClick={() => setAdding({ platformId: "youtube" })}>
                    添加国外账号
                  </Button>
                  <Button variant="ghost" onClick={() => setMode("api")}>
                    官方 API（可选）
                  </Button>
                </>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div className={pageStyles.api}>
          <Card className={styles.notice}>
            <Globe size={20} aria-hidden />
            <div>
              <strong>官方 API 增强功能</strong>
              <p>配置开发者应用后，按需授权读取数据或上传。网页登录可直接在官网工作区使用，无需配置此处。</p>
              <p>
                {isGlobalProxyEnabled(switching)
                  ? "已检测到代理开启，仍需完成代理链路验证和官方授权才能运行国际业务。"
                  : "国外平台已休眠，开启代理后即可使用。"}
              </p>
            </div>
          </Card>
          <GlobalAppsPanel onChanged={() => void refresh()} />
          <div className={styles.platformFilters} role="group" aria-label="国外平台分类">
            {(["all", ...GLOBAL_PLATFORM_IDS] as const).map((id) => (
              <Button
                key={id}
                aria-pressed={filter === id}
                variant={filter === id ? "soft" : "ghost"}
                onClick={() => setFilter(id)}
              >
                {id === "all" ? "全部平台" : NAMES[id]} ·{" "}
                {accounts.filter((account) => id === "all" || account.platformId === id).length}
              </Button>
            ))}
          </div>
          <section className={styles.list} aria-label="国际账号记录" aria-busy={!loaded || busy}>
            {!loaded ? (
              <p>正在读取国际账号…</p>
            ) : !accounts.some((account) => filter === "all" || account.platformId === filter) ? (
              <Card>
                <p>还没有此平台的账号记录，请先添加账号。</p>
              </Card>
            ) : null}
            {accounts
              .filter((account) => filter === "all" || account.platformId === filter)
              .map((account) => (
                <div key={account.id} id={`global-account-${account.id}`}>
                  <Card>
                    <div className={styles.row}>
                      <div>
                        <span className={styles.platform}>{NAMES[account.platformId]}</span>
                        <h2>{account.displayName}</h2>
                        <Badge>{AUTH_LABELS[account.authStatus]}</Badge>
                      </div>
                      <div className={styles.actions}>
                        <GlobalOAuthControls account={account} onAuthorized={() => void refresh()} />
                        {account.authStatus !== "unauthorized" ? (
                          <Button
                            icon={Unplug}
                            variant="ghost"
                            disabled={busy}
                            aria-label={`清除 ${account.displayName} 的本机授权`}
                            onClick={() => {
                              setDisconnectError(null);
                              setMessage(null);
                              setDisconnecting(account);
                            }}
                          >
                            清除本机授权
                          </Button>
                        ) : null}
                        <Button
                          icon={Trash2}
                          variant="ghost"
                          disabled={busy}
                          aria-label={`删除 ${account.displayName}`}
                          onClick={() => {
                            setError(null);
                            setDeleting(account);
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                    <GlobalReadPanel account={account} onAccountChanged={() => void refresh()} />
                    <GlobalUploadPanel account={account} />
                  </Card>
                </div>
              ))}
          </section>
        </div>
      )}
      {adding ? (
        <AddGlobalAccountModal
          key={adding.platformId}
          initialPlatform={adding.platformId}
          onClose={() => setAdding(null)}
          onCreated={created}
          onNotice={(notice) => {
            if (mounted.current) setMessage(notice);
          }}
        />
      ) : null}
      {disconnecting ? (
        <Modal
          open
          title="清除本机授权"
          onClose={() => {
            if (!busy) setDisconnecting(null);
          }}
          footer={
            <>
              <Button disabled={busy} onClick={() => setDisconnecting(null)}>
                取消
              </Button>
              <Button variant="danger" loading={busy} onClick={() => void disconnect()}>
                确认清除本机授权
              </Button>
            </>
          }
        >
          <p>
            清除“{disconnecting.displayName}
            ”在这台电脑保存的授权凭据和远端身份，保留账号名称及记录。此操作不会在平台端撤销应用授权；如需彻底解除，请到平台的已授权应用设置中操作。
          </p>
          {disconnectError ? (
            <div role="alert" className={styles.error}>
              {disconnectError}
            </div>
          ) : null}
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          open
          title="删除国际账号记录"
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
          footer={
            <>
              <Button disabled={busy} onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button variant="danger" loading={busy} onClick={() => void remove()}>
                确认删除
              </Button>
            </>
          }
        >
          <p>
            关闭“{deleting.displayName}”的官网页面，删除本机账号记录、此账号的登录数据及 API
            授权凭据。平台上的账号和内容不受影响。
          </p>
          {error ? (
            <p role="alert" className={pageStyles.error}>
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
