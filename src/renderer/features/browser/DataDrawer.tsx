import { workMetric } from "@shared/metric-quality";
import { useCallback, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Eye, Heart, ListVideo, MessageCircle, RefreshCw, Share2, Star, UserPlus, Users, X } from "lucide-react";
import { METRIC_NAMES, type Account, type MetricName } from "@shared/types";
import {
  Button,
  Cover,
  Delta,
  EmptyState,
  IconButton,
  Skeleton,
  formatDateTime,
  formatNumber,
  formatRelative,
} from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { useToasts, useUi } from "@renderer/store";
import styles from "./workspace.module.css";
import { showCollectAccepted } from "@renderer/features/metrics/collect-feedback";
import { WorkLink } from "@renderer/features/metrics/WorkLink";
import { useMetricResource } from "@renderer/features/metrics/use-metric-resource";
import { METRIC_LABELS } from "@renderer/features/metrics/metric-presentation";

const metricIcons: Record<MetricName, typeof Users> = { followers: Users, following: UserPlus, likes: Heart,
  comments: MessageCircle, plays: Eye, shares: Share2, favorites: Star, works: ListVideo };

export function DataDrawer({ account, onClose }: { account: Account; onClose: () => void }) {
  const [collecting, setCollecting] = useState(false);
  const metrics = useMetricResource(useCallback(() => api.metrics.account(account.id, 14), [account.id]), account.id);
  const worksResource = useMetricResource(useCallback(() => api.works.list(account.id, 8), [account.id]), account.id);
  const view = metrics.data, works = worksResource.data;

  const collectNow = async () => {
    setCollecting(true);
    try {
      showCollectAccepted(await api.metrics.collectNow(account.id));
    } catch (error) {
      useToasts.getState().push({ kind: "error", title: "采集失败", message: (error as Error).message });
    } finally {
      setCollecting(false);
    }
  };

  const m = view?.metrics;
  const online = account.status === "online" || account.status === "expiring";

  return (
    <>
      <div className={styles.drawerHead}>
        <h3>账号数据</h3>
        <div style={{ display: "flex", gap: 4 }}>
          <Button
            size="sm"
            variant="soft"
            icon={RefreshCw}
            loading={collecting}
            disabled={!online}
            onClick={collectNow}
            title={online ? "立即在当前会话内读取最新数据" : "账号未登录"}
          >
            立即采集
          </Button>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </div>
      </div>
      <div className={styles.drawerBody}>
        {metrics.error && <div role="alert">账号指标读取失败 <Button size="sm" onClick={metrics.retry}>重试指标</Button></div>}
        <div className={styles.kpiGrid}>
          {METRIC_NAMES.map((key) => <Kpi key={key} icon={metricIcons[key]} label={METRIC_LABELS[key]}
            value={m?.[key]?.current} delta={m?.[key]?.day} loading={!view && metrics.loading} />)}
        </div>
        <Button size="sm" onClick={() => { useUi.getState().setMetricsAccountId(account.id); useUi.getState().setMetricsPlatform(account.platformId); useUi.getState().setRoute("metrics"); }}>查看全部指标与经营分析</Button>

        <div className={styles.section}>
          <h4>近 14 天粉丝趋势</h4>
          {view && view.trend.some((point) => point.followers != null) ? (
            <div style={{ height: 120 }}>
              <ResponsiveContainer>
                <AreaChart data={view.trend} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="drawerFollowers" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand-500)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--brand-500)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" hide />
                  <YAxis hide domain={["dataMin", "dataMax"]} />
                  <Tooltip
                    contentStyle={{
                      background: "var(--bg-elev)",
                      border: "1px solid var(--line)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "var(--fg-muted)" }}
                    formatter={(value) => [formatNumber(Number(value), false), "粉丝"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="followers"
                    stroke="var(--brand-500)"
                    strokeWidth={2}
                    fill="url(#drawerFollowers)"
                    dot={{ r: 2 }}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--fg-subtle)" }}>
              数据点不足,采集两次以上后显示趋势。
            </p>
          )}
        </div>

        <div className={styles.section}>
          <h4>近期作品</h4>
          {worksResource.error && <div role="alert">作品读取失败 <Button size="sm" onClick={worksResource.retry}>重试作品</Button></div>}
          {works == null && worksResource.loading ? (
            <Skeleton height={56} />
          ) : !works?.length ? (
            <EmptyState
              icon={Eye}
              title="暂无作品数据"
              description={online ? "点击「立即采集」读取作品列表。" : "登录后自动读取作品列表。"}
            />
          ) : (
            <div className={styles.workList}>
              {works.map((work) => (
                <WorkLink key={work.id} work={work} account={account} className={styles.workItem}>
                  <Cover className={styles.workCover} src={work.coverUrl} />
                  <div className={styles.workMeta}>
                    <strong title={work.title}>{work.title || "(无标题)"}</strong>
                    <span>
                      <span className="num">▶ {formatNumber(workMetric(work, "plays"))}</span>
                      <span className="num">♥ {formatNumber(workMetric(work, "likes"))}</span>
                      <span className="num">💬 {formatNumber(workMetric(work, "comments"))}</span>
                      <span className="num">↗ {formatNumber(workMetric(work, "shares"))}</span>
                      <span className="num">☆ {formatNumber(workMetric(work, "favorites"))}</span>
                      <span>{work.publishedAt ? formatDateTime(work.publishedAt) : ""}</span>
                    </span>
                  </div>
                </WorkLink>
              ))}
            </div>
          )}
        </div>

        <div className={styles.runInfo}>
          <span>
            上次采集:
            {view?.lastRun ? formatRelative(view.lastRun.finishedAt ?? view.lastRun.startedAt) : "从未"}
          </span>
          {view?.lastRun?.message ? (
            <span title={view.lastRun.message}>
              {view.lastRun.status === "success"
                ? "成功"
                : view.lastRun.status === "partial"
                  ? "部分成功"
                  : view.lastRun.status === "skipped"
                    ? "已跳过"
                    : "失败"}
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  delta,
  loading,
}: {
  icon: typeof Users;
  label: string;
  value?: number | null;
  delta?: number | null;
  loading: boolean;
}) {
  return (
    <div className={styles.kpi}>
      <span>
        <Icon size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
        {label}
      </span>
      {loading ? (
        <Skeleton height={24} style={{ marginTop: 6 }} />
      ) : (
        <strong className="num">{formatNumber(value)}</strong>
      )}
      <small>
        <Delta value={delta} /> <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>今日</span>
      </small>
    </div>
  );
}
