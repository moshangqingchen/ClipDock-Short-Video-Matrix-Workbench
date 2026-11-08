import { Database, ArrowUpRight } from "lucide-react";
import { METRIC_NAMES, type OverviewView } from "@shared/types";
import { Button, Card, Skeleton, formatRelative } from "@renderer/components/ui";
import { METRIC_LABELS } from "@renderer/features/metrics/metric-presentation";
import { useUi } from "@renderer/store";
import styles from "./dashboard.module.css";

export function ObservationHealth({ data, loading, error = false }: { data: OverviewView | null; loading: boolean; error?: boolean }) {
  const timestamps = data?.platforms.flatMap(platform => platform.accounts)
    .map(account => account.capturedAt).filter((at): at is string => Boolean(at) && Number.isFinite(Date.parse(at!))) ?? [];
  const latest = timestamps.length ? timestamps.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b) : null;
  return <Card className={styles.healthCard}>
    <div className={styles.cardHead}>
      <div><h3><Database size={16} /> 数据覆盖</h3><p>有值才计入，未取得的指标保留为空</p></div>
      <Button size="sm" variant="ghost" icon={ArrowUpRight} onClick={() => { useUi.getState().setMetricsAccountId(null); useUi.getState().setMetricsPlatform(null); useUi.getState().setRoute("metrics"); }}>查看</Button>
    </div>
    {loading && !data ? <Skeleton height={100} /> : <div className={styles.coverageGrid}>
      {METRIC_NAMES.map(metric => {
        const covered = data?.coverage ? data.coverage[metric] ?? 0 : undefined;
        const count = data?.accountCount;
        return <div key={metric} className={styles.coverageItem}>
          <div><span>{METRIC_LABELS[metric]}</span><strong>{covered == null || count == null ? "—" : `${covered} / ${count}`}</strong></div>
          <div className={styles.coverageTrack}><span style={{ width: `${count && covered != null ? Math.min(100, covered / count * 100) : 0}%` }} /></div>
        </div>;
      })}
    </div>}
    <p className={styles.coverageNote} title={latest ? new Date(latest).toLocaleString("zh-CN") : undefined}>
      {latest ? `最近一条账号快照：${formatRelative(latest)}`
        : !data ? error ? "读取失败，暂时无法确认快照情况" : "正在读取账号快照"
        : "尚无账号快照，采集后会显示覆盖情况"} · 单位：账号
    </p>
  </Card>;
}
