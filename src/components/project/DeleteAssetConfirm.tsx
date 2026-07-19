import { useState } from "react";
import type { AssetCardData } from "./AssetCard";

type DeleteAssetConfirmProps = {
  /** 待删除的资产列表 */
  cards: AssetCardData[];
  onConfirm: (cards: AssetCardData[], deleteFiles: boolean) => void;
  onCancel: () => void;
  disabled?: boolean;
};

/**
 * 资产删除确认弹窗。
 */
export function DeleteAssetConfirm({ cards, onConfirm, onCancel, disabled }: DeleteAssetConfirmProps) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const count = cards.length;
  const first = cards[0];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="modal-panel delete-panel" onClick={(e) => e.stopPropagation()}>
        <div className="delete-panel-header">
          <h2 className="delete-panel-title">删除资产</h2>
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
        <p className="delete-panel-desc">
          {count === 1
            ? <>确认删除资产 <strong>「{first.resource.name}」</strong>？</>
            : <>确认删除 <strong>{count}</strong> 个资产？</>
          }
        </p>
        <label className="delete-panel-check">
          <input
            type="checkbox"
            checked={deleteFiles}
            onChange={(event) => setDeleteFiles(event.target.checked)}
            disabled={disabled}
          />
          <span className="delete-panel-check-box" />
          <span>同时删除磁盘文件</span>
        </label>
        <div className="delete-panel-actions">
          <button type="button" className="delete-panel-btn delete-panel-btn--cancel" onClick={onCancel} disabled={disabled}>
            取消
          </button>
          <button type="button" className="delete-panel-btn delete-panel-btn--danger" onClick={() => onConfirm(cards, deleteFiles)} disabled={disabled}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
