import { useCallback, useState } from "react";
import { open, message } from "@tauri-apps/plugin-dialog";
import {
  APP_NAME,
  CREATE_MODES,
  CREATE_MODE_OPTIONS,
  DEFAULT_PROJECT_ROOT,
  STYLE_OPTIONS,
  type CreateMode,
  type StyleMode,
} from "../../config/muse";
import { createProject } from "../../services/tauri";
import { SelectField } from "./SelectField";
import type { ProjectInfo } from "../../types/project";

type CreateProjectModalProps = {
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
};

export function CreateProjectModal({ onClose, onCreated }: CreateProjectModalProps) {
  const [loading, setLoading] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectDirectory, setProjectDirectory] = useState(DEFAULT_PROJECT_ROOT);
  const [createMode, setCreateMode] = useState<CreateMode>(CREATE_MODES.script);
  const [styleMode, setStyleMode] = useState<StyleMode>(STYLE_OPTIONS[0]);

  const handlePickWorkspace = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: DEFAULT_PROJECT_ROOT,
      title: "选择项目目录",
    });
    if (typeof selected === "string" && selected.trim()) {
      setProjectDirectory(selected);
    }
  }, []);

  const handleCreate = useCallback(async () => {
    if (!projectName.trim()) {
      await message("请先输入项目名。", { title: APP_NAME, kind: "warning" });
      return;
    }

    setLoading(true);
    try {
      const project = await createProject({
        name: projectName.trim(),
        description: projectDescription.trim() || undefined,
        workspace_path: projectDirectory.trim() || DEFAULT_PROJECT_ROOT,
        input_mode: createMode,
        style_mode: styleMode,
      });
      onCreated(project);
      await message(`项目已创建：${project.name}`, { title: APP_NAME, kind: "info" });
    } catch (error) {
      console.error(error);
      await message("创建项目失败，请检查目录权限或后端日志。", {
        title: APP_NAME,
        kind: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [projectName, projectDescription, projectDirectory, createMode, styleMode, onCreated]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-project-title"
      onClick={onClose}
    >
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="create-project-title" style={{ margin: 0, fontSize: 20 }}>
            创建新项目
          </h2>
          <button
            type="button"
            className="icon-button modal-close-button"
            aria-label="关闭创建项目弹窗"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="modal-form">
          <label className="field">
            <span>项目名</span>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="请输入项目名"
            />
          </label>

          <label className="field">
            <span>项目目录</span>
            <div className="inline-input">
              <input
                value={projectDirectory}
                onChange={(e) => setProjectDirectory(e.target.value)}
                placeholder={DEFAULT_PROJECT_ROOT}
              />
              <button type="button" className="ghost-button" onClick={handlePickWorkspace}>
                选择目录
              </button>
            </div>
          </label>

          <label className="field">
            <span>创建模式</span>
            <div className="segmented">
              {CREATE_MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={createMode === option.value ? "active" : ""}
                  onClick={() => setCreateMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </label>

          <SelectField
            label="创作风格"
            value={styleMode}
            options={STYLE_OPTIONS}
            onChange={(v) => setStyleMode(v as StyleMode)}
          />
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={handleCreate}
            disabled={loading}
          >
            {loading ? "创建中..." : "确认创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
