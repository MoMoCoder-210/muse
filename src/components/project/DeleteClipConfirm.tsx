import type { Clip } from "../../types/project";

type DeleteClipConfirmProps = {
  clip: Clip;
  onConfirm: (clip: Clip) => void;
  onCancel: () => void;
  disabled?: boolean;
};

/**
 * 片段删除确认弹窗。
 *
 */
export function DeleteClipConfirm({ clip, onConfirm, onCancel, disabled }: DeleteClipConfirmProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="modal-panel clip-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="delete-confirm-title">删除片段</h2>
          <button
            type="button"
            className="icon-button modal-close-button"
            aria-label="关闭"
            onClick={onCancel}
            disabled={disabled}
          >
            ×
          </button>
        </div>
        <p className="clip-delete-modal-text">
          确认删除 <strong>「第 {clip.sort_index} 集」</strong>？
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary-button btn-sm" onClick={onCancel} disabled={disabled}>
            取消
          </button>
          <button type="button" className="danger-button btn-sm" onClick={() => onConfirm(clip)} disabled={disabled}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
