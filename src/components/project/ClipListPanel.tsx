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
import { avatarColor } from "../../utils/avatar-colors";
import { formatDeleteResult } from "../../utils/delete-result";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { OptimizePanel } from "./OptimizePanel";

type ClipListPanelProps = {
  project: ProjectInfo;
  onCreateClip: () => void;
  refreshKey: number;
};

/** 取序号数字作为头像文字 */
function avatarLabel(index: number): string {
  return String(index);
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  running: "拆解中",
  done: "已完成",
  failed: "失败",
  clips_ready: "分集就绪",
  asset_ready: "素材就绪",
  storyboard_ready: "镜头就绪",
  media_ready: "媒体就绪",
};

/**
 * 分集列表面板。
 *
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
  const [batchDeletePending, setBatchDeletePending] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [optimizeClip, setOptimizeClip] = useState<Clip | null>(null);
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
    setBatchDeletePending(false);
  }, [load]);

  // 初始加载 + refreshKey 变化的重新加载
  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const getCanDisassemble = (clip: Clip) =>
    clip.status === "pending" || clip.status === "failed";

  /** 可被选中的分集（排除已拆解完成的，它们只能删除不能重新拆解） */
  const selectableClips = clips.filter(getCanDisassemble);
  const allSelected = selectableClips.length > 0 && selectableClips.every((c) => selectedIds.has(c.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableClips.map((c) => c.id)));
    }
  };

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setDeleteFiles(false);
    setBatchDeletePending(true);
  }, [selectedIds]);

  const confirmBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setBatchDeletePending(false);
    setOperating(true);
    try {
      const result = await deleteClips([...selectedIds], deleteFiles);
      const feedback = formatDeleteResult(result);
      toast(feedback.text, feedback.kind);
      setSelectedIds(new Set());
      await refresh();
    } catch (err) {
      const feedback = formatDeleteResult(undefined, true);
      toast(feedback.text, feedback.kind);
    } finally {
      setDeleteFiles(false);
      setOperating(false);
    }
  }, [deleteFiles, selectedIds, refresh, toast]);

  const handleDeleteOne = (clip: Clip) => {
    setDeleteFiles(false);
    setDeleteConfirmClipId(clip.id);
  };

  const confirmDeleteOne = useCallback(async () => {
    const clipId = deleteConfirmClipId;
    if (!clipId) return;
    setDeleteConfirmClipId(null);
    setOperating(true);
    try {
      const result = await deleteClips([clipId], deleteFiles);
      const feedback = formatDeleteResult(result);
      toast(feedback.text, feedback.kind);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(clipId);
        return next;
      });
      await refresh();
    } catch (err) {
      const feedback = formatDeleteResult(undefined, true);
      toast(feedback.text, feedback.kind);
    } finally {
      setDeleteFiles(false);
      setOperating(false);
    }
  }, [deleteConfirmClipId, deleteFiles, refresh, toast]);

  const handleExtract = useCallback(async (clipIds: string[]) => {
    // 过滤掉已拆解的分集（仅拆解 pending/failed 状态的分集）
    const validIds = clipIds.filter((id) => {
      const clip = clips.find((c) => c.id === id);
      return clip && getCanDisassemble(clip);
    });
    if (validIds.length === 0) return;
    setOperating(true);
    try {
      for (const clipId of validIds) {
        await generateClipScript({ clip_id: clipId });
      }
      await refresh();
    } catch (err) {
      toast("拆解请求失败，请重试", "error");
    } finally {
      setOperating(false);
    }
  }, [clips, refresh, toast]);

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

  const deletingClip = deleteConfirmClipId
    ? clips.find((c) => c.id === deleteConfirmClipId) ?? null
    : null;

  return (
    <>
    <div className="clip-list-panel">
      <div className="panel-header">
        <h3>分集列表</h3>
        <button
          type="button"
          className="clip-panel-create-btn"
          onClick={onCreateClip}
          disabled={operating}
        >
          + 新建分集
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
              className={`clip-toolbar-btn clip-toolbar-btn--primary${selectedIds.size > 0 ? "" : " clip-toolbar-btn--hidden"}`}
              onClick={() => handleExtract([...selectedIds])}
              disabled={operating || selectedIds.size === 0}
            >
              批量拆解（{selectedIds.size}）
            </button>
            <button
              type="button"
              className={`clip-toolbar-btn clip-toolbar-btn--danger${selectedIds.size > 0 ? "" : " clip-toolbar-btn--hidden"}`}
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
            <><span className="spinner spinner--inline" aria-hidden />剧本拆分中，分集生成后将在此显示…</>
          ) : splitStatus === "pending" ? (
            "智能拆解排队中，分集生成后将在此显示…"
          ) : (
            "暂无分集"
          )}
        </div>
      ) : (
        <div className="clip-list">
          {clips.map((clip) => {
            const isSelected = selectedIds.has(clip.id);
            const isExpanded = expandedId === clip.id;
            const isEditingTitle = editingTitleId === clip.id;
            const canDisassemble = getCanDisassemble(clip);
            const colors = avatarColor(clip.sort_index);

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
                    onChange={() => canDisassemble && toggleSelect(clip.id)}
                    disabled={operating || !canDisassemble}
                    onClick={(e) => e.stopPropagation()}
                    title={canDisassemble ? undefined : "已拆解的分集不可重新拆解"}
                  />

                  {/* 左侧序号头像 */}
                  <div
                    className="clip-index-avatar"
                    style={{ background: colors.bg, color: colors.text }}
                  >
                    {avatarLabel(clip.sort_index)}
                  </div>

                  {/* 中间信息区 */}
                  <div className="clip-item-info">
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
                      <div className="clip-title-row">
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
                          aria-label="编辑标题"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                            <path
                              d="M11.5 1.5L14.5 4.5L5 14H2V11L11.5 1.5Z"
                              stroke="currentColor"
                              strokeWidth="1.3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      </div>
                    )}
                    <span className="clip-wordcount">{clip.source_text.length} 字</span>
                  </div>

                  {/* 状态标签 */}
                  {clip.status === "running" ? (
                    <span className="clip-status clip-status--running">
                      <span className="spinner spinner--sm" aria-hidden />
                      拆解中
                    </span>
                  ) : clip.status !== "script_ready" && clip.status !== "pending" ? (
                    <span className={`clip-status clip-status--${clip.status}`}>
                      {STATUS_LABEL[clip.status] ?? clip.status}
                    </span>
                  ) : null}

                  {/* 操作按钮 — macOS 胶囊风格 */}
                  {clip.status === "running" ? (
                    <button
                      type="button"
                      className="clip-action-btn clip-action-btn--ghost"
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
                      className="clip-action-btn clip-action-btn--primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExtract([clip.id]);
                      }}
                      disabled={operating}
                      title="送模型分析，生成素材与提示词"
                    >
                      拆解
                    </button>
                  ) : (
                    <span className="clip-action-btn clip-action-btn--disabled">
                      已拆解
                    </span>
                  )}

                  {/* 优化按钮 — 仅未拆解分集可用 */}
                  {getCanDisassemble(clip) && (
                    <button
                      type="button"
                      className="clip-action-btn clip-action-btn--ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOptimizeClip(clip);
                      }}
                      disabled={operating}
                      title="AI 优化剧本"
                    >
                      ✨ 优化
                    </button>
                  )}

                  {/* 删除按钮 */}
                  <button
                    type="button"
                    className="clip-item__delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteOne(clip);
                    }}
                    disabled={operating}
                    aria-label="删除分集"
                    title="删除分集"
                  >
                    <svg width="12" height="13" viewBox="0 0 12 13" fill="none">
                      <path
                        d="M1.5 3.5H10.5M4.5 3V2C4.5 1.45 4.95 1 5.5 1H6.5C7.05 1 7.5 1.45 7.5 2V3M9.5 3V11C9.5 11.55 9.05 12 8.5 12H3.5C2.95 12 2.5 11.55 2.5 11V3H9.5Z"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>

                  {/* 展开箭头 */}
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

      {/* 单个删除确认弹窗 — 复用作品列表的 DeleteConfirmModal 样式 */}
      {deletingClip && (
        <DeleteConfirmModal
          title="删除分集"
          description={<>确认删除 <strong>第 {deletingClip.sort_index} 集</strong> ？</>}
          checkbox={{
            label: "同时删除磁盘文件",
            checked: deleteFiles,
            onChange: setDeleteFiles,
          }}
          confirmText={operating ? "删除中…" : "删除"}
          onConfirm={confirmDeleteOne}
          onCancel={() => { setDeleteFiles(false); setDeleteConfirmClipId(null); }}
          disabled={operating}
        />
      )}

      {batchDeletePending && (
        <DeleteConfirmModal
          title="批量删除分集"
          description={<>确认删除 <strong>{selectedIds.size} 个分集</strong> ？</>}
          checkbox={{
            label: "同时删除磁盘文件",
            checked: deleteFiles,
            onChange: setDeleteFiles,
          }}
          confirmText={operating ? "删除中…" : "删除"}
          onConfirm={confirmBatchDelete}
          onCancel={() => { setDeleteFiles(false); setBatchDeletePending(false); }}
          disabled={operating}
        />
      )}

      {/* 剧本优化面板 */}
      {optimizeClip && (
        <OptimizePanel
          projectId={project.id}
          clipId={optimizeClip.id}
          sourceText={optimizeClip.source_text}
          clipTitle={optimizeClip.title}
          onClose={() => setOptimizeClip(null)}
          onChange={refresh}
        />
      )}
    </>
  );
}
