import { useEffect, useRef, useState } from "react";
import type { GlobalAccount } from "@shared/global-accounts";
import {
  globalReadErrorCode,
  globalReadSnapshotSchema,
  type GlobalReadCapabilityState,
  type GlobalReadErrorCode,
  type GlobalReadSnapshot,
} from "@shared/global-read";
import { globalJobSchema, globalJobsSchema, isActiveGlobalJob, type GlobalJob } from "@shared/global-jobs";
import { Button } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import styles from "./global-read.module.css";

const ERRORS: Record<GlobalReadErrorCode, string> = {
  GLOBAL_READ_INPUT_INVALID: "账号记录已失效，请刷新列表。",
  GLOBAL_READ_UNAVAILABLE: "读取暂不可用，请稍后重试。",
  GLOBAL_READ_UNAUTHORIZED: "请先完成官方授权。",
  GLOBAL_READ_REAUTHORIZE: "授权需要更新，请重新进行官方授权。",
  GLOBAL_READ_WAITING_PROXY: "等待有效代理，任务会在验证通过后执行。",
  GLOBAL_READ_CANCELLED: "本次读取已取消。",
  GLOBAL_READ_BUSY: "此前读取仍在收尾，请稍后重试。",
  GLOBAL_READ_RATE_LIMITED: "平台请求额度受限，请稍后重试。",
  GLOBAL_READ_FORBIDDEN: "平台拒绝读取，请检查应用权限或套餐。",
  GLOBAL_READ_RESPONSE_INVALID: "平台数据不符合读取要求，未更新快照。",
  GLOBAL_READ_IDENTITY_MISMATCH: "平台身份与账号记录不一致，未更新快照。",
  GLOBAL_READ_SAVE_FAILED: "本机数据保存失败，请稍后重试。",
};
const CAPABILITIES: Record<GlobalReadCapabilityState, string> = {
  ready: "可读取",
  scope_required: "缺少授权范围",
  forbidden: "权限或套餐不允许",
  rate_limited: "请求额度受限",
  unavailable: "暂不可用",
};
const METRICS = [
  ["followers", "粉丝"],
  ["following", "关注"],
  ["works", "作品"],
  ["views", "浏览"],
  ["likes", "获赞"],
] as const;
const JOB_STATES = {
  queued: "已排队",
  "waiting-proxy": "等待代理",
  running: "正在通过官方 API 读取…",
  done: "读取完成",
  failed: "读取失败",
  cancelled: "读取已取消",
} as const;
interface Props {
  account: GlobalAccount;
  onAccountChanged?(): void;
}
interface Lifetime {
  alive: boolean;
  pending: boolean;
  snapshotRevision: number;
  jobs: Map<string, GlobalJob>;
  receive(job: unknown, refreshSnapshot: boolean): void;
}
export function GlobalReadPanel(props: Props) {
  const { account } = props;
  return (
    <MountedGlobalReadPanel
      key={[account.id, account.platformId, account.remoteId, account.authStatus, account.updatedAt].join(
        ":",
      )}
      {...props}
    />
  );
}
function MountedGlobalReadPanel({ account, onAccountChanged }: Props) {
  const [snapshot, setSnapshot] = useState<GlobalReadSnapshot | null>(null);
  const [jobs, setJobs] = useState<GlobalJob[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(hasBridge && account.authStatus === "authorized");
  const [pending, setPending] = useState<"submit" | "cancel" | null>(null);
  const [error, setError] = useState<GlobalReadErrorCode | null>(null);
  const lifetime = useRef<Lifetime | null>(null);
  const notify = useRef(onAccountChanged);
  useEffect(() => {
    notify.current = onAccountChanged;
  }, [onAccountChanged]);
  const active = jobs.find(isActiveGlobalJob);
  const job = active ?? jobs.find((item) => item.id === focusedId) ?? jobs[0];

  useEffect(() => {
    const current: Lifetime = {
      alive: true,
      pending: false,
      snapshotRevision: 0,
      jobs: new Map(),
      receive: () => undefined,
    };
    lifetime.current = current;
    const failure = (value: unknown) => {
      if (!current.alive) return;
      const code = globalReadErrorCode(value);
      setError(code);
      if (code === "GLOBAL_READ_UNAUTHORIZED" || code === "GLOBAL_READ_REAUTHORIZE") {
        setSnapshot(null);
        notify.current?.();
      }
    };
    const loadSnapshot = () => {
      const revision = ++current.snapshotRevision;
      void api.globalRead
        .get(account.id)
        .then((raw) => {
          if (!current.alive || revision !== current.snapshotRevision) return;
          if (raw === null) {
            setSnapshot(null);
            return;
          }
          const parsed = globalReadSnapshotSchema.safeParse(raw);
          if (!parsed.success) throw new Error("GLOBAL_READ_RESPONSE_INVALID");
          if (
            parsed.data.accountId !== account.id ||
            parsed.data.platformId !== account.platformId ||
            parsed.data.remoteId !== account.remoteId
          )
            throw new Error("GLOBAL_READ_IDENTITY_MISMATCH");
          setSnapshot(parsed.data);
        })
        .catch((value) => {
          if (revision === current.snapshotRevision) failure(value);
        })
        .finally(() => {
          if (current.alive && revision === current.snapshotRevision) setLoading(false);
        });
    };
    current.receive = (raw, refreshSnapshot) => {
      if (!current.alive) return;
      const parsed = globalJobSchema.safeParse(raw);
      if (!parsed.success) {
        failure(new Error("GLOBAL_READ_RESPONSE_INVALID"));
        return;
      }
      const value = parsed.data;
      if (value.accountId !== account.id || value.platformId !== account.platformId) return;
      const previous = current.jobs.get(value.id);
      if (previous && (previous.revision >= value.revision || !isActiveGlobalJob(previous))) return;
      current.jobs.set(value.id, value);
      const latest = [...current.jobs.values()]
        .sort(
          (a, b) =>
            Number(isActiveGlobalJob(b)) - Number(isActiveGlobalJob(a)) ||
            b.createdAt.localeCompare(a.createdAt),
        )
        .slice(0, 20);
      current.jobs = new Map(latest.map((item) => [item.id, item]));
      setJobs(latest);
      if (refreshSnapshot && value.state === "done") loadSnapshot();
      if (
        value.state === "failed" &&
        (value.errorCode === "GLOBAL_READ_UNAUTHORIZED" || value.errorCode === "GLOBAL_READ_REAUTHORIZE")
      ) {
        current.snapshotRevision++;
        setLoading(false);
        setSnapshot(null);
        notify.current?.();
      }
    };
    let unsubscribe = () => undefined as void;
    if (hasBridge && account.authStatus === "authorized") {
      // Both get/list are local. Navigation never submits or cancels a durable task.
      unsubscribe = api.globalJobs.onChanged((value) => current.receive(value, true));
      loadSnapshot();
      void api.globalJobs
        .list(account.id)
        .then((raw) => {
          if (!current.alive) return;
          const result = globalJobsSchema.safeParse(raw);
          if (
            !result.success ||
            result.data.some(
              (item) => item.accountId !== account.id || item.platformId !== account.platformId,
            )
          )
            throw new Error("GLOBAL_READ_RESPONSE_INVALID");
          result.data.forEach((item) => current.receive(item, false));
        })
        .catch(failure);
    }
    return () => {
      current.alive = false;
      current.snapshotRevision++;
      unsubscribe();
    };
  }, [account.id, account.platformId, account.remoteId, account.authStatus, account.updatedAt]);

  const refresh = async () => {
    const current = lifetime.current;
    if (!hasBridge || account.authStatus !== "authorized" || !current?.alive || current.pending || active)
      return;
    current.pending = true;
    setPending("submit");
    setError(null);
    try {
      const value = await api.globalJobs.submit(account.id);
      if (current.alive) {
        current.receive(value, true);
        setFocusedId(value.id);
      }
    } catch (value) {
      if (current.alive) {
        const code = globalReadErrorCode(value);
        setError(code);
        if (code === "GLOBAL_READ_UNAUTHORIZED" || code === "GLOBAL_READ_REAUTHORIZE") {
          setSnapshot(null);
          notify.current?.();
        }
      }
    } finally {
      current.pending = false;
      if (current.alive) setPending(null);
    }
  };
  const cancel = async () => {
    const current = lifetime.current;
    if (!current?.alive || current.pending || !active) return;
    current.pending = true;
    current.snapshotRevision++;
    setPending("cancel");
    setLoading(false);
    setError(null);
    try {
      const value = await api.globalJobs.cancel(active.id);
      if (current.alive) {
        if (value) current.receive(value, false);
        else setError("GLOBAL_READ_UNAVAILABLE");
      }
    } catch (value) {
      if (current.alive) setError(globalReadErrorCode(value));
    } finally {
      current.pending = false;
      if (current.alive) setPending(null);
    }
  };

  return (
    <section className={styles.panel} aria-label={`${account.displayName} 的平台数据`}>
      <div className={styles.header}>
        <div>
          <h3>平台数据</h3>
          <p>
            本机上次读取：
            {snapshot ? (
              <time dateTime={snapshot.fetchedAt}>
                {new Date(snapshot.fetchedAt).toLocaleString("zh-CN")}
              </time>
            ) : (
              "—"
            )}
          </p>
        </div>
        <div className={styles.actions}>
          <Button
            disabled={
              !hasBridge || account.authStatus !== "authorized" || pending !== null || Boolean(active)
            }
            onClick={() => void refresh()}
          >
            读取数据
          </Button>
          {active ? (
            <Button disabled={pending !== null} onClick={() => void cancel()}>
              取消读取
            </Button>
          ) : null}
        </div>
      </div>
      {pending ? (
        <p role="status">{pending === "cancel" ? "正在取消读取…" : "正在保存读取任务…"}</p>
      ) : loading ? (
        <p role="status">正在读取本机快照…</p>
      ) : null}
      {job ? (
        <div className={styles.job}>
          <p role="status">
            {JOB_STATES[job.state]} · 任务 {job.id.slice(0, 8)}
          </p>
          {job.state === "waiting-proxy" ? (
            <p>等待有效代理，任务会在验证通过后执行。离开页面或重启应用会保留任务。</p>
          ) : null}
          {job.errorCode && (job.state === "failed" || job.state === "cancelled") ? (
            <p role={job.state === "failed" ? "alert" : "status"}>{ERRORS[job.errorCode]}</p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role={error === "GLOBAL_READ_CANCELLED" ? "status" : "alert"} className={styles.message}>
          {ERRORS[error]}
        </p>
      ) : null}
      {!hasBridge ? (
        <p>浏览器预览不读取平台数据。</p>
      ) : account.authStatus !== "authorized" ? (
        <p>完成官方授权后，可手动读取资料、指标和作品。</p>
      ) : null}
      {snapshot ? (
        <>
          <dl className={styles.capabilities} aria-label="本次读取能力">
            <div>
              <dt>资料</dt>
              <dd>{CAPABILITIES[snapshot.capabilities.readProfile]}</dd>
            </div>
            <div>
              <dt>指标</dt>
              <dd>{CAPABILITIES[snapshot.capabilities.readMetrics]}</dd>
            </div>
            <div>
              <dt>作品列表</dt>
              <dd>{CAPABILITIES[snapshot.capabilities.listWorks]}</dd>
            </div>
          </dl>
          <div className={styles.profile}>
            <strong>{snapshot.profile.displayName || "—"}</strong>
            <span>用户名：{snapshot.profile.username ?? "—"}</span>
          </div>
          <dl className={styles.metrics}>
            {METRICS.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{snapshot.totals[key] ?? "—"}</dd>
              </div>
            ))}
          </dl>
          {snapshot.works.length ? (
            <div className={styles.tableWrap}>
              <table>
                <caption>最近作品（本次返回 {snapshot.works.length} 条，最多 20 条）</caption>
                <thead>
                  <tr>
                    <th>作品</th>
                    <th>发布时间</th>
                    <th>浏览</th>
                    <th>赞</th>
                    <th>评论</th>
                    <th>转发/分享</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.works.map((work, index) => (
                    <tr key={`${work.id}:${index}`}>
                      <td>{work.title || "—"}</td>
                      <td>
                        {work.publishedAt ? (
                          <time dateTime={work.publishedAt}>
                            {new Date(work.publishedAt).toLocaleString("zh-CN")}
                          </time>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{work.views ?? "—"}</td>
                      <td>{work.likes ?? "—"}</td>
                      <td>{work.comments ?? "—"}</td>
                      <td>{work.reposts ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>
              {snapshot.capabilities.listWorks === "ready"
                ? "本次读取未返回作品。"
                : "本次没有可用的作品数据。"}
            </p>
          )}
          {snapshot.hasMoreWorks === true ? <p>平台还有更多作品；这里只显示本次返回的数据。</p> : null}
        </>
      ) : !loading && !pending ? (
        <p>尚无本机快照。未读取的数据以“—”表示。</p>
      ) : null}
    </section>
  );
}
