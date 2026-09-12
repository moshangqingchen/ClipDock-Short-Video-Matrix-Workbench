import { useMemo, useRef, useState } from "react";
import { PlatformLogo } from "@renderer/components/ui/PlatformLogo";
import { AccountLoginStatus } from "@renderer/components/ui/AccountLoginStatus";
import { AccountEgressBadge } from "@renderer/components/ui/AccountEgressBadge";
import { api } from "@renderer/lib/api";
import { usePlatformCollapse } from "./usePlatformCollapse";
import { ChevronDown, MoreHorizontal, Plus, RefreshCw, Search, Zap } from "lucide-react";
import { PLATFORM_LIST, type PlatformId } from "@shared/platforms";
import type { Account } from "@shared/types";
import { Avatar, Button, IconButton, TextInput, cx, formatNumber } from "@renderer/components/ui";
import { useAccounts, useUi, useViews, useToasts } from "@renderer/store";
import { useNetwork } from "@renderer/store/network";
import { AccountMenu } from "@renderer/features/accounts/AccountMenu";
import { useAccountFollowers } from "@renderer/features/accounts/useAccountFollowers";
import { CreatorModeSelect } from "@renderer/features/creator/CreatorModeSelect";
import styles from "./layout.module.css";

export function AccountSidebar() {
  const accounts = useAccounts((s) => s.accounts);
  const loaded = useAccounts((s) => s.loaded);
  const loadError = useAccounts((s) => s.loadError);
  const load = useAccounts((s) => s.load);
  const activeId = useUi((s) => s.activeAccountId);
  const openAccount = useUi((s) => s.openAccount);
  const selectAccount = useUi((s) => s.selectAccount);
  const route = useUi((s) => s.route);
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);
  const viewStates = useViews((s) => s.states);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = usePlatformCollapse("domestic");
  const [menu, setMenu] = useState<{ account: Account; anchor: DOMRect } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const followers = useAccountFollowers(accounts);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PLATFORM_LIST.map((platform) => ({
      platform,
      accounts: accounts.filter(
        (a) =>
          a.platformId === platform.id &&
          (!q ||
            `${platform.name} ${platform.shortName} ${platform.id} ${a.displayName} ${a.handle ?? ""} ${a.externalId ?? ""}`
              .toLowerCase()
              .includes(q)),
      ),
    })).filter((g) => g.accounts.length > 0 || !q);
  }, [accounts, query]);

  const online = accounts.filter((a) => a.status === "online" || a.status === "expiring").length;

  const refresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await load();
      const ids = useAccounts.getState().accounts.map((a) => a.id);
      let cursor = 0;
      let failed = 0;
      const worker = async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++];
          try {
            const account = await api.accounts.checkStatus(id);
            if (useAccounts.getState().byId(id)) useAccounts.getState().upsert(account);
          } catch {
            failed++;
          }
        }
      };
      await Promise.all([worker(), worker()]);
      useToasts
        .getState()
        .push({
          kind: failed ? "warning" : "info",
          title: failed ? `${failed} 个账号检查失败，可重试` : "账号检查完成",
          message: "各账号的检查结果已显示在列表中",
        });
    } catch {
      useToasts.getState().push({ kind: "error", title: "账号列表刷新失败，请重试" });
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  return (
    <aside className={styles.sidebar} aria-label="国内账号列表">
      <div className={styles.sidebarHead}>
        <div className={styles.sidebarTitle}>
          <div style={{ minWidth: 0 }}>
            <span className={styles.eyebrow}>DOMESTIC ACCOUNTS</span>
            <CreatorModeSelect mode="domestic" />
          </div>
          <IconButton
            icon={RefreshCw}
            label="刷新"
            disabled={refreshing}
            onClick={refresh}
            style={refreshing ? { animation: "spin 0.8s linear infinite" } : undefined}
          />
        </div>
        <TextInput
          icon={Search}
          compact
          placeholder="搜索账号 / 平台"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className={styles.sidebarStats}>
        <div>
          <strong className="num">{accounts.length}</strong>已接入
        </div>
        <div>
          <strong className="num">{online}</strong>在线
        </div>
        <div>
          <strong className="num">
            {
              Object.values(viewStates).filter(
                (v) => !v.lifecycle || ["ready", "loading"].includes(v.lifecycle),
              ).length
            }
          </strong>
          已加载
        </div>
      </div>
      <div className={styles.tree}>
        {groups.map(({ platform, accounts: rows }) => {
          const isCollapsed = query.trim() ? false : (collapsed[platform.id] ?? false);
          return (
            <div key={platform.id} className={styles.group}>
              <div className={cx(styles.groupHead, isCollapsed && styles.collapsed)}>
                <button
                  type="button"
                  className={styles.groupToggle}
                  aria-expanded={!isCollapsed}
                  aria-controls={`platform-${platform.id}`}
                  onClick={() => setCollapsed((s) => ({ ...s, [platform.id]: !isCollapsed }))}
                >
                  <ChevronDown size={14} className={styles.chev} />
                  <PlatformLogo platformId={platform.id} size={32} />
                  <span className={styles.groupName}>{platform.name}</span>
                  <span className={styles.groupCount}>{rows.length}</span>
                </button>
                <IconButton
                  icon={Plus}
                  label={`添加${platform.shortName}账号`}
                  size="sm"
                  className={styles.groupAdd}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddAccountOpen(true);
                    useUi.setState({ metricsPlatform: platform.id as PlatformId });
                  }}
                />
              </div>
              <div id={`platform-${platform.id}`} className={styles.groupChildren}>
                {!isCollapsed
                  ? rows.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        color={platform.color}
                        active={account.id === activeId}
                        live={Boolean(
                          viewStates[account.id] &&
                          (!viewStates[account.id].lifecycle ||
                            ["ready", "loading"].includes(viewStates[account.id].lifecycle!)),
                        )}
                        followers={followers[account.id]}
                        onOpen={() =>
                          route !== "creator" && route !== "workspace"
                            ? selectAccount(account.id)
                            : openAccount(account.id)
                        }
                        onMenu={(anchor) => setMenu({ account, anchor })}
                      />
                    ))
                  : null}
              </div>
            </div>
          );
        })}
        {loadError ? <p role="alert" style={{ padding: "18px 10px", color: "var(--fg-muted)" }}>{loadError}</p> : null}
        {loaded && !loadError && accounts.length === 0 ? (
          <p
            style={{
              padding: "18px 10px",
              color: "var(--fg-muted)",
              fontSize: "var(--text-sm)",
              textAlign: "center",
            }}
          >
            还没有账号,点击下方按钮添加第一个账号。
          </p>
        ) : null}
      </div>
      <div className={styles.sidebarFoot}>
        <Button variant="primary" block icon={Plus} onClick={() => setAddAccountOpen(true)}>
          添加账号
        </Button>
      </div>
      {menu ? (
        <AccountMenu account={menu.account} anchor={menu.anchor} onClose={() => setMenu(null)} />
      ) : null}
    </aside>
  );
}

function AccountRow({
  account,
  color,
  active,
  live,
  followers,
  onOpen,
  onMenu,
}: {
  account: Account;
  color: string;
  active: boolean;
  live: boolean;
  followers?: number | null;
  onOpen: () => void;
  onMenu: (anchor: DOMRect) => void;
}) {
  const egressLocation = useNetwork((s) =>
    s.snapshot.accounts.find((state) => state.accountId === account.id)?.egressLocation,
  );
  return (
    <div
      className={cx(styles.accountRow, active && styles.active)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(new DOMRect(e.clientX, e.clientY, 0, 0));
      }}
    >
      <button type="button" className={styles.accountOpen} onClick={onOpen} aria-pressed={active}>
        <Avatar src={account.avatarUrl} name={account.displayName} color={color} size={20} round />
        <div className={styles.accountMeta}>
          <div className={styles.accountName}>
            <strong>{account.displayName}</strong>
            <AccountEgressBadge location={egressLocation} />
          </div>
          <span>
            <AccountLoginStatus account={account} />
            {followers != null ? <span className="num">· {formatNumber(followers)} 粉丝</span> : null}
            {live ? (
              <span
                className={styles.liveTag}
                title="账号网页已加载；此标记不代表登录状态"
                aria-label="网页已加载"
              >
                <Zap size={10} />
              </span>
            ) : null}
          </span>
        </div>
      </button>
      <IconButton
        icon={MoreHorizontal}
        label="更多操作"
        size="sm"
        className={styles.accountMore}
        onClick={(e) => {
          e.stopPropagation();
          onMenu((e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
      />
    </div>
  );
}
