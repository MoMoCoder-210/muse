import { useState } from "react";
import type { AssetType } from "../../types/project";

const TYPE_LABELS: Record<AssetType, string> = {
  character: "角色",
  scene: "场景",
  item: "物品",
};

export type AddAssetInput = {
  type: AssetType;
  name: string;
  description: string;
  prompt: string;
};

type AddAssetModalProps = {
  /** 预置的资产类型，从哪个分类打开就添加哪种类型 */
  assetType: AssetType;
  onConfirm: (input: AddAssetInput) => void;
  onCancel: () => void;
  disabled?: boolean;
};

/**
 * 添加资产弹窗。
 *
 * 资产类型由调用方指定，堆叠式表单布局。
 *
 */
export function AddAssetModal({ assetType, onConfirm, onCancel, disabled }: AddAssetModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");

  const canSubmit = name.trim().length > 0 && prompt.trim().length > 0;
  const label = TYPE_LABELS[assetType] ?? assetType;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="modal-panel add-asset-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="delete-confirm-title">添加{label}</h2>
          <button
            type="button"
            className="modal-close"
            aria-label="关闭"
            onClick={onCancel}
            disabled={disabled}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="add-asset-form">
          {/* 名称 */}
          <div className="add-asset-field">
            <label className="add-asset-label">
              名称<span className="add-asset-required">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`输入${label}名称`}
              disabled={disabled}
              required
            />
          </div>

          {/* 描述 */}
          <div className="add-asset-field">
            <label className="add-asset-label">描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`输入${label}描述`}
              disabled={disabled}
              rows={2}
            />
          </div>

          {/* 提示词 */}
          <div className="add-asset-field">
            <label className="add-asset-label">
              提示词<span className="add-asset-required">*</span>
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入生图提示词"
              disabled={disabled}
              rows={3}
              required
            />
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="asset-drawer-btn asset-drawer-btn--secondary" onClick={onCancel} disabled={disabled}>
            取消
          </button>
          <button
            type="button"
            className="asset-drawer-btn asset-drawer-btn--primary"
            onClick={() => onConfirm({ type: assetType, name: name.trim(), description: description.trim(), prompt: prompt.trim() })}
            disabled={disabled || !canSubmit}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
