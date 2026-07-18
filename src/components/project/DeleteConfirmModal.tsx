import { useCallback, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { deleteProject } from "../../services/tauri";
import { useToast } from "../../hooks/useToast";

type DeleteConfirmModalProps = {
  project: ProjectInfo;
  onDeleted: (projectId: string) => void;
  onClose: () => void;
};

export function DeleteConfirmModal({
  project,
  onDeleted,
  onClose,
}: DeleteConfirmModalProps) {
  const { toast } = useToast();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteProject(project.id, deleteFiles);
      onDeleted(project.id);
      toast(`项目「${project.name}」已删除。`, "info");
    } catch (error) {
      toast("删除项目失败，请检查日志。", "error");
    } finally {
      setDeleting(false);
    }
  }, [project, deleteFiles, onDeleted, toast]);

  return (
    <div
      className="modal-backdrop"
      role="alertdialog"
      aria-modal="true"
      onClick={() => !deleting && onClose()}
    >
      <div className="modal-panel delete-panel" onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="delete-panel-header">
          <h2 className="delete-panel-title">删除项目</h2>
          <button
            type="button"
            className="modal-close"
            aria-label="关闭"
            onClick={onClose}
            disabled={deleting}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* 正文 */}
        <p className="delete-panel-desc">
          将永久移除 <strong>{project.name}</strong> 及其全部关联数据。此操作无法恢复。
        </p>

        {/* 复选框 */}
        <label className="delete-panel-check">
          <input
            type="checkbox"
            checked={deleteFiles}
            onChange={(e) => setDeleteFiles(e.target.checked)}
          />
          <span className="delete-panel-check-box" />
          <span>同时删除本地文件夹</span>
        </label>

        {/* 按钮 */}
        <div className="delete-panel-actions">
          <button
            type="button"
            className="delete-panel-btn delete-panel-btn--cancel"
            onClick={onClose}
            disabled={deleting}
          >
            取消
          </button>
          <button
            type="button"
            className="delete-panel-btn delete-panel-btn--danger"
            onClick={handleConfirm}
            disabled={deleting}
          >
            {deleting ? "删除中…" : "删除"}
          </button>
        </div>
      </div>
    </div>
  );
}
