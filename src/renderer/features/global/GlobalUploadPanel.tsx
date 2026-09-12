import { useEffect, useRef, useState } from "react";
import type { GlobalAccount } from "@shared/global-accounts";
import type { Asset } from "@shared/types";
import {
  globalUploadJobSchema,
  globalUploadErrorCode,
  isActiveUpload,
  type GlobalUploadJob,
  type GlobalUploadErrorCode,
} from "@shared/global-uploads";
import { Button, Field, Select, TextInput, TextArea } from "@renderer/components/ui";
import { YOUTUBE_MAX_BYTES, youtubeUploadMetadataSchema } from "@shared/youtube-upload";
import { api, hasBridge } from "@renderer/lib/api";
import styles from "./global-read.module.css";

const STATES: Record<GlobalUploadJob["state"], string> = {
  "waiting-proxy": "等待有效代理",
  "waiting-retry": "等待下次重试",
  preparing: "检查本地视频",
  initializing: "创建上传任务",
  uploading: "正在上传",
  checking: "核对 TikTok 处理状态",
  processing: "视频已传完，等待 TikTok 处理",
  inbox: "已送达 TikTok 收件箱，待你编辑和发布",
  ready: "平台已处理完成",
  published: "TikTok 确认你已完成发布",
  failed: "上传未完成",
  cancelled: "已停止本机上传",
  uncertain: "结果待核对",
};
const ERRORS: Record<GlobalUploadErrorCode, string> = {
  GLOBAL_UPLOAD_INVALID: "所选账号或素材不符合要求。",
  GLOBAL_UPLOAD_UNAVAILABLE: "上传服务暂不可用。",
  GLOBAL_UPLOAD_UNAUTHORIZED: "请先完成 TikTok 官方授权。",
  GLOBAL_UPLOAD_SCOPE_MISSING: "缺少上传权限，请点击“授权草稿上传”，并确认开发者应用已开通相应能力。",
  GLOBAL_UPLOAD_WAITING_PROXY: "代理验证通过后再继续。",
  GLOBAL_UPLOAD_CANCELLED: "本机任务已停止，已经送达 TikTok 的内容不会被自动删除。",
  GLOBAL_UPLOAD_BUSY: "该账号已有任务，请等待或取消后再提交。",
  GLOBAL_UPLOAD_FILE_CHANGED: "视频已更改、移动或无法读取，请重新导入素材。",
  GLOBAL_UPLOAD_FILE_UNSUPPORTED: "请选择素材库中的 MP4、MOV 或 WebM 视频，大小不超过 4 GB。",
  GLOBAL_UPLOAD_SAVE_FAILED: "任务无法安全保存在本机，上传已停止。",
  GLOBAL_UPLOAD_RESPONSE_INVALID: "未取得有效的官方回应，未确认成功。",
  GLOBAL_UPLOAD_REAUTHORIZE: "授权已失效，请重新授权。",
  GLOBAL_UPLOAD_RATE_LIMITED: "平台请求额度受限，请稍后再试。",
  GLOBAL_UPLOAD_FORBIDDEN: "TikTok 拒绝本次上传，请检查应用权限和账号限制。",
  GLOBAL_UPLOAD_EXPIRED: "临时上传地址已过期，不能继续传输。",
  GLOBAL_UPLOAD_UNCERTAIN: "未能确认远端结果。请先查询状态或查看 TikTok 收件箱，避免重复创建上传。",
  GLOBAL_UPLOAD_REJECTED: "TikTok 未接受该视频，请检查格式、时长和账号限制。",
  GLOBAL_UPLOAD_PROGRESS_MISMATCH: "远端进度无法安全续传，已停止发送，请先查询状态。",
};
interface Life {
  active: boolean;
  busy: boolean;
  assetsVersion: number;
  jobs: Map<string, GlobalUploadJob>;
  receive(raw: unknown): void;
}
function uploadError(code: GlobalUploadErrorCode, youtube: boolean): string {
  if (!youtube) return ERRORS[code];
  const specific: Partial<Record<GlobalUploadErrorCode, string>> = {
    GLOBAL_UPLOAD_SCOPE_MISSING:
      "缺少上传权限，请点击“授权视频上传”并确认开发者应用已开通 YouTube Data API。",
    GLOBAL_UPLOAD_FILE_UNSUPPORTED: "请选择素材库中的支持格式视频，大小不超过 256 GB。",
    GLOBAL_UPLOAD_UNCERTAIN: "未能确认远端结果，请查询状态或在 YouTube Studio 查看，避免重复上传。",
  };
  return specific[code] ?? ERRORS[code].replaceAll("TikTok", "YouTube");
}
const YOUTUBE_MIME = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
  "video/x-matroska",
  "video/x-msvideo",
  "video/x-flv",
  "video/x-ms-wmv",
];
function eligibleAssets(values: Asset[], youtube: boolean): Asset[] {
  return values.filter(
    (asset) =>
      asset.kind === "video" &&
      (youtube ? YOUTUBE_MIME : YOUTUBE_MIME.slice(0, 3)).includes(asset.mimeType ?? "") &&
      asset.sizeBytes > 0 &&
      asset.sizeBytes <= (youtube ? YOUTUBE_MAX_BYTES : 4 * 1024 ** 3),
  );
}
export function GlobalUploadPanel({ account }: { account: GlobalAccount }) {
  return account.platformId === "tiktok" || account.platformId === "youtube" ? (
    <MountedUploadPanel key={`${account.id}:${account.authStatus}:${account.remoteId}`} account={account} />
  ) : null;
}
function MountedUploadPanel({ account }: { account: GlobalAccount }) {
  const youtube = account.platformId === "youtube",
    platform = youtube ? "YouTube" : "TikTok";
  const states = youtube
    ? {
        ...STATES,
        checking: "核对 YouTube 处理状态",
        processing: "视频已传完，等待 YouTube 处理",
        ready: "YouTube 已处理完成",
        published: "YouTube 确认已公开",
      }
    : STATES;
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState("");
  const [privacy, setPrivacy] = useState("private"),
    [audience, setAudience] = useState("");
  const [synthetic, setSynthetic] = useState(""),
    [notifySubscribers, setNotifySubscribers] = useState(false);
  const metadata = youtubeUploadMetadataSchema.safeParse({
    title,
    description,
    categoryId: "22",
    privacy,
    madeForKids: audience === "" ? undefined : audience === "yes",
    containsSyntheticMedia: synthetic === "" ? undefined : synthetic === "yes",
    notifySubscribers,
  });
  const [assets, setAssets] = useState<Asset[]>([]),
    [assetId, setAssetId] = useState("");
  const [jobs, setJobs] = useState<GlobalUploadJob[]>([]),
    [error, setError] = useState<GlobalUploadErrorCode | null>(null),
    [busy, setBusy] = useState(false);
  const [focusedId, setFocusedId] = useState("");
  const life = useRef<Life | null>(null);
  const active = jobs.find(isActiveUpload),
    selected = jobs.find((job) => job.id === focusedId) ?? active ?? jobs[0];
  useEffect(() => {
    const current: Life = {
      active: true,
      busy: false,
      assetsVersion: 0,
      jobs: new Map(),
      receive: () => undefined,
    };
    life.current = current;
    current.receive = (raw) => {
      const parsed = globalUploadJobSchema.safeParse(raw);
      if (
        !current.active ||
        !parsed.success ||
        parsed.data.accountId !== account.id ||
        parsed.data.platformId !== account.platformId
      )
        return;
      const job = parsed.data,
        previous = current.jobs.get(job.id);
      if (previous && previous.revision >= job.revision) return;
      current.jobs.set(job.id, job);
      const next = [...current.jobs.values()]
        .sort(
          (a, b) =>
            Number(isActiveUpload(b)) - Number(isActiveUpload(a)) || b.createdAt.localeCompare(a.createdAt),
        )
        .slice(0, 20);
      current.jobs = new Map(next.map((item) => [item.id, item]));
      setJobs(next);
    };
    const unsubscribe = api.globalUploads.onChanged(current.receive);
    void api.globalUploads
      .list(account.id)
      .then((items) => {
        for (const item of items) current.receive(item);
      })
      .catch(() => {
        if (current.active) setError("GLOBAL_UPLOAD_UNAVAILABLE");
      });
    void api.assets
      .list()
      .then((values) => {
        if (current.active && current.assetsVersion === 0) setAssets(eligibleAssets(values, youtube));
      })
      .catch(() => undefined);
    return () => {
      current.active = false;
      unsubscribe();
    };
  }, [account.id, account.platformId, youtube]);
  const action = async (operation: "submit" | "cancel" | "check" | "import") => {
    const current = life.current;
    if (!hasBridge || !current?.active || current.busy) return;
    if (operation === "submit" && youtube && !metadata.success) return;
    current.busy = true;
    setBusy(true);
    setError(null);
    try {
      if (operation === "import") {
        current.assetsVersion++;
        const imported = await api.assets.import();
        const all = await api.assets.list();
        if (current.active) {
          setAssets(eligibleAssets(all, youtube));
          const first = eligibleAssets(imported, youtube)[0];
          if (first) setAssetId(first.id);
        }
      } else {
        const job =
          operation === "submit"
            ? await api.globalUploads.submit({
                accountId: account.id,
                assetId,
                ...(youtube && metadata.success ? { youtube: metadata.data } : {}),
              })
            : selected
              ? await api.globalUploads[operation](selected.id)
              : null;
        if (job) {
          current.receive(job);
          if (current.active) setFocusedId(job.id);
        }
      }
    } catch (failure) {
      if (current.active) setError(globalUploadErrorCode(failure));
    } finally {
      current.busy = false;
      if (current.active) setBusy(false);
    }
  };
  return (
    <section
      className={styles.panel}
      aria-label={`${account.displayName} 的 ${youtube ? "YouTube 视频上传" : "TikTok 草稿上传"}`}
    >
      <div className={styles.header}>
        <div>
          <h3>{youtube ? "YouTube 视频上传" : "TikTok 草稿上传"}</h3>
          <p>
            {youtube
              ? "先授权上传，再填写信息并选择视频。默认私密；公开状态以 YouTube 的实际结果为准。"
              : "先授权上传，再选择视频。完成后请打开 TikTok 收件箱通知，继续编辑并确认发布。"}
          </p>
        </div>
      </div>
      <p>
        {youtube
          ? "支持 MP4、MOV、WebM、M4V、MKV、AVI、FLV、WMV，最多 256 GB；具体格式、时长和账号限制以 YouTube 的处理结果为准。"
          : "仅支持 MP4、MOV、WebM，最多 4 GB。时长、画面和账号限制以 TikTok 的处理结果为准。"}
      </p>
      {youtube ? (
        <fieldset className={styles.uploadMetadata} disabled={busy || !!active}>
          <legend>视频信息</legend>
          <Field label="视频标题">
            <TextInput
              aria-label="视频标题"
              maxLength={100}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="视频描述">
            <TextArea
              aria-label="视频描述"
              rows={3}
              maxLength={5000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="可见性">
            <Select aria-label="可见性" value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
              <option value="private">私密</option>
              <option value="unlisted">不公开列出（有链接可看）</option>
              <option value="public">公开</option>
            </Select>
          </Field>
          <Field label="是否专为儿童制作">
            <Select
              aria-label="是否专为儿童制作"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
            >
              <option value="">请明确选择</option>
              <option value="yes">是，专为儿童制作</option>
              <option value="no">否</option>
            </Select>
          </Field>
          <Field label="是否包含需披露的逼真合成或修改内容">
            <Select
              aria-label="是否包含需披露的逼真合成或修改内容"
              value={synthetic}
              onChange={(e) => setSynthetic(e.target.value)}
            >
              <option value="">请明确选择</option>
              <option value="yes">是</option>
              <option value="no">否</option>
            </Select>
          </Field>
          <label className={styles.uploadNotify}>
            <input
              type="checkbox"
              checked={notifySubscribers}
              onChange={(e) => setNotifySubscribers(e.target.checked)}
            />
            发布时通知订阅者
          </label>
          <p>
            当前上传类别：人物与博客。请填写标题并选择受众与合成内容声明。描述最多 5,000 个 UTF-8
            字节；标题和描述不接受尖括号。
          </p>
          <p>未通过 YouTube 审核的开发者应用可能只能上传私密视频。选择公开后，提交即表示同意按该设置上传。</p>
        </fieldset>
      ) : null}
      <div className={styles.uploadActions}>
        <Field label="待上传视频">
          <Select
            aria-label="待上传视频"
            value={assetId}
            onChange={(event) => setAssetId(event.target.value)}
            disabled={busy || !!active}
          >
            <option value="">选择素材库中的视频</option>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.fileName}
              </option>
            ))}
          </Select>
        </Field>
        <Button disabled={!hasBridge || busy} onClick={() => void action("import")}>
          导入视频
        </Button>
        <Button
          variant="primary"
          disabled={
            !hasBridge ||
            busy ||
            !!active ||
            !assetId ||
            account.authStatus !== "authorized" ||
            (youtube && !metadata.success)
          }
          onClick={() => void action("submit")}
        >
          {youtube
            ? privacy === "public"
              ? "上传并请求公开到 YouTube"
              : "上传到 YouTube"
            : "上传到 TikTok 收件箱"}
        </Button>
      </div>
      {jobs.length > 1 ? (
        <Field label="上传记录">
          <Select
            aria-label="上传记录"
            value={selected?.id ?? ""}
            disabled={busy}
            onChange={(event) => setFocusedId(event.target.value)}
          >
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.fileName} · {states[job.state]} · {new Date(job.createdAt).toLocaleString()}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {selected ? (
        <div className={styles.job}>
          <p role="status">{states[selected.state]}</p>
          <p>
            {selected.fileName} · {Math.floor((selected.sentBytes / selected.totalBytes) * 100)}% 已确认传输
          </p>
          <p>任务 {selected.id}</p>
          {selected.receipt ? (
            <p>
              YouTube 实际可见性：
              {{ private: "私密", unlisted: "不公开列出", public: "公开" }[selected.receipt.privacy]} · 视频{" "}
              {selected.receipt.videoId}
            </p>
          ) : null}
          {selected.errorCode ? <p>{uploadError(selected.errorCode, youtube)}</p> : null}
          {isActiveUpload(selected) ? (
            <Button disabled={busy} onClick={() => void action("cancel")}>
              取消上传任务
            </Button>
          ) : (
            <Button disabled={!hasBridge || busy} onClick={() => void action("check")}>
              查询 {platform} 结果
            </Button>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className={styles.message}>
          {uploadError(error, youtube)}
        </p>
      ) : null}
      {account.authStatus !== "authorized" ? (
        <p>尚未授权，提交按钮暂不可用。上方可配置并{youtube ? "授权视频上传" : "授权草稿上传"}。</p>
      ) : null}
      <p>关闭页面会保留任务；取消只停止本机发送，不会删除已到达 {platform} 的内容。</p>
    </section>
  );
}
