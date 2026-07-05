import { convertFileSrc } from "@tauri-apps/api/core";
import type { AssetType, AssetResource } from "../../types/project";

export type AssetCardId = `${string}:${AssetType}:${number}`;

export type AssetCardData = {
  id: AssetCardId;
  clipId: string;
  type: AssetType;
  index: number;
  resource: AssetResource;
};

type AssetCardProps = {
  data: AssetCardData;
  icon: string;
  selected: boolean;
  /** 当前资产绑定的图片路径（为空时显示占位 icon） */
  selectedImagePath?: string | null;
  onToggle: (id: AssetCardId) => void;
  onDelete: (data: AssetCardData) => void;
  onDetail: (data: AssetCardData) => void;
  disabled?: boolean;
};

/**
 * 单个资产卡片。
 *
 * 选中时卡片边框高亮 + 遮罩层，点击切换选中。
 * 图片区：有绑定图片则显示缩略图，否则显示占位 icon。
 * 右上角删除按钮；点击图片区弹出详情抽屉。
 *
 * @author yt @date 20260704
 */
export function AssetCard({
  data,
  icon,
  selected,
  selectedImagePath,
  onToggle,
  onDelete,
  onDetail,
  disabled,
}: AssetCardProps) {
  const { id, resource } = data;

  return (
    <div
      className={`asset-card${selected ? " asset-card--selected" : ""}`}
      onClick={() => onToggle(id)}
    >
      <div
        className="asset-card-frame"
        onClick={(e) => { e.stopPropagation(); onDetail(data); }}
      >
        {selectedImagePath ? (
          <img
            className="asset-card-img"
            src={convertFileSrc(selectedImagePath)}
            alt={resource.name}
            draggable={false}
          />
        ) : (
          <span className="asset-card-placeholder">{icon}</span>
        )}

        {/* 选中遮罩 */}
        {selected && <div className="asset-card-overlay" />}

        {/* 右上角：删除按钮 */}
        <div className="asset-card-actions asset-card-actions--delete">
          <button
            type="button"
            className="asset-card-btn asset-card-btn--delete"
            onClick={(e) => { e.stopPropagation(); onDelete(data); }}
            disabled={disabled}
            title="删除"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="asset-card-info">
        <span className="asset-card-name">{resource.name}</span>
        <span className="asset-card-desc">{resource.description}</span>
      </div>
    </div>
  );
}

/** 从资源列表构造资产卡片数据 */
export function buildAssetCards(
  clipId: string,
  type: AssetType,
  resources: AssetResource[]
): AssetCardData[] {
  return resources.map((resource, index) => ({
    id: `${clipId}:${type}:${index}`,
    clipId,
    type,
    index,
    resource,
  }));
}

/** 解析资产 ID */
export function parseAssetCardId(id: AssetCardId): { clipId: string; type: AssetType; index: number } {
  const [clipId, type, index] = id.split(":");
  return { clipId, type: type as AssetType, index: Number(index) };
}
