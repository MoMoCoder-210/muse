import { useCallback, useState } from "react";
import { createClip, getSettings } from "../../services/tauri";
import { importScriptByTab } from "../../services/import-script";
import { pickTxtFile } from "../../services/dialog";
import { getActiveChannel } from "../../types/settings";
import { useToast } from "../../hooks/useToast";

type CreateClipModalProps = {
  projectId: string;
  onCreated: () => void;
  onClose: () => void;
};

type MainTab = "manual" | "smart";
type SmartTab = "paste" | "file";

/**
 * 新建片段弹窗
 *
 * 手动输入：标题 + 正文（≤1500字符）
 * 智能创建：粘贴文本或导入 TXT 文件，LLM 自动拆分
 *
 * 两套内容同时渲染，用 visibility 切换，避免切 Tab 时弹窗高度跳动。
 *
 * @author yt @date 20260703
 */
export function CreateClipModal({ projectId, onCreated, onClose }: CreateClipModalProps) {
  const { toast } = useToast();
  const [tab, setTab] = useState<MainTab>("manual");
  const [smartTab, setSmartTab] = useState<SmartTab>("paste");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [filePath, setFilePath] = useState("");
  const [loading, setLoading] = useState(false);

  const handlePickFile = useCallback(async () => {
    const path = await pickTxtFile({ title: "选择剧本文件" });
    if (path) setFilePath(path);
  }, []);

  const handleManualCreate = useCallback(async () => {
    const t = title.trim();
    const c = text.trim();
    if (!t || !c) { toast("请填写片段标题和正文", "warning"); return; }
    if (c.length > 1500) { toast("片段正文不能超过 1500 字符", "warning"); return; }
    setLoading(true);
    try {
      await createClip({ project_id: projectId, title: t, source_text: c });
      toast("片段已创建", "success");
      onCreated();
    } catch (err) {
      toast("创建失败，请重试", "error");
    } finally { setLoading(false); }
  }, [title, text, projectId, toast, onCreated]);

  const handleSmartImport = useCallback(async () => {
    if (smartTab === "paste" && !text.trim()) { toast("请先粘贴剧本内容。", "warning"); return; }
    if (smartTab === "file" && !filePath.trim()) { toast("请先选择剧本文件。", "warning"); return; }
    setLoading(true);
    try {
      const settings = await getSettings();
      if (!getActiveChannel(settings.text)?.apiKey?.trim()) {
        toast("文本模型 API Key 未配置，请先到设置页填入后再启动拆分。", "warning");
        return;
      }
      await importScriptByTab(projectId, smartTab, text, filePath);
      toast("剧本导入成功，正在拆分…", "success");
      onCreated();
    } catch (err) {
      toast("导入失败，请检查文件内容或后端日志。", "error");
    } finally { setLoading(false); }
  }, [smartTab, text, filePath, projectId, onCreated, toast]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-panel create-clip-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>新建片段</h3>
          <button type="button" className="icon-button modal-close-button" aria-label="关闭" onClick={onClose}>×</button>
        </div>

        <div className="import-tabs">
          <button type="button" className={`tab-btn${tab === "manual" ? " active" : ""}`} onClick={() => setTab("manual")}>手动输入</button>
          <button type="button" className={`tab-btn${tab === "smart" ? " active" : ""}`} onClick={() => setTab("smart")}>智能创建</button>
        </div>

        <div style={{ position: "relative" }}>
          {/* 手动：始终占据空间，通过 visibility 切换可见性 */}
          <div style={{ visibility: tab === "manual" ? "visible" : "hidden" }}>
            <div className="import-body">
              <label className="form-field">
                <span className="form-label">片段标题</span>
                <input
                  type="text" className="form-input"
                  placeholder="例如：第 1 集 · 开场"
                  value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100}
                />
              </label>
              <label className="form-field">
                <span className="form-label">
                  片段正文 <span className="form-label-hint">（{text.length}/1500）</span>
                </span>
                <textarea
                  className="script-textarea"
                  placeholder="输入片段正文内容…"
                  value={text} onChange={(e) => setText(e.target.value)}
                  maxLength={1500} rows={10}
                />
              </label>
            </div>
          </div>

          {/* 智能：叠加在手动内容上方，通过 visibility 切换可见性 */}
          <div style={{ position: "absolute", inset: 0, visibility: tab === "smart" ? "visible" : "hidden" }}>
            <div className="import-sub-tabs">
              <button type="button" className={`tab-btn${smartTab === "paste" ? " active" : ""}`} onClick={() => setSmartTab("paste")}>粘贴文本</button>
              <button type="button" className={`tab-btn${smartTab === "file" ? " active" : ""}`} onClick={() => setSmartTab("file")}>导入 TXT 文件</button>
            </div>

            <div className="import-body">
              {smartTab === "paste" ? (
                <textarea
                  className="script-textarea"
                  value={text} onChange={(e) => setText(e.target.value)}
                  placeholder="将剧本文本粘贴到这里…" rows={10}
                />
              ) : (
                <div className="file-picker">
                  <div className="file-picker-input">
                    <input value={filePath} readOnly placeholder="选择 .txt 剧本文件" className="file-path-display" />
                    <button type="button" className="ghost-button btn-sm" onClick={handlePickFile}>选择文件</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="import-actions">
          <button type="button" className="secondary-button btn-sm" onClick={onClose} disabled={loading}>取消</button>
          <button type="button" className="primary-button btn-sm" onClick={tab === "manual" ? handleManualCreate : handleSmartImport} disabled={loading}>
            {tab === "manual" ? "创建" : "开始导入并拆分"}
          </button>
        </div>
      </div>
    </div>
  );
}
