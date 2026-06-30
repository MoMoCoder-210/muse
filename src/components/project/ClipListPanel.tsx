import { useCallback, useEffect, useState } from "react";
import { listClips, getScriptSource } from "../../services/tauri";
import type { Clip, ProjectInfo, ScriptSource } from "../../types/project";

type ClipListPanelProps = {
  project: ProjectInfo;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  script_ready: "剧本就绪",
  asset_ready: "资产就绪",
  storyboard_ready: "分镜就绪",
  media_ready: "媒体就绪",
  done: "已完成",
  failed: "失败",
};

const SPLIT_STATUS_LABEL: Record<string, string> = {
  pending: "等待拆分",
  running: "拆分中…",
  success: "拆分完成",
  failed: "拆分失败",
};

export function ClipListPanel({ project }: ClipListPanelProps) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [source, setSource] = useState<ScriptSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [clipList, src] = await Promise.all([
        listClips(project.id),
        getScriptSource(project.id),
      ]);
      setClips(clipList);
      setSource(src);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    load();
  }, [load]);

  // 拆分中时轮询
  useEffect(() => {
    if (source?.split_status !== "running") return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [source?.split_status, load]);

  if (loading && clips.length === 0) {
    return (
      <div className="clip-list-panel">
        <div className="panel-loading">加载中…</div>
      </div>
    );
  }

  return (
    <div className="clip-list-panel">
      <div className="panel-header">
        <h3>片段列表</h3>
        {source && (
          <span className={`split-status split-status--${source.split_status}`}>
            {SPLIT_STATUS_LABEL[source.split_status] ?? source.split_status}
          </span>
        )}
        <button type="button" className="ghost-button btn-sm" onClick={load}>
          刷新
        </button>
      </div>

      {source?.split_status === "failed" && (
        <div className="split-error-banner">
          拆分失败：{source.error_message ?? "未知错误"}。该剧本没有识别到集数标志，模型拆分功能即将上线。
        </div>
      )}

      {clips.length === 0 ? (
        <div className="empty-clip-list">
          {source?.split_status === "running"
            ? "正在拆分片段，请稍候…"
            : "暂无片段，导入剧本后自动生成。"}
        </div>
      ) : (
        <div className="clip-list">
          {clips.map((clip) => (
            <div key={clip.id} className="clip-item">
              <div
                className="clip-item-header"
                onClick={() => setExpandedId(expandedId === clip.id ? null : clip.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && setExpandedId(expandedId === clip.id ? null : clip.id)}
              >
                <span className="clip-index">第 {clip.sort_index} 集</span>
                <span className="clip-title">{clip.title || "（无标题）"}</span>
                <span className="clip-wordcount">
                  {clip.source_text.length} 字
                </span>
                <span className={`clip-status clip-status--${clip.status}`}>
                  {STATUS_LABEL[clip.status] ?? clip.status}
                </span>
                <span className="clip-expand-icon">
                  {expandedId === clip.id ? "▲" : "▼"}
                </span>
              </div>
              {expandedId === clip.id && (
                <div className="clip-item-body">
                  {clip.summary && <p className="clip-summary">{clip.summary}</p>}
                  <pre className="clip-text">{clip.source_text}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
