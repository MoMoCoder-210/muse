import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CREATE_MODES,
  CREATE_MODE_OPTIONS,
  DEFAULT_PROJECT_ROOT,
  STYLE_OPTIONS,
  type CreateMode,
  type StyleMode,
} from "../../config/muse";
import { createProject, ensureWorkerAndImportScript, getSettings } from "../../services/tauri";
import { SelectField } from "./SelectField";
import type { ProjectInfo } from "../../types/project";
import { useToast } from "../../hooks/useToast";

type CreateProjectModalProps = {
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
};

export function CreateProjectModal({ onClose, onCreated }: CreateProjectModalProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectDirectory, setProjectDirectory] = useState(DEFAULT_PROJECT_ROOT);
  const [createMode, setCreateMode] = useState<CreateMode>(CREATE_MODES.script);
  const [styleMode, setStyleMode] = useState<StyleMode>(STYLE_OPTIONS[0]);
  const [scriptTab, setScriptTab] = useState<"paste" | "file">("paste");
  const [scriptText, setScriptText] = useState("");
  const [scriptFilePath, setScriptFilePath] = useState("");

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

  const handlePickScriptFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "文本文件", extensions: ["txt"] }],
      title: "选择剧本文件",
    });
    if (typeof selected === "string" && selected.trim()) {
      setScriptFilePath(selected);
    }
  }, []);

  const handleScriptModePostCreate = useCallback(
    async (project: ProjectInfo) => {
      const settings = await getSettings();
      if (!settings.text?.apiKey?.trim()) {
        onCreated(project);
        toast("项目已创建，但文本模型 API Key 未配置，请先到设置页填入后再启动拆分。", "warning");
        return;
      }

      await ensureWorkerAndImportScript(project.id, {
        source_type: scriptTab === "file" ? "txt" : "paste",
        content: scriptTab === "paste" ? scriptText.trim() : undefined,
        file_path: scriptTab === "file" ? scriptFilePath : undefined,
      });
      onCreated({ ...project, current_step: "script" });
      toast(`项目已创建并开始拆分：${project.name}`, "success");
    },
    [scriptTab, scriptText, scriptFilePath, onCreated, toast],
  );

  const handleCreate = useCallback(async () => {
    if (!projectName.trim()) {
      toast("请先输入项目名。", "warning");
      return;
    }

    if (createMode === CREATE_MODES.script) {
      if (scriptTab === "paste" && !scriptText.trim()) {
        toast("剧本模式下请先输入剧本文本。", "warning");
        return;
      }
      if (scriptTab === "file" && !scriptFilePath.trim()) {
        toast("剧本模式下请先选择剧本文件。", "warning");
        return;
      }
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

      if (createMode === CREATE_MODES.script) {
        try {
          await handleScriptModePostCreate(project);
        } catch (scriptError) {
          console.error(scriptError);
          onCreated(project);
          toast("项目已创建，但剧本导入或拆分启动失败，请检查模型配置和后端日志。", "warning");
        }
        return;
      }

      onCreated(project);
      toast(`项目已创建：${project.name}`, "info");
    } catch (error) {
      console.error(error);
      toast("创建项目失败，请检查目录权限或后端日志。", "error");
    } finally {
      setLoading(false);
    }
  }, [
    projectName,
    projectDescription,
    projectDirectory,
    createMode,
    styleMode,
    scriptTab,
    scriptText,
    scriptFilePath,
    handleScriptModePostCreate,
    onCreated,
    toast,
  ]);

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

          {createMode === CREATE_MODES.script ? (
            <label className="field field--full modal-script-field">
              <span>导入剧本</span>
              <div className="import-tabs modal-script-tabs">
                <button
                  type="button"
                  className={`tab-btn ${scriptTab === "paste" ? "active" : ""}`}
                  onClick={() => setScriptTab("paste")}
                >
                  粘贴文本
                </button>
                <button
                  type="button"
                  className={`tab-btn ${scriptTab === "file" ? "active" : ""}`}
                  onClick={() => setScriptTab("file")}
                >
                  导入 TXT 文件
                </button>
              </div>

              {scriptTab === "paste" ? (
                <textarea
                  className="script-textarea modal-script-textarea"
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  placeholder="在这里粘贴待拆分的剧本文本"
                  rows={8}
                />
              ) : (
                <div className="file-picker">
                  <div className="file-picker-input">
                    <input
                      value={scriptFilePath}
                      readOnly
                      placeholder="选择 .txt 剧本文件"
                      className="file-path-display"
                    />
                    <button type="button" className="ghost-button" onClick={handlePickScriptFile}>
                      选择文件
                    </button>
                  </div>
                  {scriptFilePath ? (
                    <p className="file-hint">已选择：{scriptFilePath.split(/[\\/]/).pop()}</p>
                  ) : null}
                </div>
              )}
            </label>
          ) : null}

          <label className="field field--full">
            <span>项目描述</span>
            <textarea
              value={projectDescription}
              onChange={(e) => setProjectDescription(e.target.value)}
              placeholder="可选，补充项目背景或目标"
              rows={3}
            />
          </label>
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
