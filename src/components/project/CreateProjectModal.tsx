import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CREATE_MODES,
  CREATE_MODE_OPTIONS,
  STYLE_OPTIONS,
  type CreateMode,
  type StyleMode,
} from "../../config/muse";
import { createProject, getSettings } from "../../services/tauri";
import { importScriptByTab } from "../../services/import-script";
import { pickTxtFile } from "../../services/dialog";
import { SelectField } from "../common/SelectField";
import type { ProjectInfo } from "../../types/project";
import { getActiveChannel } from "../../types/settings";
import { useToast } from "../../hooks/useToast";

type ScriptImportSectionProps = {
  scriptTab: "paste" | "file";
  setScriptTab: (tab: "paste" | "file") => void;
  scriptText: string;
  setScriptText: (text: string) => void;
  scriptFilePath: string;
  onPickFile: () => void;
};

function ScriptImportSection({
  scriptTab,
  setScriptTab,
  scriptText,
  setScriptText,
  scriptFilePath,
  onPickFile,
}: ScriptImportSectionProps) {
  return (
    <label className="field field--full modal-script-field">
      <span>导入剧本</span>
      <div className="import-tabs modal-script-tabs">
        <button
          type="button"
          className={`tab-btn ${scriptTab === "paste" ? "active" : ""}`}
          onClick={() => setScriptTab("paste")}
        >
          粘贴剧本
        </button>
        <button
          type="button"
          className={`tab-btn ${scriptTab === "file" ? "active" : ""}`}
          onClick={() => setScriptTab("file")}
        >
          导入剧本
        </button>
      </div>

      {scriptTab === "paste" ? (
        <textarea
          className="script-textarea modal-script-textarea"
          value={scriptText}
          onChange={(e) => setScriptText(e.target.value)}
          placeholder="在这里粘贴剧本"
          rows={8}
        />
      ) : (
        <div className="file-picker">
          <div className="file-picker-input">
            <input
              value={scriptFilePath}
              readOnly
              placeholder="选择 .txt 文件"
              className="file-path-display"
            />
            <button type="button" className="ghost-button" onClick={onPickFile}>
              选择文件
            </button>
          </div>
        </div>
      )}
    </label>
  );
}

type CreateProjectModalProps = {
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
};

/**
 * 创建作品弹窗
 *
 */
export function CreateProjectModal({ onClose, onCreated }: CreateProjectModalProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectDirectory, setProjectDirectory] = useState("");
  const [defaultProjectDir, setDefaultProjectDir] = useState("");

  // 加载设置中的默认作品目录
  useEffect(() => {
    getSettings().then((s) => {
      const dir = s.general.defaultProjectDir || "";
      setDefaultProjectDir(dir);
      if (!projectDirectory) {
        setProjectDirectory(dir);
      }
    }).catch(() => {});
  }, []);
  const [styleMode, setStyleMode] = useState<StyleMode>(STYLE_OPTIONS[0]);
  const [scriptTab, setScriptTab] = useState<"paste" | "file">("paste");
  const [scriptText, setScriptText] = useState("");
  const [scriptFilePath, setScriptFilePath] = useState("");
  const [createMode, setCreateMode] = useState<CreateMode>(CREATE_MODES.manual);

  const handlePickWorkspace = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: projectDirectory || defaultProjectDir || undefined,
      title: "选择作品目录",
    });
    if (typeof selected === "string" && selected.trim()) {
      setProjectDirectory(selected);
    }
  }, [projectDirectory, defaultProjectDir]);

  const handlePickScriptFile = useCallback(async () => {
    const path = await pickTxtFile({ title: "选择剧本文件" });
    if (path) setScriptFilePath(path);
  }, []);

  const handleScriptModePostCreate = useCallback(
    async (project: ProjectInfo) => {
      await importScriptByTab(project.id, scriptTab, scriptText, scriptFilePath);
      onCreated({ ...project, current_step: "script" });
      toast(`创建成功：${project.name}`, "success");
    },
    [scriptTab, scriptText, scriptFilePath, onCreated, toast],
  );

  const handleCreate = useCallback(async () => {
    if (!projectName.trim()) {
      toast("请先输入作品名", "warning");
      return;
    }

    if (createMode === CREATE_MODES.script) {
      if (scriptTab === "paste" && !scriptText.trim()) {
        toast("请输入剧本。", "warning");
        return;
      }
      if (scriptTab === "file" && !scriptFilePath.trim()) {
        toast("请选择剧本文件。", "warning");
        return;
      }

      // 文本模型未配置则不允许通过剧本模式创建
      const settings = await getSettings();
      if (!getActiveChannel(settings.text)?.apiKey?.trim()) {
        toast("剧本模式创建作品需要配置LLM模型。", "warning");
        return;
      }
    }

    setLoading(true);
    try {
      const project = await createProject({
        name: projectName.trim(),
        description: projectDescription.trim() || undefined,
        workspace_path: projectDirectory.trim(),
        input_mode: createMode,
        style_mode: styleMode,
      });

      if (createMode === CREATE_MODES.script) {
        try {
          await handleScriptModePostCreate(project);
        } catch {
          onCreated(project);
          toast("剧本导入或拆分启动失败，请检查模型配置与日志。", "warning");
        }
        return;
      }

      onCreated(project);
      toast(`作品已创建：${project.name}`, "info");
    } catch {
      toast("创建作品失败，请检查作品目录权限或日志。", "error");
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
          <h2 id="create-project-title" className="modal-title">
            新建作品
          </h2>
          <button
            type="button"
            className="modal-close"
            aria-label="关闭新建作品弹窗"
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="modal-form">
          <label className="field">
            <span>作品名称</span>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="请输入作品名"
            />
          </label>

          <label className="field">
            <span>作品目录</span>
            <div className="inline-input">
              <input
                value={projectDirectory}
                onChange={(e) => setProjectDirectory(e.target.value)}
                placeholder={`${defaultProjectDir || "D:\\projects"}`}
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
            <ScriptImportSection
              scriptTab={scriptTab}
              setScriptTab={setScriptTab}
              scriptText={scriptText}
              setScriptText={setScriptText}
              scriptFilePath={scriptFilePath}
              onPickFile={handlePickScriptFile}
            />
          ) : null}

          <label className="field field--full">
            <span>作品描述</span>
            <textarea
              value={projectDescription}
              onChange={(e) => setProjectDescription(e.target.value)}
              placeholder="输入作品描述"
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
            {loading ? "创建中..." : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
