import { useEffect, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Globe,
  LayoutDashboard,
  ListVideo,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  PanelLeftOpen,
  PanelLeftClose,
  MessageSquare,
  RotateCw,
  Send,
  Upload,
  X,
} from "lucide-react";
import type { GlobalAccount } from "@shared/global-accounts";
import { GLOBAL_PLATFORM_DEFINITIONS, type GlobalWebCapability } from "@shared/global-platforms";
import { globalWebErrorCode, type GlobalWebErrorCode, type GlobalWebState } from "@shared/global-web";
import { Button, IconButton, Menu, MenuItem } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { useToasts, useUi } from "@renderer/store";
import { isGlobalProxyEnabled, useNetwork } from "@renderer/store/network";
import { WorkspaceActions } from "@renderer/components/ui/WorkspaceActions";
import styles from "./global-website-workspace.module.css";

interface Props {
  account: GlobalAccount;
  onConfigureApi?(): void;
  onAccountChanged?(): void;
}
const links: ReadonlyArray<readonly [typeof Globe, string, GlobalWebCapability]> = [
  [Globe, "主页", "home"],
  [LayoutDashboard, "管理", "manage"],
  [Upload, "上传", "upload"],
  [BarChart3, "数据中心", "analytics"],
  [ListVideo, "作品", "works"],
  [MessageSquare, "评论", "comments"],
];
const phaseLabels: Record<GlobalWebState["phase"], string> = {
  closed: "未打开",
  checking: "正在检查代理",
  opening: "正在加载",
  open: "官网已打开",
  closing: "正在关闭",
  dormant: "已休眠",
  error: "页面暂不可用",
};
const errorLabels: Record<GlobalWebErrorCode, string> = {
  GLOBAL_WEB_PROXY_UNVERIFIED: "请开启代理后打开国外平台官网。",
  GLOBAL_WEB_BROWSER_UNAVAILABLE: "官网页面加载失败，请重试。",
  GLOBAL_WEB_PROFILE_BUSY: "账号的旧页面仍在关闭，请稍后重试。",
  GLOBAL_WEB_BUSY: "已达到同时打开的账号上限，请先关闭一个账号页面。",
  GLOBAL_WEB_CLEANUP_FAILED: "旧页面尚未关闭完成，请先重试关闭。",
  GLOBAL_WEB_UNAVAILABLE: "页面暂不可用，请重试。",
  GLOBAL_WEB_ROUTE_UNAVAILABLE: "暂时无法进入此页面，请先在官网完成登录。",
};
interface Lifetime {
  alive: boolean;
  revision: number;
  pending: boolean;
  state: GlobalWebState | null;
}

export function GlobalWebsiteWorkspace(props: Props) {
  return <MountedGlobalWebsiteWorkspace key={props.account.id} {...props} />;
}

function MountedGlobalWebsiteWorkspace({ account, onConfigureApi }: Props) {
  const definition = GLOBAL_PLATFORM_DEFINITIONS[account.platformId];
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  const [state, setState] = useState<GlobalWebState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GlobalWebErrorCode | null>(null);
  const lifetime = useRef<Lifetime | null>(null);
  const overlayCount = useUi((value) => value.overlayCount);
  const proxyOn = useNetwork(
    (value) => isGlobalProxyEnabled(value.snapshot.switching),
  );
  const open = state?.phase === "open";
  const transitioning =
    busy || state?.phase === "checking" || state?.phase === "opening" || state?.phase === "closing";
  const cleanupNeeded = error === "GLOBAL_WEB_CLEANUP_FAILED";

  useEffect(() => {
    const current: Lifetime = { alive: true, revision: 0, pending: false, state: null };
    lifetime.current = current;
    const accept = (next: GlobalWebState) => {
      if (!current.alive || next.accountId !== account.id) return;
      current.state = next;
      setState(next);
      setError(next.errorCode);
    };
    const unsubscribe = api.globalWeb.onChanged((next) => {
      if (!current.alive || next.accountId !== account.id) return;
      current.revision++;
      accept(next);
    });
    const revision = current.revision;
    void api.globalWeb
      .state(account.id)
      .then((next) => {
        if (revision === current.revision) accept(next);
      })
      .catch(() => {
        if (current.alive && revision === current.revision) setError("GLOBAL_WEB_UNAVAILABLE");
      });
    return () => {
      current.alive = false;
      unsubscribe();
    };
  }, [account.id]);

  const act = async (
    action: "open" | "close" | "chrome" | "standard" | GlobalWebCapability | "back" | "forward" | "reload",
  ) => {
    const current = lifetime.current;
    if (!hasBridge || !current?.alive || current.pending) return;
    current.pending = true;
    setBusy(true);
    setError(null);
    const revision = ++current.revision;
    const accept = (next: GlobalWebState) => {
      if (!current.alive || current.revision !== revision || next.accountId !== account.id) return;
      current.state = next;
      setState(next);
      setError(next.errorCode);
    };
    const isOpen = () => current.state?.phase === "open";
    try {
      if (action === "chrome") accept(await api.globalWeb.openChrome(account.id));
      else if (action === "standard") {
        await api.globalWorkspace.useBrowser(account.id, "embedded");
        if (current.alive) accept(await api.globalWeb.state(account.id));
      } else if (action === "close") accept(await api.globalWeb.close(account.id));
      else {
        if (!isOpen()) {
          const next = await (current.state?.engine === "chrome"
            ? api.globalWeb.openChrome(account.id)
            : api.globalWeb.open(account.id));
          accept(next);
          if (!current.alive || next.phase !== "open" || !isOpen()) return;
        }
        if (!current.alive) return;
        if (action === "back" || action === "forward" || action === "reload")
          await api.globalWeb.command(account.id, action);
        else if (action !== "open") await api.globalWeb.go(account.id, action);
      }
    } catch (failure) {
      if (!current.alive) return;
      const code = globalWebErrorCode(failure);
      if (code === "GLOBAL_WEB_ROUTE_UNAVAILABLE") {
        useToasts.getState().push({
          kind: "warning",
          title: "请先进入账号后台",
          message:
            account.platformId === "youtube" && ["analytics", "works", "comments"].includes(action)
              ? "请先在 YouTube Studio 完成登录并选择频道，再使用这个快捷入口。"
              : account.platformId === "x" && action === "comments"
                ? "请先在作品列表中打开要查看回复的帖子。"
                : errorLabels[code],
        });
      } else setError(code);
    } finally {
      current.pending = false;
      if (current.alive) setBusy(false);
    }
  };

  const disabled = !hasBridge || !proxyOn || transitioning || cleanupNeeded;
  const showNative = open && proxyOn && overlayCount === 0;
  return (
    <section className={styles.workspace} aria-label={`${account.displayName} 官网工作区`}>
      <header className={styles.toolbar}>
        <IconButton
          icon={sidebarHidden ? PanelLeftOpen : PanelLeftClose}
          label={sidebarHidden ? "显示账号栏" : "收起账号栏"}
          onClick={() => useUi.getState().toggleSidebar()}
        />
        <div className={styles.identity}>
          <span className={styles.avatar} data-platform={account.platformId}>
            {definition.name.slice(0, 1)}
          </span>
          <div>
            <strong title={account.displayName}>{account.displayName}</strong>
            <span>
              <i data-open={open} />
              {state ? phaseLabels[state.phase] : "正在读取状态"}
            </span>
          </div>
        </div>
        <div className={styles.browserControls}>
          <IconButton
            icon={ChevronLeft}
            label="后退"
            disabled={disabled || !open || state?.canGoBack === false}
            onClick={() => void act("back")}
          />
          <IconButton
            icon={ChevronRight}
            label="前进"
            disabled={disabled || !open || state?.canGoForward === false}
            onClick={() => void act("forward")}
          />
          <IconButton
            icon={RotateCw}
            label="刷新官网"
            disabled={disabled}
            onClick={() => void act("reload")}
          />
        </div>
        <button
          className={styles.address}
          title={state?.displayUrl ?? definition.entry}
          disabled={disabled}
          onClick={() => void act("manage")}
        >
          <LockKeyhole size={13} />
          <span>{state?.displayUrl ?? "页面尚未打开"}</span>
          <small>{state?.engine === "chrome" ? "Chrome" : definition.name}</small>
        </button>
        <IconButton
          icon={MoreHorizontal}
          label="浏览器选项"
          onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
        />
        <Menu anchor={menu} onClose={() => setMenu(null)}>
          <MenuItem
            disabled={disabled}
            onClick={() => {
              setMenu(null);
              void act(state?.engine === "chrome" ? "standard" : "chrome");
            }}
          >
            {state?.engine === "chrome" ? "切换到内置引擎" : "使用 Chrome"}
          </MenuItem>
          <MenuItem
            disabled={disabled || state?.engine !== "chrome"}
            onClick={() => {
              setMenu(null);
              void api.globalWorkspace
                .openLoginWindow(account.id)
                .catch(() => useToasts.getState().push({ kind: "warning", title: "普通登录窗口暂不可用" }));
            }}
          >
            在普通 Chrome 窗口登录
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(null);
              onConfigureApi?.();
            }}
          >
            官方 API（可选）
          </MenuItem>
          <MenuItem
            disabled={transitioning || (!open && !cleanupNeeded)}
            onClick={() => {
              setMenu(null);
              void act("close");
            }}
          >
            关闭官网页面
          </MenuItem>
        </Menu>
        <nav className={styles.navigation} aria-label="国外官网功能">
          <WorkspaceActions
            items={[
              ...links.map(([icon, label, capability]) => ({
                icon,
                label,
                disabled: disabled || !definition.capabilities[capability],
                onClick: () => void act(capability),
              })),
              {
                icon: Activity,
                label: "数据观测",
                onClick: () => {
                  useUi.getState().selectGlobalAccount(account.id);
                  useUi.getState().setRoute("metrics");
                },
              },
            ]}
          />
          <Button
            variant="primary"
            size="sm"
            icon={Send}
            onClick={() => {
              useUi.getState().selectGlobalAccount(account.id);
              useUi.getState().setRoute("publish");
            }}
          >
            发布
          </Button>
        </nav>
      </header>
      {error && open ? (
        <div className={styles.error} role="alert">
          {errorLabels[error]}
        </div>
      ) : null}
      <div className={styles.body}>
        <div className={styles.content}>
          <GlobalEmbeddedViewport accountId={account.id} visible={showNative} />
          {!open ? (
            <div className={styles.empty}>
              <span className={styles.emptyIcon}>
                {transitioning ? <LoaderCircle size={27} className={styles.spin} /> : <Globe size={27} />}
              </span>
              <h2>
                {transitioning
                  ? "正在打开独立登录环境"
                  : !proxyOn
                    ? "国外平台已休眠"
                    : `登录 ${definition.name}`}
              </h2>
              <p>
                {!hasBridge
                  ? "请在桌面工作台中打开账号官网。"
                  : error
                    ? errorLabels[error]
                    : !proxyOn
                      ? "开启代理后，可在软件内登录和使用国外平台。"
                      : "在官方页面完成登录，登录状态独立保存。"}
              </p>
              <Button
                variant="primary"
                icon={cleanupNeeded ? X : Globe}
                disabled={!hasBridge || transitioning || (!proxyOn && !cleanupNeeded)}
                onClick={() => void act(cleanupNeeded ? "close" : "open")}
              >
                {cleanupNeeded ? "重试关闭" : transitioning ? "正在加载…" : "打开官网"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// Native views sit above DOM overlays. Serialize shows so an old account's late
// IPC completion cannot cover a modal or hide a newly selected account's view.
let visibilityTransition: Promise<void> = Promise.resolve();
function GlobalEmbeddedViewport({ accountId, visible }: { accountId: string; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !visible) {
      void api.globalWeb.hide?.(accountId)?.catch(() => undefined);
      return;
    }
    let cancelled = false;
    let frame: number | undefined;
    let lastBounds = "";
    const sync = () => {
      if (cancelled) return;
      const rect = el.getBoundingClientRect();
      const bounds = {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      if (bounds.width < 2 || bounds.height < 2) return;
      const key = JSON.stringify(bounds);
      if (key === lastBounds) return;
      lastBounds = key;
      visibilityTransition = visibilityTransition
        .then(async () => {
          if (cancelled) return;
          try {
            await api.globalWeb.show?.(accountId, bounds);
          } finally {
            if (cancelled) await api.globalWeb.hide?.(accountId);
          }
        })
        .catch(() => undefined);
    };
    sync();
    const resize = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        sync();
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    window.addEventListener("resize", resize);
    // Follow rail/sidebar transitions as well as changes in viewport size.
    const timer = window.setInterval(sync, 120);
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.clearInterval(timer);
      void api.globalWeb.hide?.(accountId)?.catch(() => undefined);
    };
  }, [accountId, visible]);
  return <div ref={ref} className={styles.viewport} aria-label="官网页面显示区域" data-open={visible} />;
}
