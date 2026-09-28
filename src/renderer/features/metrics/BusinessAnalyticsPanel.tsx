import { useEffect, useState } from "react";
import { AVAILABILITY_LABELS, BUSINESS_LABELS, BUSINESS_METRICS, type AnalyticsRecord, type AnalyticsView } from "@shared/business-analytics";
import { api } from "@renderer/lib/api";
import { Button, Card, Tabs, formatRelative } from "@renderer/components/ui";
import { useToasts, useUi } from "@renderer/store";
import styles from "./business-analytics.module.css";

function Value({ record }: { record: AnalyticsRecord }) {
  const data = record.data;
  if (data.kind === "rate") return <strong>{(data.value * 100).toFixed(2)}%</strong>;
  if (data.kind === "duration") return <strong>{data.value.toLocaleString()} 秒</strong>;
  if (data.kind === "money") return <strong>{data.value.toLocaleString(undefined, { minimumFractionDigits: 2 })} {data.currency} · {data.settlement === "estimated" ? "预估" : "已结算"}</strong>;
  return <table className={styles.distribution}><caption>{data.dimension}</caption><tbody>
    {data.entries.map((entry, index) => <tr key={index}><td>{entry.label}</td><td>{data.unit === "ratio" ? (entry.value * 100).toFixed(2) + "%" : entry.value.toLocaleString() + (data.unit === "people" ? " 人" : " 次")}</td></tr>)}
  </tbody></table>;
}
export function BusinessAnalyticsPanel({ accountId }: { accountId: string }) {
  const [days, setDays] = useState<7 | 30 | 90>(90);
  const [view, setView] = useState<AnalyticsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, sequence = 0;
    const load = () => {
      const request = ++sequence;
      void api.analytics.get(accountId, days).then((next) => { if (alive && request === sequence) { setView(next); setError(null); } })
        .catch(() => { if (alive) setError("经营分析暂不可用"); });
    };
    load();
    const off = api.on("metrics-updated", ({ accountId: changed }) => { if (changed === accountId) load(); });
    return () => { alive = false; off(); };
  }, [accountId, days]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); setView(await api.analytics.get(accountId, days)); }
    catch (reason) { useToasts.getState().push({ kind: "warning", title: "经营数据未更新", message: reason instanceof Error ? reason.message : "请稍后重试" }); }
    finally { setBusy(false); }
  };
  return <Card className={styles.panel}>
    <div className={styles.toolbar}><h3>经营分析</h3><Tabs value={days} onChange={setDays} items={[{ value: 7, label: "7 天" }, { value: 30, label: "30 天" }, { value: 90, label: "90 天" }]} /></div>
    <p>按官方页面的统计区间保存，保留平台原始口径。收益仅包含内容收入；分布和比例不跨平台相加。</p>
    {error && <p role="alert">{error}</p>}
    {view && <>
      <div className={styles.toolbar}>
        <Button disabled={busy} onClick={() => void run(() => api.analytics.setEnabled(view.platformId, !view.enabled))}>{view.enabled ? "暂停此平台经营观测" : "启用此平台经营观测"}</Button>
        <Button disabled={busy} onClick={() => { useUi.getState().openAccount(accountId); void api.views.go(accountId, "analytics").catch(() => undefined); }}>打开官方分析页</Button>
        <Button disabled={!view.enabled || busy} onClick={() => void run(async () => { await api.analytics.readCurrentPage(accountId); useToasts.getState().push({ kind: "info", title: "经营页面读取已加入采集队列" }); })}>读取当前官方页面</Button>
      </div>
      <p>目标范围 {view.requestedStart} — {view.requestedEnd} · 最近尝试 {formatRelative(view.lastAttemptAt)}。仅出现下列记录不代表整个目标范围已补齐；可在官方页面选择日期后再次读取。</p>
      {(view.recordsTotal ?? 0) > view.records.length && <p role="status">该范围共有 {view.recordsTotal} 条记录，当前仅展示最近 {view.records.length} 条；完整记录保留在数据库和备份中。</p>}
      <div className={styles.grid}>{BUSINESS_METRICS.map((metric) => {
        const state = view.states.find((row) => row.metric === metric);
        const records = view.records.filter((row) => row.metric === metric);
        return <section key={metric} className={styles.metric}><h4>{BUSINESS_LABELS[metric]}</h4>
          <p>{state ? AVAILABILITY_LABELS[state.state] : "待核对"} · {state?.reason}</p>
          {!records.length ? <span className={styles.empty}>暂无可验证的数据</span> : records.map((record, index) => <div className={styles.record} key={index}>
            <small>{record.platformLabel} · {record.startDate} — {record.endDate}{record.workId ? " · 单作品" : " · 账号"}</small>
            <Value record={record} /><small>读取于 {formatRelative(record.capturedAt)} · 官方页面</small>
          </div>)}
        </section>;
      })}</div>
    </>}
  </Card>;
}
