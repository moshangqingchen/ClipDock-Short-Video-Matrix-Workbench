import { useCallback, useState } from "react";
import { PlatformLogo } from "@renderer/components/ui/PlatformLogo";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  Heart,
  MessageCircle,
  RefreshCw,
  Share2,
  UserPlus,
  Users,
  UsersRound,
  Bookmark,
  Film,
} from "lucide-react";
import { PLATFORMS } from "@shared/platforms";
import { METRIC_NAMES, type MetricName } from "@shared/types";
import {
  Avatar,
  Button,
  Card,
  Delta,
  Skeleton,
  StatusDot,
  STATUS_LABEL,
  cx,
  formatNumber,
} from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { useAccounts, useToasts, useUi } from "@renderer/store";
import layout from "@renderer/features/layout/layout.module.css";
import styles from "./dashboard.module.css";
import { CollectQueue } from "@renderer/features/metrics/CollectQueue";
import { showCollectAccepted } from "@renderer/features/metrics/collect-feedback";
import { METRIC_LABELS } from "@renderer/features/metrics/metric-presentation";
import { useMetricResource } from "@renderer/features/metrics/use-metric-resource";

const METRIC_STYLE = {
  followers: { icon: Users, color: "var(--brand-500)" }, following: { icon: UserPlus, color: "#14b8a6" },
  likes: { icon: Heart, color: "#ec4899" }, comments: { icon: MessageCircle, color: "#f59e0b" },
  plays: { icon: Eye, color: "#0ea5e9" }, shares: { icon: Share2, color: "#8b5cf6" },
  favorites: { icon: Bookmark, color: "#f97316" }, works: { icon: Film, color: "#64748b" },
};

export function OverviewPage() {
  const { data, loading, error, retry } = useMetricResource(useCallback(() => api.metrics.overview(30), []));
  const [collecting, setCollecting] = useState(false);
  const [trendMetric, setTrendMetric] = useState<MetricName>("followers");
  const accounts = useAccounts((s) => s.accounts);
  const openAccount = useUi((s) => s.openAccount);
  const setRoute = useUi((s) => s.setRoute);
  const setMetricsPlatform = useUi((s) => s.setMetricsPlatform);
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);

  const collectAll = async () => {
    setCollecting(true);
    try {
      showCollectAccepted(await api.metrics.collectNow());
    } catch (error) {
      useToasts.getState().push({ kind: "error", title: "采集失败", message: (error as Error).message });
    } finally {
      setCollecting(false);
    }
  };

  const t = data?.totals ?? {};
  const d = data?.dayDelta ?? {};

  return (
    <div className={layout.page}>
      <div className={layout.pageHead}>
        <div>
          <span className={layout.eyebrow}>OVERVIEW</span>
          <h1>总览</h1>
          <p>查看各平台账号状态和已取得的 8 项基础指标。跨平台总数仅供概览，不代表统一统计口径。</p>
        </div>
        <div className={layout.pageActions}>
          <Button icon={RefreshCw} loading={collecting} onClick={collectAll} disabled={accounts.length === 0}>
            全部采集
          </Button>
          <Button variant="primary" onClick={() => setAddAccountOpen(true)}>
            添加账号
          </Button>
        </div>
      </div>

      <CollectQueue />
      {error && <div role="alert" className={styles.notice}><span>总览读取失败。{data ? "已保留上次结果。" : "请重试读取本地数据。"}</span><Button size="sm" onClick={retry}>重试读取</Button></div>}
      {data && !data.accountCount && <div role="status" className={styles.notice}>还没有账号。添加并登录账号后，可通过「全部采集」读取数据。</div>}
      <h3 className={styles.rowTitle}>全部数据</h3>
      <div className={cx(styles.kpiRow, styles.kpiRow5)}>
        <Kpi
          icon={UsersRound}
          label="账号"
          value={data?.accountCount}
          sub={data ? `${data.onlineCount} 在线 · ${data.attentionCount} 需关注` : undefined}
          accent="#6366f1"
          loading={loading && !data}
        />
        {METRIC_NAMES.map(metric => <Kpi key={metric} icon={METRIC_STYLE[metric].icon} label={`总${METRIC_LABELS[metric]}`}
          value={t[metric]} delta={d[metric]} accent={METRIC_STYLE[metric].color} loading={loading && !data}
          sub={data ? `${data.coverage?.[metric] ?? 0}/${data.accountCount} 个账号有值` : undefined} />)}
      </div>

      <h3 className={styles.rowTitle}>今日观测</h3>
      <div className={cx(styles.kpiRow, styles.kpiRow5)}>
        {METRIC_NAMES.map(metric => <Kpi key={metric} icon={METRIC_STYLE[metric].icon}
          label={metric === "followers" ? "今日涨粉" : `今日${METRIC_LABELS[metric]}变化`} value={d[metric]} signed
          accent={METRIC_STYLE[metric].color} loading={loading && !data}
          sub={data ? `${data.dayCoverage?.[metric] ?? 0}/${data.accountCount} 个账号可比较 · 北京时间 0 点` : undefined} />)}
      </div>

      <div className={styles.grid}>
        <Card>
          <div className={styles.cardHead}>
            <div>
              <h3>近 30 天趋势</h3>
              <p>全部账号有值的{METRIC_LABELS[trendMetric]}合计；缺失日期留空</p>
            </div>
            <label>趋势指标 <select value={trendMetric} onChange={event => setTrendMetric(event.target.value as MetricName)}>
              {METRIC_NAMES.map(metric => <option key={metric} value={metric}>{METRIC_LABELS[metric]}</option>)}
            </select></label>
          </div>
          <div style={{ height: 260 }}>
            {data && data.trend.some(point => point[trendMetric] != null) ? (
              <ResponsiveContainer>
                <AreaChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="ovF" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand-500)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--brand-500)" stopOpacity={0} />
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
                    formatter={(value, _name, item) => [
                      formatNumber(Number(value), false),
                      `${METRIC_LABELS[trendMetric]}（${item.payload?.coverage?.[trendMetric] ?? "—"} 个账号有值）`,
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey={trendMetric}
                    stroke="var(--brand-500)"
                    strokeWidth={2}
                    fill="url(#ovF)"
                    dot={{ r: 2 }}
                    connectNulls={false}
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
                {loading && !data ? <Skeleton height={200} width="100%" /> : `${METRIC_LABELS[trendMetric]}暂无有效趋势，采集后可在此查看`}
              </div>
            )}
          </div>
        </Card>

        <Card>
          <div className={styles.cardHead}>
            <div>
              <h3>需要关注</h3>
              <p>掉线、需验证或即将过期的账号</p>
            </div>
          </div>
          {!data && loading ? (
            <Skeleton height={120} />
          ) : !data ? <p>暂无可用状态，请重试读取总览。</p> : data.attention.length === 0 ? (
            <div className={styles.okState}>
              <CheckCircle2 size={18} />
              所有账号状态正常
            </div>
          ) : (
            <div className={styles.attentionList}>
              {data.attention.map((item) => {
                const account = accounts.find((a) => a.id === item.accountId);
                return (
                  <div
                    key={item.accountId}
                    className={styles.attentionItem}
                    onClick={() => openAccount(item.accountId)}
                    role="button"
                    tabIndex={0}
                  >
                    <Avatar
                      src={account?.avatarUrl}
                      name={item.displayName}
                      color={PLATFORMS[item.platformId].color}
                      size={32}
                      round
                    />
                    <div className={styles.attentionMeta}>
                      <strong className="truncate">{item.displayName}</strong>
                      <span className="truncate">
                        <StatusDot status={item.status} /> {STATUS_LABEL[item.status]} · {item.message}
                      </span>
                    </div>
                    <ArrowRight size={14} color="var(--fg-subtle)" />
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <div className={styles.platformGrid}>
        {(data?.platforms ?? []).map((platform) => {
          const def = PLATFORMS[platform.platformId];
          return (
            <Card
              key={platform.platformId}
              interactive
              onClick={() => {
                setMetricsPlatform(platform.platformId);
                setRoute("metrics");
              }}
              className={styles.platformCard}
            >
              <div className={styles.platformTop}>
                <PlatformLogo platformId={def.id} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{def.name}</strong>
                  <span>
                    {platform.accountCount} 个账号 · {platform.onlineCount} 在线
                  </span>
                </div>
                <ArrowRight size={16} color="var(--fg-subtle)" />
              </div>
              <div className={styles.platformStats}>
                {METRIC_NAMES.map(metric => <Stat key={metric} label={METRIC_LABELS[metric]}
                  value={platform.totals[metric]} delta={platform.dayDelta[metric]}
                  coverage={`${platform.coverage?.[metric] ?? 0}/${platform.accountCount} 个账号有值`} />)}
              </div>
              <div className={styles.platformAccounts}>
                {platform.accounts.slice(0, 6).map((a) => (
                  <Avatar
                    key={a.accountId}
                    src={a.avatarUrl}
                    name={a.displayName}
                    color={def.color}
                    size={26}
                    round
                  />
                ))}
                {platform.accounts.length > 6 ? (
                  <span className={cx("more")}>+{platform.accounts.length - 6}</span>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  delta,
  sub,
  accent,
  loading,
  signed,
}: {
  icon: typeof Users;
  label: string;
  value?: number | null;
  delta?: number | null;
  sub?: string;
  accent: string;
  loading: boolean;
  /** Render as a movement (+/−) rather than a total. */
  signed?: boolean;
}) {
  const text = value == null ? "—" : signed && value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
  const tone =
    !signed || value == null || value === 0 ? undefined : value > 0 ? "var(--success)" : "var(--danger)";
  return (
    <Card className={styles.kpiCard} style={{ "--kpi-accent": accent } as React.CSSProperties}>
      <div className={styles.kpiHead}>
        <span>{label}</span>
        <span className={styles.kpiIcon}>
          <Icon size={15} />
        </span>
      </div>
      {loading ? (
        <Skeleton height={30} width={120} style={{ marginTop: 14 }} />
      ) : (
        <div className={cx(styles.kpiValue, "num")} style={{ color: tone }}>
          {text}
        </div>
      )}
      <div className={styles.kpiFoot}>
        {sub ??
          (delta !== undefined ? (
            <>
              <Delta value={delta} /> 今日
            </>
          ) : null)}
      </div>
    </Card>
  );
}

function Stat({ label, value, delta, coverage }: { label: string; value?: number; delta?: number; coverage: string }) {
  return (
    <div className={styles.platformStat}>
      <span>{label}</span>
      <strong className="num">{formatNumber(value)}</strong>
      <Delta value={delta} />
      <small>{coverage}</small>
    </div>
  );
}
