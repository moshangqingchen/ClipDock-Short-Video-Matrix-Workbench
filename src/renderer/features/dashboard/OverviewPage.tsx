import { useEffect, useState } from "react";
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
} from "lucide-react";
import { PLATFORMS } from "@shared/platforms";
import type { OverviewView } from "@shared/types";
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

export function OverviewPage() {
  const [data, setData] = useState<OverviewView | null>(null);
  const [collecting, setCollecting] = useState(false);
  const accounts = useAccounts((s) => s.accounts);
  const openAccount = useUi((s) => s.openAccount);
  const setRoute = useUi((s) => s.setRoute);
  const setMetricsPlatform = useUi((s) => s.setMetricsPlatform);
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.metrics
        .overview(30)
        .then((d) => !cancelled && setData(d))
        .catch(() => undefined);
    void load();
    const off = api.on("metrics-updated", () => void load());
    const off2 = api.on("account-changed", () => void load());
    return () => {
      cancelled = true;
      off();
      off2();
    };
  }, [accounts.length]);

  const collectAll = async () => {
    setCollecting(true);
    try {
      const runs = await api.metrics.collectNow();
      const ok = runs.filter((r) => r.status === "success" || r.status === "partial").length;
      useToasts
        .getState()
        .push({ kind: "success", title: "采集完成", message: `${ok}/${runs.length} 个账号已更新` });
      setData(await api.metrics.overview(30));
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
          <p>所有平台账号的实时状态与数据汇总。同平台数据可相加,跨平台仅作展示。</p>
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

      <h3 className={styles.rowTitle}>全部数据</h3>
      <div className={cx(styles.kpiRow, styles.kpiRow5)}>
        <Kpi
          icon={UsersRound}
          label="账号"
          value={data?.accountCount}
          sub={data ? `${data.onlineCount} 在线 · ${data.attentionCount} 需关注` : undefined}
          accent="#6366f1"
          loading={!data}
        />
        <Kpi
          icon={Users}
          label="总粉丝"
          value={t.followers}
          delta={d.followers}
          accent="var(--brand-500)"
          loading={!data}
        />
        <Kpi icon={Heart} label="总获赞" value={t.likes} delta={d.likes} accent="#ec4899" loading={!data} />
        <Kpi
          icon={MessageCircle}
          label="总评论"
          value={t.comments}
          delta={d.comments}
          accent="#f59e0b"
          loading={!data}
        />
        <Kpi icon={Eye} label="总播放" value={t.plays} delta={d.plays} accent="#0ea5e9" loading={!data} />
      </div>

      <h3 className={styles.rowTitle}>今日观测</h3>
      <div className={cx(styles.kpiRow, styles.kpiRow5)}>
        <Kpi
          icon={UserPlus}
          label="今日涨粉"
          value={d.followers}
          signed
          accent="var(--brand-500)"
          loading={!data}
          sub="较今日 0 点"
        />
        <Kpi
          icon={Heart}
          label="今日点赞"
          value={d.likes}
          signed
          accent="#ec4899"
          loading={!data}
          sub="较今日 0 点"
        />
        <Kpi
          icon={MessageCircle}
          label="今日评论"
          value={d.comments}
          signed
          accent="#f59e0b"
          loading={!data}
          sub="较今日 0 点"
        />
        <Kpi
          icon={Eye}
          label="今日播放"
          value={d.plays}
          signed
          accent="#0ea5e9"
          loading={!data}
          sub="较今日 0 点"
        />
        <Kpi
          icon={Share2}
          label="今日分享"
          value={d.shares}
          signed
          accent="#8b5cf6"
          loading={!data}
          sub="较今日 0 点"
        />
      </div>

      <div className={styles.grid}>
        <Card>
          <div className={styles.cardHead}>
            <div>
              <h3>近 30 天趋势</h3>
              <p>全部账号粉丝与获赞合计</p>
            </div>
            <div className={styles.legend}>
              <span>
                <i style={{ background: "var(--brand-500)" }} />
                粉丝
              </span>
              <span>
                <i style={{ background: "#ec4899" }} />
                获赞
              </span>
            </div>
          </div>
          <div style={{ height: 260 }}>
            {data && data.trend.length > 1 ? (
              <ResponsiveContainer>
                <AreaChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="ovF" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand-500)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--brand-500)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="ovL" x1="0" y1="0" x2="0" y2="1">
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
                    stroke="var(--brand-500)"
                    strokeWidth={2}
                    fill="url(#ovF)"
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Area
                    yAxisId="l"
                    type="monotone"
                    dataKey="likes"
                    stroke="#ec4899"
                    strokeWidth={2}
                    fill="url(#ovL)"
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
                {data ? "累计两次以上采集后显示趋势" : <Skeleton height={200} width="100%" />}
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
          {!data ? (
            <Skeleton height={120} />
          ) : data.attention.length === 0 ? (
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
                <span className={styles.platformGlyph} style={{ background: def.color }}>
                  {def.glyph}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{def.name}</strong>
                  <span>
                    {platform.accountCount} 个账号 · {platform.onlineCount} 在线
                  </span>
                </div>
                <ArrowRight size={16} color="var(--fg-subtle)" />
              </div>
              <div className={styles.platformStats}>
                <Stat label="粉丝" value={platform.totals.followers} delta={platform.dayDelta.followers} />
                <Stat label="获赞" value={platform.totals.likes} delta={platform.dayDelta.likes} />
                <Stat label="播放" value={platform.totals.plays} delta={platform.dayDelta.plays} />
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

function Stat({ label, value, delta }: { label: string; value?: number; delta?: number }) {
  return (
    <div className={styles.platformStat}>
      <span>{label}</span>
      <strong className="num">{formatNumber(value)}</strong>
      <Delta value={delta} />
    </div>
  );
}
