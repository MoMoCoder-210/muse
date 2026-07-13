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
  /** 图片 URL 缓存破坏参数（路径不变但文件内容被替换时需要） */
  renderKey?: number;
  /** 该资产关联的图片是否有正在生成的任务 */
  generating?: boolean;
  onToggle: (id: AssetCardId) => void;
  onDelete: (data: AssetCardData) => void;
  onDetail: (data: AssetCardData) => void;
  /** 角色资产点击声音按钮打开声音绑定抽屉 */
  onVoice?: (data: AssetCardData) => void;
  disabled?: boolean;
};

/**
 * 单个资产卡片。
 *
 * 选中时卡片边框高亮 + 遮罩层，点击切换选中。
 * 图片区：有绑定图片则显示缩略图，否则显示占位 icon。
 * 右上角删除按钮；点击图片区弹出详情抽屉。
 *
 */
export function AssetCard({
  data,
  icon,
  selected,
  selectedImagePath,
  renderKey = 0,
  generating = false,
  onToggle,
  onDelete,
  onDetail,
  onVoice,
  disabled,
}: AssetCardProps) {
  const { id, resource } = data;
  const hasVoice = Boolean(resource.voiceBinding);

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
            src={`${convertFileSrc(selectedImagePath)}?r=${renderKey}`}
            alt={resource.name}
            draggable={false}
          />
        ) : (
          <span className="asset-card-placeholder">{icon}</span>
        )}

        {/* 选中遮罩 */}
        {selected && <div className="asset-card-overlay" />}

        {/* 生成中状态角标（实时） */}
        {generating && (
          <div className="asset-card-status asset-card-status--generating">
            <span className="asset-card-spinner" />
            生成中
          </div>
        )}

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

        {/* 右下角：声音绑定按钮（仅角色资产） */}
        {data.type === "character" && (
          <button
            type="button"
            className={`asset-card-voice asset-card-btn${hasVoice ? " is-bound" : ""}`}
            onClick={(e) => { e.stopPropagation(); onVoice?.(data); }}
            disabled={disabled}
            title={hasVoice ? "已绑定声音，点击重新选择" : "绑定声音"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          </button>
        )}
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
