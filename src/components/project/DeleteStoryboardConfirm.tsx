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
 */
export function DeleteStoryboardConfirm({ sb, onConfirm, onCancel, disabled }: DeleteStoryboardConfirmProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="modal-panel delete-panel" onClick={(e) => e.stopPropagation()}>
        <div className="delete-panel-header">
          <h2 className="delete-panel-title">删除分镜</h2>
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
          确认删除分镜 <strong>「#{sb.seq_num}」</strong>？
        </p>
        <div className="delete-panel-actions">
          <button type="button" className="delete-panel-btn delete-panel-btn--cancel" onClick={onCancel} disabled={disabled}>
            取消
          </button>
          <button type="button" className="delete-panel-btn delete-panel-btn--danger" onClick={onConfirm} disabled={disabled}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
