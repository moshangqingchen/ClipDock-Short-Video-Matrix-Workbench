import { useGlobalAccounts, useUi } from "@renderer/store";
import { PlatformLogo } from "@renderer/components/ui/PlatformLogo";
import { usePlatformCollapse } from "./usePlatformCollapse";
import { GlobalAccountMenu } from "@renderer/features/global/GlobalAccountMenu";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Plus, RefreshCw, Search, MoreHorizontal } from "lucide-react";
import type { GlobalAccount } from "@shared/global-accounts";
import type { GlobalPlatformId } from "@shared/platforms";
import type { GlobalWebState } from "@shared/global-web";
import { Avatar, Button, IconButton, TextInput, cx } from "@renderer/components/ui";
import { CreatorModeSelect } from "@renderer/features/creator/CreatorModeSelect";
import styles from "./layout.module.css";

const PLATFORMS: ReadonlyArray<{ id: GlobalPlatformId; name: string; glyph: string; color: string }> = [
  { id: "youtube", name: "YouTube", glyph: "Y", color: "#e11d48" },
  { id: "tiktok", name: "TikTok", glyph: "♪", color: "#111827" },
  { id: "x", name: "X", glyph: "𝕏", color: "#111827" },
];
const phaseLabel: Record<GlobalWebState["phase"], string> = {
  closed: "未打开",
  checking: "验证中",
  opening: "打开中",
  open: "已打开",
  closing: "关闭中",
  dormant: "休眠",
  error: "需处理",
};

export function GlobalAccountSidebar() {
  const accounts = useGlobalAccounts((s) => s.accounts),
    states = useGlobalAccounts((s) => s.states),
    identities = useGlobalAccounts((s) => s.identities);
  const loaded = useGlobalAccounts((s) => s.loaded),
    error = useGlobalAccounts((s) => s.error),
    load = useGlobalAccounts((s) => s.load);
  const active = useUi((s) => s.activeGlobalAccountId),
    selectAccount = useUi((s) => s.selectGlobalAccount);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = usePlatformCollapse("global");
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<{ account: GlobalAccount; anchor: DOMRect } | null>(null);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PLATFORMS.map((item) => ({
      ...item,
      accounts: accounts.filter(
        (account) =>
          account.platformId === item.id &&
          (!q || account.displayName.toLowerCase().includes(q) || item.name.toLowerCase().includes(q)),
      ),
    })).filter((group) => group.accounts.length || !q);
  }, [accounts, query]);
  const openCount = accounts.filter((account) => states[account.id]?.phase === "open").length;
  const loadedCount = accounts.filter((account) =>
    ["open", "opening", "checking"].includes(states[account.id]?.phase ?? "closed"),
  ).length;
  const select = (id: string) => {
    selectAccount(id);
    window.dispatchEvent(new CustomEvent("clipdock:select-global-account", { detail: id }));
  };
  return (
    <aside className={styles.sidebar} aria-label="国外账号列表">
      <div className={styles.sidebarHead}>
        <div className={styles.sidebarTitle}>
          <div style={{ minWidth: 0 }}>
            <span className={styles.eyebrow}>GLOBAL ACCOUNTS</span>
            <CreatorModeSelect mode="global" />
          </div>
          <IconButton
            icon={RefreshCw}
            label="刷新国外账号"
            disabled={refreshing}
            onClick={() => void refresh()}
            style={refreshing ? { animation: "spin 0.8s linear infinite" } : undefined}
          />
        </div>
        <TextInput
          icon={Search}
          compact
          placeholder="搜索账号 / 平台"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className={styles.sidebarStats}>
        <div>
          <strong className="num">{accounts.length}</strong>已接入
        </div>
        <div>
          <strong className="num">{openCount}</strong>窗口
        </div>
        <div>
          <strong className="num">{loadedCount}</strong>已加载
        </div>
      </div>
      <div className={styles.tree}>
        {groups.map((group) => {
          const isCollapsed = query.trim() ? false : (collapsed[group.id] ?? false);
          return (
            <div key={group.id} className={styles.group}>
              <div className={cx(styles.groupHead, isCollapsed && styles.collapsed)}>
                <button
                  type="button"
                  className={styles.groupToggle}
                  aria-expanded={!isCollapsed}
                  aria-controls={`platform-${group.id}`}
                  onClick={() => setCollapsed((rows) => ({ ...rows, [group.id]: !isCollapsed }))}
                >
                  <ChevronDown size={14} className={styles.chev} />
                  <PlatformLogo platformId={group.id} size={32} />
                  <span className={styles.groupName}>{group.name}</span>
                  <span className={styles.groupCount}>{group.accounts.length}</span>
                </button>
                <IconButton
                  icon={Plus}
                  label={`添加${group.name}账号`}
                  size="sm"
                  className={styles.groupAdd}
                  onClick={(event) => {
                    event.stopPropagation();
                    window.dispatchEvent(
                      new CustomEvent("clipdock:focus-global-create", { detail: group.id }),
                    );
                  }}
                />
              </div>
              <div id={`platform-${group.id}`} className={styles.groupChildren}>
                {!isCollapsed
                  ? group.accounts.map((account) => {
                      const state = states[account.id] ?? { phase: "closed" as const };
                      return (
                        <div
                          key={account.id}
                          className={cx(styles.accountRow, active === account.id && styles.active)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setMenu({ account, anchor: new DOMRect(event.clientX, event.clientY, 0, 0) });
                          }}
                        >
                          <button
                            type="button"
                            className={styles.accountOpen}
                            onClick={() => select(account.id)}
                            aria-pressed={active === account.id}
                          >
                            <Avatar name={account.displayName} color={group.color} size={20} round />
                            <div className={styles.accountMeta}>
                              <strong>{account.displayName}</strong>
                              <span>
                                <span
                                  className={styles.globalStatusDot}
                                  data-phase={state.phase}
                                  aria-hidden
                                />
                                {identities[account.id]?.status === "online" && state.phase === "open"
                                  ? "已登录"
                                  : identities[account.id]?.status === "needs_verification"
                                    ? "需要验证"
                                    : phaseLabel[state.phase]}
                              </span>
                            </div>
                          </button>
                          <IconButton
                            icon={MoreHorizontal}
                            label="更多操作"
                            size="sm"
                            className={styles.accountMore}
                            onClick={(event) => {
                              event.stopPropagation();
                              setMenu({ account, anchor: event.currentTarget.getBoundingClientRect() });
                            }}
                          />
                        </div>
                      );
                    })
                  : null}
              </div>
            </div>
          );
        })}
        {error ? (
          <p
            role="alert"
            style={{
              padding: "18px 10px",
              color: "var(--fg-muted)",
              fontSize: "var(--text-sm)",
              textAlign: "center",
            }}
          >
            账号读取失败，请点击右上角刷新重试。
          </p>
        ) : loaded && !accounts.length ? (
          <p
            style={{
              padding: "18px 10px",
              color: "var(--fg-muted)",
              fontSize: "var(--text-sm)",
              textAlign: "center",
            }}
          >
            还没有国外账号，点击下方按钮添加。
          </p>
        ) : null}
      </div>
      <div className={styles.sidebarFoot}>
        <Button
          variant="primary"
          block
          icon={Plus}
          onClick={() => window.dispatchEvent(new CustomEvent("clipdock:focus-global-create"))}
        >
          添加国外账号
        </Button>
      </div>
      {menu ? (
        <GlobalAccountMenu account={menu.account} anchor={menu.anchor} onClose={() => setMenu(null)} />
      ) : null}
    </aside>
  );
}
