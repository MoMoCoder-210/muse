import { useCallback, useRef, useState } from "react";
import { open, message } from "@tauri-apps/plugin-dialog";
import { APP_NAME } from "../../config/muse";
import { importScript } from "../../services/tauri";
import type { ProjectInfo } from "../../types/project";

type ScriptImportPanelProps = {
  project: ProjectInfo;
  onImported: () => void;
};

type Tab = "paste" | "file";

export function ScriptImportPanel({ project, onImported }: ScriptImportPanelProps) {
  const [tab, setTab] = useState<Tab>("paste");
  const [pasteText, setPasteText] = useState("");
  const [filePath, setFilePath] = useState("");
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handlePickFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "文本文件", extensions: ["txt"] }],
      title: "选择剧本文件",
    });
    if (typeof selected === "string" && selected.trim()) {
      setFilePath(selected);
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (tab === "paste" && !pasteText.trim()) {
      await message("请先粘贴剧本内容。", { title: APP_NAME, kind: "warning" });
      return;
    }
    if (tab === "file" && !filePath.trim()) {
      await message("请先选择剧本文件。", { title: APP_NAME, kind: "warning" });
      return;
    }

    setLoading(true);
    try {
      const sourceType = tab === "file" ? "txt" : "paste";
      await importScript({
        project_id: project.id,
        source_type: sourceType,
        content: tab === "paste" ? pasteText.trim() : undefined,
        file_path: tab === "file" ? filePath : undefined,
      });
      onImported();
    } catch (err) {
      console.error(err);
      await message("导入失败，请检查文件内容或后端日志。", {
        title: APP_NAME,
        kind: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [tab, pasteText, filePath, project.id, onImported]);

  return (
    <div className="script-import-panel">
      <div className="panel-header">
        <h3>导入剧本</h3>
        <p>将剧本文本导入后，系统会自动按集数拆分为片段</p>
      </div>

      <div className="import-tabs">
        <button
          type="button"
          className={`tab-btn ${tab === "paste" ? "active" : ""}`}
          onClick={() => setTab("paste")}
        >
          粘贴文本
        </button>
        <button
          type="button"
          className={`tab-btn ${tab === "file" ? "active" : ""}`}
          onClick={() => setTab("file")}
        >
          导入 TXT 文件
        </button>
      </div>

      <div className="import-body">
        {tab === "paste" ? (
          <textarea
            ref={textareaRef}
            className="script-textarea"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="将剧本文本粘贴到这里…"
            rows={16}
          />
        ) : (
          <div className="file-picker">
            <div className="file-picker-input">
              <input
                value={filePath}
                readOnly
                placeholder="选择 .txt 剧本文件"
                className="file-path-display"
              />
              <button type="button" className="ghost-button" onClick={handlePickFile}>
                选择文件
              </button>
            </div>
            {filePath && (
              <p className="file-hint">已选择：{filePath.split(/[\\/]/).pop()}</p>
            )}
          </div>
        )}
      </div>

      <div className="import-actions">
        <button
          type="button"
          className="primary-button"
          onClick={handleImport}
          disabled={loading}
        >
          {loading ? "导入中…" : "开始导入并拆分"}
        </button>
      </div>
    </div>
  );
}
