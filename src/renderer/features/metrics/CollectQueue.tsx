import { useEffect, useState } from "react";
import { COLLECT_JOB_LABELS, isActiveCollectJob, type CollectJob } from "@shared/collect-jobs";
import { Button, Card, formatRelative } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { useAccounts, useToasts } from "@renderer/store";
import styles from "./collect-queue.module.css";

export function CollectQueue() {
  const [jobs, setJobs] = useState<CollectJob[]>([]);
  const accounts = useAccounts((s) => s.accounts);
  useEffect(() => {
    let alive = true,
      revision = 0;
    const load = () => {
      const request = ++revision;
      void api.metrics
        .jobs()
        .then((next) => {
          if (alive && request === revision) setJobs(next);
        })
        .catch(() => undefined);
    };
    const off = api.on("collect-job", load);
    const offAccounts = api.on("accounts-reloaded", load);
    load();
    return () => {
      alive = false;
      off();
      offAccounts();
    };
  }, []);
  const active = jobs.filter(isActiveCollectJob).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recent = jobs.filter((j) => !isActiveCollectJob(j)).slice(0, 5);
  const cancel = async (id: string) => {
    try {
      const next = await api.metrics.cancelJob(id);
      if (next) setJobs((list) => list.map((j) => (j.id === id ? next : j)));
    } catch {
      useToasts.getState().push({ kind: "error", title: "取消任务失败" });
    }
  };
  if (!jobs.length) return null;
  return (
    <Card className={styles.queue}>
      <div className={styles.head}>
        <h3>采集队列</h3>
        <span>
          {active.length} 个待完成 · {active.filter((j) => j.state === "waiting-network").length}{" "}
          个等待国内网络
        </span>
      </div>
      <p>相同账号的重复采集合并。网络恢复只继续已登录账号的数据任务。</p>
      <ul>
        {[...active, ...recent].map((job) => (
          <li key={job.id}>
            <div>
              <strong>{accounts.find((a) => a.id === job.accountId)?.displayName ?? "账号"}</strong>
              <span>
                {COLLECT_JOB_LABELS[job.state]} · {formatRelative(job.createdAt)}
              </span>
              {job.message && <small>{job.message}</small>}
            </div>
            {isActiveCollectJob(job) && (
              <Button size="sm" variant="ghost" onClick={() => void cancel(job.id)}>
                取消任务
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
