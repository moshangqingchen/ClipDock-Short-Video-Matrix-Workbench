import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ClipboardCopy, ExternalLink, FileUp, Plus, Send, Trash2, X } from "lucide-react";
import { PLATFORMS, type PlatformId, type GlobalPlatformId } from "@shared/platforms";
import type { PublishRecord as DomesticPublishRecord, PublishRecordInput } from "@shared/types";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Modal,
  StatusDot,
  TextArea,
  TextInput,
  cx,
  formatDateTime,
} from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { useAccounts, useGlobalAccounts, useToasts, useUi } from "@renderer/store";
import { AssetGrid, useAssets } from "@renderer/features/assets/AssetsPage";
import layout from "@renderer/features/layout/layout.module.css";
import styles from "./publish.module.css";

type PublishRecord = Omit<DomesticPublishRecord, "platformId"> & {
  platformId: PlatformId | GlobalPlatformId;
};
type Draft = { title: string; description: string; tags: string[]; selected: string[]; recordId?: string };
const drafts = new Map<string, Draft>();
const composerPlatform = (id: PublishRecord["platformId"]) => {
  if (id in PLATFORMS) return PLATFORMS[id as keyof typeof PLATFORMS];
  const name = { youtube: "YouTube", tiktok: "TikTok", x: "X" }[id as "youtube" | "tiktok" | "x"];
  return { name, shortName: name, color: id === "youtube" ? "#e11d48" : "#172033" };
};
const globalPublisher = {
  list: (id?: string): Promise<PublishRecord[]> => api.globalWorkspace.publishList(id),
  save: (input: PublishRecordInput): Promise<PublishRecord> => api.globalWorkspace.publishSave(input),
  delete: (id: string) => api.globalWorkspace.publishDelete(id),
  openUpload: (id: string) => api.globalWorkspace.openUpload(id),
  attachFiles: (id: string, assets: string[]) => api.globalWorkspace.attachFiles(id, assets),
};
export function PublishPage() {
  const scope = useUi((s) => s.creatorMode),
    domestic = useAccounts((s) => s.accounts),
    global = useGlobalAccounts((s) => s.accounts);
  const domesticId = useUi((s) => s.activeAccountId),
    globalId = useUi((s) => s.activeGlobalAccountId);
  const rows = scope === "global" ? global : domestic,
    selected = scope === "global" ? globalId : domesticId;
  const accountId = rows.some((row) => row.id === selected) ? selected : (rows[0]?.id ?? null);
  return <PublishComposer key={`${scope}:${accountId}`} scope={scope} currentAccountId={accountId} />;
}
function PublishComposer({
  scope,
  currentAccountId,
}: {
  scope: "domestic" | "global";
  currentAccountId: string | null;
}) {
  const domestic = useAccounts((s) => s.accounts),
    global = useGlobalAccounts((s) => s.accounts),
    identities = useGlobalAccounts((s) => s.identities);
  const accounts =
    scope === "domestic"
      ? domestic
      : global.map((row) => ({ ...row, avatarUrl: null, status: identities[row.id]?.status ?? "unknown" }));
  const publisher = scope === "global" ? globalPublisher : api.publish;
  const draftKey = `${scope}:${currentAccountId}`;
  const initialDraft = drafts.get(draftKey);
  const activeId = currentAccountId;
  const openAccount = scope === "global" ? useUi.getState().openGlobalAccount : useUi.getState().openAccount;
  const { assets, reload } = useAssets();

  const chosenAccountId = activeId;
  const setAccountId = (id: string) =>
    scope === "global" ? useUi.getState().selectGlobalAccount(id) : useUi.getState().selectAccount(id);
  // Fall back to the first account without effect-driven state sync.
  const accountId =
    chosenAccountId && accounts.some((a) => a.id === chosenAccountId)
      ? chosenAccountId
      : (accounts[0]?.id ?? null);
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  const [tags, setTags] = useState<string[]>(initialDraft?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [selected, setSelected] = useState<string[]>([
    ...new Set([...(initialDraft?.selected ?? []), ...useUi.getState().selectedAssetIds]),
  ]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [records, setRecords] = useState<PublishRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [recordId, setRecordId] = useState<string | undefined>(initialDraft?.recordId);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const platform = account ? composerPlatform(account.platformId) : null;
  useEffect(() => {
    drafts.set(draftKey, { title, description, tags, selected, recordId });
  }, [draftKey, title, description, tags, selected, recordId]);

  useEffect(() => {
    void publisher
      .list()
      .then(setRecords)
      .catch(() => undefined);
  }, [publisher]);

  const selectedAssets = useMemo(
    () => (assets ?? []).filter((a) => selected.includes(a.id)),
    [assets, selected],
  );

  const addTag = () => {
    const value = tagInput.trim().replace(/^#/, "");
    if (value && !tags.includes(value) && tags.length < 30) setTags([...tags, value]);
    setTagInput("");
  };

  const composedText = useMemo(() => {
    const hash = tags.map((t) => `#${t}`).join(" ");
    return [title.trim(), description.trim(), hash].filter(Boolean).join("\n\n");
  }, [title, description, tags]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      useToasts.getState().push({ kind: "success", title: `${label}已复制` });
    } catch {
      useToasts.getState().push({ kind: "error", title: "复制失败" });
    }
  };

  const saveRecord = async (status: PublishRecord["status"] = "planned") => {
    if (!account) return;
    setBusy("save");
    try {
      const record = await publisher.save({
        id: recordId,
        accountId: account.id,
        assetIds: selected,
        title: title.trim(),
        description: description.trim(),
        tags,
        status,
      });
      setRecordId(record.id);
      setRecords(await publisher.list());
      useToasts
        .getState()
        .push({ kind: "success", title: status === "published" ? "已记录为已发布" : "发布计划已保存" });
    } catch (error) {
      useToasts.getState().push({ kind: "error", title: "保存失败", message: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const openUpload = async () => {
    if (!account) return;
    setBusy("open");
    try {
      await publisher.openUpload(account.id);
      openAccount(account.id);
    } catch (error) {
      useToasts
        .getState()
        .push({ kind: "error", title: "打开上传页失败", message: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const attach = async () => {
    if (!account || selected.length === 0) return;
    setBusy("attach");
    try {
      const result = await publisher.attachFiles(account.id, selected);
      if (result.attached > 0) {
        useToasts.getState().push({
          kind: "success",
          title: `已将 ${result.attached} 个文件填入上传控件`,
          message: "请在账号页面继续完成发布",
        });
        openAccount(account.id);
      } else {
        useToasts.getState().push({
          kind: "warning",
          title: "未能自动填入文件",
          message: result.message ?? "请先在账号页面打开上传页",
        });
      }
    } catch (error) {
      useToasts.getState().push({ kind: "error", title: "填入失败", message: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const loadRecord = (record: PublishRecord) => {
    drafts.set(`${scope}:${record.accountId}`, {
      title: record.title,
      description: record.description,
      tags: record.tags,
      selected: record.assetIds,
      recordId: record.id,
    });
    setRecordId(record.id);
    setAccountId(record.accountId);
    setTitle(record.title);
    setDescription(record.description);
    setTags(record.tags);
    setSelected(record.assetIds);
  };

  const resetForm = () => {
    setRecordId(undefined);
    setTitle("");
    setDescription("");
    setTags([]);
    setSelected([]);
  };

  return (
    <div className={layout.page}>
      <div className={layout.pageHead}>
        <div>
          <span className={layout.eyebrow}>PUBLISH</span>
          <h1>发布助手</h1>
          <p>选好素材与文案,一键打开该账号的官方上传页并把文件填入;最终发布动作由你在平台页面确认。</p>
        </div>
        <div className={layout.pageActions}>
          {recordId ? (
            <Button variant="ghost" icon={Plus} onClick={resetForm}>
              新建
            </Button>
          ) : null}
        </div>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={Send}
          title="先添加一个账号"
          description="发布助手需要一个已登录的账号来打开上传页面。"
        />
      ) : (
        <div className={styles.layout}>
          <div className={styles.composer}>
            <Card>
              <Field label="发布到">
                <div className={styles.accountPick}>
                  {accounts.map((a) => {
                    const p = composerPlatform(a.platformId);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={cx(styles.accountChip, a.id === accountId && styles.active)}
                        onClick={() => setAccountId(a.id)}
                      >
                        <Avatar src={a.avatarUrl} name={a.displayName} color={p.color} size={24} round />
                        {a.displayName}
                        <StatusDot status={a.status} />
                      </button>
                    );
                  })}
                </div>
              </Field>
            </Card>

            <Card>
              <Field label={`素材 (${selected.length})`}>
                <div className={styles.selectedStrip}>
                  {selectedAssets.map((a) => (
                    <span key={a.id} className={styles.selectedItem}>
                      {a.fileName}
                      <IconButton
                        icon={X}
                        label="移除"
                        size="sm"
                        onClick={() => setSelected(selected.filter((id) => id !== a.id))}
                      />
                    </span>
                  ))}
                  <Button size="sm" icon={Plus} onClick={() => setPickerOpen(true)}>
                    选择素材
                  </Button>
                </div>
              </Field>
              <Field label="标题">
                <TextInput
                  value={title}
                  maxLength={200}
                  placeholder="作品标题"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="文案">
                <TextArea
                  value={description}
                  maxLength={5000}
                  placeholder="正文 / 描述"
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <Field label="话题标签" hint="回车添加,复制文案时自动带上 #。">
                <TextInput
                  value={tagInput}
                  placeholder="输入标签后回车"
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                />
                {tags.length ? (
                  <div className={styles.tagRow}>
                    {tags.map((tag) => (
                      <span key={tag} className={styles.tag}>
                        #{tag}
                        <IconButton
                          icon={X}
                          label="删除标签"
                          size="sm"
                          onClick={() => setTags(tags.filter((t) => t !== tag))}
                        />
                      </span>
                    ))}
                  </div>
                ) : null}
              </Field>
            </Card>
          </div>

          <div className={styles.sideCard}>
            <Card>
              <div className={styles.step}>
                <span className={styles.stepNo}>1</span>
                <div>
                  <strong>打开上传页</strong>
                  <p>在 {platform?.name ?? "平台"} 的独立登录环境中打开官方上传页面。</p>
                  <Button
                    style={{ marginTop: 8 }}
                    icon={ExternalLink}
                    loading={busy === "open"}
                    onClick={openUpload}
                    disabled={!account}
                  >
                    打开上传页
                  </Button>
                </div>
              </div>
            </Card>
            <Card>
              <div className={styles.step}>
                <span className={styles.stepNo}>2</span>
                <div>
                  <strong>填入素材文件</strong>
                  <p>把选中的本地文件直接填入页面的上传控件,省去文件对话框。</p>
                  <Button
                    style={{ marginTop: 8 }}
                    variant="primary"
                    icon={FileUp}
                    loading={busy === "attach"}
                    onClick={attach}
                    disabled={!account || selected.length === 0 || !hasBridge}
                  >
                    填入 {selected.length || ""} 个文件
                  </Button>
                </div>
              </div>
            </Card>
            <Card>
              <div className={styles.step}>
                <span className={styles.stepNo}>3</span>
                <div>
                  <strong>粘贴文案并发布</strong>
                  <p>复制后到页面粘贴,确认无误再点击平台的发布按钮。</p>
                  <div className={cx(styles.copyRow)} style={{ marginTop: 8 }}>
                    <Button
                      size="sm"
                      icon={ClipboardCopy}
                      onClick={() => copy(title, "标题")}
                      disabled={!title.trim()}
                    >
                      标题
                    </Button>
                    <Button
                      size="sm"
                      icon={ClipboardCopy}
                      onClick={() => copy(composedText, "完整文案")}
                      disabled={!composedText}
                    >
                      标题+文案+标签
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
            <Card>
              <div style={{ display: "grid", gap: 8 }}>
                <Button
                  block
                  icon={Send}
                  loading={busy === "save"}
                  onClick={() => saveRecord("planned")}
                  disabled={!account || !title.trim()}
                >
                  保存为计划
                </Button>
                <Button
                  block
                  variant="soft"
                  icon={CheckCircle2}
                  loading={busy === "save"}
                  onClick={() => saveRecord("published")}
                  disabled={!account || !title.trim()}
                >
                  标记为已发布
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}

      <div className={styles.records}>
        <Card padded={false}>
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--line)",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <strong style={{ fontSize: "var(--text-sm)" }}>发布记录</strong>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>{records.length} 条</span>
          </div>
          {records.length === 0 ? (
            <EmptyState
              icon={Send}
              title="还没有发布记录"
              description="保存计划或标记已发布后会显示在这里。"
            />
          ) : (
            records.map((record) => {
              const a = accounts.find((x) => x.id === record.accountId);
              const p = composerPlatform(record.platformId);
              return (
                <div key={record.id} className={styles.recordRow}>
                  <Avatar
                    src={a?.avatarUrl}
                    name={a?.displayName ?? p.shortName}
                    color={p.color}
                    size={36}
                    round
                  />
                  <div style={{ minWidth: 0, cursor: "pointer" }} onClick={() => loadRecord(record)}>
                    <strong>{record.title || "(无标题)"}</strong>
                    <span>
                      {a?.displayName ?? "已删除账号"} · {p.name} · {record.assetIds.length} 个素材 ·{" "}
                      {formatDateTime(record.publishedAt ?? record.updatedAt)}
                    </span>
                  </div>
                  <Badge
                    tone={
                      record.status === "published"
                        ? "success"
                        : record.status === "cancelled"
                          ? "neutral"
                          : "info"
                    }
                  >
                    {{ planned: "计划中", published: "已发布", cancelled: "已取消" }[record.status]}
                  </Badge>
                  <IconButton
                    icon={Trash2}
                    label="删除记录"
                    onClick={async () => {
                      await publisher.delete(record.id);
                      setRecords(await publisher.list());
                      if (recordId === record.id) resetForm();
                    }}
                  />
                </div>
              );
            })
          )}
        </Card>
      </div>

      <Modal
        open={pickerOpen}
        wide
        title="选择素材"
        onClose={() => setPickerOpen(false)}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={async () => {
                const added = await api.assets.import();
                if (added.length) {
                  await reload();
                  setSelected([...selected, ...added.map((a) => a.id)]);
                }
              }}
            >
              导入新素材
            </Button>
            <Button variant="primary" onClick={() => setPickerOpen(false)}>
              完成 ({selected.length})
            </Button>
          </>
        }
      >
        <AssetGrid
          assets={assets}
          onChanged={reload}
          selectable
          selected={selected}
          onToggle={(id) =>
            setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
          }
        />
      </Modal>
    </div>
  );
}
