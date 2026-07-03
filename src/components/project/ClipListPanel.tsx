import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteClips,
  listClips,
  updateClip,
  generateClipScript,
  getClipScripts,
  cancelClipScript,
} from "../../services/tauri";
import type { Clip, ClipScriptInfo, ProjectInfo, ScriptSource } from "../../types/project";
import { useToast } from "../../hooks/useToast";

type ClipListPanelProps = {
  project: ProjectInfo;
  /** 按剧本源过滤片段（可选，不传则显示全部） */
  sourceId?: string | null;
  /** 选中的剧本源信息 */
  source?: ScriptSource | null;
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
export function ClipListPanel({ project, sourceId, source }: ClipListPanelProps) {
  const { toast } = useToast();
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState("");
  const [operating, setOperating] = useState(false);
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[]>([]);
  const [deleteConfirmClipId, setDeleteConfirmClipId] = useState<string | null>(null);
  const editingTitleRef = useRef("");

  // 重置选中状态（切换剧本时）
  useEffect(() => {
    setExpandedId(null);
    setSelectedIds(new Set());
  }, [sourceId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [clipList, csList] = await Promise.all([
        listClips(project.id),
        getClipScripts(project.id),
      ]);
      // 按剧本源过滤
      const filtered = sourceId
        ? clipList.filter((c) => c.source_id === sourceId)
        : clipList;
      setClips(filtered);
      setClipScripts(csList);
      setDeleteConfirmClipId(null);
      setSelectedIds((prev) => {
        const next = new Set<string>();
        const ids = new Set(filtered.map((c) => c.id));
        for (const id of prev) if (ids.has(id)) next.add(id);
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, [project.id, sourceId]);

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

  const getCanDisassemble = (clip: Clip) =>
    clip.status === "pending" || clip.status === "failed";

  const deletingClip = deleteConfirmClipId
    ? clips.find((c) => c.id === deleteConfirmClipId) ?? null
    : null;

  const isSplitting =
    source?.split_status === "pending" || source?.split_status === "running";
  const isPending = source?.split_status === "pending";
  const allSelected = clips.length > 0 && selectedIds.size === clips.length;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const batchDisassembleIds = clips.filter((c) => selectedIds.has(c.id) && getCanDisassemble(c)).map((c) => c.id);

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

  /** 取消片段拆解任务 */
  const handleCancel = useCallback(async (clipId: string) => {
    setOperating(true);
    try {
      await cancelClipScript(clipId);
      toast("拆解已取消", "info");
      await load();
    } catch (err) {
      toast("取消失败，请重试", "error");
    } finally {
      setOperating(false);
    }
  }, [load, toast]);

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
      await load();
    } catch (err) {
      toast("标题保存失败，请重试", "error");
      console.error("[ClipListPanel] 标题保存失败:", err);
    } finally {
      setOperating(false);
    }
  }, [load, toast]);

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
        <button type="button" className="ghost-button btn-sm" onClick={load} disabled={operating}>
          刷新
        </button>
      </div>

      <div className="clip-list-extra">
        {isSplitting && (
          <div className="split-running-banner">
            {isPending ? (
              <span className="pending-dots">排队等待中</span>
            ) : (
              <>
                <span className="spinner" aria-hidden />
                <span>剧本拆解中</span>
              </>
            )}
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
              style={{ visibility: batchDisassembleIds.length > 0 ? "visible" : "hidden" }}
              onClick={() => handleExtract(batchDisassembleIds)}
              disabled={operating || batchDisassembleIds.length === 0}
              title="将选中片段送模型分析，生成资产与提示词"
            >
              批量拆解（{batchDisassembleIds.length}）
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
          {isSplitting ? (
            isPending ? (
              <span className="pending-dots">排队等待中</span>
            ) : (
              <>
                <span className="spinner" aria-hidden style={{ width: 16, height: 16, marginRight: 8 }} />
                剧本拆解中
              </>
            )
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
                      <span className="spinner" aria-hidden style={{ width: 10, height: 10, verticalAlign: "middle", marginRight: 4 }} />
                      拆解中
                    </span>
                  ) : (
                    <span className={`clip-status clip-status--${clip.status}`}>
                      {STATUS_LABEL[clip.status] ?? clip.status}
                    </span>
                  )}
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

      {deletingClip && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setDeleteConfirmClipId(null)}>
          <div className="modal-panel clip-delete-modal" onClick={(e) => e.stopPropagation()}>
            <p className="clip-delete-modal-text">
              确认删除 <strong>「第 {deletingClip.sort_index} 集」</strong>？
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary-button btn-sm" onClick={() => setDeleteConfirmClipId(null)} disabled={operating}>
                取消
              </button>
              <button type="button" className="danger-button btn-sm" onClick={() => confirmDeleteOne(deletingClip)} disabled={operating}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
