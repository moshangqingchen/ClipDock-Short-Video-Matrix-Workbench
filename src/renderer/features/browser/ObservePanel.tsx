import { useCallback, useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Eye,
  Heart,
  ListVideo,
  MessageCircle,
  RefreshCw,
  Share2,
  Star,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { PLATFORMS } from "@shared/platforms";
import type { Account, AccountMetricsView, MetricName, Work } from "@shared/types";
import {
  Badge,
  Button,
  Card,
  Delta,
  EmptyState,
  IconButton,
  STATUS_LABEL,
  STATUS_TONE,
  Skeleton,
  Tabs,
  cx,
  formatDateTime,
  formatNumber,
  formatRelative,
} from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { useToasts } from "@renderer/store";
import dash from "@renderer/features/dashboard/dashboard.module.css";
import styles from "./observe.module.css";

type Range = 7 | 30 | 90;

const TODAY_CARDS: Array<{ metric: MetricName; label: string; icon: typeof Users; accent: string }> = [
  { metric: "followers", label: "今日涨粉", icon: UserPlus, accent: "var(--brand-500)" },
  { metric: "likes", label: "今日点赞", icon: Heart, accent: "#ec4899" },
  { metric: "comments", label: "今日评论", icon: MessageCircle, accent: "#f59e0b" },
  { metric: "plays", label: "今日播放", icon: Eye, accent: "#0ea5e9" },
  { metric: "shares", label: "今日分享", icon: Share2, accent: "#8b5cf6" },
];

const TOTAL_CARDS: Array<{ metric: MetricName; label: string; icon: typeof Users; accent: string }> = [
  { metric: "followers", label: "粉丝总数", icon: Users, accent: "var(--brand-500)" },
  { metric: "likes", label: "获赞总数", icon: Heart, accent: "#ec4899" },
  { metric: "comments", label: "评论总数", icon: MessageCircle, accent: "#f59e0b" },
  { metric: "plays", label: "播放总数", icon: Eye, accent: "#0ea5e9" },
  { metric: "favorites", label: "收藏总数", icon: Star, accent: "#8b5cf6" },
  { metric: "works", label: "作品数", icon: ListVideo, accent: "#6366f1" },
];

/**
 * Full-pane observation view for the selected account: today's movement, the
 * account totals, a trend chart and the top works. Data comes from the
 * snapshots collected inside this account's own session.
 */
export function ObservePanel({ account, onClose }: { account: Account; onClose: () => void }) {
  const platform = PLATFORMS[account.platformId];
  const [range, setRange] = useState<Range>(30);
  const [view, setView] = useState<AccountMetricsView | null>(null);
  const [works, setWorks] = useState<Work[] | null>(null);
  const [collecting, setCollecting] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([api.metrics.account(account.id, range), api.works.list(account.id, 30)]).then(
        ([metrics, list]) => {
          setView(metrics);
          setWorks(list);
        },
      ),
    [account.id, range],
  );

  useEffect(() => {
    const off = api.on("metrics-updated", ({ accountId }) => {
      if (accountId === account.id) void load();
    });
    void load().catch(() => undefined);
    return off;
  }, [account.id, load]);

  const collectNow = async () => {
    setCollecting(true);
    try {
      await api.metrics.collectNow(account.id);
      await load();
    } catch (error) {
      useToasts.getState().push({ kind: "error", title: "采集失败", message: (error as Error).message });
    } finally {
      setCollecting(false);
    }
  };

  const topWorks = useMemo(() => [...(works ?? [])].sort((a, b) => b.plays - a.plays).slice(0, 8), [works]);
  const online = account.status === "online" || account.status === "expiring";
  const m = view?.metrics ?? {};

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div>
          <span className={styles.eyebrow}>OBSERVE · {platform.name}</span>
          <h2>
            {account.displayName}
            <Badge tone={STATUS_TONE[account.status]} className={styles.statusBadge}>
              {STATUS_LABEL[account.status]}
            </Badge>
          </h2>
          <p>
            数据来自该账号自己的登录会话,只读不写 · 上次采集{" "}
            {formatRelative(view?.lastRun?.finishedAt ?? view?.capturedAt)}
            {view?.lastRun?.message ? ` · ${view.lastRun.message}` : ""}
          </p>
        </div>
        <div className={styles.headActions}>
          <Tabs
            value={range}
            onChange={setRange}
            items={[
              { value: 7, label: "7 天" },
              { value: 30, label: "30 天" },
              { value: 90, label: "90 天" },
            ]}
          />
          <Button icon={RefreshCw} loading={collecting} disabled={!online} onClick={collectNow}>
            立即采集
          </Button>
          <IconButton icon={X} label="返回页面" onClick={onClose} />
        </div>
      </div>

      <div className={styles.body}>
        <section>
          <h3 className={styles.sectionTitle}>今日数据观测</h3>
          <div className={cx(styles.cards, styles.cards5)}>
            {TODAY_CARDS.map((card) => (
              <KpiCard
                key={card.metric}
                icon={card.icon}
                label={card.label}
                accent={card.accent}
                loading={!view}
                value={m[card.metric]?.day}
                signed
                foot={
                  <>
                    <span>7日</span> <Delta value={m[card.metric]?.week} /> <span>30日</span>{" "}
                    <Delta value={m[card.metric]?.month} />
                  </>
                }
              />
            ))}
          </div>
        </section>

        <section>
          <h3 className={styles.sectionTitle}>总数据观测</h3>
          <div className={cx(styles.cards, styles.cards6)}>
            {TOTAL_CARDS.map((card) => (
              <KpiCard
                key={card.metric}
                icon={card.icon}
                label={card.label}
                accent={card.accent}
                loading={!view}
                value={m[card.metric]?.current}
                foot={
                  <>
                    <Delta value={m[card.metric]?.day} /> <span>今日</span>
                  </>
                }
              />
            ))}
          </div>
        </section>

        <section className={styles.split}>
          <Card>
            <div className={dash.cardHead}>
              <div>
                <h3>粉丝 / 获赞趋势</h3>
                <p>近 {range} 天,每日最后一次采集值</p>
              </div>
              <div className={dash.legend}>
                <span>
                  <i style={{ background: platform.color }} />
                  粉丝
                </span>
                <span>
                  <i style={{ background: "#ec4899" }} />
                  获赞
                </span>
              </div>
            </div>
            <div style={{ height: 220 }}>
              {view && view.trend.length > 1 ? (
                <ResponsiveContainer>
                  <AreaChart data={view.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="obsF" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={platform.color} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={platform.color} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="obsL" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#ec4899" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#ec4899" stopOpacity={0} />
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
                      fill="url(#obsF)"
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Area
                      yAxisId="l"
                      type="monotone"
                      dataKey="likes"
                      stroke="#ec4899"
                      strokeWidth={2}
                      fill="url(#obsL)"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className={styles.chartEmpty}>
                  {view ? "累计两天以上的采集后显示趋势" : <Skeleton height={180} width="100%" />}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <div className={dash.cardHead}>
              <div>
                <h3>作品榜</h3>
                <p>按播放量排序,取前 8</p>
              </div>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
                {works?.length ?? 0} 个作品
              </span>
            </div>
            {works == null ? (
              <Skeleton height={120} />
            ) : topWorks.length === 0 ? (
              <EmptyState
                icon={ListVideo}
                title="暂无作品数据"
                description={online ? "点击「立即采集」读取作品列表。" : "登录后自动读取作品列表。"}
              />
            ) : (
              <div className={styles.workList}>
                {topWorks.map((work, index) => (
                  <div key={work.id} className={styles.workRow}>
                    <span className={styles.rank}>{index + 1}</span>
                    {work.coverUrl ? (
                      <img className={styles.cover} src={work.coverUrl} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <div className={styles.cover} />
                    )}
                    <div className={styles.workMeta}>
                      <strong title={work.title}>{work.title || "(无标题)"}</strong>
                      <span>
                        <em className="num">▶ {formatNumber(work.plays)}</em>
                        <em className="num">♥ {formatNumber(work.likes)}</em>
                        <em className="num">💬 {formatNumber(work.comments)}</em>
                        <em className="num">↗ {formatNumber(work.shares)}</em>
                        <em>{formatDateTime(work.publishedAt)}</em>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  accent,
  value,
  signed,
  foot,
  loading,
}: {
  icon: typeof Users;
  label: string;
  accent: string;
  value?: number | null;
  signed?: boolean;
  foot: React.ReactNode;
  loading: boolean;
}) {
  const text = value == null ? "—" : signed && value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
  const tone =
    !signed || value == null || value === 0 ? undefined : value > 0 ? "var(--success)" : "var(--danger)";
  return (
    <Card className={dash.kpiCard} style={{ "--kpi-accent": accent } as React.CSSProperties}>
      <div className={dash.kpiHead}>
        <span>{label}</span>
        <span className={dash.kpiIcon}>
          <Icon size={15} />
        </span>
      </div>
      {loading ? (
        <Skeleton height={30} width={110} style={{ marginTop: 14 }} />
      ) : (
        <div className={cx(dash.kpiValue, "num")} style={{ color: tone }}>
          {text}
        </div>
      )}
      <div className={dash.kpiFoot}>{foot}</div>
    </Card>
  );
}
