import { useEffect, useState } from "react";
import { ClipboardCopy, FileUp, Pencil, Save } from "lucide-react";
import { Button } from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { DRAFT_CHANGED, readPublishDraft, savePublishDraft, type PublishScope } from "@renderer/lib/publish-drafts";
import { useUi } from "@renderer/store";
import { useAssets } from "@renderer/features/assets/AssetsPage";
import styles from "./publish.module.css";

export function PublishAssist(props: { scope: PublishScope; accountId: string }) {
  return <AccountPublishAssist key={`${props.scope}:${props.accountId}`} {...props} />;
}

function AccountPublishAssist({ scope, accountId }: { scope: PublishScope; accountId: string }) {
  const [snapshot, setSnapshot] = useState(() => readPublishDraft(scope, accountId));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const { assets, error: assetsError, reload } = useAssets();
  const draft = snapshot.draft;
  useEffect(() => {
    const refresh = () => setSnapshot(readPublishDraft(scope, accountId));
    window.addEventListener(DRAFT_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(DRAFT_CHANGED, refresh); window.removeEventListener("storage", refresh); };
  }, [scope, accountId]);
  const edit = () => {
    const ui = useUi.getState();
    ui.setCreatorMode(scope);
    if (scope === "global") ui.selectGlobalAccount(accountId); else ui.selectAccount(accountId);
    ui.setRoute("publish");
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setFeedback({ error: false, text: "已复制，可直接粘贴到左侧平台页面。" }); }
    catch { setFeedback({ error: true, text: "复制失败，请选中文案后手动复制。" }); }
  };
  const attach = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const result = scope === "global"
        ? await api.globalWorkspace.attachFiles(accountId, draft.selected)
        : await api.publish.attachFiles(accountId, draft.selected);
      setFeedback({ error: result.attached === 0, text: result.attached
        ? `已填入 ${result.attached} 个文件，请在平台页面核对并完成发布。`
        : result.message ?? "未找到上传控件，请先在平台打开上传页。" });
    } catch (error) { setFeedback({ error: true, text: `填入失败：${(error as Error).message}` }); }
    finally { setBusy(false); }
  };
  const savePlan = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const input = { id: draft.recordId, accountId, assetIds: draft.selected, title: draft.title,
        description: draft.description, tags: draft.tags, status: "planned" as const };
      const record = scope === "global" ? await api.globalWorkspace.publishSave(input) : await api.publish.save(input);
      const latest = readPublishDraft(scope, accountId).draft ?? draft;
      setSnapshot(savePublishDraft(scope, accountId, { ...latest, recordId: record.id }));
      setFeedback({ error: false, text: "发布计划已保存，可稍后继续。" });
    } catch (error) { setFeedback({ error: true, text: `计划保存失败：${(error as Error).message}` }); }
    finally { setBusy(false); }
  };
  const text = draft ? [draft.title, draft.description, draft.tags.map(tag => `#${tag}`).join(" ")].filter(Boolean).join("\n\n") : "";
  return <section className={styles.assist} aria-label="发布辅助">
    <h3>继续发布</h3>
    <p>素材与文案随当前账号保留。最后在平台页面确认发布。</p>
    {snapshot.error && <div role="alert" className={styles.draftStatus}>{snapshot.error}</div>}
    {feedback && <div role={feedback.error ? "alert" : "status"} className={styles.draftStatus}>{feedback.text}</div>}
    {!draft ? <p>当前账号还没有草稿，先选择素材并填写文案。</p> : <>
      <strong>已选 {draft.selected.length} 个素材</strong>
      {assetsError && <div role="alert">素材名称读取失败。<Button size="sm" onClick={reload}>重试读取素材</Button></div>}
      {draft.selected.length > 0 && <ul className={styles.assistFiles}>{draft.selected.map(id =>
        <li key={id}>{assets?.find(asset => asset.id === id)?.fileName ?? (assets ? "素材已移出，请重新选择" : "正在读取素材…")}</li>)}</ul>}
      <Button icon={FileUp} disabled={!hasBridge || !draft.selected.length || busy} loading={busy} onClick={attach}>填入素材文件</Button>
      <div className={styles.assistText}>{text || "尚未填写文案"}</div>
      <div className={styles.copyRow}>
        <Button size="sm" icon={ClipboardCopy} disabled={!draft.title.trim()} onClick={() => copy(draft.title)}>复制标题</Button>
        <Button size="sm" icon={ClipboardCopy} disabled={!text.trim()} onClick={() => copy(text)}>复制完整文案</Button>
      </div>
      <Button icon={Save} disabled={!draft.title.trim() || busy} onClick={savePlan}>保存为计划</Button>
    </>}
    <Button icon={Pencil} onClick={edit}>编辑素材与文案</Button>
  </section>;
}
