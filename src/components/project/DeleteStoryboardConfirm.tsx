import type { Storyboard } from "../../types/project";

type DeleteStoryboardConfirmProps = {
  sb: Storyboard;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
};

/**
 * 分镜删除确认弹窗。
 *
 * @author yt @date 20260708
 */
export function DeleteStoryboardConfirm({ sb, onConfirm, onCancel, disabled }: DeleteStoryboardConfirmProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="modal-panel clip-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="delete-confirm-title">删除分镜</h2>
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
          确认删除分镜 <strong>「#{sb.seq_num}」</strong>？
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary-button btn-sm" onClick={onCancel} disabled={disabled}>
            取消
          </button>
          <button type="button" className="danger-button btn-sm" onClick={onConfirm} disabled={disabled}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
