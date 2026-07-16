type StoryboardConfirmProps = {
  title: string;
  message: string;
  confirmText: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
  /** 可选：在消息下方显示一个复选框 */
  checkbox?: { label: string; checked: boolean; onChange: (checked: boolean) => void };
};

/**
 * 分镜操作确认弹窗（添加/插入/删除通用）。
 *
 */
export function StoryboardConfirm({ title, message, confirmText, onConfirm, onCancel, disabled, checkbox }: StoryboardConfirmProps) {
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
        {checkbox && (
          <label className="delete-files-option">
            <input
              type="checkbox"
              checked={checkbox.checked}
              onChange={(e) => checkbox.onChange(e.target.checked)}
              disabled={disabled}
            />
            <span>{checkbox.label}</span>
          </label>
        )}
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
