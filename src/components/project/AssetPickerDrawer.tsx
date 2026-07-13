import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listProjectAssetImages } from "../../services/tauri";
import type { AssetType } from "../../types/project";

const TYPE_LABELS: Record<string, string> = {
  character: "角色",
  scene: "场景",
  item: "物品",
};

const TYPE_ICONS: Record<string, string> = {
  character: "\u{1F464}",
  scene: "\u{1F3DE}",
  item: "\u{1F4E6}",
};

type ProjectAsset = {
  asset_id: string;
  clip_id: string;
  asset_type: string;
  name: string;
  description: string;
  prompt: string;
  selected_image_path: string;
  selected_image_id: string;
};

type AssetPickerDrawerProps = {
  /** 当前项目 ID */
  projectId: string;
  /** 要查询的资产类型 */
  assetType: AssetType;
  /** 排除的当前分镜 clip_id */
  excludeClipId: string;
  /** 选中某个资产的图片后回调 */
  onPick: (sourceImageId: string, sourceName: string) => void;
  /** 关闭抽屉 */
  onClose: () => void;
  /** 抽屉是否正在执行关闭动画 */
  closing?: boolean;
};

/**
 * 资产图片选择器抽屉（左侧弹出）
 *
 * 展示当前项目下同类型的所有资产及其选中图片，
 * 用户点击后将其图片复制到当前编辑的资产。
 *
 */
export function AssetPickerDrawer({
  projectId,
  assetType,
  excludeClipId,
  onPick,
  onClose,
  closing,
}: AssetPickerDrawerProps) {
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listProjectAssetImages({
      projectId,
      assetType,
      excludeClipId,
    })
      .then((items) => {
        if (!cancelled) setAssets(items);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, assetType, excludeClipId]);

  const typeLabel = TYPE_LABELS[assetType] ?? assetType;
  const icon = TYPE_ICONS[assetType] ?? "\u{1F4C4}";

  const handlePick = useCallback(
    (asset: ProjectAsset) => {
      onPick(asset.selected_image_id, asset.name);
    },
    [onPick],
  );

  return (
    <>
      {/* 遮罩层 */}
      <div
        className={`asset-picker-backdrop${closing ? " asset-picker-backdrop--closing" : ""}`}
        onClick={onClose}
      />

      {/* 抽屉面板（左侧） */}
      <aside
        className={`asset-picker-drawer${closing ? " asset-picker-drawer--closing" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="asset-picker-header">
          <div className="asset-picker-title-row">
            <h2 className="asset-picker-title">
              选择{typeLabel}图片
            </h2>
          </div>
          <button
            type="button"
            className="icon-button modal-close-button"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* 内容区 */}
        <div className="asset-picker-body">
          {loading ? (
            <div className="asset-picker-empty">
              <span className="spinner" aria-hidden />
              <span>加载中…</span>
            </div>
          ) : error ? (
            <div className="asset-picker-empty asset-picker-empty--error">
              <span>加载失败：{error}</span>
            </div>
          ) : assets.length === 0 ? (
            <div className="asset-picker-empty">
              <span className="asset-picker-empty-icon">{icon}</span>
              <span>暂无其他{typeLabel}资产图片</span>
            </div>
          ) : (
            <div className="asset-picker-grid">
              {assets.map((asset) => (
                <button
                  key={asset.asset_id}
                  type="button"
                  className="asset-picker-card"
                  onClick={() => handlePick(asset)}
                  title={`使用「${asset.name}」的图片`}
                >
                  <div className="asset-picker-card-img-wrap">
                    <img
                      src={convertFileSrc(asset.selected_image_path)}
                      alt={asset.name}
                      draggable={false}
                    />
                  </div>
                  <div className="asset-picker-card-info">
                    <span className="asset-picker-card-name">{asset.name}</span>
                    {asset.description && (
                      <span className="asset-picker-card-desc">{asset.description}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
