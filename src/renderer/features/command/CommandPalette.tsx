import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowUpRight,
  BarChart3,
  CornerDownLeft,
  FolderOpen,
  Globe2,
  LayoutDashboard,
  Search,
  Send,
  Settings2,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Modal, cx } from "@renderer/components/ui";
import { PlatformLogo } from "@renderer/components/ui/PlatformLogo";
import { useAccounts, useGlobalAccounts, useUi, type Route } from "@renderer/store";
import { GLOBAL_PLATFORM_DEFINITIONS } from "@shared/global-platforms";
import { PLATFORMS } from "@shared/platforms";
import styles from "./command.module.css";

interface Command {
  id: string;
  label: string;
  detail: string;
  keywords: string;
  group: "页面" | "国内账号" | "国外账号";
  icon?: LucideIcon;
  platformId?: string;
  run(): void;
}

const PAGES: ReadonlyArray<{
  route: Route;
  label: string;
  detail: string;
  keywords: string;
  icon: LucideIcon;
  scope?: "domestic" | "global";
}> = [
  {
    route: "overview",
    label: "工作台总览",
    detail: "查看当前范围的账号与数据",
    keywords: "首页 dashboard overview",
    icon: LayoutDashboard,
  },
  {
    route: "creator",
    scope: "domestic",
    label: "国内创作者平台",
    detail: "抖音、快手、小红书、B 站等",
    keywords: "国内 账号 工作区 domestic creator",
    icon: UsersRound,
  },
  {
    route: "creator",
    scope: "global",
    label: "国外创作者平台",
    detail: "YouTube、TikTok 与 X",
    keywords: "海外 国外 国际 账号 global creator",
    icon: Globe2,
  },
  {
    route: "metrics",
    label: "数据观测",
    detail: "查看采集结果与变化趋势",
    keywords: "分析 统计 粉丝 播放 metrics analytics",
    icon: BarChart3,
  },
  {
    route: "assets",
    label: "素材库",
    detail: "整理视频、图片与发布素材",
    keywords: "文件 素材 图片 视频 assets media",
    icon: FolderOpen,
  },
  {
    route: "publish",
    label: "发布助手",
    detail: "准备文案与发布任务",
    keywords: "发作品 上传 草稿 publish upload",
    icon: Send,
  },
  {
    route: "settings",
    label: "设置",
    detail: "调整工作台与数据管理偏好",
    keywords: "配置 主题 备份 settings preferences",
    icon: Settings2,
  },
];

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().trim();

/** Mount once in the shell. Search uses the same live account stores as the sidebars. */
export function CommandPalette() {
  const open = useUi((state) => state.searchOpen);
  const setOpen = useUi((state) => state.setSearchOpen);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "k"
      )
        return;
      const ui = useUi.getState();
      // Do not stack this panel over account creation or an in-progress edit.
      if (!ui.searchOpen && ui.overlayCount > 0) return;
      event.preventDefault();
      event.stopPropagation();
      ui.setSearchOpen(!ui.searchOpen);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <Modal open={open} title="快速前往" icon={<Search size={19} />} onClose={() => setOpen(false)}>
      {open ? <CommandContents onClose={() => setOpen(false)} /> : null}
    </Modal>
  );
}

/** Optional visible entry point; a compact variant fits a collapsed navigation rail. */
export function CommandTrigger({ compact = false, className }: { compact?: boolean; className?: string }) {
  const setOpen = useUi((state) => state.setSearchOpen);
  const shortcut =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";
  return (
    <button
      type="button"
      className={cx(styles.trigger, compact && styles.compact, className)}
      onClick={() => setOpen(true)}
      title={`搜索页面与账号（${shortcut}）`}
      aria-label="搜索页面与账号"
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+k Meta+k"
    >
      <Search size={16} aria-hidden="true" />
      {!compact && (
        <>
          <span>快速前往</span>
          <kbd>{shortcut}</kbd>
        </>
      )}
    </button>
  );
}

function CommandContents({ onClose }: { onClose(): void }) {
  const accounts = useAccounts((state) => state.accounts);
  const accountsLoaded = useAccounts((state) => state.loaded);
  const accountsError = useAccounts((state) => state.loadError);
  const globalAccounts = useGlobalAccounts((state) => state.accounts);
  const globalLoaded = useGlobalAccounts((state) => state.loaded);
  const globalError = useGlobalAccounts((state) => state.error);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(
    () => [
      ...PAGES.map((page) => ({
        id: `page:${page.route}:${page.scope ?? "current"}`,
        label: page.label,
        detail: page.detail,
        keywords: page.keywords,
        icon: page.icon,
        group: "页面" as const,
        run: () => {
          if (page.scope) useUi.getState().setCreatorMode(page.scope);
          useUi.getState().setRoute(page.route);
        },
      })),
      ...accounts.map((account) => ({
        id: `domestic:${account.id}`,
        label: account.displayName,
        detail: `${PLATFORMS[account.platformId].name} · ${account.handle || account.externalId || "国内账号"}`,
        keywords: `${account.platformId} ${PLATFORMS[account.platformId].shortName} ${account.handle ?? ""} ${account.externalId ?? ""} ${account.note ?? ""} 国内`,
        platformId: account.platformId,
        group: "国内账号" as const,
        run: () => {
          // Account identity is always its stored ID, never a display-name lookup.
          if (useAccounts.getState().accounts.some((row) => row.id === account.id))
            useUi.getState().openAccount(account.id);
        },
      })),
      ...globalAccounts.map((account) => ({
        id: `global:${account.id}`,
        label: account.displayName,
        detail: `${GLOBAL_PLATFORM_DEFINITIONS[account.platformId].name} · ${account.remoteId || "国外账号"}`,
        keywords: `${account.platformId} ${account.remoteId ?? ""} ${account.note ?? ""} 国外 海外 国际`,
        platformId: account.platformId,
        group: "国外账号" as const,
        run: () => {
          if (!useGlobalAccounts.getState().accounts.some((row) => row.id === account.id)) return;
          useUi.getState().openGlobalAccount(account.id);
          // Existing creator pages may be showing the API tab; explicit entry returns to the website.
          window.dispatchEvent(new CustomEvent("clipdock:select-global-account", { detail: account.id }));
        },
      })),
    ],
    [accounts, globalAccounts],
  );

  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const results = commands.filter((command) => {
    const haystack = normalize(`${command.label} ${command.detail} ${command.keywords}`);
    return terms.every((term) => haystack.includes(term));
  });
  const activeIndex = Math.max(
    0,
    results.findIndex((command) => command.id === selectedId),
  );
  const activeCommand = results[activeIndex];
  const activeOptionId = activeCommand ? `${id}-option-${activeIndex}` : undefined;

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  const execute = (command: Command) => {
    onClose();
    command.run();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length)
        setSelectedId(
          results[(activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length].id,
        );
    } else if (event.key === "Enter" && activeCommand) {
      event.preventDefault();
      execute(activeCommand);
    }
  };

  return (
    <div className={styles.content}>
      <div className={styles.search}>
        <Search size={20} aria-hidden="true" />
        <input
          role="combobox"
          aria-label="搜索页面、平台或账号"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${id}-results`}
          aria-activedescendant={activeOptionId}
          aria-describedby={`${id}-help`}
          placeholder="输入页面、平台、账号名称或 ID…"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedId(null);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd aria-hidden="true">ESC</kbd>
      </div>
      <div className={styles.summary} role="status" aria-live="polite" aria-atomic="true">
        {terms.length ? `找到 ${results.length} 个结果` : "页面与全部平台账号"}
        <span>{accounts.length + globalAccounts.length} 个已读取账号</span>
      </div>
      {(accountsError || globalError) && (
        <p className={styles.notice} role="alert">
          {accountsError ? "国内" : ""}
          {accountsError && globalError ? "、" : ""}
          {globalError ? "国外" : ""}账号读取失败，当前仅显示已读取的账号。
        </p>
      )}
      {((!accountsLoaded && !accountsError) || (!globalLoaded && !globalError)) && (
        <p className={styles.notice}>正在读取账号，搜索结果会自动更新…</p>
      )}
      <div
        ref={listRef}
        id={`${id}-results`}
        className={styles.results}
        role="listbox"
        aria-label="快速前往结果"
      >
        {results.map((command, index) => {
          const Icon = command.icon;
          return (
            <div key={command.id}>
              {(index === 0 || results[index - 1].group !== command.group) && (
                <div className={styles.group} aria-hidden="true">
                  {command.group}
                </div>
              )}
              <button
                type="button"
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={activeIndex === index}
                className={cx(styles.result, activeIndex === index && styles.selected)}
                tabIndex={-1}
                onMouseEnter={() => setSelectedId(command.id)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => execute(command)}
              >
                <span className={styles.icon}>
                  {Icon ? (
                    <Icon size={18} aria-hidden="true" />
                  ) : (
                    <PlatformLogo platformId={command.platformId!} size={24} />
                  )}
                </span>
                <span className={styles.label}>
                  <strong>{command.label}</strong>
                  <small>{command.detail}</small>
                </span>
                <ArrowUpRight size={16} aria-hidden="true" className={styles.arrow} />
              </button>
            </div>
          );
        })}
      </div>
      {results.length === 0 && (
        <div className={styles.empty}>
          <Search size={26} aria-hidden="true" />
          <strong>没有匹配的页面或账号</strong>
          <span>试试平台名称、账号昵称或更短的关键词。</span>
        </div>
      )}
      <div id={`${id}-help`} className={styles.footer}>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> 选择
        </span>
        <span>
          <CornerDownLeft size={13} aria-hidden="true" /> Enter 打开
        </span>
        <span>Esc 关闭</span>
      </div>
    </div>
  );
}
