import { useCallback, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { deleteProject } from "../../services/tauri";
import { useToast } from "../../hooks/useToast";

type DeleteConfirmModalProps = {
  project: ProjectInfo;
  onDeleted: (projectId: string) => void;
  onClose: () => void;
};

/**
 * 删除确认弹窗
 */
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
      role="dialog"
      aria-modal="true"
      onClick={() => !deleting && onClose()}
    >
      <div className="modal-panel delete-confirm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="delete-confirm-title">删除项目</h2>
          <button
            type="button"
            className="icon-button modal-close-button"
            aria-label="关闭"
            onClick={() => !deleting && onClose()}
          >
            ×
          </button>
        </div>

        <div className="delete-confirm-body">
          <p>
            确认删除 <strong>「{project.name}」</strong> ？此操作不可撤销。
          </p>

          <label className="delete-files-option">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => setDeleteFiles(e.target.checked)}
            />
            <span>同时删除项目文件夹</span>
          </label>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={deleting}
          >
            取消
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={handleConfirm}
            disabled={deleting}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
