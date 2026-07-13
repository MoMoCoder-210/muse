type StoryboardConfirmProps = {
  title: string;
  message: string;
  confirmText: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
};

/**
 * 分镜操作确认弹窗（添加/插入通用）。
 *
 */
export function StoryboardConfirm({ title, message, confirmText, onConfirm, onCancel, disabled }: StoryboardConfirmProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="modal-panel clip-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="delete-confirm-title">{title}</h2>
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
        <p className="clip-delete-modal-text">{message}</p>
        <div className="modal-actions">
          <button type="button" className="secondary-button btn-sm" onClick={onCancel} disabled={disabled}>
            取消
          </button>
          <button type="button" className="primary-button btn-sm" onClick={onConfirm} disabled={disabled}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
