import { useEffect, useState } from "react";
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
}

export function useAssets() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const reload = () =>
    api.assets
      .list()
      .then(setAssets)
      .catch(() => setAssets([]));
  useEffect(() => {
    void reload();
  }, []);
  return { assets, reload, setAssets };
}

export function AssetsPage() {
  const { assets, reload } = useAssets();
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
      <AssetGrid assets={assets} onChanged={reload} />
    </div>
  );
}

export function AssetGrid({
  assets,
  onChanged,
  selectable,
  selected = [],
  onToggle,
}: { assets: Asset[] | null; onChanged: () => void } & AssetsPageProps) {
  const remove = async (asset: Asset) => {
    await api.assets.remove(asset.id);
    onChanged();
  };
  if (!assets) {
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
    <div className={styles.grid}>
      {assets.map((asset) => {
        const isSelected = selected.includes(asset.id);
        const KindIcon = asset.kind === "video" ? FileVideo2 : asset.kind === "image" ? ImageIcon : Music2;
        const src = hasBridge ? `sv-asset://${asset.thumbnailPath ? "thumb" : "file"}/${asset.id}` : null;
        return (
          <div
            key={asset.id}
            className={cx(styles.asset, isSelected && styles.selected)}
            onClick={selectable ? () => onToggle?.(asset.id) : undefined}
            role={selectable ? "button" : undefined}
            tabIndex={selectable ? 0 : undefined}
          >
            <div className={styles.thumb}>
              {src && asset.kind === "video" && !asset.thumbnailPath ? (
                <video src={src} muted preload="metadata" />
              ) : src && (asset.kind === "image" || asset.thumbnailPath) ? (
                <img src={src} alt="" />
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
            {!selectable ? (
              <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
                <IconButton
                  icon={FolderOpen}
                  label="在文件夹中显示"
                  size="sm"
                  onClick={() => void api.assets.reveal(asset.id)}
                />
                <IconButton icon={Trash2} label="移出素材库" size="sm" onClick={() => void remove(asset)} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
