import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, ArrowUpDown, BarChart3, ExternalLink, RefreshCw } from "lucide-react";
import { PLATFORMS, PLATFORM_LIST, type PlatformId } from "@shared/platforms";
import type { AccountMetricsView, MetricDelta, MetricName, PlatformSummaryView, Work } from "@shared/types";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Delta,
  EmptyState,
  STATUS_LABEL,
  STATUS_TONE,
  Skeleton,
  StatusDot,
  Table,
  Tabs,
  cx,
  formatDateTime,
  formatNumber,
  formatRelative,
  tableStyles,
} from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { useAccounts, useToasts, useUi } from "@renderer/store";
import layout from "@renderer/features/layout/layout.module.css";
import styles from "./metrics.module.css";

type SortKey = "followers" | "likes" | "plays" | "comments" | "works" | "dayFollowers";
type Range = 7 | 30 | 90;

export function MetricsPage() {
  const accounts = useAccounts((s) => s.accounts);
  const platformId = useUi((s) => s.metricsPlatform);
  const setPlatform = useUi((s) => s.setMetricsPlatform);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(30);

  const available = PLATFORM_LIST.filter((p) => accounts.some((a) => a.platformId === p.id));
  const selected =
    platformId && available.some((p) => p.id === platformId) ? platformId : (available[0]?.id ?? null);

  useEffect(() => {
    if (selected !== platformId) setPlatform(selected);
  }, [selected, platformId, setPlatform]);

  if (detailId)
    return (
      <AccountDetail accountId={detailId} range={range} onBack={() => setDetailId(null)} onRange={setRange} />
    );

  return (
    <div className={layout.page}>
      <div className={layout.pageHead}>
        <div>
          <span className={layout.eyebrow}>ANALYTICS</span>
          <h1>数据观测</h1>
          <p>按平台查看各账号的粉丝、获赞、评论、播放及增量。数据来自各账号自身登录会话,只读不写。</p>
        </div>
        <Tabs
          value={range}
          onChange={setRange}
          items={[
            { value: 7, label: "7 天" },
            { value: 30, label: "30 天" },
            { value: 90, label: "90 天" },
          ]}
        />
      </div>

      {available.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="还没有账号数据"
          description="添加账号并登录后,系统会自动读取并持续记录账号数据。"
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            <div className={styles.platformTabs}>
              {available.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={cx(styles.platformTab, selected === p.id && styles.active)}
                  onClick={() => setPlatform(p.id)}
                >
                  <i style={{ background: p.color }}>{p.glyph}</i>
                  {p.name}
                  <b>{accounts.filter((a) => a.platformId === p.id).length}</b>
                </button>
              ))}
            </div>
          </div>
          {selected ? (
            <PlatformTable key={selected} platformId={selected} range={range} onOpen={setDetailId} />
          ) : null}
        </>
      )}
    </div>
  );
}

function PlatformTable({
  platformId,
  range,
  onOpen,
}: {
  platformId: PlatformId;
  range: Range;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<PlatformSummaryView | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "followers", dir: -1 });
  const [collecting, setCollecting] = useState(false);
  const platform = PLATFORMS[platformId];

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.metrics
        .platform(platformId, range)
        .then((d) => !cancelled && setData(d))
        .catch(() => undefined);
    void load();
    const off = api.on("metrics-updated", () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [platformId, range]);

  const rows = useMemo(() => {
    if (!data) return [];
    const value = (m: Partial<Record<MetricName, MetricDelta>>, key: SortKey) =>
      key === "dayFollowers" ? (m.followers?.day ?? -Infinity) : (m[key]?.current ?? -Infinity);
    return [...data.accounts].sort(
      (a, b) => (value(a.metrics, sort.key) - value(b.metrics, sort.key)) * sort.dir,
    );
  }, [data, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 }));

  const collectPlatform = async () => {
    setCollecting(true);
    try {
      for (const row of data?.accounts ?? []) await api.metrics.collectNow(row.accountId);
      setData(await api.metrics.platform(platformId, range));
    } catch (error) {
      useToasts.getState().push({ kind: "error", title: "采集失败", message: (error as Error).message });
    } finally {
      setCollecting(false);
    }
  };

  const header = (label: string, keyName: SortKey) => (
    <SortHeader
      key={keyName}
      label={label}
      active={sort.key === keyName}
      onClick={() => toggleSort(keyName)}
    />
  );

  return (
    <>
      <div className={styles.summaryRow}>
        <SummaryCell
          label={`${platform.shortName}账号`}
          value={data?.accountCount}
          sub={data ? `${data.onlineCount} 在线` : undefined}
          loading={!data}
        />
        <SummaryCell
          label="粉丝合计"
          value={data?.totals.followers}
          delta={data?.dayDelta.followers}
          loading={!data}
        />
        <SummaryCell
          label="获赞合计"
          value={data?.totals.likes}
          delta={data?.dayDelta.likes}
          loading={!data}
        />
        <SummaryCell
          label="评论合计"
          value={data?.totals.comments}
          delta={data?.dayDelta.comments}
          loading={!data}
        />
        <SummaryCell
          label="播放合计"
          value={data?.totals.plays}
          delta={data?.dayDelta.plays}
          loading={!data}
        />
      </div>
      <Card padded={false} className={styles.tableWrap}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <strong style={{ fontSize: "var(--text-sm)" }}>{platform.name} · 账号明细</strong>
          <Button size="sm" icon={RefreshCw} loading={collecting} onClick={collectPlatform}>
            采集本平台
          </Button>
        </div>
        <div className={styles.tableScroll}>
          <Table>
            <thead>
              <tr>
                <th>账号</th>
                <th>状态</th>
                {header("粉丝", "followers")}
                {header("今日涨粉", "dayFollowers")}
                {header("获赞", "likes")}
                {header("评论", "comments")}
                {header("播放", "plays")}
                {header("作品", "works")}
                <th>14 天趋势</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {!data
                ? Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={10}>
                        <Skeleton height={20} />
                      </td>
                    </tr>
                  ))
                : rows.map((row) => (
                    <tr
                      key={row.accountId}
                      className={tableStyles.clickable}
                      onClick={() => onOpen(row.accountId)}
                    >
                      <td>
                        <div className={styles.accountCell}>
                          <Avatar
                            src={row.avatarUrl}
                            name={row.displayName}
                            color={platform.color}
                            size={30}
                            round
                          />
                          <strong>{row.displayName}</strong>
                        </div>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[row.status]}>
                          <StatusDot status={row.status} />
                          {STATUS_LABEL[row.status]}
                        </Badge>
                      </td>
                      <MetricTd delta={row.metrics.followers} />
                      <td className={styles.metricCell}>
                        <Delta value={row.metrics.followers?.day} />
                      </td>
                      <MetricTd delta={row.metrics.likes} />
                      <MetricTd delta={row.metrics.comments} />
                      <MetricTd delta={row.metrics.plays} />
                      <MetricTd delta={row.metrics.works} />
                      <td>
                        <Spark values={row.spark} color={platform.color} />
                      </td>
                      <td
                        style={{ color: "var(--fg-muted)", fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}
                      >
                        {formatRelative(row.capturedAt)}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </Table>
        </div>
      </Card>
    </>
  );
}

function SortHeader({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <th className={cx(tableStyles.sortable, tableStyles.right)} onClick={onClick}>
      {label} {active ? <ArrowUpDown size={11} style={{ verticalAlign: -1 }} /> : null}
    </th>
  );
}

function MetricTd({ delta }: { delta?: MetricDelta }) {
  return (
    <td className={styles.metricCell}>
      <strong className="num">{formatNumber(delta?.current)}</strong>
      <Delta value={delta?.day} />
    </td>
  );
}

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>—</span>;
  const data = values.map((v, i) => ({ i, v }));
  return (
    <div className={styles.spark}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  delta,
  sub,
  loading,
}: {
  label: string;
  value?: number;
  delta?: number;
  sub?: string;
  loading: boolean;
}) {
  return (
    <Card className={styles.summaryCell}>
      <span>{label}</span>
      {loading ? (
        <Skeleton height={26} width={90} style={{ marginTop: 8 }} />
      ) : (
        <strong className="num">{formatNumber(value)}</strong>
      )}
      <small>
        {sub ??
          (delta !== undefined ? (
            <>
              <Delta value={delta} /> 今日
            </>
          ) : (
            ""
          ))}
      </small>
    </Card>
  );
}

/* ---------------- detail ---------------- */

function AccountDetail({
  accountId,
  range,
  onBack,
  onRange,
}: {
  accountId: string;
  range: Range;
  onBack: () => void;
  onRange: (r: Range) => void;
}) {
  const account = useAccounts((s) => s.accounts.find((a) => a.id === accountId));
  const openAccount = useUi((s) => s.openAccount);
  const [view, setView] = useState<AccountMetricsView | null>(null);
  const [works, setWorks] = useState<Work[] | null>(null);
  const [collecting, setCollecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.all([api.metrics.account(accountId, range), api.works.list(accountId, 60)])
        .then(([v, w]) => {
          if (cancelled) return;
          setView(v);
          setWorks(w);
        })
        .catch(() => undefined);
    void load();
    const off = api.on("metrics-updated", (p) => p.accountId === accountId && void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [accountId, range]);

  const topWorks = useMemo(() => [...(works ?? [])].sort((a, b) => b.plays - a.plays).slice(0, 12), [works]);

  if (!account) return null;
  const platform = PLATFORMS[account.platformId];
  const m = view?.metrics ?? {};

  const collect = async () => {
    setCollecting(true);
    try {
      await api.metrics.collectNow(accountId);
    } finally {
      setCollecting(false);
    }
  };

  return (
    <div className={layout.page}>
      <Button variant="ghost" icon={ArrowLeft} onClick={onBack} style={{ marginBottom: 12, marginLeft: -10 }}>
        返回 {platform.name}
      </Button>
      <div className={styles.detailHead}>
        <Avatar
          src={account.avatarUrl}
          name={account.displayName}
          color={platform.color}
          size={52}
          round
          badge={platform.glyph}
          badgeColor={platform.color}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{account.displayName}</h2>
          <p>
            <Badge tone={STATUS_TONE[account.status]}>{STATUS_LABEL[account.status]}</Badge>
            {"  "}
            {account.handle ? `@${account.handle} · ` : ""}上次采集{" "}
            {formatRelative(view?.lastRun?.finishedAt ?? view?.capturedAt)}
          </p>
        </div>
        <Tabs
          value={range}
          onChange={onRange}
          items={[
            { value: 7, label: "7 天" },
            { value: 30, label: "30 天" },
            { value: 90, label: "90 天" },
          ]}
        />
        <Button icon={RefreshCw} loading={collecting} onClick={collect}>
          立即采集
        </Button>
        <Button variant="primary" icon={ExternalLink} onClick={() => openAccount(accountId)}>
          打开账号页面
        </Button>
      </div>

      <div className={styles.detailGrid}>
        {(["followers", "likes", "plays", "comments"] as const).map((key) => (
          <Card key={key} className={styles.detailKpi}>
            <span>{{ followers: "粉丝", likes: "获赞", plays: "播放", comments: "评论" }[key]}</span>
            {view ? (
              <strong className="num">{formatNumber(m[key]?.current)}</strong>
            ) : (
              <Skeleton height={28} width={100} style={{ marginTop: 6 }} />
            )}
            <div className={styles.deltaRow}>
              <span>
                <b>日</b>
                <Delta value={m[key]?.day} />
              </span>
              <span>
                <b>周</b>
                <Delta value={m[key]?.week} />
              </span>
              <span>
                <b>月</b>
                <Delta value={m[key]?.month} />
              </span>
            </div>
          </Card>
        ))}
      </div>

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <strong style={{ fontSize: "var(--text-md)" }}>粉丝 / 获赞趋势</strong>
        </div>
        <div style={{ height: 240 }}>
          {view && view.trend.length > 1 ? (
            <ResponsiveContainer>
              <AreaChart data={view.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="detF" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={platform.color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={platform.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => v.slice(5)}
                  tick={{ fontSize: 11, fill: "var(--fg-subtle)" }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={28}
                />
                <YAxis
                  yAxisId="f"
                  tickFormatter={(v: number) => formatNumber(v)}
                  tick={{ fontSize: 11, fill: "var(--fg-subtle)" }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  domain={["auto", "auto"]}
                />
                <YAxis
                  yAxisId="l"
                  orientation="right"
                  tickFormatter={(v: number) => formatNumber(v)}
                  tick={{ fontSize: 11, fill: "var(--fg-subtle)" }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  domain={["auto", "auto"]}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg-elev)",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    fontSize: 12,
                  }}
                  formatter={(value, name) => [
                    formatNumber(Number(value), false),
                    name === "followers" ? "粉丝" : "获赞",
                  ]}
                />
                <Area
                  yAxisId="f"
                  type="monotone"
                  dataKey="followers"
                  stroke={platform.color}
                  strokeWidth={2}
                  fill="url(#detF)"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="l"
                  type="monotone"
                  dataKey="likes"
                  stroke="#ec4899"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div
              style={{
                height: "100%",
                display: "grid",
                placeItems: "center",
                color: "var(--fg-subtle)",
                fontSize: "var(--text-sm)",
              }}
            >
              累计两次以上采集后显示趋势
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <strong style={{ fontSize: "var(--text-md)" }}>作品榜 · 按播放排序</strong>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
            {works?.length ?? 0} 个作品
          </span>
        </div>
        {works == null ? (
          <Skeleton height={80} />
        ) : topWorks.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="暂无作品数据"
            description="登录后点击「立即采集」读取作品列表。"
          />
        ) : (
          <div className={styles.worksGrid}>
            {topWorks.map((work) => (
              <div key={work.id} className={styles.workCard}>
                {work.coverUrl ? (
                  <img src={work.coverUrl} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <div className={styles.noCover} />
                )}
                <div style={{ minWidth: 0 }}>
                  <strong title={work.title}>{work.title || "(无标题)"}</strong>
                  <div className={styles.stats}>
                    <span className="num">▶ {formatNumber(work.plays)}</span>
                    <span className="num">♥ {formatNumber(work.likes)}</span>
                    <span className="num">💬 {formatNumber(work.comments)}</span>
                    <span className="num">↗ {formatNumber(work.shares)}</span>
                    <span>{formatDateTime(work.publishedAt)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
