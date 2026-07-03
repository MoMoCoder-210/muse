import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteClips,
  updateClip,
  generateClipScript,
  cancelClipScript,
} from "../../services/tauri";
import type { Clip, ProjectInfo } from "../../types/project";
import { useToast } from "../../hooks/useToast";
import { useClipPolling } from "../../hooks/useClipPolling";
import { DeleteClipConfirm } from "./DeleteClipConfirm";

type ClipListPanelProps = {
  project: ProjectInfo;
  onCreateClip: () => void;
  /** 递增此值触发列表重新加载 */
  refreshKey: number;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  running: "拆解中",
  done: "已完成",
  failed: "失败",
  clips_ready: "片段就绪",
  asset_ready: "资产就绪",
  storyboard_ready: "分镜就绪",
  media_ready: "媒体就绪",
};

/**
 * 片段列表面板。
 *
 * @author yt @date 20260702
 */
export function ClipListPanel({ project, onCreateClip, refreshKey }: ClipListPanelProps) {
  const { toast } = useToast();
  const { clips, splitStatus, loading, load } = useClipPolling(project.id);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState("");
  const [operating, setOperating] = useState(false);
  const [deleteConfirmClipId, setDeleteConfirmClipId] = useState<string | null>(null);
  const editingTitleRef = useRef("");

  // 数据变化时清理已失效的选中项
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      const ids = new Set(clips.map((c) => c.id));
      for (const id of prev) if (ids.has(id)) next.add(id);
      return next;
    });
  }, [clips]);

  // 所有 handler 调用的统一刷新入口，刷新后关闭删除确认弹窗
  const refresh = useCallback(async () => {
    await load();
    setDeleteConfirmClipId(null);
  }, [load]);

  // 初始加载 + refreshKey 变化的重新加载
  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const getCanDisassemble = (clip: Clip) =>
    clip.status === "pending" || clip.status === "failed";

  const deletingClip = deleteConfirmClipId
    ? clips.find((c) => c.id === deleteConfirmClipId) ?? null
    : null;

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
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(clips.map((c) => c.id)));
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
      await refresh();
    } catch (err) {
      toast("删除失败，请重试", "error");
    } finally {
      setOperating(false);
    }
  }, [selectedIds, refresh, toast]);

  const handleDeleteOne = (clip: Clip) => {
    setDeleteConfirmClipId(clip.id);
  };

  const confirmDeleteOne = useCallback(async (clip: Clip) => {
    setDeleteConfirmClipId(null);
    setOperating(true);
    try {
      await deleteClips([clip.id]);
      toast("已删除片段", "success");
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(clip.id);
        return next;
      });
      await refresh();
    } catch (err) {
      toast("删除失败，请重试", "error");
    } finally {
      setOperating(false);
    }
  }, [refresh, toast]);

  const handleExtract = useCallback(async (clipIds: string[]) => {
    if (clipIds.length === 0) return;
    setOperating(true);
    try {
      for (const clipId of clipIds) {
        await generateClipScript({ clip_id: clipId });
      }
      await refresh();
    } catch (err) {
      toast("拆解请求失败，请重试", "error");
    } finally {
      setOperating(false);
    }
  }, [refresh, toast]);

  const handleCancel = useCallback(async (clipId: string) => {
    setOperating(true);
    try {
      await cancelClipScript(clipId);
      toast("已取消拆解", "info");
      await refresh();
    } catch (err) {
      toast("取消失败，请重试", "error");
    } finally {
      setOperating(false);
    }
  }, [refresh, toast]);

  const startEditTitle = useCallback((clip: Clip) => {
    setEditingTitleId(clip.id);
    setEditingTitleValue(clip.title);
    editingTitleRef.current = clip.title;
  }, []);

  const saveTitle = useCallback(async (clipId: string) => {
    const value = editingTitleRef.current.trim();
    setEditingTitleId(null);
    if (!value) return;
    setOperating(true);
    try {
      await updateClip({ clip_id: clipId, title: value });
      await refresh();
    } catch (err) {
      toast("标题保存失败，请重试", "error");
    } finally {
      setOperating(false);
    }
  }, [refresh, toast]);

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
        <button
          type="button"
          className="primary-button btn-sm"
          onClick={onCreateClip}
          disabled={operating}
        >
          新建片段
        </button>
      </div>

      <div className="clip-list-extra">
        {splitStatus && (splitStatus === "running" || splitStatus === "pending") && (
          <div className="split-running-banner">
            {splitStatus === "pending" ? (
              <span className="pending-dots">排队等待中</span>
            ) : (
              <>
                <span className="spinner" aria-hidden />
                <span>剧本拆分中</span>
              </>
            )}
          </div>
        )}
        {splitStatus === "failed" && (
          <div className="split-error-banner">
            剧本拆分失败，请重试
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
              <span>全选</span>
            </label>
            <span className="clip-selected-count">
              {selectedIds.size > 0 ? `已选 ${selectedIds.size}` : ""}
            </span>
            <button
              type="button"
              className="primary-button btn-sm"
              style={{ visibility: selectedIds.size > 0 ? "visible" : "hidden" }}
              onClick={() => handleExtract([...selectedIds])}
              disabled={operating || selectedIds.size === 0}
            >
              批量拆解（{selectedIds.size}）
            </button>
            <button
              type="button"
              className="danger-button btn-sm"
              style={{ visibility: selectedIds.size > 0 ? "visible" : "hidden" }}
              onClick={handleBatchDelete}
              disabled={operating || selectedIds.size === 0}
            >
              批量删除
            </button>
          </div>
        )}
      </div>

      {clips.length === 0 ? (
        <div className="empty-clip-list">
          {splitStatus === "running" ? (
            <><span className="spinner spinner--inline" aria-hidden />剧本拆分中，片段生成后将在此显示…</>
          ) : splitStatus === "pending" ? (
            "智能拆解排队中，片段生成后将在此显示…"
          ) : (
            "暂无片段"
          )}
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
                      onChange={(e) => { setEditingTitleValue(e.target.value); editingTitleRef.current = e.target.value; }}
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
                      <span className="spinner spinner--sm" aria-hidden />
                      拆解中
                    </span>
                  ) : clip.status !== "script_ready" ? (
                    <span className={`clip-status clip-status--${clip.status}`}>
                      {STATUS_LABEL[clip.status] ?? clip.status}
                    </span>
                  ) : null}
                  {clip.status === "running" ? (
                    <button
                      type="button"
                      className="ghost-button btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancel(clip.id);
                      }}
                      disabled={operating}
                      title="取消拆解"
                    >
                      取消
                    </button>
                  ) : getCanDisassemble(clip) ? (
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
                  ) : (
                    <button
                      type="button"
                      className="primary-button btn-sm"
                      disabled
                      title="已完成拆解"
                    >
                      已拆解
                    </button>
                  )}
                  <button
                    type="button"
                    className="project-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteOne(clip);
                    }}
                    disabled={operating}
                    aria-label="删除片段"
                    title="删除片段"
                  >
                    ✕
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

      {deletingClip && (
        <DeleteClipConfirm
          clip={deletingClip}
          onConfirm={confirmDeleteOne}
          onCancel={() => setDeleteConfirmClipId(null)}
          disabled={operating}
        />
      )}
    </div>
  );
}
