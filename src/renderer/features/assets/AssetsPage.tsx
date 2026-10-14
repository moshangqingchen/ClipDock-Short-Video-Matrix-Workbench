import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  FileVideo2,
  FolderOpen,
  Image as ImageIcon,
  Music2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import type { Asset } from "@shared/types";
import {
  Button,
  EmptyState,
  IconButton,
  Skeleton,
  TextInput,
  cx,
  formatBytes,
  formatRelative,
} from "@renderer/components/ui";
import { api, hasBridge } from "@renderer/lib/api";
import { useToasts, useUi } from "@renderer/store";
import layout from "@renderer/features/layout/layout.module.css";
import styles from "./assets.module.css";

export interface AssetsPageProps {
  selectable?: boolean;
  selected?: string[];
  onToggle?: (id: string) => void;
  embedded?: boolean;
  manageable?: boolean;
}

export function useAssets() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const rows = await api.assets.list();
      if (request === sequence.current) { setAssets(rows); setError(false); }
    } catch {
      if (request === sequence.current) setError(true);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, []);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void reload(); });
    return () => { active = false; invalidate(); };
  }, [reload, invalidate]);
  return { assets, reload, setAssets, error, loading };
}

export function AssetsPage() {
  const { assets, reload, error, loading } = useAssets();
  const selected = useUi((s) => s.selectedAssetIds);
  const [importing, setImporting] = useState(false);
  const setRoute = useUi((s) => s.setRoute);

  const doImport = async () => {
    setImporting(true);
    try {
      const added = await api.assets.import();
      if (added.length)
        useToasts.getState().push({ kind: "success", title: `已导入 ${added.length} 个素材` });
      await reload();
    } catch (error) {
      useToasts.getState().push({ kind: "error", title: "导入失败", message: (error as Error).message });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className={layout.page}>
      <div className={layout.pageHead}>
        <div>
          <span className={layout.eyebrow}>LIBRARY</span>
          <h1>素材库</h1>
          <p>视频与图片保留在本机原位置,这里只记录引用、哈希与缩略图,用于发布助手快速选择。</p>
        </div>
        <div className={layout.pageActions}>
          <Button variant="primary" icon={Plus} loading={importing} onClick={doImport}>
            导入素材
          </Button>
          <Button icon={Upload} onClick={() => setRoute("publish")}>
            去发布
          </Button>
        </div>
      </div>
      {error && <div role="alert" className={styles.notice}>
        <span>素材读取失败。{assets ? "已保留上次列表。" : "请重试读取。"}</span>
        <Button size="sm" loading={loading} onClick={reload}>重试读取素材</Button>
      </div>}
      <AssetGrid
        assets={assets}
        loading={loading}
        onChanged={reload}
        selectable
        manageable
        selected={selected}
        onToggle={(id) =>
          useUi
            .getState()
            .selectAssets(
              selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id],
            )
        }
      />
    </div>
  );
}

export function AssetGrid({
  assets,
  onChanged,
  selectable,
  manageable = !selectable,
  loading = true,
  selected = [],
  onToggle,
}: { assets: Asset[] | null; onChanged: () => void; loading?: boolean } & AssetsPageProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const filtered = (assets ?? []).filter(asset =>
    (kind === "all" || asset.kind === kind) && asset.fileName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pageSize = 24;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const remove = async (asset: Asset) => {
    if (removing) return;
    setRemoving(asset.id);
    try {
      await api.assets.remove(asset.id);
      useUi.getState().selectAssets(useUi.getState().selectedAssetIds.filter(id => id !== asset.id));
      onChanged();
    } catch (error) {
      useToasts.getState().push({ kind: "error", title: "移出素材库失败", message: (error as Error).message });
    } finally { setRemoving(null); }
  };
  if (!assets) {
    if (!loading) return null;
    return (
      <div className={styles.grid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} height={260} />
        ))}
      </div>
    );
  }
  if (assets.length === 0) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="素材库为空"
        description={hasBridge ? "点击右上角「导入素材」从本机选择视频或图片。" : "桌面端可从本机导入素材。"}
      />
    );
  }
  return (
    <>
    <div className={styles.toolbar}>
      <TextInput aria-label="搜索素材" placeholder="搜索文件名" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
      <label>类型 <select aria-label="素材类型" value={kind} onChange={event => { setKind(event.target.value); setPage(0); }}>
        <option value="all">全部类型</option><option value="video">视频</option><option value="image">图片</option><option value="audio">音频</option><option value="other">其他</option>
      </select></label>
      <span>{filtered.length} 个素材 · 已选 {selected.length} 个</span>
    </div>
    {!filtered.length && <p role="status" className={styles.notice}>没有匹配的素材，请调整搜索或类型。</p>}
    <div className={styles.grid}>
      {visible.map((asset) => {
        const isSelected = selected.includes(asset.id);
        const KindIcon = asset.kind === "video" ? FileVideo2 : asset.kind === "image" ? ImageIcon : Music2;
        const src = hasBridge ? `sv-asset://${asset.thumbnailPath ? "thumb" : "file"}/${asset.id}` : null;
        const Selection = selectable ? "button" : "div";
        return (
          <div
            key={asset.id}
            className={cx(styles.asset, isSelected && styles.selected)}
          >
            <Selection className={styles.assetSelect} type={selectable ? "button" : undefined}
              aria-label={selectable ? `选择素材：${asset.fileName}` : undefined}
              aria-pressed={selectable ? isSelected : undefined}
              onClick={selectable ? () => onToggle?.(asset.id) : undefined}>
            <div className={styles.thumb}>
              {src && asset.kind === "video" && !asset.thumbnailPath ? (
                <LazyVideo src={src} />
              ) : src && (asset.kind === "image" || asset.thumbnailPath) ? (
                <img src={src} alt="" loading="lazy" decoding="async" />
              ) : (
                <KindIcon size={30} />
              )}
              <span className={styles.kind}>
                {{ video: "视频", image: "图片", audio: "音频", other: "文件" }[asset.kind]}
              </span>
              {isSelected ? (
                <span className={styles.check}>
                  <Check size={13} />
                </span>
              ) : null}
            </div>
            <div className={styles.meta}>
              <strong title={asset.fileName}>{asset.fileName}</strong>
              <span>
                <em style={{ fontStyle: "normal" }}>{formatBytes(asset.sizeBytes)}</em>
                <em style={{ fontStyle: "normal" }}>{formatRelative(asset.createdAt)}</em>
              </span>
            </div>
            </Selection>
            {manageable ? (
              <div className={styles.actions}>
                <IconButton
                  icon={FolderOpen}
                  label={`在文件夹中显示：${asset.fileName}`}
                  size="sm"
                  onClick={() => void api.assets.reveal(asset.id).catch(() => useToasts.getState().push({ kind: "error", title: "无法打开素材所在文件夹" }))}
                />
                <IconButton icon={Trash2} label={`移出素材库：${asset.fileName}`} disabled={Boolean(removing)} size="sm" onClick={() => void remove(asset)} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
    {pages > 1 && <div className={styles.pagination} aria-label="素材分页">
      <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
      <span>第 {currentPage + 1} / {pages} 页</span>
      <Button size="sm" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</Button>
    </div>}
    </>
  );
}

function LazyVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const video = ref.current;
    if (!video || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "120px" });
    observer.observe(video);
    return () => observer.disconnect();
  }, []);
  return <video ref={ref} src={visible ? src : undefined} muted preload={visible ? "metadata" : "none"} />;
}
