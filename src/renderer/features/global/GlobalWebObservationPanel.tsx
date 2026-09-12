import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Activity,
  BarChart3,
  Clock3,
  Eye,
  Heart,
  ListVideo,
  MessageCircle,
  MousePointer2,
  RefreshCw,
  Share2,
  Users,
  X,
} from "lucide-react";
import type { GlobalAccount } from "@shared/global-accounts";
import { GLOBAL_PLATFORM_DEFINITIONS } from "@shared/global-platforms";
import {
  WEB_METRICS,
  webObservationHistorySchema,
  webObservationSchema,
  webObserveErrorCode,
  type WebObservation,
} from "@shared/global-web-observation";
import { observationDay, observationTrend, type WebMetricKey } from "@shared/global-web-trend";
import { Badge, Button, IconButton, Tabs } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { GlobalReadPanel } from "./GlobalReadPanel";
import styles from "./global-web-observation.module.css";

const messages = {
  WEB_OBSERVE_CLOSED: "请先打开这个账号的官网并完成登录。",
  WEB_OBSERVE_PAGE_REQUIRED: "请打开官方数据中心，等指标显示后点击立即采集。",
  WEB_OBSERVE_UNAVAILABLE: "当前页面暂时无法采集。请等待数据加载完成后重试。",
  WEB_OBSERVE_CANCELLED: "页面或网络状态已变化，本次未保存，请重新采集。",
  WEB_OBSERVE_BUSY: "这个账号正在采集，请稍后再试。",
};
const expected: Record<GlobalAccount["platformId"], WebMetricKey[]> = {
  youtube: ["followers", "views", "watchHours", "impressions", "likes", "works"],
  tiktok: ["followers", "views", "likes", "comments", "shares", "profileVisits"],
  x: ["followers", "views", "impressions", "engagements", "profileVisits", "likes", "shares"],
};
const icons = {
  followers: Users,
  views: Eye,
  likes: Heart,
  comments: MessageCircle,
  shares: Share2,
  watchHours: Clock3,
  impressions: BarChart3,
  engagements: MousePointer2,
  profileVisits: Users,
  works: ListVideo,
};
const colors = ["#2878ff", "#0ea5e9", "#ec4899", "#f59e0b", "#8b5cf6", "#6366f1"];
interface Props {
  account: GlobalAccount;
  readable: boolean;
  canNavigate: boolean;
  onAnalytics(): void;
  onClose(): void;
  subjectId?: string | null;
  refreshVersion?: number;
  enqueueRead?(): Promise<void>;
  prepareRead?(): Promise<void>;
  finishRead?(): void;
  onConfigureApi?(): void;
  onAccountChanged?(): void;
}
export function GlobalWebObservationPanel(props: Props) {
  return <Observation key={props.account.id} {...props} />;
}
function Observation({
  account,
  readable,
  canNavigate,
  onAnalytics,
  onClose,
  prepareRead,
  enqueueRead,
  refreshVersion,
  subjectId,
  finishRead,
  onConfigureApi,
  onAccountChanged,
}: Props) {
  const [tab, setTab] = useState<"web" | "api">("web");
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const [metricKey, setMetricKey] = useState<WebMetricKey>("followers");
  const [snapshot, setSnapshot] = useState<WebObservation | null>(null);
  const [history, setHistory] = useState<WebObservation[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const life = useRef({ alive: false, revision: 0, pending: false });
  const keys = [
    ...new Set([...expected[account.platformId], ...(snapshot?.metrics.map((metric) => metric.key) ?? [])]),
  ];
  useEffect(() => {
    const current = { alive: true, revision: 0, pending: false };
    life.current = current;
    void Promise.all([api.globalWeb.observation(account.id), api.globalWeb.observationHistory(account.id)])
      .then(([raw, rows]) => {
        if (!current.alive || current.revision !== 0) return;
        const values = webObservationHistorySchema.parse(rows);
        const value = raw === null ? null : webObservationSchema.parse(raw);
        if (
          [...values, ...(value ? [value] : [])].some(
            (item) => item.accountId !== account.id || item.platformId !== account.platformId,
          )
        )
          throw new Error("WEB_OBSERVE_UNAVAILABLE");
        setSnapshot(value && (!subjectId || value.subjectId === subjectId) ? value : null);
        setHistory(subjectId ? values.filter((row) => row.subjectId === subjectId) : values);
      })
      .catch(() => {
        if (current.alive && current.revision === 0)
          setFeedback("本机采集记录暂不可用，可重新采集当前页面。");
      });
    return () => {
      current.alive = false;
    };
  }, [account.id, account.platformId, refreshVersion, subjectId]);
  const read = async () => {
    const current = life.current;
    if (!hasBridge || !readable || !current.alive || current.pending) return;
    current.pending = true;
    current.revision++;
    setBusy(true);
    setFeedback(null);
    setFresh(false);
    try {
      if (enqueueRead) {
        await enqueueRead();
        if (current.alive) setFeedback("已加入后台采集队列，结果完成后自动更新");
        return;
      }
      await prepareRead?.();
      if (!current.alive) return;
      const value = webObservationSchema.parse(await api.globalWeb.readPage(account.id));
      if (!current.alive) return;
      if (value.accountId !== account.id || value.platformId !== account.platformId)
        throw new Error("WEB_OBSERVE_UNAVAILABLE");
      if (value.metrics.length) {
        setSnapshot(value);
        setFresh(true);
        setHistory((previous) => [...previous, value]);
        try {
          const rows = webObservationHistorySchema.parse(await api.globalWeb.observationHistory(account.id));
          if (rows.some((item) => item.accountId !== account.id || item.platformId !== account.platformId))
            throw new Error("WEB_OBSERVE_UNAVAILABLE");
          if (current.alive) setHistory(rows);
        } catch {
          if (current.alive) setFeedback("本次采集已保存，历史记录暂未刷新，请重新打开数据观测。");
        }
      } else setFeedback("当前页没有识别到可汇总的指标。请确认已登录、数据已显示；未读取的数据以“—”表示。");
    } catch (error) {
      if (current.alive) setFeedback(messages[webObserveErrorCode(error)]);
    } finally {
      current.pending = false;
      if (current.alive) {
        setBusy(false);
        finishRead?.();
      }
    }
  };
  const trend = useMemo(
    () => observationTrend(history, snapshot, metricKey, range),
    [history, snapshot, metricKey, range],
  );
  const records = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - range + 1);
    const rows = new Map<string, WebObservation>();
    for (const value of [...history, ...(snapshot ? [snapshot] : [])]) {
      if (new Date(value.capturedAt) >= start) rows.set(value.capturedAt, value);
    }
    return [...rows.values()].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }, [history, snapshot, range]);
  return (
    <aside className={styles.panel} data-collecting={busy} aria-label="网页数据观测">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>
            OBSERVE · {GLOBAL_PLATFORM_DEFINITIONS[account.platformId].name}
          </span>
          <h2>
            {account.displayName} <Badge tone="info">网页采集</Badge>
          </h2>
          <p>
            数据来自该账号已登录的官方页面 · {snapshot?.subjectId ? `身份 ${snapshot.subjectId} · ` : ""}
            上次采集 {snapshot ? new Date(snapshot.capturedAt).toLocaleString() : "从未"}
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
          <Button
            icon={RefreshCw}
            loading={busy}
            disabled={!hasBridge || !readable || busy}
            onClick={() => void read()}
          >
            立即采集
          </Button>
          <IconButton icon={X} label="关闭数据观测" onClick={onClose} />
        </div>
      </header>
      <nav className={styles.tabs} aria-label="数据来源">
        <Button size="sm" variant={tab === "web" ? "primary" : "ghost"} onClick={() => setTab("web")}>
          网页数据
        </Button>
        <Button size="sm" variant={tab === "api" ? "primary" : "ghost"} onClick={() => setTab("api")}>
          官方 API（可选）
        </Button>
        <Button size="sm" variant="ghost" disabled={!canNavigate || busy} onClick={onAnalytics}>
          打开官方数据中心
        </Button>
      </nav>
      <div className={styles.scroll}>
        {tab === "web" ? (
          <>
            <p className={styles.help}>
              登录官网后即可采集。系统在该账号的独立后台页面读取数据，不影响当前浏览或编辑。
              7／30／90 天筛选本机历史，官网统计周期单独标注，无需配置 API。
            </p>
            {busy ? (
              <p className={styles.notice} role="status">
                正在读取此账号的官方页面，完成后自动返回看板…
              </p>
            ) : null}
            {!readable ? (
              <p className={styles.notice}>请开启代理并打开这个账号的官网，完成登录后即可采集。</p>
            ) : null}
            {feedback ? (
              <p className={styles.notice} role="status">
                {feedback}
                {snapshot ? " 下方保留上次成功读取的快照。" : ""}
              </p>
            ) : null}
            {fresh && !feedback ? (
              <p className={styles.success} role="status">
                已保存本次采集，账号数据独立保存在本机。
              </p>
            ) : null}
            <div className={styles.sectionHeading}>
              <h3>官网数据观测</h3>
              <span>页面日期范围：{snapshot?.period ?? "未识别，请以官网为准"}</span>
            </div>
            <div className={styles.metrics} aria-label="网页指标">
              {keys.map((key, index) => {
                const metric = snapshot?.metrics.find((item) => item.key === key),
                  Icon = icons[key];
                return (
                  <article
                    key={key}
                    className={styles.metric}
                    style={{ "--accent": colors[index % colors.length] } as CSSProperties}
                  >
                    <span className={styles.metricIcon}>
                      <Icon size={18} />
                    </span>
                    <span>{WEB_METRICS[key]}</span>
                    <strong key={metric?.value} className={fresh ? styles.updated : undefined}>
                      {metric?.value ?? "—"}
                    </strong>
                    <small>
                      {metric
                        ? `官网字段：${metric.label}`
                        : snapshot
                          ? "该官网页面未显示此字段，请核对统计权限和周期"
                          : "尚无成功采集记录"}
                    </small>
                  </article>
                );
              })}
            </div>
            <div className={styles.split}>
              <section className={styles.card}>
                <div className={styles.sectionHeading}>
                  <div>
                    <h3>数据趋势</h3>
                    <p>近 {range} 天，同一统计口径，每日最后一次采集值</p>
                  </div>
                  <select
                    aria-label="趋势指标"
                    value={metricKey}
                    onChange={(event) => setMetricKey(event.target.value as WebMetricKey)}
                  >
                    {keys.map((key) => (
                      <option key={key} value={key}>
                        {WEB_METRICS[key]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.chart}>
                  {trend.length > 1 ? (
                    <ResponsiveContainer>
                      <AreaChart data={trend} margin={{ top: 15, right: 20, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" />
                        <XAxis
                          dataKey="day"
                          tickFormatter={(day) => String(day).slice(5)}
                          tick={{ fontSize: 12 }}
                        />
                        <YAxis width={48} tick={{ fontSize: 12 }} />
                        <Tooltip
                          formatter={(_value, _name, item) => [item.payload.display, WEB_METRICS[metricKey]]}
                        />
                        <Area
                          type="linear"
                          dataKey="value"
                          stroke="#2878ff"
                          fill="#2878ff"
                          fillOpacity={0.12}
                          isAnimationActive={false}
                          connectNulls={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className={styles.empty}>
                      <Activity size={28} />
                      <span>累计两天以上的同口径采集后显示趋势</span>
                      <small>尚未采集的日期不会补成零</small>
                    </div>
                  )}
                </div>
              </section>
              <section className={styles.card}>
                <div className={styles.sectionHeading}>
                  <div>
                    <h3>采集记录</h3>
                    <p>
                      近 {range} 天 · {records.length} 条记录
                    </p>
                  </div>
                  <Clock3 size={17} />
                </div>
                {records.length ? (
                  <div className={styles.records}>
                    {records.slice(0, 12).map((value) => (
                      <div key={value.capturedAt}>
                        <strong>
                          {observationDay(value.capturedAt)} {new Date(value.capturedAt).toLocaleTimeString()}
                        </strong>
                        <span>
                          {value.metrics.length} 项指标 · {value.period ?? "页面日期范围未识别"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.empty}>
                    <ListVideo size={28} />
                    <span>尚无采集记录</span>
                    <small>登录官网后，点击右上角“立即采集”</small>
                  </div>
                )}
              </section>
            </div>
            <div className={styles.source}>
              <span>来源：{snapshot?.engine === "chrome" ? "Chrome 官方页面" : "账号官方页面"}</span>
              {snapshot ? (
                <span className={styles.page} title={snapshot.page}>
                  {snapshot.page}
                </span>
              ) : null}
            </div>
            <p className={styles.help}>
              指标保留官网单位、统计周期和账号身份，不将周期内数据当作“今日新增”。未知值显示“—”，失败时保留旧记录；作品表现单独列在下方。
            </p>
          </>
        ) : (
          <>
            <p className={styles.help}>
              可选：通过官方 API 汇总账号资料、指标和作品。此方式需要单独授权，不影响网页登录和网页采集。
            </p>
            {account.authStatus !== "authorized" && onConfigureApi ? (
              <Button size="sm" onClick={onConfigureApi}>
                配置官方 API 授权
              </Button>
            ) : null}
            <GlobalReadPanel account={account} onAccountChanged={onAccountChanged} />
          </>
        )}
      </div>
    </aside>
  );
}
