import { useCallback, useState } from "react";
import { AVAILABILITY_LABELS, BUSINESS_LABELS, BUSINESS_METRICS, type AnalyticsRecord } from "@shared/business-analytics";
import { api } from "@renderer/lib/api";
import { Button, Card, Tabs, formatRelative } from "@renderer/components/ui";
import { useToasts, useUi } from "@renderer/store";
import styles from "./business-analytics.module.css";
import { useMetricResource } from "./use-metric-resource";

function Value({ record }: { record: AnalyticsRecord }) {
  const data = record.data;
  if (data.kind === "rate") return <strong>{(data.value * 100).toFixed(2)}%</strong>;
  if (data.kind === "duration") return <strong>{data.value.toLocaleString()} 秒</strong>;
  if (data.kind === "money") return <strong>{data.value.toLocaleString(undefined, { minimumFractionDigits: 2 })} {data.currency} · {data.settlement === "estimated" ? "预估" : "已结算"}</strong>;
  return <table className={styles.distribution}><caption>{data.dimension}</caption><tbody>
    {data.entries.map((entry, index) => <tr key={index}><td>{entry.label}</td><td>{data.unit === "ratio" ? (entry.value * 100).toFixed(2) + "%" : entry.value.toLocaleString() + (data.unit === "people" ? " 人" : " 次")}</td></tr>)}
  </tbody></table>;
}

function MetricHistory({ metric, records }: { metric: keyof typeof BUSINESS_LABELS; records: AnalyticsRecord[] }) {
  const [limit, setLimit] = useState(10);
  return <>
    {!records.length ? <span className={styles.empty}>暂无可验证的数据。打开对应的官方分析页面，选择日期后读取。</span> : records.slice(0, limit).map((record, index) => <div className={styles.record} key={index}>
      <small>{record.platformLabel} · {record.startDate} — {record.endDate}{record.workId ? " · 单作品" : " · 账号"}</small>
      <Value record={record} /><small>读取于 {formatRelative(record.capturedAt)} · {record.source === "official-response" ? "官方接口" : "官方页面"}</small>
    </div>)}
    {records.length > limit && <Button size="sm" onClick={() => setLimit((n) => n + 10)}>查看更多{BUSINESS_LABELS[metric]}记录（剩余 {records.length - limit} 条）</Button>}
  </>;
}

export function BusinessAnalyticsPanel({ accountId }: { accountId: string }) {
  const [days, setDays] = useState<7 | 30 | 90>(90);
  const [busy, setBusy] = useState(false);
  const { data: view, error, retry } = useMetricResource(useCallback(() => api.analytics.get(accountId, days), [accountId, days]), accountId);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); retry(); }
    catch (reason) { useToasts.getState().push({ kind: "warning", title: "经营数据未更新", message: reason instanceof Error ? reason.message : "请稍后重试" }); }
    finally { setBusy(false); }
  };
  const openPage = async () => {
    if (view && !view.enabled) await api.analytics.setEnabled(view.platformId, true);
    useUi.getState().openAccount(accountId);
    await api.views.go(accountId, "analytics");
  };
  return <Card className={styles.panel}>
    <div className={styles.toolbar}><h3>经营分析</h3><Tabs value={days} onChange={setDays} items={[{ value: 7, label: "7 天" }, { value: 30, label: "30 天" }, { value: 90, label: "90 天" }]} /></div>
    <p>按官方页面的统计区间保存，保留平台原始口径。收益仅包含内容收入；分布和比例不跨平台相加。</p>
    <p>查看完播率、平均观看时长、内容收益、粉丝画像和流量来源。先打开官方分析页，待数据展示后返回此处读取；可切换官方收益或粉丝页面补充对应指标。</p>
    {error && <div role="alert"><p>经营分析暂不可用或读取超时，请重试。{view ? "已保留上次读取结果。" : ""}</p><Button size="sm" onClick={retry}>重试经营分析</Button></div>}
    {!view && !error && <p role="status">正在读取已保存的经营数据…</p>}
    {view && <>
      <div className={styles.toolbar}>
        <Button disabled={busy} onClick={() => void run(() => api.analytics.setEnabled(view.platformId, !view.enabled))}>{view.enabled ? "暂停此平台经营观测" : "启用此平台经营观测"}</Button>
        <Button disabled={busy} onClick={() => void run(openPage)}>{view.enabled ? "打开官方分析页" : "启用并打开官方分析页"}</Button>
        <Button disabled={!view.enabled || busy} onClick={() => void run(async () => { await api.analytics.readCurrentPage(accountId); useToasts.getState().push({ kind: "info", title: "经营页面读取已加入采集队列" }); })}>读取当前官方页面</Button>
      </div>
      <p>目标范围 {view.requestedStart} — {view.requestedEnd} · 最近尝试 {formatRelative(view.lastAttemptAt)}。仅出现下列记录不代表整个目标范围已补齐；可在官方页面选择日期后再次读取。</p>
      {(view.recordsTotal ?? 0) > view.records.length && <p role="status">该范围共有 {view.recordsTotal} 条记录，当前仅展示最近 {view.records.length} 条；完整记录保留在数据库和备份中。</p>}
      <div className={styles.grid}>{BUSINESS_METRICS.map((metric) => {
        const state = view.states.find((row) => row.metric === metric);
        const records = view.records.filter((row) => row.metric === metric);
        return <section key={metric} className={styles.metric}><h4>{BUSINESS_LABELS[metric]}</h4>
          <p>{state ? AVAILABILITY_LABELS[state.state] : "待核对"} · {state?.reason}</p>
          <MetricHistory key={`${accountId}:${days}:${metric}`} metric={metric} records={records} />
        </section>;
      })}</div>
    </>}
  </Card>;
}
