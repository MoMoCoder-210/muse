import { useCallback, useEffect, useState } from "react";
import {
  deleteClips,
  listClips,
  getScriptSource,
  updateClip,
  generateClipScript,
  getClipScripts,
} from "../../services/tauri";
import type { Clip, ClipScriptInfo, ProjectInfo, ScriptSource } from "../../types/project";
import { useToast } from "../../hooks/useToast";

type ClipListPanelProps = {
  project: ProjectInfo;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  running: "拆解中",
  script_ready: "剧本就绪",
  asset_ready: "资产就绪",
  storyboard_ready: "分镜就绪",
  media_ready: "媒体就绪",
  done: "已完成",
  failed: "失败",
};

const SPLIT_STATUS_LABEL: Record<string, string> = {
  pending: "等待拆解",
  running: "拆解中…",
  success: "拆解完成",
  failed: "拆解失败",
};

/**
 * 片段列表面板（剧本管理阶段）。
 *
 * 功能：
 *   - 剧本拆解状态实时展示（3s 轮询）
 *   - 单选/多选/全选，可批量删除、批量拆解
 *   - 列表项含删除、拆解按钮
 *   - 片段标题可点击编辑（回车/失焦保存，Esc 取消）
 *
 * @author yt @date 20260702
 */
export function ClipListPanel({ project }: ClipListPanelProps) {
  const { toast } = useToast();
  const [clips, setClips] = useState<Clip[]>([]);
  const [source, setSource] = useState<ScriptSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState("");
  const [operating, setOperating] = useState(false);
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [clipList, src, csList] = await Promise.all([
        listClips(project.id),
        getScriptSource(project.id),
        getClipScripts(project.id),
      ]);
      setClips(clipList);
      setSource(src);
      setClipScripts(csList);
      // 清理已不存在的选中项（删除后可能残留）
      setSelectedIds((prev) => {
        const next = new Set<string>();
        const ids = new Set(clipList.map((c) => c.id));
        for (const id of prev) if (ids.has(id)) next.add(id);
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    load();
  }, [load]);

  // 拆解排队/执行中时轮询
  useEffect(() => {
    const hasRunning = source?.split_status === "pending" || source?.split_status === "running"
      || clipScripts.some((cs) => cs.status === "pending" || cs.status === "running");
    if (!hasRunning) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [source?.split_status, clipScripts, load]);

  const isSplitting =
    source?.split_status === "pending" || source?.split_status === "running";
  const allSelected = clips.length > 0 && selectedIds.size === clips.length;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (prev.size === clips.length) return new Set();
      return new Set(clips.map((c) => c.id));
    });
  };

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`确认删除选中的 ${selectedIds.size} 个片段？`)) return;
    setOperating(true);
    try {
      const count = selectedIds.size;
      await deleteClips([...selectedIds]);
      toast(`已删除 ${count} 个片段`, "success");
      setSelectedIds(new Set());
      await load();
    } catch (err) {
      toast("删除失败，请重试", "error");
      console.error("[ClipListPanel] 删除失败:", err);
    } finally {
      setOperating(false);
    }
  }, [selectedIds, load, toast]);

  const handleDeleteOne = useCallback(async (clip: Clip) => {
    if (!window.confirm(`确认删除「第 ${clip.sort_index} 集」？`)) return;
    setOperating(true);
    try {
      await deleteClips([clip.id]);
      toast("已删除片段", "success");
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(clip.id);
        return next;
      });
      await load();
    } catch (err) {
      toast("删除失败，请重试", "error");
      console.error("[ClipListPanel] 删除失败:", err);
    } finally {
      setOperating(false);
    }
  }, [load, toast]);

  /** 触发片段拆解（送模型分析，生成分镜/角色/场景/物品提示词） */
  const handleExtract = useCallback(async (clipIds: string[]) => {
    if (clipIds.length === 0) return;
    setOperating(true);
    try {
      for (const clipId of clipIds) {
        await generateClipScript({ clip_id: clipId });
      }
      toast(`已提交 ${clipIds.length} 个片段拆解任务`, "success");
      await load();
    } catch (err) {
      toast("拆解提交失败，请重试", "error");
      console.error("[ClipListPanel] 拆解提交失败:", err);
    } finally {
      setOperating(false);
    }
  }, [load, toast]);

  const startEditTitle = (clip: Clip) => {
    setEditingTitleId(clip.id);
    setEditingTitleValue(clip.title);
  };

  const saveTitle = useCallback(async (clipId: string) => {
    const value = editingTitleValue.trim();
    setEditingTitleId(null);
    if (!value) return;
    setOperating(true);
    try {
      await updateClip({ clip_id: clipId, title: value });
      await load();
    } catch (err) {
      toast("标题保存失败，请重试", "error");
      console.error("[ClipListPanel] 标题保存失败:", err);
    } finally {
      setOperating(false);
    }
  }, [editingTitleValue, load, toast]);

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
        <button type="button" className="ghost-button btn-sm" onClick={load} disabled={operating}>
          刷新
        </button>
      </div>

      <div className="clip-list-extra">
        {isSplitting && (
          <div className="split-running-banner">
            <span className="spinner" aria-hidden />
            <span>
              {source?.split_status === "pending"
                ? "剧本拆解已排队，等待执行…"
                : "剧本拆解中，请稍候…"}
            </span>
          </div>
        )}
        {source?.split_status === "failed" && (
          <div className="split-error-banner">
            拆解失败：{source.error_message ?? "未知错误"}
          </div>
        )}
        {clips.length > 0 && (
          <div className="clip-list-toolbar">
            <label className="clip-select-all">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                disabled={operating}
              />
              全选
            </label>
            <span className="clip-selected-count">
              已选 {selectedIds.size}/{clips.length}
            </span>
            <button
              type="button"
              className="primary-button btn-sm"
              style={{ visibility: selectedIds.size > 0 ? "visible" : "hidden" }}
              onClick={() => handleExtract([...selectedIds])}
              disabled={operating || selectedIds.size === 0}
              title="将选中片段送模型分析，生成资产与提示词"
            >
              批量拆解（{selectedIds.size}）
            </button>
            <button
              type="button"
              className="ghost-button btn-sm"
              style={{ visibility: selectedIds.size > 0 ? "visible" : "hidden" }}
              onClick={handleBatchDelete}
              disabled={operating || selectedIds.size === 0}
            >
              批量删除（{selectedIds.size}）
            </button>
          </div>
        )}
      </div>

      {clips.length === 0 ? (
        <div className="empty-clip-list">
          {isSplitting
            ? "剧本拆解中，片段生成后将在此显示…"
            : "暂无片段，导入剧本后自动生成。"}
        </div>
      ) : (
        <div className="clip-list">
          {clips.map((clip) => {
            const isSelected = selectedIds.has(clip.id);
            const isExpanded = expandedId === clip.id;
            const isEditingTitle = editingTitleId === clip.id;
            return (
              <div
                key={clip.id}
                className={`clip-item ${isSelected ? "clip-item--selected" : ""}`}
              >
                <div
                  className="clip-item-header"
                  onClick={() => setExpandedId(isExpanded ? null : clip.id)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(clip.id)}
                    disabled={operating}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className="clip-index">第 {clip.sort_index} 集</span>
                  {isEditingTitle ? (
                    <input
                      className="clip-title-input"
                      value={editingTitleValue}
                      onChange={(e) => setEditingTitleValue(e.target.value)}
                      onBlur={() => saveTitle(clip.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveTitle(clip.id);
                        else if (e.key === "Escape") setEditingTitleId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="clip-title">
                        {clip.title || "（无标题）"}
                      </span>
                      <button
                        type="button"
                        className="clip-edit-title-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditTitle(clip);
                        }}
                        title="编辑标题"
                      >
                        ✏️
                      </button>
                    </>
                  )}
                  <span className="clip-wordcount">{clip.source_text.length} 字</span>
                  {clip.status === "running" ? (
                    <span className="clip-status clip-status--running">
                      <span className="spinner" aria-hidden style={{ width: 10, height: 10, verticalAlign: "middle", marginRight: 4 }} />
                      拆解中
                    </span>
                  ) : (
                    <span className={`clip-status clip-status--${clip.status}`}>
                      {STATUS_LABEL[clip.status] ?? clip.status}
                    </span>
                  )}
                  <button
                    type="button"
                    className="primary-button btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExtract([clip.id]);
                    }}
                    disabled={operating}
                    title="送模型分析，生成资产与提示词"
                  >
                    拆解
                  </button>
                  <button
                    type="button"
                    className="ghost-button btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteOne(clip);
                    }}
                    disabled={operating}
                  >
                    删除
                  </button>
                  <span className="clip-expand-icon" aria-hidden>
                    {isExpanded ? "▲" : "▼"}
                  </span>
                </div>
                {isExpanded && (
                  <div className="clip-item-body">
                    {clip.summary && <p className="clip-summary">{clip.summary}</p>}
                    <pre className="clip-text">{clip.source_text}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
