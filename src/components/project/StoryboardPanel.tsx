import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ProjectInfo, Clip, Storyboard, StoryboardAssetInfo, AssetType, PromptDoc,
} from "../../types/project";
import {
  listClips, listStoryboards, listClipAssets,
  updateStoryboardAssets, createStoryboard, deleteStoryboard, insertStoryboard,
  updateStoryboardParams, updateStoryboardDuration, getSettings,
  generateStoryboardVideo,
  selectStoryboardVideo, listStoryboardVideos,
  listStoryboardVideoTasks, deleteStoryboardVideoTask, deleteStoryboardVideo,
  importVideoFile, addStoryboardVideo,
} from "../../services/tauri";
import type { StoryboardVideoInfo } from "../../services/tauri";
import type { MentionAnchor } from "../../types/mention";
import { getActiveChannel } from "../../types/settings";
import { useToast } from "../../hooks/useToast";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { StoryboardConfirm } from "./StoryboardConfirm";
import { MentionDropdown } from "./MentionDropdown";
import type { AssetMention } from "./MentionDropdown";
import { PromptEditor } from "./PromptEditor";
import type { PromptEditorHandle, PromptEditorChange } from "./PromptEditor";
import {
  annotatePrompt, createAssetTag, plainTextToPromptDoc,
  promptDocToPlainText, type PromptMention,
} from "../../utils/promptDocument";
import {
  VIDEO_DURATION_MIN, VIDEO_DURATION_MAX, VIDEO_ASPECT_OPTIONS,
  VIDEO_RESOLUTION_OPTIONS,
} from "../../config/muse";
import { isClipDecomposed } from "../../utils/clip";
import { avatarColor } from "../../utils/avatar-colors";
import { formatDeleteResult } from "../../utils/delete-result";
import { ImageLightbox } from "../common/ImageLightbox";
import { pickVideoFile } from "../../services/dialog";
import { ParamSelect } from "./ParamSelect";
import {
  CATS, EMPTY_VIDEO_TASKS,
  type ClipData, type VideoTaskState,
  type VideoTaskTerminalEvent, type DisplayStoryboardVideo, type DetailProps, type VideoParams,
} from "./storyboard-types";
import {
  parseIds, formatStoryboardVideoFailure, normalizePromptReferences,
  parseVideoParams, getResolutions, clampDuration,
} from "./storyboard-helpers";

/* ========================================================================
   StoryboardPanel — 分镜管理（含视频生成）

   上方：选中分镜的视频 + 提示词 + 资产
   下方：分镜缩略图条，点击切换
   ======================================================================== */

type Props = { project: ProjectInfo };

export function StoryboardPanel({ project }: Props) {
  const { toast } = useToast();
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  // 用户在设置里为「视频」激活渠道配置的模型 → 其支持的分辨率；未配置则为空对象
  const [videoModels, setVideoModels] = useState<Record<string, string[]>>({});

  const [videosMap, setVideosMap] = useState<Record<string, StoryboardVideoInfo[]>>({});
  const [dataMap, setDataMap] = useState<Record<string, ClipData>>({});
  const dataMapRef = useRef(dataMap); dataMapRef.current = dataMap;

  // 同时恢复已完成视频和未成功落库的任务批次。任务表是 pending/running/failed
  // 卡片的唯一来源，因此页面重新挂载时不会把默认 video_state 误认为“生成中”。
  const loadAllVideos = useCallback(async (sbs: Storyboard[]) => {
    const videos: Record<string, StoryboardVideoInfo[]> = {};
    const tasks: Record<string, VideoTaskState[]> = {};
    await Promise.all(sbs.map(async (sb) => {
      try { videos[sb.id] = await listStoryboardVideos(sb.id); }
      catch { videos[sb.id] = []; }
      try {
        tasks[sb.id] = (await listStoryboardVideoTasks(sb.id)).map((task) => ({
          taskId: task.task_id,
          status: task.status,
        }));
      } catch { tasks[sb.id] = []; }
    }));
    setVideosMap((prev) => ({ ...prev, ...videos }));
    setVideoTaskStates((prev) => {
      const next = { ...prev };
      for (const sb of sbs) {
        if (tasks[sb.id].length > 0) next[sb.id] = tasks[sb.id];
        else delete next[sb.id];
      }
      return next;
    });
  }, []);
  // ── 左侧片段栏：手动展开/收起 ──
  const [railCollapsed, setRailCollapsed] = useState(false);
  const toggleRail = useCallback(() => setRailCollapsed((v) => !v), []);

  const [clipId, setClipId] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Storyboard | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [videoTaskStates, setVideoTaskStates] = useState<Record<string, VideoTaskState[]>>({});
  // Worker 的终态事件可能早于 generateStoryboardVideo() 返回 taskId；暂存后在入队回调中协调。
  const terminalVideoTaskEventsRef = useRef(new Map<string, VideoTaskTerminalEvent>());
  const videoTaskStatesRef = useRef(videoTaskStates);
  videoTaskStatesRef.current = videoTaskStates;
  // 新增分镜：undefined=不弹窗, "__end__"=末尾添加, null=最前插入, string=在某分镜后插入
  const [insertAfterId, setInsertAfterId] = useState<string | null | undefined>(undefined);
  // 缩略图条悬停插入位：number=在第i个分镜后插入, "__first__"=在最前插入
  const [hoverGap, setHoverGap] = useState<string | null>(null);

  // ── 数据 ────────────────────────────────────────

  const loadAll = useCallback(async () => {
    if (!project) return; setLoading(true);
    try {
      const c = await listClips(project.id);
      setClips(c);
      // 进入该步骤时自动选中第一个已拆解片段（无符合片段则不选择）
      const dec = c.filter((x) => isClipDecomposed(x.status));
      setClipId((prev) => (prev && dec.some((x) => x.id === prev) ? prev : (dec[0]?.id ?? null)));
    }
    catch { toast("加载失败", "error"); } finally { setLoading(false); }
  }, [project?.id]);
  useEffect(() => { loadAll(); }, [loadAll]);

  // 监听拆解完成事件，实时刷新片段列表
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("clip-script-ready", (e: { payload: { project_id: string } }) => {
      if (e.payload.project_id === project?.id) loadAll();
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [project?.id, loadAll]);

  // 读取设置里「视频」激活渠道配置的模型 → 支持分辨率映射，供模型 / 分辨率下拉使用
  useEffect(() => {
    getSettings()
      .then((s) => {
        const map: Record<string, string[]> = {};
        for (const m of getActiveChannel(s.video)?.models ?? []) {
          const id = m.modelId.trim();
          if (!id) continue;
          // 用户未勾选任何分辨率时，回退为全部分辨率
          map[id] = m.resolutions && m.resolutions.length ? m.resolutions : [...VIDEO_RESOLUTION_OPTIONS];
        }
        setVideoModels(map);
      })
      .catch(() => setVideoModels({}));
  }, []);

  const filtered = useMemo(() => clips.filter((c) => isClipDecomposed(c.status)), [clips]);
  useEffect(() => { if (clipId && !filtered.find((c) => c.id === clipId)) setClipId(null); }, [filtered, clipId]);
  const clip = filtered.find((c) => c.id === clipId) ?? null;

  const loadSb = useCallback(async (cid: string) => {
    if (dataMapRef.current[cid]?.loaded) return;
    try {
      const [sb, as] = await Promise.all([listStoryboards(cid), listClipAssets(cid)]);
      await loadAllVideos(sb);
      setDataMap((p) => ({ ...p, [cid]: { storyboards: sb, assets: as, loaded: true } }));
    }
    catch { toast("加载分镜失败", "error"); }
  }, [toast, loadAllVideos]);
  useEffect(() => { if (clip) loadSb(clip.id); }, [clip?.id, loadSb]);

  // 切片段时重置选中索引
  useEffect(() => { setActiveIdx(0); }, [clipId]);

  const data = clip ? dataMap[clip.id] : null;
  const sbList = data?.storyboards ?? [];
  const assets = data?.assets ?? [];

  // 确保 activeIdx 不越界
  const safeIdx = Math.min(activeIdx, Math.max(sbList.length - 1, 0));
  const activeSb = sbList[safeIdx] ?? null;

  // 片段中已有绑定视频时，锁定分辨率+宽高比，避免拼接时比例不一致
  const lockedRatio = useMemo(() => {
    const bound = sbList
      .filter((s) => s.selected_video_id != null)
      .sort((a, b) => a.seq_num - b.seq_num);
    for (const s of bound) {
      if (!s.video_param_json) continue;
      try {
        const obj = JSON.parse(s.video_param_json);
        if (obj.resolution && obj.aspect_ratio) {
          return { resolution: obj.resolution as string, aspect_ratio: obj.aspect_ratio as string };
        }
      } catch { /* skip */ }
    }
    return null;
  }, [sbList]);

  // ── 资产关联 ────────────────────────────────────

  const toggleLink = useCallback(async (sb: Storyboard, a: StoryboardAssetInfo) => {
    const cIds = parseIds(sb.character_ids_json), sIds = parseIds(sb.scene_ids_json), iIds = parseIds(sb.item_ids_json);
    const ids = a.type === "character" ? cIds : a.type === "scene" ? sIds : iIds;
    ids.has(a.asset_id) ? ids.delete(a.asset_id) : ids.add(a.asset_id);
    setSaving(sb.id);
    try {
      await updateStoryboardAssets({ storyboard_id: sb.id, character_ids: [...cIds], scene_ids: [...sIds], item_ids: [...iIds] });
      setDataMap((p) => { const d = p[sb.clip_id]; if (!d) return p; return { ...p, [sb.clip_id]: { ...d, storyboards: d.storyboards.map((s) => s.id === sb.id ? { ...s, character_ids_json: JSON.stringify([...cIds]), scene_ids_json: JSON.stringify([...sIds]), item_ids_json: JSON.stringify([...iIds]) } : s) } }; });
    } catch { toast("更新失败", "error"); } finally { setSaving(null); }
  }, [toast]);

  // 批量绑定资产（一次调用 API，避免逐个覆盖）
  const batchToggleLink = useCallback(async (sb: Storyboard, ids: { character: Set<string>; scene: Set<string>; item: Set<string> }) => {
    const cArr = [...ids.character], sArr = [...ids.scene], iArr = [...ids.item];
    setSaving(sb.id);
    try {
      await updateStoryboardAssets({ storyboard_id: sb.id, character_ids: cArr, scene_ids: sArr, item_ids: iArr });
      setDataMap((p) => { const d = p[sb.clip_id]; if (!d) return p; return { ...p, [sb.clip_id]: { ...d, storyboards: d.storyboards.map((s) => s.id === sb.id ? { ...s, character_ids_json: JSON.stringify(cArr), scene_ids_json: JSON.stringify(sArr), item_ids_json: JSON.stringify(iArr) } : s) } }; });
    } catch { toast("批量关联失败", "error"); } finally { setSaving(null); }
  }, [toast]);

  // 实时更新分镜时长（秒），写回分镜记录本身；同步更新本地数据使缩略图条即时刷新
  const updateSbDuration = useCallback(async (sb: Storyboard, duration: number | null) => {
    try {
      await updateStoryboardDuration({ storyboard_id: sb.id, duration });
      setDataMap((p) => {
        const d = p[sb.clip_id]; if (!d) return p;
        return { ...p, [sb.clip_id]: { ...d, storyboards: d.storyboards.map((s) => s.id === sb.id ? { ...s, video_duration: duration } : s) } };
      });
    } catch { toast("更新时长失败", "error"); }
  }, [toast]);

  // 视频变更（上传/选中/删除/生成终态）后同步 dataMap、videosMap 与任务批次状态。
  const refreshVideoState = useCallback(async (sbId: string, targetClipId: string | null = clipId) => {
    if (!targetClipId) return;
    try {
      const [vids, sbs, tasks] = await Promise.all([
        listStoryboardVideos(sbId).catch(() => [] as StoryboardVideoInfo[]),
        listStoryboards(targetClipId).catch(() => [] as Storyboard[]),
        listStoryboardVideoTasks(sbId).catch(() => []),
      ]);
      setVideosMap((prev) => ({ ...prev, [sbId]: vids }));
      setVideoTaskStates((prev) => {
        const next = { ...prev };
        const taskStates = tasks.map((task) => ({ taskId: task.task_id, status: task.status }));
        if (taskStates.length > 0) next[sbId] = taskStates;
        else delete next[sbId];
        return next;
      });
      setDataMap((prev) => {
        const d = prev[targetClipId];
        if (!d) return prev;
        return { ...prev, [targetClipId]: { ...d, storyboards: sbs } };
      });
    } catch { /* 静默 */ }
  }, [clipId]);

  const handleVideoTaskQueued = useCallback((storyboardId: string, taskId: string) => {
    const terminal = terminalVideoTaskEventsRef.current.get(taskId);
    if (terminal) terminalVideoTaskEventsRef.current.delete(taskId);
    setVideoTaskStates((prev) => {
      const tasks = prev[storyboardId] ?? [];
      if (tasks.some((task) => task.taskId === taskId) || terminal?.status === "success") return prev;
      return {
        ...prev,
        [storyboardId]: [...tasks, {
          taskId,
          status: terminal?.status === "failed" ? "failed" as const : "pending" as const,
        }],
      };
    });
    void refreshVideoState(storyboardId);
  }, [refreshVideoState]);

  // 终态事件只在此处监听一次：避免 DetailView 重挂载或 Strict Mode 产生重复失败提示。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<VideoTaskTerminalEvent>("storyboard-video-ready", ({ payload }) => {
      // Worker 在 Tauri 调用返回前就完成时，先缓存终态；handleVideoTaskQueued() 收到
      // taskId 后会立即结算，避免该批次随后被错误地渲染为 pending。
      const knownTask = (videoTaskStatesRef.current[payload.storyboard_id] ?? [])
        .some((task) => task.taskId === payload.task_id);
      if (!knownTask) terminalVideoTaskEventsRef.current.set(payload.task_id, payload);

      void refreshVideoState(payload.storyboard_id, payload.clip_id);
      setVideoTaskStates((prev) => {
        const tasks = prev[payload.storyboard_id] ?? [];
        if (!tasks.some((task) => task.taskId === payload.task_id)) return prev;

        const nextTasks: VideoTaskState[] = payload.status === "success"
          ? tasks.filter((task) => task.taskId !== payload.task_id)
          : tasks.map((task) => task.taskId === payload.task_id ? { ...task, status: "failed" } : task);
        const next = { ...prev };
        if (nextTasks.length > 0) next[payload.storyboard_id] = nextTasks;
        else delete next[payload.storyboard_id];
        return next;
      });
      if (payload.status === "failed") {
        toast(formatStoryboardVideoFailure(), "error");
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshVideoState, toast]);

  // ── 新增/插入/删除分镜 ────────────────────────

  const addSb = useCallback(async () => {
    if (!clip) return; setSaving("__new__");
    try {
      await createStoryboard({ clip_id: clip.id, project_id: project.id });
      setDataMap((p) => ({ ...p, [clip.id]: { ...p[clip.id], loaded: false } }));
      // 手动同步 ref，确保 loadSb 能进入加载逻辑
      dataMapRef.current = { ...dataMapRef.current, [clip.id]: { ...dataMapRef.current[clip.id], loaded: false } };
      await loadSb(clip.id);
    }
    catch { toast("添加失败", "error"); } finally { setSaving(null); }
  }, [clip, project.id, toast, loadSb]);

  const insertSb = useCallback(async (afterId: string | null) => {
    if (!clip) return; setSaving("__new__");
    try {
      await insertStoryboard({ clip_id: clip.id, project_id: project.id, after_storyboard_id: afterId });
      setDataMap((p) => ({ ...p, [clip.id]: { ...p[clip.id], loaded: false } }));
      // 手动同步 ref，确保 loadSb 能进入加载逻辑
      dataMapRef.current = { ...dataMapRef.current, [clip.id]: { ...dataMapRef.current[clip.id], loaded: false } };
      await loadSb(clip.id);
    }
    catch { toast("插入失败", "error"); } finally { setSaving(null); }
  }, [clip, project.id, toast, loadSb]);

  const delSb = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const shouldDeleteFiles = deleteFiles;
    setSaving(target.id);
    setDeleteTarget(null);
    setDeleteFiles(false);
    try {
      const result = await deleteStoryboard({
        storyboard_id: target.id,
        delete_files: shouldDeleteFiles,
      });
      // 删除后重新加载，确保 seq_num 与数据库一致
      setDataMap((p) => ({ ...p, [target.clip_id]: { ...p[target.clip_id], loaded: false } }));
      dataMapRef.current = { ...dataMapRef.current, [target.clip_id]: { ...dataMapRef.current[target.clip_id], loaded: false } };
      await loadSb(target.clip_id);
      const feedback = formatDeleteResult(result);
      toast(feedback.text, feedback.kind);
    }
    catch {
      const feedback = formatDeleteResult(undefined, true);
      toast(feedback.text, feedback.kind);
    } finally { setSaving(null); }
  }, [deleteTarget, deleteFiles, toast, loadSb]);

  const busy = saving !== null;

  return (
    <div className="rail-layout">
      {/* ── 左侧轨道（手动展开/收起） ── */}
      <div className={`rail-clips${railCollapsed ? " is-collapsed" : " is-expanded"}`}>
        <div className="rail-clips-inner">
          <div className="rail-clips-head">
            <span className="rail-clips-head-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg></span>
            <span className="rail-clips-head-text">片段列表</span>
          </div>
          {loading ? <p className="rail-clips-empty">加载中…</p> : filtered.length === 0 ? <p className="rail-clips-empty">暂无片段</p> : (
            <div className="rail-clips-list">
              {filtered.map((c) => {
                const colors = avatarColor(c.sort_index);
                return (
                  <button key={c.id} className={`rail-clips-item${c.id === clipId ? " on" : ""}`} onClick={() => setClipId(c.id)} title={c.title}>
                    <span className="rail-clips-item-num" style={{ background: colors.bg, color: colors.text }}>{c.sort_index}</span>
                    <span className="rail-clips-item-text"><span className="rail-clips-item-title">{c.title}</span></span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          className="rail-clips-toggle"
          onClick={toggleRail}
          title={railCollapsed ? "展开片段列表" : "收起片段列表"}
          aria-label={railCollapsed ? "展开片段列表" : "收起片段列表"}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {railCollapsed ? (
              <path d="M6 4L10 8L6 12" />
            ) : (
              <path d="M10 4L6 8L10 12" />
            )}
          </svg>
        </button>
      </div>

      {/* ── 主内容 ── */}
      <div className="rail-main">
        <div className="sb-scroll">
          {!clip ? (
            <div className="sb-empty"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg><p>从左侧选择片段</p></div>
          ) : !data?.loaded ? (
            <div className="sb-empty"><p>加载中…</p></div>
          ) : sbList.length === 0 ? (
            <div className="sb-empty"><p>暂无分镜</p></div>
          ) : (
            <div className="sb-view">
              {/* ========== 上方：选中分镜详情 ========== */}
              {activeSb && (
                <DetailView
                  key={activeSb.id}
                  sb={activeSb}
                  assets={assets}
                  busy={busy}
                  saving={saving === activeSb.id}
                  videoModels={videoModels}
                  onToggle={(a) => toggleLink(activeSb, a)}
                  onBatchToggle={batchToggleLink}
                  onDurationWrite={updateSbDuration}
                  onVideoRefresh={refreshVideoState}
                  videoTaskStates={videoTaskStates[activeSb.id] ?? EMPTY_VIDEO_TASKS}
                  onVideoTaskQueued={handleVideoTaskQueued}
                  lockedRatio={lockedRatio}
                />
              )}

              {/* ========== 第四行：分镜缩略列表 ========== */}
              <div className="sd-row-card sd-row-card--strip">
                <div
                  className="sb-strip-wrap"
                onWheel={(e) => {
                  const el = e.currentTarget;
                  el.scrollLeft += e.deltaY;
                }}
              >
                <div className="sb-strip">
                  {/* 最前插入：悬停触发 */}
                  <div
                    className={`sb-strip-gap${hoverGap === "__first__" ? " on" : ""}`}
                    onMouseEnter={() => setHoverGap("__first__")}
                    onMouseLeave={() => setHoverGap(null)}
                  >
                    <button
                      className="sb-strip-gap-btn"
                      onClick={() => setInsertAfterId("__first__")}
                      disabled={busy}
                      title="在最前插入"
                      aria-label="在最前插入"
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                      </svg>
                    </button>
                  </div>

                  {sbList.map((sb, i) => {
                    const selVid = videosMap[sb.id]?.find((v: StoryboardVideoInfo) => v.id === sb.selected_video_id);
                    const videoSrc = selVid ? convertFileSrc(selVid.file_path) : null;
                    const sec = Math.round(selVid?.duration ?? sb.video_duration ?? sb.voice_duration ?? 0);
                    const storyboardTasks = videoTaskStates[sb.id] ?? [];
                    // 仅任务表中真实存在的 pending/running 批次才显示生成状态；
                    // 新分镜默认 video_state 和历史失败批次都不能影响缩略条。
                    const isVideoGenerating = storyboardTasks.some((task) => task.status === "pending" || task.status === "running");
                    return (
                      <div key={sb.id} style={{ display: "contents" }}>
                        <div className="sb-strip-group">
                          <div
                            className={`sb-strip-item${i === safeIdx ? " on" : ""}`}
                            onClick={() => setActiveIdx(i)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveIdx(i); } }}
                          >
                            <div className="sb-strip-thumb">
                              {videoSrc ? (
                                <video src={videoSrc} muted preload="metadata" />
                              ) : (
                                <svg viewBox="0 0 80 60" fill="none" className="sb-strip-placeholder">
                                  <rect width="80" height="60" rx="3" fill="var(--bg-input)" />
                                  <circle cx="40" cy="30" r="10" fill="rgba(var(--text-muted-rgb),0.12)" stroke="rgba(var(--text-muted-rgb),0.25)" strokeWidth="1" />
                                  <polygon points="38,24 38,36 48,30" fill="rgba(var(--text-muted-rgb),0.25)" />
                                </svg>
                              )}
                              {isVideoGenerating && (
                                <div className="sb-strip-task-state sb-strip-task-state--generating">
                                  <span className="sd-video-task-orb" aria-hidden />
                                </div>
                              )}
                              <button
                                className="sb-strip-del"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  setDeleteFiles(false);
                                  setDeleteTarget(sb);
                                }}
                                disabled={busy}
                                title="删除"
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                              </button>
                            </div>
                            <span className={`sb-strip-dur${isVideoGenerating ? " is-generating" : ""}`}>
                              #{String(sb.seq_num).padStart(2, "0")} · {sec > 0 ? `${sec}S` : "--S"}
                            </span>
                          </div>
                        </div>

                        {/* 卡片间悬停插入 */}
                        <div
                          className={`sb-strip-gap${hoverGap === sb.id ? " on" : ""}`}
                          onMouseEnter={() => setHoverGap(sb.id)}
                          onMouseLeave={() => setHoverGap(null)}
                        >
                          <button
                            className="sb-strip-gap-btn"
                            onClick={() => setInsertAfterId(sb.id)}
                            disabled={busy}
                            title="在此后插入"
                            aria-label="在此后插入"
                          >
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            </div>
          )}
        </div>
      </div>

      {deleteTarget && (
        <DeleteConfirmModal
          title="删除分镜"
          description={<>确认删除分镜 <strong>「#{deleteTarget.seq_num}」</strong>？</>}
          checkbox={{ label: "同时删除磁盘文件", checked: deleteFiles, onChange: setDeleteFiles }}
          onConfirm={delSb}
          onCancel={() => {
            setDeleteFiles(false);
            setDeleteTarget(null);
          }}
          disabled={busy}
        />
      )}

      {/* 新增分镜确认框（添加/插入统一） */}
      {insertAfterId !== undefined && (
        <StoryboardConfirm
          title="新增分镜"
          message="确认新增一个空分镜？"
          confirmText="新增"
          onConfirm={() => {
            const id = insertAfterId;
            setInsertAfterId(undefined);
            if (id === null) addSb();
            else if (id === "__first__") insertSb(null);
            else insertSb(id);
          }}
          onCancel={() => setInsertAfterId(undefined)}
          disabled={busy}
        />
      )}

    </div>
  );
}

/* ========================================================================
   DetailView — 上方选中分镜详情

   批次区域拆分为：
     左侧：视频批次缩略图（横排）
     右侧：视频生成参数（模型/时长/分辨率/宽高比 + 生成按钮）
   所有参数失焦保存。
   ======================================================================== */

function DetailView({
  sb,
  assets,
  busy,
  saving,
  videoModels,
  onToggle,
  onBatchToggle,
  onDurationWrite,
  onVideoRefresh,
  videoTaskStates,
  onVideoTaskQueued,
  lockedRatio,
}: DetailProps) {
  const { toast } = useToast();
  const cIds = parseIds(sb.character_ids_json), sIds = parseIds(sb.scene_ids_json), iIds = parseIds(sb.item_ids_json);
  const linked = (a: StoryboardAssetInfo) => a.type === "character" ? cIds.has(a.asset_id) : a.type === "scene" ? sIds.has(a.asset_id) : iIds.has(a.asset_id);

  const [videos, setVideos] = useState<StoryboardVideoInfo[]>([]);
  const [videoVer, setVideoVer] = useState(0);
  const [pendingSelect, setPendingSelect] = useState<StoryboardVideoInfo | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StoryboardVideoInfo | null>(null);
  const [pendingDeleteFailedTask, setPendingDeleteFailedTask] = useState<VideoTaskState | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [viewingVideoId, setViewingVideoId] = useState<string | null>(null);

  const displayVideos = useMemo<DisplayStoryboardVideo[]>(() => {
    // 终态刷新与事件可能交错；task_id 已落库的视频优先作为完成批次展示，
    // 以免同一个 taskId 同时显示“生成中”和最终视频。
    const completedTaskIds = new Set(videos.flatMap((video) => video.task_id ? [video.task_id] : []));
    return [
      ...videos,
      ...videoTaskStates
        .filter((task) => !completedTaskIds.has(task.taskId))
        .map((task) => ({
          id: `task:${task.taskId}`,
          storyboard_id: sb.id,
          file_path: "",
          file_name: task.status === "failed" ? "视频生成失败" : "视频生成中",
          source: "generated",
          task_id: task.taskId,
          duration: null,
          taskStatus: task.status,
        })),
    ];
  }, [sb.id, videoTaskStates, videos]);

  const loadVideos = useCallback(async () => {
    try { setVideos(await listStoryboardVideos(sb.id)); }
    catch { /* ignore */ }
  }, [sb.id]);
  useEffect(() => { loadVideos(); }, [loadVideos, sb.video_state, videoTaskStates, videoVer]);

  // 选择本地视频导入为批次
  const [importingVideo, setImportingVideo] = useState(false);
  const handleImportLocalVideo = useCallback(async () => {
    const filePath = await pickVideoFile();
    if (!filePath) return;
    setImportingVideo(true);
    try {
      const imported = await importVideoFile(sb.clip_id, filePath);
      await addStoryboardVideo({ storyboard_id: sb.id, video_path: imported.file_path, file_name: imported.file_name });
      onVideoRefresh(sb.id);
      setVideoVer((x) => x + 1);
      toast("本地视频已导入", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "导入失败", "error");
    } finally {
      setImportingVideo(false);
    }
  }, [sb.clip_id, sb.id, onVideoRefresh, toast]);

  // 最终视频变更时同步播放到该视频
  useEffect(() => { setViewingVideoId(sb.selected_video_id || null); }, [sb.selected_video_id]);
  // 切换分镜后重置观看状态
  useEffect(() => { setViewingVideoId(null); }, [sb.id]);

  const playerVidId = viewingVideoId ?? sb.selected_video_id;
  const activeVideo = displayVideos.find((video) => video.id === playerVidId) ?? null;
  const currentVideoSrc = activeVideo?.file_path ? convertFileSrc(activeVideo.file_path) : null;
  const currentVideoTaskStatus = activeVideo?.taskStatus;
  // 任务成功后，若正在查看已完成的临时批次则切换至最终视频，避免预览停在空状态。
  useEffect(() => {
    const isViewingTask = viewingVideoId?.startsWith("task:");
    const taskStillVisible = isViewingTask
      && videoTaskStates.some((task) => `task:${task.taskId}` === viewingVideoId);
    if (isViewingTask && !taskStillVisible) {
      setViewingVideoId(sb.selected_video_id ?? videos[videos.length - 1]?.id ?? null);
    }
  }, [sb.selected_video_id, videoTaskStates, videos, viewingVideoId]);

  // ── 自绘播放控件（绕开 WebView2 原生 controls 命中错位） ──
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [waiting, setWaiting] = useState(false);

  // 切换视频源时重置状态
  useEffect(() => {
    setIsPlaying(false);
    setCurTime(0);
    setDur(0);
    setWaiting(true);
  }, [currentVideoSrc]);

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused || el.ended) {
      void el.play();
    } else {
      el.pause();
    }
  }, []);

  const onSeek = useCallback((t: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = t;
    setCurTime(t);
  }, []);

  const fmt = (s: number) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const seekByRatio = useCallback((ratio: number) => {
    const el = videoRef.current;
    if (!el || !el.duration || !Number.isFinite(el.duration)) return;
    onSeek(ratio * el.duration);
  }, [onSeek]);

  const playerRef = useRef<HTMLDivElement | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  }, []);

  const onVolume = useCallback((v: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = v;
    el.muted = v === 0;
    setVolume(v);
    setMuted(v === 0);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = playerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  const togglePip = useCallback(async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch { /* 某些格式不支持画中画，静默 */ }
  }, []);

  // ── 视频参数状态（从 sb.video_param_json 初始化，时长回退到数据库存储时长） ──
  const [params, setParams] = useState<VideoParams>(() => parseVideoParams(sb.video_param_json, sb.video_duration ?? sb.voice_duration, videoModels));
  const [prompt, setPrompt] = useState(sb.video_prompt || "");
  // promptDoc 是编辑器的唯一主数据；prompt 是从它派生并提交给 Worker/API 的纯文本。
  const [promptDoc, setPromptDoc] = useState<PromptDoc>(() => plainTextToPromptDoc(sb.video_prompt || "", []));
  const paramsRef = useRef(params); paramsRef.current = params;
  const promptRef = useRef(prompt); promptRef.current = prompt;
  const promptDocRef = useRef(promptDoc); promptDocRef.current = promptDoc;
  const sbIdRef = useRef(sb.id); sbIdRef.current = sb.id;
  // 同一分镜的迁移、失焦保存与点击生成保存必须串行，避免旧迁移请求晚到覆盖新编辑。
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  // 一个旧 JSON 版本最多迁移一次；资产缩略图刷新不能重新排队旧文本覆盖用户编辑。
  const migratedPromptDocKeysRef = useRef(new Set<string>());
  const queueStoryboardSave = useCallback((input: {
    storyboard_id: string;
    video_param_json: string | null;
    video_prompt: string | null;
  }) => {
    const write = saveQueueRef.current.then(() => updateStoryboardParams(input));
    // 队列本身吞掉错误以继续处理后续用户保存；调用方仍会收到本次 write 的失败。
    saveQueueRef.current = write.catch(() => undefined);
    return write;
  }, []);

  // 切换分镜：一次性恢复稳定的 mention_map 与 prompt_doc。
  // 旧数据缺失 mention_map，或曾被保存为“只有文本的 prompt_doc”时，严格按完整
  // `资产名(@图片N)` 恢复；名称不唯一时宁可保留文本，也绝不猜错资产。
  useEffect(() => {
    let rawParams: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(sb.video_param_json || "{}");
      if (parsed && typeof parsed === "object") rawParams = parsed as Record<string, unknown>;
    } catch { /* 使用默认参数与空映射 */ }

    const currentAssetById = new Map(assets.map((asset) => [asset.asset_id, asset]));
    let mentions: AssetMention[] = [];
    for (const rawMention of Array.isArray(rawParams.mention_map) ? rawParams.mention_map : []) {
      if (!rawMention || typeof rawMention !== "object") continue;
      const value = rawMention as Partial<PromptMention>;
      const index = Number(value.n);
      const name = typeof value.name === "string" ? value.name : "";
      const assetId = typeof value.assetId === "string" ? value.assetId : "";
      if (!Number.isInteger(index) || index < 1 || !name || !assetId) continue;
      const currentAsset = currentAssetById.get(assetId);
      mentions.push({
        assetId,
        name,
        type: typeof value.type === "string" ? value.type : (currentAsset?.type ?? ""),
        imagePath: currentAsset?.selected_image_path ?? (typeof value.imagePath === "string" ? value.imagePath : null),
        index,
        assetTag: typeof value.assetTag === "string" && value.assetTag
          ? value.assetTag
          : createAssetTag(name, index),
        deleted: !currentAsset,
      });
    }

    const sourcePrompt = sb.video_prompt || "";
    const mentionByIndex = new Map(mentions.map((mention) => [mention.index, mention]));

    // 按名称恢复资产映射（仅名称唯一时生效，避免误匹配）
    const assetsByName = (() => {
      const map = new Map<string, StoryboardAssetInfo[]>();
      for (const asset of assets) {
        const name = asset.name.trim();
        if (!name) continue;
        const entries = map.get(name) ?? [];
        entries.push(asset);
        map.set(name, entries);
      }
      return map;
    })();
    const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const [name, matching] of assetsByName) {
      if (matching.length !== 1) continue;
      const pattern = new RegExp(`${escapeRegex(name)}\\(@图片(\\d+)\\)`, "gu");
      for (const m of sourcePrompt.matchAll(pattern)) {
        const idx = Number(m[1]);
        if (!Number.isInteger(idx) || idx < 1 || mentionByIndex.has(idx)) continue;
        const asset = matching[0];
        mentionByIndex.set(idx, {
          assetId: asset.asset_id, name: asset.name, type: asset.type,
          imagePath: asset.selected_image_path,
          index: idx, assetTag: createAssetTag(asset.name, idx),
        });
      }
    }
    mentions = [...mentionByIndex.values()].sort((a, b) => a.index - b.index);

    const normalizedMentions: PromptMention[] = mentions.map((m) => ({
      n: m.index, assetId: m.assetId, name: m.name,
      type: m.type, imagePath: m.imagePath, assetTag: m.assetTag,
      deleted: m.deleted,
    }));

    // 动态标注 (@图片N) → 全量重建 Tiptap doc
    const annotatedPrompt = annotatePrompt(sourcePrompt, normalizedMentions);
    const nextDoc = plainTextToPromptDoc(annotatedPrompt, normalizedMentions);
    const nextPrompt = promptDocToPlainText(nextDoc);

    mentionMapRef.current = new Map(mentions.map((m) => [m.index, m]));
    setMentionItems(mentions);
    const parsedParams = parseVideoParams(sb.video_param_json, sb.video_duration ?? sb.voice_duration, videoModels);
    setParams(lockedRatio ? { ...parsedParams, resolution: lockedRatio.resolution, aspect_ratio: lockedRatio.aspect_ratio } : parsedParams);
    setPrompt(nextPrompt);
    setPromptDoc(nextDoc);

    // 持久化矫正后的 prompt_doc（仅旧数据缺失/损坏时迁移，不覆盖原始 video_prompt）
    const storedDoc = rawParams.prompt_doc;
    const needsMigration = storedDoc && JSON.stringify(nextDoc) !== JSON.stringify(storedDoc);
    const migrationKey = `${sb.id}:${sb.video_param_json ?? ""}`;
    if (needsMigration && !migratedPromptDocKeysRef.current.has(migrationKey)) {
      migratedPromptDocKeysRef.current.add(migrationKey);
      const migratedParams = {
        ...rawParams,
        ...parseVideoParams(sb.video_param_json, sb.video_duration ?? sb.voice_duration, videoModels),
        mention_map: normalizedMentions,
        prompt_doc: nextDoc,
      };
      void queueStoryboardSave({
        storyboard_id: sb.id,
        video_param_json: JSON.stringify(migratedParams),
        video_prompt: sourcePrompt || null,
      }).catch(() => { /* 下次编辑/失焦时重试 */ });
    }
  }, [assets, sb.id, sb.video_param_json, sb.video_prompt, sb.video_duration, sb.voice_duration, videoModels]);

  // lockedRatio 变化时（如其他分镜新绑定了视频），同步锁定当前参数
  useEffect(() => {
    if (lockedRatio) {
      setParams((prev) => ({
        ...prev,
        resolution: lockedRatio.resolution,
        aspect_ratio: lockedRatio.aspect_ratio,
      }));
    }
  }, [lockedRatio]);

  // 失焦保存：只持久化当前提示词中实际存在的胶囊，并保持编号与文本标签连续一致。
  const saveParams = useCallback(async () => {
    try {
      const doc = editorRef.current?.getPromptDoc() ?? promptDocRef.current;
      const normalized = normalizePromptReferences(doc, mentionMapRef.current);
      mentionMapRef.current = new Map(normalized.mentions.map((mention) => [mention.index, mention]));
      setMentionItems(normalized.mentions);
      setPromptDoc(normalized.promptDoc);
      setPrompt(normalized.prompt);
      const mapEntries = normalized.mentions.map((mention) => ({
        n: mention.index,
        assetId: mention.assetId,
        name: mention.name,
        type: mention.type,
        imagePath: mention.imagePath,
        assetTag: mention.assetTag,
      }));
      const paramsJson = {
        ...paramsRef.current,
        mention_map: mapEntries,
        prompt_doc: normalized.promptDoc,
      };
      await queueStoryboardSave({
        storyboard_id: sbIdRef.current,
        video_param_json: JSON.stringify(paramsJson),
        video_prompt: normalized.prompt || null,
      });
    } catch {
      // 静默失败，后续失焦仍会重试。
    }
  }, []);

  const updateParam = useCallback(<K extends keyof VideoParams>(key: K, value: VideoParams[K]) => {
    setParams((prev) => {
      const next = { ...prev, [key]: value };
      // 切换模型时，若当前分辨率不在新模型支持列表中，自动选第一个
      if (key === "model") {
        const allowed = getResolutions(value as string, videoModels);
        if (!allowed.includes(next.resolution)) {
          next.resolution = allowed[0];
        }
      }
      return next;
    });
  }, []);

  const [pickerCat, setPickerCat] = useState<AssetType | null>(null);
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());

  // ── @mention 状态 ────────────────────────────────
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionPos, setMentionPos] = useState<MentionAnchor | null>(null);
  const editorRef = useRef<PromptEditorHandle>(null);
  const mentionMapRef = useRef<Map<number, AssetMention>>(new Map());
  // mentionItems：已分配 index 的资产列表，作为 state 传给 PromptEditor 触发重渲染
  const [mentionItems, setMentionItems] = useState<AssetMention[]>([]);

  // 当前分镜可 @ 的资产。已分配项从 mention_map（或后端返回的 assetTag）取稳定编号；
  // 新资产在用户选择时才分配 N，避免列表排序影响任何既有引用。
  const mentionAssets = useMemo<AssetMention[]>(() =>
    assets.filter(linked).map((asset) => {
      const assigned = mentionItems.find((mention) => mention.assetId === asset.asset_id);
      const index = assigned?.index ?? asset.index ?? 0;
      return {
        assetId: asset.asset_id,
        name: asset.name,
        type: asset.type,
        imagePath: asset.selected_image_path,
        index,
        assetTag: assigned?.assetTag ?? asset.assetTag ?? (index > 0 ? createAssetTag(asset.name, index) : ""),
      };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assets, mentionItems, sb.character_ids_json, sb.scene_ids_json, sb.item_ids_json],
  );

  // 新资产在当前映射的末尾分配编号；保存或生成时会按仍存在的胶囊重排为连续编号。
  const nextMentionIndex = useMemo(() => {
    const maxIndex = mentionItems.reduce((max, mention) => Math.max(max, mention.index), 0);
    return maxIndex + 1;
  }, [mentionItems]);

  // assetId → 已分配序号（供下拉展示并复用同一资产编号）。
  const existingAssetIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const mention of mentionItems) map.set(mention.assetId, mention.index);
    return map;
  }, [mentionItems]);

  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionFilter("");
    setMentionPos(null);
  }, []);

  // Tiptap suggestion 回调：@ 触发时打开下拉。
  const handleMentionStart = useCallback((query: string, pos: MentionAnchor) => {
    setMentionFilter(query);
    setMentionPos(pos);
    setMentionOpen(true);
  }, []);

  const handleMentionUpdate = useCallback((query: string) => {
    setMentionFilter(query);
  }, []);

  // 任何键入、粘贴或 @ 插入都由 PromptEditor 实时返回 AST 与其纯文本序列化。
  const handlePromptChange = useCallback((change: PromptEditorChange) => {
    setPromptDoc(change.promptDoc);
    setPrompt(change.plainText);
  }, []);

  // 选中资产：通过 editorRef 插入 mention 节点（Tiptap 内部处理）。
  // 同一资产可多次插入胶囊；限制的是每分镜关联的资产数量，而不是胶囊数量。
  const handleMentionSelect = useCallback((asset: AssetMention) => {
    let assignedIndex: number | undefined;
    mentionMapRef.current.forEach((mention, index) => {
      if (mention.assetId === asset.assetId) assignedIndex = index;
    });

    const index = assignedIndex ?? nextMentionIndex;

    // 新资产先分配编号；保存或生成时会根据仍存在的胶囊清理并重排引用。
    if (assignedIndex === undefined) {
      const mention: AssetMention = {
        ...asset,
        index,
        assetTag: createAssetTag(asset.name, index),
      };
      mentionMapRef.current.set(index, mention);
      setMentionItems([...mentionMapRef.current.values()].sort((a, b) => a.index - b.index));
    }

    const assetTag = mentionMapRef.current.get(index)?.assetTag ?? createAssetTag(asset.name, index);
    editorRef.current?.insertMention({ ...asset, index, assetTag }, index);
    closeMention();
  }, [nextMentionIndex, closeMention]);

  const [generatingVideo, setGeneratingVideo] = useState(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const handleGenerateVideo = useCallback(async () => {
    try {
      // 检查是否有已删除的资产胶囊
      const deletedEntries = [...mentionMapRef.current.values()].filter((m) => m.deleted);
      if (deletedEntries.length > 0) {
        const names = deletedEntries.map((m) => `"${m.name}"`).join("、");
        toast(`资产${names}已被删除，请先移除提示词中的红色胶囊后再生成视频`, "error");
        return;
      }

      const doc = editorRef.current?.getPromptDoc() ?? promptDocRef.current;
      const normalized = normalizePromptReferences(doc, mentionMapRef.current);
      const raw = normalized.prompt.trim();
      if (!raw) {
        toast("提示词为空，无法生成视频", "error");
        return;
      }

      mentionMapRef.current = new Map(normalized.mentions.map((mention) => [mention.index, mention]));
      setMentionItems(normalized.mentions);
      setPromptDoc(normalized.promptDoc);
      setPrompt(normalized.prompt);

      // 同步检查：所有绑定资产必须已选择参考图片
      const missingImageNames = normalized.mentions
        .filter((m) => !m.imagePath)
        .map((m) => `"${m.name}"`);
      if (missingImageNames.length > 0) {
        toast(`资产${missingImageNames.join("、")}尚未绑定图片，请先在资产详情中选择参考图片`, "error");
        return;
      }

      const mapEntries = normalized.mentions.map((mention) => ({
        n: mention.index,
        assetId: mention.assetId,
        name: mention.name,
        type: mention.type,
        imagePath: mention.imagePath,
        assetTag: mention.assetTag,
      }));

      setGeneratingVideo(true);
      // 先提交当前光标位置的 AST，随后才入队，避免 Worker 读到旧的 video_prompt。
      await queueStoryboardSave({
        storyboard_id: sb.id,
        video_param_json: JSON.stringify({ ...params, mention_map: mapEntries, prompt_doc: normalized.promptDoc }),
        video_prompt: raw,
      });
      const task = await generateStoryboardVideo({ storyboard_id: sb.id });
      onVideoTaskQueued(sb.id, task.task_id);
      toast("视频生成任务已提交", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : (typeof err === "string" ? err : "");
      toast(msg || formatStoryboardVideoFailure(), "error");
    } finally {
      setGeneratingVideo(false);
    }
  }, [onVideoTaskQueued, params, sb.id, sb.seq_num, toast]);


  return (
    <div className={saving ? "sd-detail is-busy" : "sd-detail"}>
      {/* 第一行：视频播放器 + 提示词 */}
      <div className="sd-row-card sd-row-card--grow">
        <div className="sd-detail-top">
        {/* 左侧：视频播放器 */}
        <div className="sd-detail-left">
          {currentVideoSrc ? (
            <div className="sd-player" ref={playerRef}>
              <video
                ref={videoRef}
                className="sd-player-video"
                src={currentVideoSrc}
                preload="metadata"
                muted={muted}
                onClick={togglePlay}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onTimeUpdate={(e) => setCurTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); setWaiting(false); }}
                onVolumeChange={(e) => { setMuted(e.currentTarget.muted); setVolume(e.currentTarget.volume); }}
                onWaiting={() => setWaiting(true)}
                onPlaying={() => setWaiting(false)}
                onCanPlay={() => setWaiting(false)}
              />
              <div className="sd-player-controls">
                <button className="sd-player-btn" onClick={togglePlay} type="button" aria-label={isPlaying ? "暂停" : "播放"}>
                  {isPlaying ? (
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
                      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                      <path d="M8 5v14l11-7z" fill="currentColor" />
                    </svg>
                  )}
                </button>
                <span className="sd-player-time">{fmt(curTime)}</span>
                <div
                  className="sd-player-seek"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    seekByRatio(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
                  }}
                >
                  <div className="sd-player-seek-fill" style={{ width: `${dur ? (curTime / dur) * 100 : 0}%` }} />
                  <div className="sd-player-seek-thumb" style={{ left: `${dur ? (curTime / dur) * 100 : 0}%` }} />
                </div>
                <span className="sd-player-time sd-player-time--total">{fmt(dur)}</span>
                <div className="sd-player-volume">
                  <button className="sd-player-btn" onClick={toggleMute} type="button" aria-label={muted ? "取消静音" : "静音"}>
                    {muted || volume === 0 ? (
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor" />
                        <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor" />
                        <path d="M16 8a5 5 0 0 1 0 8M18.5 5.5a8.5 8.5 0 0 1 0 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                      </svg>
                    )}
                  </button>
                  <input
                    className="sd-player-vol-slider"
                    type="range" min={0} max={1} step={0.01}
                    value={muted ? 0 : volume}
                    onChange={(e) => onVolume(Number(e.target.value))}
                  />
                </div>
                <button className="sd-player-btn" onClick={togglePip} type="button" aria-label="画中画" title="画中画">
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" fill="none" />
                    <rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor" />
                  </svg>
                </button>
                <button className="sd-player-btn" onClick={toggleFullscreen} type="button" aria-label="全屏" title="全屏">
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                </button>
              </div>
              {waiting && <div className="sd-player-loading">加载中…</div>}
            </div>
          ) : currentVideoTaskStatus ? (
            <div className={`sd-player-task-state sd-player-task-state--${currentVideoTaskStatus}`}>
              {currentVideoTaskStatus === "failed" ? (
                <span className="sd-video-task-failure-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                </span>
              ) : (
                <span className="sd-video-task-orb" aria-hidden />
              )}
              <strong>{currentVideoTaskStatus === "failed" ? "视频生成失败" : "视频生成中"}</strong>
              <span>
                {currentVideoTaskStatus === "failed"
                  ? formatStoryboardVideoFailure()
                  : "视频批次正在生成，请稍候…"}
              </span>
            </div>
          ) : (
            <svg viewBox="0 0 320 180" fill="none" className="sd-detail-video-empty" preserveAspectRatio="xMidYMid meet">
              <defs>
                <linearGradient id={`vph-grad-${sb.id}`} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--bg-input)" />
                  <stop offset="55%" stopColor="var(--bg-surface)" />
                  <stop offset="100%" stopColor="var(--bg-canvas)" />
                </linearGradient>
                <linearGradient id={`vph-ring-${sb.id}`} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
                  <stop offset="100%" stopColor="rgba(255,255,255,0.05)" />
                </linearGradient>
                <filter id={`vph-glow-${sb.id}`}>
                  <feGaussianBlur stdDeviation="2.5" result="b" />
                  <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <rect width="320" height="180" rx="10" fill={`url(#vph-grad-${sb.id})`} />
              <g opacity="0.12">
                <rect x="28" y="44" width="6" height="10" rx="1" fill="rgba(var(--text-muted-rgb),0.8)" />
                <rect x="28" y="66" width="6" height="10" rx="1" fill="rgba(var(--text-muted-rgb),0.8)" />
                <rect x="28" y="88" width="6" height="10" rx="1" fill="rgba(var(--text-muted-rgb),0.8)" />
                <rect x="28" y="110" width="6" height="10" rx="1" fill="rgba(var(--text-muted-rgb),0.8)" />
                <rect x="286" y="44" width="6" height="10" rx="1" fill="rgba(var(--text-muted-rgb),0.8)" />
                <rect x="286" y="66" width="6" height="10" rx="1" fill="rgba(var(--text-muted-rgb),0.8)" />
                <rect x="286" y="88" width="6" height="10" rx="1" fill="rgba(var(--text-muted-rgb),0.8)" />
                <rect x="286" y="110" width="6" height="10" rx="1" fill="rgba(var(--text-muted-rgb),0.8)" />
              </g>
              <circle cx="160" cy="90" r="34" fill="rgba(0,0,0,0.22)" stroke={`url(#vph-ring-${sb.id})`} strokeWidth="1" />
              <circle cx="160" cy="90" r="26" fill="rgba(0,0,0,0.28)" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
              <polygon points="152,78 152,102 176,90" fill="rgba(255,255,255,0.75)" filter={`url(#vph-glow-${sb.id})`} />
            </svg>
          )}
        </div>

        {/* 右侧：提示词 */}
        <div className="sd-detail-right">
          <div className="sd-detail-prompt">
            <PromptEditor
              ref={editorRef}
              document={promptDoc}
              resetKey={sb.id}
              onChange={handlePromptChange}
              onBlur={saveParams}
              placeholder="暂无提示词 · 输入 @ 引用资产"
              onMentionStart={handleMentionStart}
              onMentionUpdate={handleMentionUpdate}
              onMentionClose={closeMention}
              disabled={busy}
            />
            <MentionDropdown
              assets={mentionAssets}
              isOpen={mentionOpen}
              filter={mentionFilter}
              position={mentionPos}
              onSelect={handleMentionSelect}
              onClose={closeMention}
              nextIndex={nextMentionIndex}
              existingIndexMap={existingAssetIndexMap}
            />
          </div>
        </div>
      </div>
      </div>

      {/* 第二行：视频批次 */}
      <div className="sd-row-card">
        <div className="sd-batch-thumbs">
          {displayVideos.map((v, i) => {
            const isTaskBatch = Boolean(v.taskStatus);
            const isSelected = !isTaskBatch && v.id === sb.selected_video_id;
            const isViewing = v.id === playerVidId;
            const batchLabel = `B${i + 1}`;
            const taskLabel = v.taskStatus === "failed" ? "生成失败" : "生成中";
            return (
              <div
                key={v.id}
                className={`sd-video-thumb-wrap${isSelected ? " on" : ""}${isViewing ? " playing" : ""}${v.taskStatus ? ` is-task is-task--${v.taskStatus}` : ""}`}
              >
                <div
                  className="sd-video-thumb-click"
                  onClick={() => setViewingVideoId(v.id)}
                  title={isTaskBatch ? taskLabel : v.file_name}
                >
                  {isTaskBatch ? (
                    <div className="sd-video-task-thumb" aria-label={taskLabel}>
                      {v.taskStatus === "failed" ? (
                        <span className="sd-video-task-failure-icon" aria-hidden>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                            <line x1="6" y1="6" x2="18" y2="18" />
                            <line x1="18" y1="6" x2="6" y2="18" />
                          </svg>
                        </span>
                      ) : (
                        <span className="sd-video-task-orb" aria-hidden />
                      )}
                    </div>
                  ) : (
                    <video src={convertFileSrc(v.file_path)} muted preload="metadata" className="sd-video-thumb-vid" />
                  )}
                </div>
                <span className="sd-video-thumb-label">{batchLabel}</span>
                {isSelected && <span className="sd-video-thumb-bound-badge" title="分镜绑定视频" />}
                {v.taskStatus === "failed" && v.task_id && (
                  <button
                    className="sd-video-thumb-delete"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteFailedTask({ taskId: v.task_id!, status: "failed" });
                    }}
                    title="删除失败批次"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
                {!isTaskBatch && !isSelected && (
                  <button
                    className="sd-video-thumb-select"
                    onClick={(e) => { e.stopPropagation(); setPendingSelect(v); }}
                    title="选为分镜最终视频"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </button>
                )}
                {!isTaskBatch && !isSelected && (
                  <button
                    className="sd-video-thumb-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteFiles(false);
                      setPendingDelete(v);
                    }}
                    title="删除该批次"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
          {/* 选择本地视频按钮 */}
          <button
            className="sd-video-thumb-add"
            disabled={importingVideo || busy}
            onClick={handleImportLocalVideo}
            title="选择本地视频导入"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 第三行：关联资产 + 参数 */}
      <div className="sd-row-split">
        {/* 左侧：关联资产 */}
        <div className="sd-row-card sd-row-card--fixed">
          <div className="sd-section sd-section--assets">
            <span className="sd-section-label">关联资产</span>
            <div className="sd-detail-assets">
              {CATS.map((cat) => {
                const linkedList = assets.filter((a) => a.type === cat.type && linked(a));
                const totalLinkedCount = cIds.size + sIds.size + iIds.size;
                const atLimit = totalLinkedCount >= 9;
                return (
                  <div key={cat.type} className="sd-detail-asset-row">
                    <span className="sd-detail-asset-icon">{cat.icon}</span>
                    <div className="sd-detail-asset-chips">
                      {linkedList.map((a) => {
                        const img = a.selected_image_path ? convertFileSrc(a.selected_image_path) : null;
                        return (
                          <span
                            key={a.asset_id}
                            className={`sd-detail-chip on${!img ? " sd-detail-chip--nogen" : ""}`}
                            title={!img ? `${a.name}（图片未生成）` : (a.description || a.name)}
                            onClick={() => { if (img) setPreviewImg(img); }}
                          >
                            {img ? (
                              <span className="sd-detail-chip-img"><img src={img} alt="" /></span>
                            ) : (
                              <span className="sd-detail-chip-img sd-detail-chip-img--empty" title="图片未生成">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </span>
                            )}
                            <span className="sd-detail-chip-name">{a.name}</span>
                            <button
                              className="sd-detail-chip-x"
                              disabled={busy}
                              onClick={(e) => { e.stopPropagation(); onToggle(a); }}
                              title="取消关联"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                          </span>
                        );
                      })}
                      <button
                        className="sd-detail-chip sd-detail-chip--add"
                        disabled={busy || atLimit}
                        onClick={() => setPickerCat(cat.type)}
                        title={atLimit ? "每个分镜最多关联 9 个资产" : `关联${cat.label}`}
                      >+</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 右侧：视频生成参数 */}
        <div className="sd-row-card sd-row-card--fixed">
          <div className="sd-section sd-section--params">
            <div className="sd-params-grid">
              <label className="sd-param-field">
                <span className="sd-param-label">模型</span>
                <ParamSelect
                  value={params.model}
                  options={Object.keys(videoModels).length === 0
                    ? [{ label: "未配置模型", value: "" as string }]
                    : Object.keys(videoModels).map((m) => ({ label: m, value: m }))}
                  onChange={(v) => updateParam("model", v)}
                  onBlur={saveParams}
                />
              </label>
              <label className="sd-param-field">
                <span className="sd-param-label">时长</span>
                <ParamSelect
                  value={String(params.duration)}
                  disabled={busy}
                  options={Array.from({ length: VIDEO_DURATION_MAX - VIDEO_DURATION_MIN + 1 }, (_, i) => VIDEO_DURATION_MIN + i).map((d) => ({ label: `${d}s`, value: String(d) }))}
                  onChange={(v) => {
                    const n = Number(v);
                    if (!Number.isFinite(n)) return;
                    setParams((prev) => ({ ...prev, duration: n }));
                    onDurationWrite(sb, clampDuration(n));
                  }}
                  onBlur={saveParams}
                />
              </label>
              <label className="sd-param-field">
                <span className="sd-param-label">分辨率{lockedRatio ? <span title="为保证最终视频合成效果，分辨率已锁定"> 🔒</span> : ""}</span>
                <ParamSelect
                  value={params.resolution}
                  disabled={!!lockedRatio}
                  options={getResolutions(params.model, videoModels).map((r) => ({ label: r, value: r }))}
                  onChange={(v) => updateParam("resolution", v)}
                  onBlur={saveParams}
                />
              </label>
              <label className="sd-param-field">
                <span className="sd-param-label">宽高比{lockedRatio ? <span title="为保证最终视频合成效果，宽高比已锁定"> 🔒</span> : ""}</span>
                <ParamSelect
                  value={params.aspect_ratio}
                  disabled={!!lockedRatio}
                  options={VIDEO_ASPECT_OPTIONS.map((a) => ({ label: a, value: a }))}
                  onChange={(v) => updateParam("aspect_ratio", v)}
                  onBlur={saveParams}
                />
              </label>
            </div>
            <button
              className="sd-generate-btn primary-button"
              type="button"
              disabled={generatingVideo}
              onClick={() => { if (lockedRatio) { handleGenerateVideo(); } else { setConfirmGenerate(true); } }}
              title="按当前提示词和参考图片生成视频"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5,3 19,12 5,21"/></svg>
              {generatingVideo ? "提交中…" : "生成视频"}
            </button>
          </div>
        </div>
      </div>

      {/* 资产选择弹窗 */}
      {pickerCat && (() => {
        const catLabel = CATS.find((c) => c.type === pickerCat)?.label ?? "";
        const catIcon = CATS.find((c) => c.type === pickerCat)?.icon ?? "";
        const allOfType = assets.filter((a) => a.type === pickerCat);
        const linkedList = allOfType.filter((a) => linked(a));
        const freeList = allOfType.filter((a) => !linked(a));
        const hasSelection = pickerSelected.size > 0;
        const totalLinked = cIds.size + sIds.size + iIds.size;
        const remainingSlots = Math.max(0, 9 - totalLinked);
        const overLimit = pickerSelected.size > remainingSlots;

        const closePicker = () => { setPickerCat(null); setPickerSelected(new Set()); };
        const togglePick = (id: string) => {
          setPickerSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
        };
        const confirmPick = async () => {
          // 一次性收集所有选中的资产 ID，合并到现有关联中
          const cIds = new Set(parseIds(sb.character_ids_json));
          const sIds = new Set(parseIds(sb.scene_ids_json));
          const iIds = new Set(parseIds(sb.item_ids_json));
          const newIds = freeList.filter((a) => pickerSelected.has(a.asset_id));

          // 超过每分镜最多 9 个资产的上限时阻止关联
          const currentTotal = cIds.size + sIds.size + iIds.size;
          if (currentTotal + newIds.length > 9) {
            toast(`每个分镜最多关联 9 个资产（当前已关联 ${currentTotal} 个，本次选择了 ${newIds.length} 个）`, "error");
            return;
          }

          for (const a of newIds) {
            if (a.type === "character") cIds.add(a.asset_id);
            else if (a.type === "scene") sIds.add(a.asset_id);
            else iIds.add(a.asset_id);
          }
          closePicker();
          await onBatchToggle(sb, { character: cIds, scene: sIds, item: iIds });
        };

        return (
          <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={closePicker}>
            <div className="modal-panel sd-picker-panel" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 className="sd-picker-title">{catIcon} 关联{catLabel}</h2>
                <button type="button" className="icon-button modal-close-button" aria-label="关闭" onClick={closePicker} disabled={busy}>×</button>
              </div>

              <div className="sd-picker-body">
                {linkedList.map((a) => {
                  const img = a.selected_image_path ? convertFileSrc(a.selected_image_path) : null;
                  return (
                    <div key={a.asset_id} className="sd-picker-item sd-picker-item--linked">
                      <div className="sd-picker-item-img">
                        {img ? <img src={img} alt="" /> : <span>{catIcon}</span>}
                      </div>
                      <div className="sd-picker-item-info">
                        <span className="sd-picker-item-name">{a.name}</span>
                      </div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="2.5" opacity="0.5"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>
                  );
                })}

                {freeList.length > 0 && (
                  <div className="sd-picker-section">
                    {freeList.map((a) => {
                      const img = a.selected_image_path ? convertFileSrc(a.selected_image_path) : null;
                      const sel = pickerSelected.has(a.asset_id);
                      return (
                        <button key={a.asset_id} className={`sd-picker-item${sel ? " on" : ""}`} disabled={busy} onClick={() => togglePick(a.asset_id)}>
                          <div className="sd-picker-item-img">
                            {img ? <img src={img} alt="" /> : <span>{catIcon}</span>}
                          </div>
                          <div className="sd-picker-item-info">
                            <span className="sd-picker-item-name">{a.name}</span>
                            <span className="sd-picker-item-desc">{a.description?.slice(0, 36) || ""}</span>
                          </div>
                          {sel && (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                          )}
                        </button>
                      );
                    })
                  }
                </div>
              )}
              </div>

              {freeList.length > 0 && (
                <div className="modal-actions">
                  <button type="button" className="secondary-button btn-sm" onClick={closePicker} disabled={busy}>取消</button>
                  <button
                    type="button"
                    className="primary-button btn-sm"
                    onClick={confirmPick}
                    disabled={busy || !hasSelection || overLimit}
                    title={overLimit ? `最多可再关联 ${remainingSlots} 个资产（每分镜上限 9 个）` : undefined}
                  >
                    {overLimit
                      ? `超出上限（最多再选 ${remainingSlots} 个）`
                      : `确定${hasSelection ? ` (${pickerSelected.size})` : ""}`}
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* 首次生成确认：片段尚无绑定视频时锁定比例 */}
      {confirmGenerate && (
        <DeleteConfirmModal
          title="确认生成"
          description={<>确定生成 <strong>{params.resolution}</strong> 分辨率、<strong>{params.aspect_ratio}</strong> 比例的视频？生成后此片段分辨率、比例将不能更改！（删除全部视频后方可更改）</>}
          confirmText="生成"
          onConfirm={() => { setConfirmGenerate(false); handleGenerateVideo(); }}
          onCancel={() => setConfirmGenerate(false)}
          disabled={generatingVideo}
        />
      )}

      {/* 设为最终视频确认 */}
      {pendingSelect && (
        <DeleteConfirmModal
          title="确定视频"
          description="将当前视频设为分镜最终视频？"
          confirmText="确认"
          onConfirm={() => {
            const v = pendingSelect;
            setPendingSelect(null);
            if (!v) return;
            selectStoryboardVideo({ storyboard_id: sb.id, video_id: v.id }).catch(() => {});
            onVideoRefresh(sb.id);
            setVideoVer((x) => x + 1);
          }}
          onCancel={() => setPendingSelect(null)}
          disabled={busy}
        />
      )}

      {/* 删除批次视频确认 */}
      {pendingDelete && (
        <DeleteConfirmModal
          title="删除批次"
          description={<>确认删除 <strong>{pendingDelete.file_name}</strong>？</>}
          checkbox={{ label: "同时删除磁盘文件", checked: deleteFiles, onChange: setDeleteFiles }}
          onConfirm={async () => {
            const video = pendingDelete;
            const shouldDeleteFile = deleteFiles;
            setPendingDelete(null);
            setDeleteFiles(false);
            if (!video) return;
            try {
              const result = await deleteStoryboardVideo({
                storyboard_id: sb.id,
                video_id: video.id,
                delete_file: shouldDeleteFile,
              });
              await onVideoRefresh(sb.id);
              setVideoVer((version) => version + 1);
              const feedback = formatDeleteResult(result);
              toast(feedback.text, feedback.kind);
            } catch (error) {
              const feedback = formatDeleteResult(undefined, true);
              toast(feedback.text, feedback.kind);
            }
          }}
          onCancel={() => {
            setDeleteFiles(false);
            setPendingDelete(null);
          }}
          disabled={busy}
          excludeTitlebar
        />
      )}

      {pendingDeleteFailedTask && (
        <DeleteConfirmModal
          title="删除批次"
          description={<>确认删除 <strong>生成失败批次</strong>？</>}
          onConfirm={async () => {
            const task = pendingDeleteFailedTask;
            setPendingDeleteFailedTask(null);
            try {
              await deleteStoryboardVideoTask({ storyboard_id: sb.id, task_id: task.taskId });
              onVideoRefresh(sb.id);
              setVideoVer((version) => version + 1);
              toast("失败视频批次已删除", "success");
            } catch {
              toast("删除失败视频批次失败", "error");
            }
          }}
          onCancel={() => setPendingDeleteFailedTask(null)}
          disabled={busy}
          excludeTitlebar
        />
      )}

      {/* 资产图片灯箱 */}
      {previewImg && <ImageLightbox src={previewImg} alt="" onClose={() => setPreviewImg(null)} />}

    </div>
  );
}
