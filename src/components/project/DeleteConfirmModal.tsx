import { createPortal } from "react-dom";
import type { ReactNode } from "react";

type DeleteConfirmCheckbox = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

type DeleteConfirmModalProps = {
  title: string;
  description: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  disabled?: boolean;
  checkbox?: DeleteConfirmCheckbox;
  /** 遮罩覆盖完整应用内容区，但不遮挡窗口标题栏与控制按钮。 */
  excludeTitlebar?: boolean;
};

/**
 * 统一的破坏性操作确认弹窗。
 *
 * 始终挂载到 document.body，避免被工作区容器裁切；业务侧负责删除请求与加载状态。
 */
export function DeleteConfirmModal({
  title,
  description,
  onConfirm,
  onCancel,
  confirmText = "删除",
  disabled = false,
  checkbox,
  excludeTitlebar = true,
}: DeleteConfirmModalProps) {
  return createPortal(
    <div
      className={`modal-backdrop${excludeTitlebar ? " delete-batch-backdrop" : ""}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
      onClick={() => { if (!disabled) onCancel(); }}
    >
      <div className="modal-panel delete-panel" onClick={(event) => event.stopPropagation()}>
        <div className="delete-panel-header">
          <h2 id="delete-confirm-title" className="delete-panel-title">{title}</h2>
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
        <p className="delete-panel-desc">{description}</p>
        {checkbox && (
          <label className="delete-panel-check">
            <input
              type="checkbox"
              checked={checkbox.checked}
              onChange={(event) => checkbox.onChange(event.target.checked)}
              disabled={disabled}
            />
            <span className="delete-panel-check-box" />
            <span>{checkbox.label}</span>
          </label>
        )}
        <div className="delete-panel-actions">
          <button type="button" className="delete-panel-btn delete-panel-btn--cancel" onClick={onCancel} disabled={disabled}>
            取消
          </button>
          <button type="button" className="delete-panel-btn delete-panel-btn--danger" onClick={onConfirm} disabled={disabled}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
