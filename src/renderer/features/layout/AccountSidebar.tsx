import { useMemo, useState } from "react";
import { ChevronDown, MoreHorizontal, Plus, RefreshCw, Search, Zap } from "lucide-react";
import { PLATFORM_LIST, type PlatformId } from "@shared/platforms";
import type { Account } from "@shared/types";
import {
  Avatar,
  Button,
  IconButton,
  STATUS_LABEL,
  StatusDot,
  TextInput,
  cx,
  formatNumber,
} from "@renderer/components/ui";
import { useAccounts, useUi, useViews } from "@renderer/store";
import { AccountMenu } from "@renderer/features/accounts/AccountMenu";
import { useAccountFollowers } from "@renderer/features/accounts/useAccountFollowers";
import styles from "./layout.module.css";

export function AccountSidebar() {
  const accounts = useAccounts((s) => s.accounts);
  const loaded = useAccounts((s) => s.loaded);
  const load = useAccounts((s) => s.load);
  const activeId = useUi((s) => s.activeAccountId);
  const openAccount = useUi((s) => s.openAccount);
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);
  const viewStates = useViews((s) => s.states);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ account: Account; anchor: DOMRect } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const followers = useAccountFollowers(accounts);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PLATFORM_LIST.map((platform) => ({
      platform,
      accounts: accounts.filter(
        (a) =>
          a.platformId === platform.id &&
          (!q || a.displayName.toLowerCase().includes(q) || (a.handle ?? "").toLowerCase().includes(q)),
      ),
    })).filter((g) => g.accounts.length > 0 || !q);
  }, [accounts, query]);

  const online = accounts.filter((a) => a.status === "online" || a.status === "expiring").length;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  };

  return (
    <aside className={styles.sidebar} aria-label="账号列表">
      <div className={styles.sidebarHead}>
        <div className={styles.sidebarTitle}>
          <div>
            <span className={styles.eyebrow}>ACCOUNTS</span>
            <h2>账号</h2>
          </div>
          <IconButton
            icon={RefreshCw}
            label="刷新"
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
          <strong className="num">{Object.keys(viewStates).length}</strong>已加载
        </div>
      </div>
      <div className={styles.tree}>
        {groups.map(({ platform, accounts: rows }) => {
          const isCollapsed = collapsed[platform.id] ?? false;
          return (
            <div key={platform.id} className={styles.group}>
              <button
                type="button"
                className={cx(styles.groupHead, isCollapsed && styles.collapsed)}
                onClick={() => setCollapsed((s) => ({ ...s, [platform.id]: !isCollapsed }))}
              >
                <ChevronDown size={14} className={styles.chev} />
                <span className={styles.groupGlyph} style={{ background: platform.color }}>
                  {platform.glyph}
                </span>
                <span className={styles.groupName}>{platform.name}</span>
                <span className={styles.groupCount}>{rows.length}</span>
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
              </button>
              {!isCollapsed
                ? rows.map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      color={platform.color}
                      active={account.id === activeId}
                      live={Boolean(viewStates[account.id])}
                      followers={followers[account.id]}
                      onOpen={() => openAccount(account.id)}
                      onMenu={(anchor) => setMenu({ account, anchor })}
                    />
                  ))
                : null}
            </div>
          );
        })}
        {loaded && accounts.length === 0 ? (
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
  return (
    <div
      className={cx(styles.accountRow, active && styles.active)}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" ? onOpen() : undefined)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(new DOMRect(e.clientX, e.clientY, 0, 0));
      }}
    >
      <Avatar src={account.avatarUrl} name={account.displayName} color={color} size={36} round />
      <div className={styles.accountMeta}>
        <strong>{account.displayName}</strong>
        <span>
          <StatusDot status={account.status} />
          {STATUS_LABEL[account.status]}
          {followers != null ? <span className="num">· {formatNumber(followers)} 粉丝</span> : null}
          {live ? (
            <span className={styles.liveTag}>
              <Zap size={10} />
              已加载
            </span>
          ) : null}
        </span>
      </div>
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
