import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BarChart3, ExternalLink, RefreshCw, Users, X } from "lucide-react";
import { GLOBAL_PLATFORM_DEFINITIONS } from "@shared/global-platforms";
import type { WebObservation } from "@shared/global-web-observation";
import type { GlobalWork, WebCollectJob } from "@shared/global-workspace";
import { observationNumber } from "@shared/global-web-trend";
import { Badge, Button, Card, EmptyState, IconButton, Table, formatDateTime } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { useGlobalAccounts, useUi, useToasts } from "@renderer/store";
import { GlobalWebObservationPanel } from "./GlobalWebObservationPanel";
import layout from "@renderer/features/layout/layout.module.css";
import styles from "./global-metrics.module.css";

const jobLabels: Record<WebCollectJob["state"], string> = {
  queued: "排队中",
  "waiting-network": "等待网络",
  "waiting-login": "等待登录",
  running: "正在采集",
  done: "已完成",
  failed: "需处理",
  cancelled: "已取消",
};

interface ReadState {
  snapshots: Record<string, WebObservation | null>;
  snapshotErrors: Record<string, boolean>;
  jobs: WebCollectJob[] | null;
  jobsError: boolean;
  works: Record<string, GlobalWork[]>;
  worksErrors: Record<string, boolean>;
  ownerKey: string | null;
}

async function readResult<T>(load: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await load() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

export function GlobalMetricsPage({ overview = false }: { overview?: boolean }) {
  const accounts = useGlobalAccounts((s) => s.accounts),
    identities = useGlobalAccounts((s) => s.identities);
  const accountsLoaded = useGlobalAccounts((s) => s.loaded),
    accountsError = useGlobalAccounts((s) => s.error),
    reloadAccounts = useGlobalAccounts((s) => s.load);
  const activeId = useUi((s) => s.activeGlobalAccountId),
    select = useUi((s) => s.selectGlobalAccount);
  const detail = useUi((s) => s.globalMetricsDetail),
    setDetail = useUi((s) => s.setGlobalMetricsDetail);
  const [read, setRead] = useState<ReadState>({
    snapshots: {},
    snapshotErrors: {},
    jobs: null,
    jobsError: false,
    works: {},
    worksErrors: {},
    ownerKey: null,
  });
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);
  const account = accounts.find((row) => row.id === activeId) ?? accounts[0] ?? null;
  const accountId = account?.id;
  const readKey = JSON.stringify([accounts.map((row) => [row.id, row.platformId]), accountId, revision]);
  const pending = read.ownerKey !== readKey;
  const { snapshots } = read;
  const jobs = read.jobs?.filter((job) => accounts.some((row) => row.id === job.accountId));
  const works = accountId
    ? read.works[accountId]?.filter(
        (work) =>
          work.accountId === accountId &&
          (!identities[accountId]?.subjectId || work.subjectId === identities[accountId]?.subjectId),
      )
    : undefined;
  const visibleJobs = jobs?.filter((job) => overview || !detail || job.accountId === accountId);
  const failedResources = [
    accountsError && "账号列表",
    accounts.some((row) => read.snapshotErrors[row.id]) && "账号观测",
    read.jobsError && "采集任务",
    accountId && read.worksErrors[accountId] && "作品记录",
  ].filter(Boolean);
  const refresh = () => {
    // Invalidate immediately: a request can settle before the next effect cleanup.
    requestSequence.current++;
    setRevision((value) => value + 1);
  };
  useEffect(
    () =>
      api.globalWorkspace.onChanged(() => {
        requestSequence.current++;
        setRevision((value) => value + 1);
      }),
    [],
  );
  useEffect(() => {
    let alive = true;
    const request = ++requestSequence.current;
    const load = async () => {
      const [values, queue, work] = await Promise.all([
        Promise.all(
          accounts.map(async (row) => ({
            id: row.id,
            result: await readResult(async () => {
              const observation = await api.globalWeb.observation(row.id);
              if (
                observation &&
                (observation.accountId !== row.id || observation.platformId !== row.platformId)
              )
                throw new Error("Observation belongs to a different account");
              return observation;
            }),
          })),
        ),
        readResult(() => api.globalWorkspace.jobs()),
        readResult(async () => {
          if (!accountId) return [];
          const rows = await api.globalWorkspace.works(accountId);
          if (rows.some((row) => row.accountId !== accountId))
            throw new Error("Works belong to a different account");
          return rows;
        }),
      ]);
      if (!alive || request !== requestSequence.current) return;
      setRead((previous) => {
        const nextSnapshots: ReadState["snapshots"] = {};
        const snapshotErrors: ReadState["snapshotErrors"] = {};
        for (const { id, result } of values) {
          if (result.status === "fulfilled") nextSnapshots[id] = result.value;
          else if (id in previous.snapshots) nextSnapshots[id] = previous.snapshots[id];
          snapshotErrors[id] = result.status === "rejected";
        }
        return {
          snapshots: nextSnapshots,
          snapshotErrors,
          jobs: queue.status === "fulfilled" ? queue.value : previous.jobs,
          jobsError: queue.status === "rejected",
          works: {
            ...previous.works,
            ...(accountId && work.status === "fulfilled" ? { [accountId]: work.value } : {}),
          },
          worksErrors: {
            ...previous.worksErrors,
            ...(accountId ? { [accountId]: work.status === "rejected" } : {}),
          },
          ownerKey: readKey,
        };
      });
    };
    void load();
    return () => {
      alive = false;
    };
  }, [accounts, accountId, revision, readKey]);
  const collect = async (id: string) => {
    try {
      const job = await api.globalWorkspace.collect(id);
      setRead((previous) => ({
        ...previous,
        jobs: [job, ...(previous.jobs ?? []).filter((row) => row.id !== job.id)],
      }));
      refresh();
      useToasts
        .getState()
        .push({ kind: "success", title: "已加入采集队列", message: "使用账号后台页面采集，不切换当前页面" });
    } catch {
      useToasts.getState().push({ kind: "error", title: "无法提交采集任务" });
    }
  };
  const retry = () => {
    if (accountsError) void reloadAccounts();
    refresh();
  };
  const navigate = async () => {
    if (!account) return;
    useUi.getState().openGlobalAccount(account.id);
    try {
      await api.globalWeb.open(account.id);
      await api.globalWeb.go(account.id, "analytics");
    } catch {
      useToasts.getState().push({ kind: "warning", title: "请先在官网完成登录并选择频道" });
    }
  };
  if (!accounts.length)
    return (
      <div className={layout.page}>
        <h1>{overview ? "总览" : "数据观测"}</h1>
        {accountsError ? (
          <div role="alert">
            <p>国外账号读取失败，无法确认账号列表。</p>
            <Button onClick={() => void reloadAccounts()}>重试读取账号</Button>
          </div>
        ) : !accountsLoaded ? (
          <p role="status">正在读取国外账号…</p>
        ) : (
          <EmptyState
            icon={BarChart3}
            title="还没有国外账号"
            description="添加账号并在官方页面登录后，即可采集数据与持续记录趋势。"
            action={
              <Button onClick={() => window.dispatchEvent(new CustomEvent("clipdock:focus-global-create"))}>
                添加国外账号
              </Button>
            }
          />
        )}
      </div>
    );
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <div>
          <span className={layout.eyebrow}>GLOBAL ANALYTICS</span>
          <h1>{overview ? "总览" : "数据观测"}</h1>
          <p>国外账号 · 官网数据与本机历史 · API 授权可选</p>
        </div>
        <Button
          icon={RefreshCw}
          disabled={!hasBridge}
          onClick={() => void Promise.all(accounts.map((row) => collect(row.id)))}
        >
          采集全部账号
        </Button>
      </header>
      {failedResources.length > 0 && (
        <div role="alert">
          <p>
            {failedResources.join("、")}
            读取失败。已保留上次成功读取的结果；未读取的数据以「—」显示。
          </p>
          <Button size="sm" icon={RefreshCw} loading={pending} onClick={retry}>
            重试读取
          </Button>
        </div>
      )}
      {overview || !detail ? (
        <>
          <div className={styles.summary}>
            <Card>
              <Users size={20} />
              <strong>{accounts.length}</strong>
              <span>国外账号</span>
            </Card>
            <Card>
              <strong>{accounts.filter((row) => identities[row.id]?.status === "online").length}</strong>
              <span>最近确认登录</span>
            </Card>
            <Card>
              <strong>
                {accounts.every((row) => row.id in snapshots)
                  ? accounts.filter(
                      (row) =>
                        snapshots[row.id] &&
                        (!identities[row.id]?.subjectId ||
                          snapshots[row.id]?.subjectId === identities[row.id]?.subjectId),
                    ).length
                  : "—"}
              </strong>
              <span>已读取的观测记录</span>
            </Card>
            <Card>
              <strong>
                {jobs?.filter((row) => ["waiting-login", "failed"].includes(row.state)).length ?? "—"}
              </strong>
              <span>需要关注的任务</span>
            </Card>
          </div>
          {Object.values(GLOBAL_PLATFORM_DEFINITIONS).map((platform) => {
            const rows = accounts.filter((row) => row.platformId === platform.id);
            if (!rows.length) return null;
            // Only explicitly current/total followers can be added; partial coverage remains visible.
            const totals = rows
              .map((row) =>
                (!identities[row.id]?.subjectId ||
                snapshots[row.id]?.subjectId === identities[row.id]?.subjectId
                  ? snapshots[row.id]
                  : null
                )?.metrics.find(
                  (metric) => metric.key === "followers" && /current|total|当前|总粉丝/i.test(metric.label),
                ),
              )
              .filter((row) => row && observationNumber(row.value) !== null);
            const total = totals.length
              ? totals.reduce((sum, row) => sum + (observationNumber(row!.value) ?? 0), 0)
              : null;
            return (
              <Card key={platform.id} className={styles.platform}>
                <div className={styles.platformHead}>
                  <h2>{platform.name}</h2>
                  <span>
                    {rows.length} 个账号 · 粉丝／订阅者合计{" "}
                    {total === null
                      ? "—"
                      : `${totals.some((row) => /[KMB万亿千]/i.test(row!.value)) ? "≈" : ""}${total.toLocaleString()}`}{" "}
                    {totals.length && totals.length !== rows.length
                      ? `（已覆盖 ${totals.length}/${rows.length}）`
                      : ""}
                  </span>
                </div>
                <div className={styles.tableScroll}>
                  <Table>
                    <thead>
                      <tr>
                        <th>账号</th>
                        <th>粉丝／订阅者</th>
                        <th>观看／浏览</th>
                        <th>展示</th>
                        <th>统计周期</th>
                        <th>最近采集</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const stored = snapshots[row.id];
                        const snapshot =
                          stored &&
                          (!identities[row.id]?.subjectId ||
                            stored.subjectId === identities[row.id]?.subjectId)
                            ? stored
                            : null;
                        const metric = (key: string) =>
                          snapshot?.metrics.find((item) => item.key === key)?.value ?? "—";
                        return (
                          <tr key={row.id}>
                            <td>
                              <button
                                className={styles.accountLink}
                                onClick={() => {
                                  select(row.id);
                                  setDetail(true);
                                  if (overview) useUi.getState().setRoute("metrics");
                                }}
                              >
                                {row.displayName}
                              </button>
                            </td>
                            <td>{metric("followers")}</td>
                            <td>{metric("views")}</td>
                            <td>{metric("impressions")}</td>
                            <td>{snapshot ? (snapshot.period ?? "官网未注明") : "—"}</td>
                            <td>
                              {snapshot ? (
                                <>
                                  {formatDateTime(snapshot.capturedAt)}
                                  {read.snapshotErrors[row.id] ? " · 上次结果" : ""}
                                </>
                              ) : read.snapshotErrors[row.id] ? (
                                "读取失败"
                              ) : !(row.id in snapshots) ? (
                                "正在读取…"
                              ) : stored ? (
                                "账号身份已变化，请重新采集"
                              ) : (
                                "尚未采集"
                              )}
                            </td>
                            <td>
                              <IconButton
                                icon={RefreshCw}
                                label={`采集 ${row.displayName}`}
                                onClick={() => void collect(row.id)}
                                disabled={!hasBridge}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
              </Card>
            );
          })}
        </>
      ) : account ? (
        <>
          <div>
            <Button variant="ghost" icon={ArrowLeft} onClick={() => setDetail(false)}>
              平台汇总
            </Button>
          </div>
          <div className={styles.detail}>
            <GlobalWebObservationPanel
              key={account.id}
              refreshVersion={revision}
              subjectId={identities[account.id]?.subjectId}
              account={account}
              readable={hasBridge}
              canNavigate={hasBridge}
              onAnalytics={() => void navigate()}
              onClose={() => setDetail(false)}
              enqueueRead={() => collect(account.id)}
            />
          </div>
          <Card>
            <h2>最近作品</h2>
            <p className={styles.hint}>展示官网可读取的最近 30 条作品；缺失指标保留为空。</p>
            {works?.length ? (
              <div className={styles.tableScroll}>
                <Table>
                  <thead>
                    <tr>
                      <th>作品</th>
                      <th>观看</th>
                      <th>展示</th>
                      <th>点赞</th>
                      <th>评论／回复</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {works.map((work) => (
                      <tr key={work.remoteId}>
                        <td>{work.title || "无标题"}</td>
                        <td>{work.metrics.views ?? "—"}</td>
                        <td>{work.metrics.impressions ?? "—"}</td>
                        <td>{work.metrics.likes ?? "—"}</td>
                        <td>{work.metrics.comments ?? "—"}</td>
                        <td>
                          <IconButton
                            icon={ExternalLink}
                            label="打开作品与评论"
                            onClick={() => {
                              useUi.getState().openGlobalAccount(account.id);
                              void api.globalWorkspace
                                .openWork(account.id, work.remoteId)
                                .catch(() =>
                                  useToasts.getState().push({ kind: "error", title: "请检查账号页面" }),
                                );
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : (
              <p className={styles.hint}>
                {read.worksErrors[account.id]
                  ? "作品读取失败，暂时无法确认记录，请重试读取。"
                  : works === undefined
                    ? "正在读取该账号的作品…"
                    : "还没有当前账号身份的可用作品记录。采集后会显示可识别内容，也可在官网查看作品和评论。"}
              </p>
            )}
          </Card>
        </>
      ) : null}
      <Card>
        <h2>采集任务</h2>
        <div className={styles.queue}>
          {visibleJobs?.slice(0, 12).map((job) => (
            <div key={job.id}>
              <strong>{accounts.find((row) => row.id === job.accountId)?.displayName}</strong>
              <Badge tone={job.state === "done" ? "success" : job.state === "failed" ? "warning" : "neutral"}>
                {jobLabels[job.state]}
              </Badge>
              <span>{job.message ?? "后台读取官方页面"}</span>
              {!["done", "failed", "cancelled"].includes(job.state) ? (
                <IconButton
                  icon={X}
                  label="取消采集"
                  onClick={() =>
                    void api.globalWorkspace
                      .cancelJob(job.id)
                      .then(refresh)
                      .catch(() => {
                        useToasts.getState().push({ kind: "error", title: "取消采集失败，请重试" });
                      })
                  }
                />
              ) : null}
            </div>
          ))}
        </div>
        {!jobs ? (
          <p className={styles.hint}>
            {read.jobsError ? "任务读取失败，暂时无法确认采集队列。" : "正在读取采集任务…"}
          </p>
        ) : !visibleJobs?.length ? (
          <p className={styles.hint}>
            当前没有已读取的采集任务。登录后按设置间隔自动采集，也可随时手动刷新。
          </p>
        ) : null}
      </Card>
    </div>
  );
}
