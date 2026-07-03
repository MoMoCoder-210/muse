import { useCallback, useEffect, useRef, useState } from "react";
import { listScriptSources } from "../../services/tauri";
import type { ProjectInfo, ScriptSourceListItem } from "../../types/project";
import { ScriptImportModal } from "./ScriptImportModal";

type ScriptListPanelProps = {
  project: ProjectInfo;
  selectedSourceId: string | null;
  onSelectSource: (sourceId: string | null) => void;
  onSourcesChanged: () => void;
};

const SPLIT_STATUS_LABEL: Record<string, string> = {
  pending: "等待拆解",
  running: "拆解中…",
  success: "拆解完成",
  failed: "拆解失败",
};

/**
 * 剧本列表组件（工作台左侧 1/3）
 *
 * 展示项目下所有剧本源，支持导入和选中查看片段。
 *
 * @author yt @date 20260703
 */
export function ScriptListPanel({
  project,
  selectedSourceId,
  onSelectSource,
  onSourcesChanged,
}: ScriptListPanelProps) {
  const [sources, setSources] = useState<ScriptSourceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const selectedSourceIdRef = useRef(selectedSourceId);
  selectedSourceIdRef.current = selectedSourceId;
  const onSelectSourceRef = useRef(onSelectSource);
  onSelectSourceRef.current = onSelectSource;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listScriptSources(project.id);
      setSources(list);
      if (selectedSourceIdRef.current && !list.some((s) => s.id === selectedSourceIdRef.current)) {
        onSelectSourceRef.current(null);
      }
    } catch (err) {
      console.error("[ScriptListPanel] 加载失败:", err);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const hasRunning = sources.some(
      (s) => s.split_status === "pending" || s.split_status === "running"
    );
    if (!hasRunning) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [sources, load]);

  const handleImported = useCallback(() => {
    setShowImport(false);
    load();
    onSourcesChanged();
  }, [load, onSourcesChanged]);

  const hasRunning = sources.some(
    (s) => s.split_status === "pending" || s.split_status === "running"
  );

  return (
    <div className="script-list-panel">
      <div className="panel-header">
        <h3>剧本列表</h3>
        <button
          type="button"
          className="primary-button btn-sm"
          onClick={() => setShowImport(true)}
          disabled={hasRunning}
          title={hasRunning ? "有剧本正在拆分中，请完成后添加" : "添加新剧本"}
        >
          + 添加剧本
        </button>
      </div>

      {loading && sources.length === 0 ? (
        <div className="panel-loading">加载中…</div>
      ) : sources.length === 0 ? (
        <div className="empty-script-list">
          <p>暂无剧本</p>
          <p className="empty-script-list-hint">点击上方按钮添加</p>
        </div>
      ) : (
        <div className="script-list">
          {sources.map((source) => {
            const isSelected = source.id === selectedSourceId;
            const isRunning =
              source.split_status === "pending" || source.split_status === "running";
            return (
              <div
                key={source.id}
                className={`script-list-item ${isSelected ? "script-list-item--selected" : ""}`}
                onClick={() => onSelectSource(source.id)}
              >
                <div className="script-list-item-info">
                  <span className="script-list-item-name">
                    {source.file_name ?? `剧本 ${source.id.slice(0, 8)}`}
                  </span>
                  <span className="script-list-item-meta">
                    {source.source_type === "paste" ? "粘贴" : "TXT"} ·{" "}
                    {source.created_at.slice(0, 10)}
                  </span>
                  <span className={`script-list-item-status script-list-item-status--${source.split_status}`}>
                    {SPLIT_STATUS_LABEL[source.split_status] ?? source.split_status}
                  </span>
                </div>
                {isRunning && (
                  <span className="spinner" aria-hidden style={{ width: 12, height: 12 }} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {showImport && (
        <ScriptImportModal
          project={project}
          onClose={() => setShowImport(false)}
          onImported={handleImported}
        />
      )}
    </div>
  );
}
