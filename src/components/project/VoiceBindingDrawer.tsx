import { useState } from "react";
import { useToast } from "../../hooks/useToast";
import { updateAssetInClip } from "../../services/tauri";
import { VoiceBindingSection } from "./VoiceBindingSection";
import type { AssetCardData } from "./AssetCard";
import type { VoiceBinding } from "../../types/project";

type VoiceBindingDrawerProps = {
  /** 目标资产卡片（仅角色） */
  card: AssetCardData;
  /** 关闭抽屉 */
  onClose: () => void;
  /** 绑定变化后由父级同步回 clipScripts */
  onVoiceBound: (card: AssetCardData, binding: VoiceBinding | undefined) => void;
  /** 抽屉是否正在执行关闭动画 */
  closing?: boolean;
  disabled?: boolean;
};

/**
 * 角色声音绑定抽屉。
 */
export function VoiceBindingDrawer({
  card,
  onClose,
  onVoiceBound,
  closing,
  disabled,
}: VoiceBindingDrawerProps) {
  const { toast } = useToast();
  const { resource } = card;
  const [saving, setSaving] = useState(false);

  const handleVoiceBindingChange = async (binding: VoiceBinding | undefined) => {
    setSaving(true);
    try {
      await updateAssetInClip({
        clip_id: card.clipId,
        asset_type: card.type,
        name: card.resource.name,
        description: resource.description ?? "",
        prompt: resource.prompt ?? "",
        voice_binding: binding ? JSON.stringify(binding) : undefined,
      });
      onVoiceBound(card, binding);
    } catch (err) {
      toast(`保存失败：${String(err)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* 遮罩层 */}
      <div
        className={`asset-drawer-backdrop${
          closing ? " asset-drawer-backdrop--closing" : ""
        }`}
        onClick={onClose}
      />

      {/* 抽屉面板 */}
      <aside
        className={`asset-drawer voice-binding-drawer${
          closing ? " asset-drawer--closing" : ""
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="asset-drawer-header">
          <div className="asset-drawer-title-row">
            <h2 className="asset-drawer-title">{resource.name}</h2>
            <span className="asset-detail-type-tag">绑定声音</span>
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

        <div className="asset-drawer-body">
          <VoiceBindingSection
            value={resource.voiceBinding}
            onChange={handleVoiceBindingChange}
            disabled={disabled || saving}
            clipId={card.clipId}
          />
        </div>

        <div className="asset-drawer-footer">
          <button type="button" className="primary-button btn-sm" onClick={onClose}>
            确定
          </button>
        </div>
      </aside>
    </>
  );
}
