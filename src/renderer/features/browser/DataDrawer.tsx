import { useCallback, useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Eye, Heart, MessageCircle, RefreshCw, Users, X } from "lucide-react";
import type { Account, AccountMetricsView, Work } from "@shared/types";
import {
  Button,
  Delta,
  EmptyState,
  IconButton,
  Skeleton,
  formatDateTime,
  formatNumber,
  formatRelative,
} from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { useToasts } from "@renderer/store";
import styles from "./workspace.module.css";

export function DataDrawer({ account, onClose }: { account: Account; onClose: () => void }) {
  const [view, setView] = useState<AccountMetricsView | null>(null);
  const [works, setWorks] = useState<Work[] | null>(null);
  const [collecting, setCollecting] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([api.metrics.account(account.id, 14), api.works.list(account.id, 8)]).then(
        ([metrics, list]) => {
          setView(metrics);
          setWorks(list);
        },
      ),
    [account.id],
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
        <div className={styles.kpiGrid}>
          <Kpi
            icon={Users}
            label="粉丝"
            value={m?.followers?.current}
            delta={m?.followers?.day}
            loading={!view}
          />
          <Kpi icon={Heart} label="获赞" value={m?.likes?.current} delta={m?.likes?.day} loading={!view} />
          <Kpi icon={Eye} label="播放" value={m?.plays?.current} delta={m?.plays?.day} loading={!view} />
          <Kpi
            icon={MessageCircle}
            label="评论"
            value={m?.comments?.current}
            delta={m?.comments?.day}
            loading={!view}
          />
        </div>

        <div className={styles.section}>
          <h4>近 14 天粉丝趋势</h4>
          {view && view.trend.length > 1 ? (
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
                    dot={false}
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
          {works == null ? (
            <Skeleton height={56} />
          ) : works.length === 0 ? (
            <EmptyState
              icon={Eye}
              title="暂无作品数据"
              description={online ? "点击「立即采集」读取作品列表。" : "登录后自动读取作品列表。"}
            />
          ) : (
            <div className={styles.workList}>
              {works.map((work) => (
                <div key={work.id} className={styles.workItem}>
                  {work.coverUrl ? (
                    <img
                      className={styles.workCover}
                      src={work.coverUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className={styles.workCover} />
                  )}
                  <div className={styles.workMeta}>
                    <strong title={work.title}>{work.title || "(无标题)"}</strong>
                    <span>
                      <span className="num">▶ {formatNumber(work.plays)}</span>
                      <span className="num">♥ {formatNumber(work.likes)}</span>
                      <span className="num">💬 {formatNumber(work.comments)}</span>
                      <span>{work.publishedAt ? formatDateTime(work.publishedAt) : ""}</span>
                    </span>
                  </div>
                </div>
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
