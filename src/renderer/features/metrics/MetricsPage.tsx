import { workMetric } from "@shared/metric-quality";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlatformLogo } from "@renderer/components/ui/PlatformLogo";
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
import type { MetricDelta, MetricName } from "@shared/types";
import { METRIC_NAMES, WORK_METRICS } from "@shared/types";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Cover,
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
import { showCollectAccepted } from "./collect-feedback";
import { WorkLink } from "./WorkLink";
import { BusinessAnalyticsPanel } from "./BusinessAnalyticsPanel";
import { METRIC_LABELS, RUN_LABELS, originLabel } from "./metric-presentation";
import { useMetricResource } from "./use-metric-resource";

type SortKey = MetricName | "dayFollowers";
type Range = 7 | 30 | 90;

export function MetricsPage() {
  const accounts = useAccounts((s) => s.accounts);
  const platformId = useUi((s) => s.metricsPlatform);
  const setPlatform = useUi((s) => s.setMetricsPlatform);
  const detailId = useUi((s) => s.metricsAccountId),
    setDetailId = useUi((s) => s.setMetricsAccountId);
  const [range, setRange] = useState<Range>(30);
  const [collectingAll, setCollectingAll] = useState(false);
  const collectAll = async () => {
    setCollectingAll(true);
    try { showCollectAccepted(await api.metrics.collectNow()); }
    catch { useToasts.getState().push({ kind: "error", title: "任务受理失败", message: "请稍后重试采集全部平台" }); }
    finally { setCollectingAll(false); }
  };

  const available = PLATFORM_LIST.filter((p) => accounts.some((a) => a.platformId === p.id));
  const selected =
    platformId && available.some((p) => p.id === platformId) ? platformId : (available[0]?.id ?? null);

  useEffect(() => {
    if (selected !== platformId) setPlatform(selected);
  }, [selected, platformId, setPlatform]);

  if (detailId && accounts.some((account) => account.id === detailId))
    return (
      <AccountDetail key={detailId} accountId={detailId} range={range} onBack={() => setDetailId(null)} onRange={setRange} />
    );

  return (
    <div className={layout.page}>
      <div className={layout.pageHead}>
        <div>
          <span className={layout.eyebrow}>ANALYTICS</span>
          <h1>数据观测</h1>
          <p>查看粉丝、关注、获赞、评论、播放、分享、收藏与作品；缺失数据保留为空，采集通过各账号自身登录会话只读进行。</p>
        </div>
        <div className={styles.detailActions}>
        <Button icon={RefreshCw} loading={collectingAll} disabled={!accounts.length} onClick={collectAll}>采集全部平台</Button>
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
                  <PlatformLogo platformId={p.id} size={20} />
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
  const { data, loading, error, retry } = useMetricResource(useCallback(
    () => api.metrics.platform(platformId, range), [platformId, range]));
  const accounts = useAccounts(state => state.accounts);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "followers", dir: -1 });
  const [collecting, setCollecting] = useState(false);
  const platform = PLATFORMS[platformId];

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
      const batches = await Promise.all(
        accounts.filter(account => account.platformId === platformId).map(account => api.metrics.collectNow(account.id)),
      );
      showCollectAccepted(batches.flat());
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
      {error && <LoadError label="平台数据读取失败" retry={retry} retained={Boolean(data)} />}
      <div className={styles.summaryRow}>
        <SummaryCell
          label={`${platform.shortName}账号`}
          value={data?.accountCount}
          sub={data ? `${data.onlineCount} 在线` : undefined}
          loading={loading && !data}
        />
        {METRIC_NAMES.map(metric => <SummaryCell key={metric} label={`${METRIC_LABELS[metric]}合计`}
          sub={data ? `${data.coverage?.[metric] ?? 0}/${data.accountCount} 个账号有值` : undefined}
          value={data?.totals[metric]} delta={data?.dayDelta[metric]} loading={loading && !data} />)}
      </div>
      {data && !METRIC_NAMES.some(metric => data.totals[metric] != null) &&
        <p role="status" className={styles.notice}>该平台尚未取得指标。完成账号登录后可点击「采集本平台」；进入账号详情查看采集结果与原因。</p>}
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
        <p className={styles.scopeNote}>点击账号查看全部 8 项指标、趋势、作品及经营分析；横向滚动可查看全部列。</p>
        <div className={styles.tableScroll}>
          <Table>
            <thead>
              <tr>
                <th>账号</th>
                <th>状态</th>
                <th>最近采集</th>
                {METRIC_NAMES.map(metric => header(METRIC_LABELS[metric], metric))}
                {header("今日涨粉", "dayFollowers")}
                <th>粉丝趋势</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {!data && loading
                ? Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={14}>
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
                      <td className={styles.runCell}>
                        <strong>{row.lastRun ? RUN_LABELS[row.lastRun.status] : "尚未采集"}</strong>
                        <small title={row.lastRun?.message ?? undefined}>{row.lastRun?.message || "进入账号查看详情"}</small>
                      </td>
                      {METRIC_NAMES.map(metric => <MetricTd key={metric} delta={row.metrics[metric]} />)}
                      <td className={styles.metricCell}>
                        <Delta value={row.metrics.followers?.day} />
                      </td>
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
              {!loading && !rows.length && <tr><td colSpan={14}>{error ? "读取失败，请重试" : "暂无账号明细，请刷新数据或添加账号"}</td></tr>}
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
    <td className={styles.metricCell} title={delta?.current == null ? "尚未取得该指标" : `${originLabel(delta.origin)} · ${formatDateTime(delta.capturedAt)}`}>
      <strong className="num">{formatNumber(delta?.current)}</strong>
      <Delta value={delta?.day} />
    </td>
  );
}

function LoadError({ label, retry, retained }: { label: string; retry: () => void; retained?: boolean }) {
  return <div role="alert" className={styles.notice}>
    <span>{label}。{retained ? "已保留上次读取结果。" : "请重试读取本地数据。"}</span>
    <Button size="sm" onClick={retry}>重试读取</Button>
  </div>;
}

function Spark({ values, color }: { values: Array<number | null>; color: string }) {
  if (!values.some((value) => value != null)) return <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>—</span>;
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
            dot={{ r: 1.5 }}
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
  const [collecting, setCollecting] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [detailSection, setDetailSection] = useState<"basic" | "business">("basic");
  const [trendMetric, setTrendMetric] = useState<MetricName>("followers");
  const { data: view, loading, error, retry } = useMetricResource(useCallback(
    () => api.metrics.account(accountId, range), [accountId, range]), accountId);
  const { data: works, loading: worksLoading, error: worksError, retry: retryWorks } = useMetricResource(useCallback(
    () => api.works.list(accountId, 50, pageIndex * 50), [accountId, pageIndex]), accountId);

  const topWorks = useMemo(() => [...(works ?? [])].sort((a, b) => (workMetric(b, "plays") ?? -1) - (workMetric(a, "plays") ?? -1)), [works]);

  if (!account) return null;
  const platform = PLATFORMS[account.platformId];
  const m = view?.metrics ?? {};

  const collect = async () => {
    setCollecting(true);
    try {
      showCollectAccepted(await api.metrics.collectNow(accountId));
    } catch (error) {
      useToasts.getState().push({ kind: "error", title: "任务受理失败", message: (error as Error).message });
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
          badge={<PlatformLogo platformId={platform.id} size={16} />}
          badgeColor={platform.color}
        />
        <div className={styles.detailIdentity}>
          <h2>{account.displayName}</h2>
          <p>
            <Badge tone={STATUS_TONE[account.status]}>{STATUS_LABEL[account.status]}</Badge>
            {"  "}
            {account.handle ? `@${account.handle} · ` : ""}最后成功更新{" "}
            {formatRelative(view?.capturedAt)} · 最后尝试 {formatRelative(view?.lastRun?.finishedAt)}
          </p>
        </div>
        <div className={styles.detailActions}>
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
        <Button onClick={() => void api.metrics.collectHistory(accountId).then(() =>
          useToasts.getState().push({ kind: "info", title: "历史补采已加入队列" })).catch((error: Error) =>
          useToasts.getState().push({ kind: "error", title: "无法启动历史补采", message: error.message }))}>补齐历史作品</Button>
        <Button variant="primary" icon={ExternalLink} onClick={() => openAccount(accountId)}>
          打开账号页面
        </Button>
        </div>
      </div>

      {error && <LoadError label="账号指标读取失败" retry={retry} retained={Boolean(view)} />}
      {view && <div className={styles.notice} role="status">
        {view.lastRun ? <><strong>{RUN_LABELS[view.lastRun.status]}</strong>
          <span>{view.lastRun.message || "本次未提供额外说明"}</span>
          <span>{formatDateTime(view.lastRun.finishedAt ?? view.lastRun.startedAt)} · 写入 {view.lastRun.metricsWritten} 条指标 / {view.lastRun.worksWritten} 条作品</span>
        </> : <span>尚无采集记录。完成登录后点击「立即采集」，查看可取得的指标及作品。</span>}
      </div>}

      <div style={{ marginBottom: 16 }}><Tabs value={detailSection} onChange={setDetailSection}
        items={[{ value: "basic", label: "基础数据" }, { value: "business", label: "经营分析" }]} /></div>
      {detailSection === "business" ? <BusinessAnalyticsPanel accountId={accountId} /> : <>
      <div className={styles.detailGrid}>
        {METRIC_NAMES.map((key) => (
          <Card key={key} className={styles.detailKpi}>
            <span>{METRIC_LABELS[key]}</span>
            {view || !loading ? (
              <strong className="num">{formatNumber(m[key]?.current)}</strong>
            ) : (
              <Skeleton height={28} width={100} style={{ marginTop: 6 }} />
            )}
            <small title={formatDateTime(m[key]?.capturedAt)}>{m[key]?.current == null ? "尚未取得该指标" : "更新 " + formatRelative(m[key]?.capturedAt) + " · " + originLabel(m[key]?.origin)}</small>
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
        <div className={styles.chartHead}>
          <strong>{METRIC_LABELS[trendMetric]}趋势 · 最近 {range} 天</strong>
          <label>趋势指标 <select value={trendMetric} onChange={event => setTrendMetric(event.target.value as MetricName)}>
            {METRIC_NAMES.map(metric => <option key={metric} value={metric}>{METRIC_LABELS[metric]}</option>)}
          </select></label>
        </div>
        <div style={{ height: 240 }}>
          {view && view.trend.some(point => point[trendMetric] != null) ? (
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
                  formatter={(value) => [
                    formatNumber(Number(value), false),
                    METRIC_LABELS[trendMetric],
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey={trendMetric}
                  stroke={platform.color}
                  strokeWidth={2}
                  fill="url(#detF)"
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
              {loading ? "正在读取趋势…" : `${METRIC_LABELS[trendMetric]}在所选时段暂无有效观测，采集后可在此查看；缺失值不会显示为 0。`}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div className={styles.chartHead}>
          <strong style={{ fontSize: "var(--text-md)" }}>作品列表 · 当前页按播放排序</strong>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
            第 {pageIndex + 1} 页 · 本页 {works?.length ?? 0} 条 / 已采 {view?.collectedWorkCount ?? "—"} 条
          </span>
        </div>
        {worksError && <LoadError label="作品列表读取失败" retry={retryWorks} retained={Boolean(works)} />}
        {works == null && worksLoading ? (
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
              <WorkLink key={work.id} work={work} account={account} className={styles.workCard}>
                <Cover className={styles.noCover} src={work.coverUrl} />
                <div style={{ minWidth: 0 }}>
                  <strong title={work.title}>{work.title || "(无标题)"}</strong>
                  <dl className={styles.workMetrics}>{WORK_METRICS.map(metric => {
                    const value = workMetric(work, metric), observation = work.observations?.[metric];
                    return <div key={metric}><dt>{METRIC_LABELS[metric]}</dt><dd>
                      <span className="num">{value == null ? "未取得" : formatNumber(value)}</span>
                      {value != null && <small title={formatDateTime(observation?.capturedAt ?? work.fetchedAt)}>
                        {originLabel(observation?.origin)} · {formatRelative(observation?.capturedAt ?? work.fetchedAt)}
                      </small>}
                    </dd></div>;
                  })}</dl>
                  <small>发布 {formatDateTime(work.publishedAt)}</small>
                </div>
              </WorkLink>
            ))}
          </div>
        )}
        <div className={styles.pagination}>
          <Button disabled={pageIndex === 0 || worksLoading} onClick={() => setPageIndex((n) => n - 1)}>上一页</Button>
          <Button disabled={worksLoading || (pageIndex + 1) * 50 >= (view?.collectedWorkCount ?? 0)} onClick={() => setPageIndex((n) => n + 1)}>下一页</Button>
        </div>
        <p className={styles.scopeNote}>以下合计仅覆盖已采作品，含历史值，不代表账号全部作品总计。</p>
        <div className={styles.workTotals}>{WORK_METRICS.map(metric => <div key={metric}>
          <span>已采作品{METRIC_LABELS[metric]}合计</span><strong>{formatNumber(view?.workTotals?.[metric])}</strong>
          {view?.workCoverage?.[metric] && <small>{view.workCoverage[metric]!.observed}/{view.collectedWorkCount ?? 0} 条有值，其中 {view.workCoverage[metric]!.legacy} 条来源未验证</small>}
        </div>)}</div>
      </Card>
      </>}
    </div>
  );
}
