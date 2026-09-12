import { useCallback, useEffect, useMemo, useState } from "react";
import { PlatformLogo } from "@renderer/components/ui/PlatformLogo";
import { AccountLoginStatus } from "@renderer/components/ui/AccountLoginStatus";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Globe,
  LayoutDashboard,
  ListVideo,
  Lock,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  QrCode,
  RotateCw,
  Send,
  Upload,
  Users,
  X,
} from "lucide-react";
import { getPlatform, platformEntryUrl } from "@shared/platforms";
import type { Account } from "@shared/types";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  IconButton,
  STATUS_TONE,
  Spinner,
  StatusDot,
  cx,
} from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { useAccounts, useToasts, useUi, useViews } from "@renderer/store";
import { AccountMenu } from "@renderer/features/accounts/AccountMenu";
import { ViewHost } from "./ViewHost";
import { DataDrawer } from "./DataDrawer";
import { ObservePanel } from "./ObservePanel";
import { WorkspaceActions } from "@renderer/components/ui/WorkspaceActions";
import styles from "./workspace.module.css";

type QuickRoute = "site" | "home" | "upload" | "analytics" | "works" | "comments";

/**
 * 主页 = the platform's consumer site (browse / watch in this login);
 * 管理 = the creator console. Platforms without a consumer web product hide
 * 主页 and 管理 is the first entry.
 */
const QUICK: Array<{ route: QuickRoute; label: string; icon: typeof Globe }> = [
  { route: "site", label: "主页", icon: Globe },
  { route: "home", label: "管理", icon: LayoutDashboard },
  { route: "upload", label: "上传", icon: Upload },
  { route: "analytics", label: "数据中心", icon: BarChart3 },
  { route: "works", label: "作品", icon: ListVideo },
  { route: "comments", label: "评论", icon: MessageSquare },
];

export function AccountWorkspace() {
  const activeId = useUi((s) => s.activeAccountId);
  const entryRevision = useUi((s) => s.accountEntryRevision);
  const account = useAccounts((s) => s.accounts.find((a) => a.id === activeId));
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);

  if (!account) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <EmptyState
          icon={Users}
          title="选择一个账号开始"
          description="左侧账号列表中选择账号,右侧会显示该账号独立登录环境中的平台页面;也可以先添加新账号。"
          action={
            <Button variant="primary" icon={QrCode} onClick={() => setAddAccountOpen(true)}>
              添加账号
            </Button>
          }
        />
      </div>
    );
  }
  return <Workspace key={`${account.id}:${entryRevision}`} account={account} />;
}

function Workspace({ account }: { account: Account }) {
  const entryUrl = useUi((s) => s.accountEntryUrl);
  const platform = getPlatform(account.platformId);
  const view = useViews((s) => s.states[account.id]);
  const drawerOpen = useUi((s) => s.drawerOpen);
  const toggleDrawer = useUi((s) => s.toggleDrawer);
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const setRoute = useUi((s) => s.setRoute);
  // `address` is only meaningful while the operator edits; otherwise the
  // input shows the live URL, so no state sync is needed.
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [observing, setObserving] = useState(false);
  const pushOverlay = useUi((s) => s.pushOverlay);
  const popOverlay = useUi((s) => s.popOverlay);

  const quickLinks = useMemo(() => QUICK.filter((q) => Boolean(platform.routes[q.route])), [platform]);

  const activeQuick = useMemo<QuickRoute | null>(() => {
    const url = view?.url ?? "";
    // Longest matching route wins so `home` does not shadow `upload` etc.
    let best: { route: QuickRoute; length: number } | null = null;
    for (const q of quickLinks) {
      const target = (platform.routes[q.route] as string).replace(/[?#].*$/, "");
      if (url.startsWith(target) && (!best || target.length > best.length))
        best = { route: q.route, length: target.length };
    }
    return best?.route ?? null;
  }, [view?.url, platform, quickLinks]);

  const go = useCallback(
    (route: QuickRoute) => {
      setObserving(false);
      void api.views
        .go(account.id, route)
        .catch((error: Error) =>
          useToasts.getState().push({ kind: "error", title: "跳转失败", message: error.message }),
        );
    },
    [account.id],
  );

  // The observe panel is rendered over the pane, so the native view must be
  // hidden while it is open (it would otherwise paint above the panel). The
  // effect also releases the overlay when the workspace unmounts mid-observe.
  useEffect(() => {
    if (!observing) return undefined;
    pushOverlay();
    return () => popOverlay();
  }, [observing, pushOverlay, popOverlay]);
  const toggleObserve = useCallback(() => setObserving((open) => !open), []);

  const navigateAddress = () => {
    setEditing(false);
    const target = address.trim();
    if (!target || target === view?.url) return;
    void api.views
      .navigate(account.id, target)
      .catch((error: Error) =>
        useToasts.getState().push({ kind: "warning", title: "无法打开", message: error.message }),
      );
  };

  const displayUrl = (() => {
    try {
      const u = new URL(view?.url ?? "");
      return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      return view?.url ?? "";
    }
  })();

  const error = view?.lastError && view.lastError !== dismissedError ? view.lastError : hostError;

  return (
    <div className={cx(styles.workspace, drawerOpen && styles.drawerOpen)}>
      <header className={styles.topbar}>
        <IconButton
          icon={sidebarHidden ? PanelLeftOpen : PanelLeftClose}
          label={sidebarHidden ? "显示账号栏" : "收起账号栏(给页面更多空间)"}
          onClick={toggleSidebar}
        />
        <div className={styles.identity}>
          <Avatar
            src={account.avatarUrl}
            name={account.displayName}
            color={platform.color}
            size={32}
            round
            badge={<PlatformLogo platformId={platform.id} size={16} />}
            badgeColor={platform.color}
          />
          <div className={styles.identityText}>
            <strong title={account.displayName}>{account.displayName}</strong>
            <span>
              <AccountLoginStatus account={account} />
              {account.handle ? <span className="truncate">· {account.handle}</span> : null}
            </span>
          </div>
        </div>

        <div className={styles.navGroup}>
          <IconButton
            icon={ChevronLeft}
            label="后退"
            disabled={!view?.canGoBack}
            onClick={() => void api.views.back(account.id)}
          />
          <IconButton
            icon={ChevronRight}
            label="前进"
            disabled={!view?.canGoForward}
            onClick={() => void api.views.forward(account.id)}
          />
          {view?.loading ? (
            <IconButton icon={X} label="停止" onClick={() => void api.views.stop(account.id)} />
          ) : (
            <IconButton icon={RotateCw} label="刷新" onClick={() => void api.views.reload(account.id)} />
          )}
        </div>

        <form
          className={styles.address}
          onSubmit={(e) => {
            e.preventDefault();
            navigateAddress();
          }}
        >
          {view?.loading ? <Spinner /> : <Lock size={13} className={styles.lock} />}
          <input
            value={editing ? address : displayUrl}
            onFocus={() => {
              setEditing(true);
              setAddress(view?.url ?? "");
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
            placeholder={platformEntryUrl(platform.id)}
            spellCheck={false}
            aria-label="页面地址"
          />
          <Badge tone={STATUS_TONE[account.status]}>{platform.shortName}</Badge>
        </form>

        <div className={styles.quickLinks}>
          <WorkspaceActions
            items={[
              ...quickLinks.map((q) => ({
                icon: q.icon,
                label: q.label,
                active: !observing && activeQuick === q.route,
                onClick: () => go(q.route),
              })),
              { icon: Activity, label: "数据观测", active: observing, onClick: toggleObserve },
            ]}
          />
        </div>

        <div className={styles.topbarActions}>
          <Button variant="soft" size="sm" icon={Send} onClick={() => setRoute("publish")}>
            发布
          </Button>
          <IconButton
            icon={drawerOpen ? PanelRightClose : PanelRightOpen}
            label={drawerOpen ? "收起数据面板" : "展开数据面板"}
            active={drawerOpen}
            onClick={() => toggleDrawer()}
          />
          <IconButton
            icon={MoreHorizontal}
            label="更多"
            onClick={(e) => setMenuAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}
          />
        </div>
      </header>

      <div className={styles.hostWrap}>
        {observing ? <ObservePanel account={account} onClose={toggleObserve} /> : null}
        {hasBridge ? (
          <ViewHost accountId={account.id} initialUrl={entryUrl} onError={setHostError} />
        ) : (
          <div className={styles.placeholder}>
            <div className={styles.placeholderCard}>
              <div className={styles.placeholderIcon}>
                <Lock size={26} />
              </div>
              <h3>浏览器预览模式</h3>
              <p>
                在桌面端运行时,这里会显示 {platform.name} 的官方创作者页面(独立 Cookie
                环境),可直接扫码登录、刷视频、上传作品。
              </p>
            </div>
          </div>
        )}
        {hasBridge && !view ? (
          <div className={styles.placeholder}>
            <div className={styles.placeholderCard}>
              <div className={styles.placeholderIcon}>
                <Spinner />
              </div>
              <h3>正在加载独立登录环境</h3>
              <p>首次打开会加载 {platform.name} 官方页面,登录后状态会自动更新。</p>
            </div>
          </div>
        ) : null}
        {view &&
        !view.loading &&
        (account.checkInfo?.state !== "confirmed" ||
          account.status === "offline" ||
          account.status === "unknown") &&
        !view.isLoginPage ? (
          <div className={styles.statusBar}>
            <StatusDot status={account.status} />
            {account.checkInfo?.reason ?? "等待平台网页确认身份"}
          </div>
        ) : null}
        {error ? (
          <div className={styles.errorBar}>
            <AlertTriangle size={14} />
            <span>{humanizeError(error)}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setHostError(null);
                void api.views
                  .reload(account.id)
                  .catch((error: Error) =>
                    useToasts
                      .getState()
                      .push({ kind: "error", title: "重新加载失败", message: error.message }),
                  );
              }}
            >
              重新加载
            </Button>
            <IconButton
              icon={X}
              label="关闭"
              size="sm"
              onClick={() => {
                setDismissedError(view?.lastError ?? null);
                setHostError(null);
              }}
            />
          </div>
        ) : null}
      </div>

      <aside className={styles.drawer} aria-hidden={!drawerOpen}>
        {drawerOpen ? <DataDrawer account={account} onClose={() => toggleDrawer(false)} /> : null}
      </aside>

      {menuAnchor ? (
        <AccountMenu account={account} anchor={menuAnchor} onClose={() => setMenuAnchor(null)} />
      ) : null}
    </div>
  );
}

function humanizeError(error: string): string {
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(error))
    return "网络连接失败,请检查网络后重试";
  if (/ERR_TIMED_OUT/i.test(error)) return "页面加载超时";
  if (/renderer:/i.test(error)) return "页面进程已退出,点击重新加载";
  return `页面加载出错:${error}`;
}
