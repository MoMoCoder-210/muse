import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProjectInfo, Clip } from "../../types/project";
import {
  listClips,
  detectFFmpeg,
  listClipConcatVideos,
  concatStoryboardVideos,
  openInFolder,
  saveConcatOutput,
  listConcatOutputs,
  deleteConcatOutput,
  type ConcatSegment,
  type ConcatResult,
  type ConcatProgressEvent,
} from "../../services/tauri";
import { useToast } from "../../hooks/useToast";

type SegType = ConcatSegment & { enabled: boolean };

/** 视频元数据（比例 + 时长），来自 video.onLoadedMetadata */
type VideoMeta = { ar: number; dur: number };

type Props = { project: ProjectInfo };

import { isClipDecomposed } from "../../utils/clip";
import { avatarColor } from "../../utils/avatar-colors";

/** 秒 → "m:ss" */
function fmtDur(d: number | null): string {
  if (d == null || !Number.isFinite(d) || d <= 0) return "--";
  const m = Math.floor(d / 60);
  const s = Math.round(d % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 秒 → "mm:ss"（零填充，用于成片时长） */
function fmtClock(d: number | null): string {
  if (d == null || !Number.isFinite(d) || d <= 0) return "00:00";
  const m = Math.floor(d / 60);
  const s = Math.round(d % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 生成跟随视频比例的卡片样式（宽度与缩略图比例均由视频宽高决定） */
function cardStyle(ar: number): React.CSSProperties {
  return {
    ["--card-ar" as string]: `${ar} / 1`,
    ["--card-ar-num" as string]: `${ar}`,
  } as React.CSSProperties;
}

/**
 * 根据选中片段自动生成输出文件名：片段名（clip_title）+ 段数 + 时间戳，
 * 保证唯一且无需用户手动输入。中文片段名会被后端保留。
 */
function buildOutputName(segs: SegType[]): string {
  if (segs.length === 0) return "";
  const title = (segs[0].clip_title || "成片").trim();
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${title}_${segs.length}段_${ts}`;
}

export function VideoEditorPage({ project }: Props) {
  const { toast } = useToast();

  const [clips, setClips] = useState<Clip[]>([]);
  const [clipId, setClipId] = useState<string | null>(null);
  const [loadingClips, setLoadingClips] = useState(true);

  // ── 左侧片段栏：常驻展开，可点击收起 ──
  const [railCollapsed, setRailCollapsed] = useState(false);
  const toggleRail = useCallback(() => setRailCollapsed((v) => !v), []);


  const [segments, setSegments] = useState<SegType[]>([]);
  const [loadingSegs, setLoadingSegs] = useState(false);
  const [metaMap, setMetaMap] = useState<Record<string, VideoMeta>>({});

  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [outputs, setOutputs] = useState<ConcatResult[]>([]);

  // ── 自定义鼠标拖拽排序（DOM 直操作 + rAF + 卡片让位动画） ──
  const [dragState, setDragState] = useState<{ idx: number } | null>(null);
  const [insertIdx, setInsertIdx] = useState<number | null>(null);
  const [shiftMap, setShiftMap] = useState<Record<number, number>>({});
  const dragRef = useRef<{
    idx: number;
    startX: number;
    currentX: number;
    cardWidth: number;
    el: HTMLDivElement | null;
    rafId: number;
  } | null>(null);
  const justDraggedRef = useRef(false);
  const cardElRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // 单播放控制：同一时刻仅一个 <video> 在播放
  const [playingId, setPlayingId] = useState<string | null>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const setVideoRef = (id: string) => (el: HTMLVideoElement | null) => {
    if (el) videoRefs.current.set(id, el);
    else videoRefs.current.delete(id);
  };
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const pauseOthers = useCallback((exceptId: string) => {
    videoRefs.current.forEach((el, key) => {
      if (key !== exceptId && !el.paused) el.pause();
    });
  }, []);
  // ── 自定义播放控件状态（仅追踪当前播放的那个视频） ──
  const [playCur, setPlayCur] = useState(0);
  const [playDur, setPlayDur] = useState(0);

  const onVideoPlay = useCallback(
    (id: string) => {
      pauseOthers(id);
      setPlayingId(id);
      const el = videoRefs.current.get(id);
      if (el) {
        setPlayCur(el.currentTime);
        if (el.duration && Number.isFinite(el.duration)) setPlayDur(el.duration);
      }
    },
    [pauseOthers],
  );
  const onVideoPause = useCallback((id: string) => {
    setPlayingId((p) => (p === id ? null : p));
  }, []);

  const togglePlay = useCallback((id: string) => {
    const el = videoRefs.current.get(id);
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }, []);

  const onTimeUpdate = useCallback(
    (id: string, el: HTMLVideoElement) => {
      if (playingId !== id) return;
      setPlayCur(el.currentTime);
      if (el.duration && Number.isFinite(el.duration)) setPlayDur(el.duration);
    },
    [playingId],
  );

  const seekTo = useCallback((id: string, ratio: number) => {
    const el = videoRefs.current.get(id);
    if (!el || !el.duration || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(1, ratio)) * el.duration;
  }, []);

  // 进度条按下即定位，可拖动
  const onSeekPointer = useCallback(
    (id: string) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const track = e.currentTarget;
      const apply = (clientX: number) => {
        const rect = track.getBoundingClientRect();
        if (rect.width > 0) seekTo(id, (clientX - rect.left) / rect.width);
      };
      apply(e.clientX);
      const move = (ev: PointerEvent) => apply(ev.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [seekTo],
  );

  const toggleFullscreen = useCallback((id: string) => {
    const el = videoRefs.current.get(id);
    if (!el) return;
    // 对包含 video 与控件条的容器全屏，而非 video 自身，
    // 否则自定义控件条（video 的兄弟节点）不会进入全屏
    const container = el.parentElement ?? el;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      container.requestFullscreen?.();
    }
  }, []);

  // 自定义控件条：播放时覆盖在视频底部
  const renderControls = (id: string) => {
    const ratio = playDur > 0 ? Math.min(1, playCur / playDur) : 0;
    return (
      <div
        className="ve-ctrl"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ve-ctrl-row">
          <button
            className="ve-ctrl-btn"
            title="暂停"
            onClick={(e) => {
              e.stopPropagation();
              togglePlay(id);
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          </button>
          <div className="ve-ctrl-times">
            <span className="ve-ctrl-time">{fmtDur(playCur)}</span>
            <span className="ve-ctrl-time">{fmtDur(playDur)}</span>
          </div>
          <button
            className="ve-ctrl-btn"
            title="全屏"
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen(id);
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </button>
        </div>
        <div className="ve-ctrl-track">
          <div className="ve-ctrl-bar" onPointerDown={onSeekPointer(id)}>
            <div className="ve-ctrl-fill" style={{ width: `${ratio * 100}%` }}>
              <span className="ve-ctrl-knob" />
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── 加载片段列表（仅已拆解） ──
  useEffect(() => {
    if (!project) return;
    setLoadingClips(true);
    listClips(project.id)
      .then((c) => {
        const decomposed = c.filter((x) => isClipDecomposed(x.status));
        setClips(decomposed);
        setClipId((prev) =>
          prev && decomposed.some((x) => x.id === prev)
            ? prev
            : (decomposed[0]?.id ?? null),
        );
      })
      .catch(() => toast("加载片段失败", "error"))
      .finally(() => setLoadingClips(false));
  }, [project?.id, toast]);

  // ── 检测 ffmpeg ──
  useEffect(() => {
    detectFFmpeg()
      .then((s) => setFfmpegOk(s.available))
      .catch(() => setFfmpegOk(false));
  }, []);

  // ── 加载选中片段的可拼接视频 + 已存成片 ──
  useEffect(() => {
    if (!clipId) {
      setSegments([]);
      setOutputs([]);
      return;
    }
    let cancelled = false;
    setLoadingSegs(true);
    setPlayingId(null);
    listClipConcatVideos(clipId)
      .then((list) => {
        if (cancelled) return;
        setSegments(list.map((s) => ({ ...s, enabled: true })));
      })
      .catch(() => {
        if (!cancelled) toast("加载分镜视频失败", "error");
      })
      .finally(() => {
        if (!cancelled) setLoadingSegs(false);
      });
    // 同时加载该片段已保存的成片
    listConcatOutputs(clipId)
      .then((rows) => {
        if (cancelled) return;
        setOutputs(
          rows.map((r): ConcatResult => ({
            id: r.id,
            output_path: r.output_path,
            file_name: r.file_name,
            duration: r.duration,
            segment_count: r.segment_count,
            audio_included: r.audio_included,
          })),
        );
      })
      .catch(() => {
        // 表可能尚未创建，静默失败
      });
    return () => {
      cancelled = true;
    };
  }, [clipId, toast]);

  // 卡片默认比例（元数据加载前先用 16:9 占位）
  const defaultAR = 16 / 9;
  const enabledCount = segments.filter((s) => s.enabled).length;

  const canConcat = ffmpegOk === true && enabledCount > 0 && !running && !!clipId;

  const stageText = useMemo(() => {
    if (running) {
      if (stage === "done") return "拼接完成";
      return `拼接处理中 ${progress.toFixed(0)}%`;
    }
    if (ffmpegOk === false) return "未检测到 ffmpeg，无法拼接";
    return "";
  }, [running, stage, progress, ffmpegOk]);

  const onSegMetadata = useCallback((storyboardId: string, el: HTMLVideoElement) => {
    const ar = el.videoWidth / el.videoHeight;
    const dur = el.duration;
    if (Number.isFinite(ar) && ar > 0) {
      setMetaMap((m) => {
        const prev = m[storyboardId];
        if (prev && prev.ar === ar && prev.dur === dur) return m;
        return { ...m, [storyboardId]: { ar, dur } };
      });
    } else if (Number.isFinite(dur) && dur > 0) {
      // 仅拿到时长
      setMetaMap((m) => ({ ...m, [storyboardId]: { ar: m[storyboardId]?.ar ?? 16 / 9, dur } }));
    }
  }, []);


  const toggleSeg = useCallback((i: number) => {
    setSegments((ss) => ss.map((x, idx) => (idx === i ? { ...x, enabled: !x.enabled } : x)));
  }, []);

  const allEnabled = segments.length > 0 && enabledCount === segments.length;
  const toggleAll = useCallback(
    () =>
      setSegments((ss) => {
        const next = !(ss.length > 0 && ss.every((x) => x.enabled));
        return ss.map((x) => ({ ...x, enabled: next }));
      }),
    [],
  );

  const reorder = useCallback((from: number, to: number) => {
    if (from === to) return;
    setSegments((ss) => {
      const next = [...ss];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // ── 自定义鼠标拖拽排序 ──

  /** 根据鼠标 X 坐标估算拖拽到的目标位置 */
  function computeInsertIdx(mouseX: number, fromIdx: number): number {
    let insertAt = fromIdx;
    const els = cardElRefs.current;
    for (let j = 0; j < segments.length; j++) {
      if (j === fromIdx) continue;
      const el = els.get(j);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const midX = r.left + r.width / 2;
      if (j > fromIdx && mouseX > midX) insertAt = j + 1;
      else if (j < fromIdx && mouseX < midX) insertAt = j;
    }
    return Math.max(0, Math.min(insertAt, segments.length));
  }

  // 文档级鼠标事件监听（保证超出容器也能正常结束）
  useEffect(() => {
    if (!dragState) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.currentX = e.clientX;
      if (Math.abs(d.currentX - d.startX) > 4) justDraggedRef.current = true;

      // 直接操作 DOM 做偏移 — 不经过 React state，不触发重渲染
      const offsetX = d.currentX - d.startX;
      if (d.el) d.el.style.setProperty("--drag-offset-x", `${offsetX}px`);

      // rAF 节流：落点 + 卡片让位计算最多每帧一次
      if (!d.rafId) {
        d.rafId = requestAnimationFrame(() => {
          d.rafId = 0;
          if (!dragRef.current) return;
          const dr = dragRef.current;
          const newIdx = computeInsertIdx(dr.currentX, dr.idx);
          setInsertIdx(newIdx);

          // 计算其他卡片需平移的量（为大厂式"让位"动画）
          const shifts: Record<number, number> = {};
          const from = dr.idx;
          const cw = dr.cardWidth || 0;
          if (from < newIdx) {
            // 右拖：收紧左侧缺口，但在落点 card 前留出开口（不含 newIdx）
            for (let j = from + 1; j < newIdx; j++) shifts[j] = -cw;
          } else if (from > newIdx) {
            // 左拖：向右推开，自然形成开口
            for (let j = newIdx; j < from; j++) shifts[j] = cw;
          }
          setShiftMap(shifts);
        });
      }
    };

    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;

      // 清理 rAF
      if (d.rafId) cancelAnimationFrame(d.rafId);

      // 清除 DOM 偏移
      if (d.el) d.el.style.removeProperty("--drag-offset-x");

      // 执行重排
      const to = computeInsertIdx(d.currentX, d.idx);
      if (to !== d.idx) reorder(d.idx, to);

      // 清理状态（shiftMap 先清零让卡片动画回原位，再一次性重排）
      setShiftMap({});
      dragRef.current = null;
      setDragState(null);
      setInsertIdx(null);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragState, reorder, segments]);

  const openInFolderHandler = useCallback(async (path: string) => {
    try {
      await openInFolder(path);
    } catch (err) {
      toast(`打开文件夹失败：${String(err)}`, "error");
    }
  }, [toast]);

  /** 删除某条成片（数据库记录 + 磁盘文件） */
  const handleDeleteOutput = useCallback(async (out: ConcatResult) => {
    if (!out.id) {
      toast("该成片暂不可删除（缺少记录 ID）", "error");
      return;
    }
    if (!window.confirm(`确认删除成片 ${out.file_name}？`)) return;
    try {
      await deleteConcatOutput(out.id, true);
      setOutputs((prev) => prev.filter((o) => o.id !== out.id));
      // 若该成片正在播放，则停止播放（卡片随列表重排，index 会变化）
      if (playingId?.startsWith("output_")) {
        videoRefs.current.forEach((el) => el.pause());
        setPlayingId(null);
      }
      toast("成片已删除", "success");
    } catch (err) {
      toast(`删除失败：${String(err)}`, "error");
    }
  }, [toast, playingId]);

  const handleConcat = useCallback(async () => {
    if (!clipId) return;
    const enabled = segments.filter((s) => s.enabled);
    if (enabled.length === 0) return;
    const paths = enabled.map((s) => s.file_path);
    const outputName = buildOutputName(enabled);

    setRunning(true);
    setProgress(0);
    setStage("preparing");

    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<ConcatProgressEvent>("concat-progress", (e) => {
        setProgress(e.payload.percent);
        setStage(e.payload.stage);
      });
      const res = await concatStoryboardVideos({
        clip_id: clipId,
        segments: paths,
        output_name: outputName,
      });
      // 持久化到数据库，并取回新记录 id 以便删除
      const savedId = await saveConcatOutput({
        clip_id: clipId,
        output_path: res.output_path,
        file_name: res.file_name,
        duration: res.duration,
        segment_count: res.segment_count,
        audio_included: res.audio_included,
      }).catch(() => undefined);
      setOutputs((prev) => [{ ...res, id: savedId }, ...prev]);
      toast(`拼接完成：${res.file_name}`, "success");
    } catch (err) {
      toast(`拼接失败：${String(err)}`, "error");
      setProgress(0);
      setStage("");
    } finally {
      unlisten?.();
      setRunning(false);
    }
  }, [clipId, segments, toast]);

  const showEmpty = !loadingClips && clips.length === 0;

  return (
    <div className="rail-layout ve-layout">
      {/* ── 左侧片段栏（常驻，可点击收起） ── */}
      <div
        className={`rail-clips${railCollapsed ? " is-collapsed" : " is-expanded"}`}
      >
        <div className="rail-clips-inner">
          <div className="rail-clips-head">
            <span className="rail-clips-head-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
            </span>
            <span className="rail-clips-head-text">片段列表</span>
          </div>
          {loadingClips ? (
            <p className="rail-clips-empty">加载中…</p>
          ) : showEmpty ? (
            <p className="rail-clips-empty">暂无片段</p>
          ) : (
            <div className="rail-clips-list">
              {clips.map((c) => {
                const colors = avatarColor(c.sort_index);
                return (
                <button
                  key={c.id}
                  className={`rail-clips-item${c.id === clipId ? " on" : ""}`}
                  onClick={() => setClipId(c.id)}
                  title={c.title}
                >
                  <span className="rail-clips-item-num" style={{ background: colors.bg, color: colors.text }}>{c.sort_index}</span>
                  <span className="rail-clips-item-text">
                    <span className="rail-clips-item-title">{c.title}</span>
                  </span>
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
            <path d={railCollapsed ? "M6 4L10 8L6 12" : "M10 4L6 8L10 12"} />
          </svg>
        </button>
      </div>

      {/* ── 主区 ── */}
      <div className="rail-main ve-main">
        {ffmpegOk === false && (
          <div className="ve-warn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            未检测到 ffmpeg，无法执行拼接。请将 ffmpeg 置于应用 ffmpeg 目录下。
          </div>
        )}

        <div className="ve-split">
          {/* 上：视频拼接 */}
          <section className="ve-panel ve-panel--top">
            <div className="ve-strip-head">
                <div className="ve-strip-title-wrap">
                  <span className="ve-strip-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <line x1="3" y1="9" x2="21" y2="9" />
                      <line x1="9" y1="21" x2="9" y2="9" />
                    </svg>
                  </span>
                  <div className="ve-strip-title-texts">
                    <span className="ve-strip-title">分镜视频</span>
                    <span className="ve-strip-sub">按此顺序拼接 · 可拖拽排序</span>
                  </div>
                </div>
                <div className="ve-strip-tools">
                  <button
                    className="ve-tool-btn"
                    disabled={running || segments.length === 0}
                    onClick={toggleAll}
                  >
                    {allEnabled ? "清空" : "全选"}
                  </button>
                  <span className="ve-strip-count">{enabledCount}/{segments.length} 段</span>
                  <button
                    className="primary-button ve-concat-btn"
                    disabled={!canConcat}
                    onClick={handleConcat}
                  >
                    {running ? (
                      <>
                        <span className="ve-btn-spinner" />
                        {stageText}
                      </>
                    ) : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="17 1 21 5 17 9" />
                          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                          <polyline points="7 23 3 19 7 15" />
                          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                        </svg>
                        开始拼接
                      </>
                    )}
                  </button>
                </div>
              </div>

              {loadingSegs ? (
                <div className="ve-strip-empty">加载中…</div>
              ) : segments.length === 0 ? (
                <div className="ve-strip-empty">暂无分镜视频</div>
              ) : (
                <div className="ve-cards" ref={cardsRef}>
                  {segments.map((seg, i) => {
                    const meta = metaMap[seg.storyboard_id];
                    const ar = meta?.ar ?? defaultAR;
                    const dur = meta?.dur ?? seg.duration;
                    const playing = playingId === seg.storyboard_id;
                    const isDragged = dragState?.idx === i;
                    const isShifted = shiftMap[i] !== undefined;
                    return (
                      <Fragment key={seg.storyboard_id}>
                        {/* 间隙式落点指示 — 独立于卡片，在两张卡片之间 */}
                        {insertIdx === i && !isDragged && dragState && (
                          <div className="ve-card-gap" />
                        )}
                        <div
                          ref={(el) => {
                            if (el) cardElRefs.current.set(i, el);
                            else cardElRefs.current.delete(i);
                          }}
                          className={`ve-card${seg.enabled ? " selected" : " off"}${playing ? " playing" : ""}${isDragged ? " dragging" : isShifted ? " shifting" : ""}`}
                          style={{
                            ...cardStyle(ar),
                            ...(isDragged
                              ? { zIndex: 10, cursor: "grabbing" }
                              : isShifted
                                ? { transform: `translateX(${shiftMap[i]}px)` }
                                : {}),
                          }}
                          onMouseDown={(e) => {
                            if ((e.target as HTMLElement).closest("button") || running || !!playingId) return;
                            justDraggedRef.current = false;
                            e.preventDefault();
                            const el = e.currentTarget as HTMLDivElement;
                            dragRef.current = {
                              idx: i,
                              startX: e.clientX,
                              currentX: e.clientX,
                              cardWidth: el.getBoundingClientRect().width,
                              el,
                              rafId: 0,
                            };
                            setDragState({ idx: i });
                          }}
                          onClick={() => {
                            if (justDraggedRef.current) {
                              justDraggedRef.current = false;
                              return;
                            }
                            togglePlay(seg.storyboard_id);
                          }}
                        >
                        <div className="ve-card-thumb">
                        <video
                          ref={setVideoRef(seg.storyboard_id)}
                          className="ve-card-video"
                          src={convertFileSrc(seg.file_path)}
                          muted={!playing}
                          preload="metadata"
                          playsInline
                          draggable={false}
                          onPlay={() => onVideoPlay(seg.storyboard_id)}
                          onPause={() => onVideoPause(seg.storyboard_id)}
                          onTimeUpdate={(e) => onTimeUpdate(seg.storyboard_id, e.currentTarget)}
                          onLoadedMetadata={(e) => onSegMetadata(seg.storyboard_id, e.currentTarget)}
                        />
                          {playing && renderControls(seg.storyboard_id)}
                          {!playing && (
                            <button
                              className="ve-card-play"
                              title="预览播放"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePlay(seg.storyboard_id);
                              }}
                            >
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            </button>
                          )}
                          <span className="ve-card-dur-b">{fmtClock(dur)}</span>
                          <span className="ve-card-seq-b">#{String(seg.seq).padStart(2, "0")}</span>
                          <button
                            className={`ve-card-check${seg.enabled ? " on" : ""}`}
                            title={seg.enabled ? "取消选择" : "选择拼接"}
                            disabled={running}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSeg(i);
                            }}
                          >
                            {seg.enabled && (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                      </Fragment>
                    );
                  })}
                  {/* 末尾落点指示 */}
                  {insertIdx === segments.length && dragState && (
                    <div className="ve-card-gap" />
                  )}
                </div>
              )}
                {running && (
                  <div className="ve-progress">
                    <div className="ve-progress-bar" style={{ width: `${progress}%` }} />
                  </div>
                )}
              </section>

            {/* 下：成片展示（不可拖拽） */}
            <section className="ve-panel ve-panel--bottom">
              <div className="ve-output-head">
                <div className="ve-output-title-wrap">
                  <span className="ve-output-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <polygon points="23 7 16 12 23 17 23 7" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                  </span>
                  <div className="ve-strip-title-texts">
                    <span className="ve-strip-title">成片</span>
                    <span className="ve-strip-sub">{`共 ${outputs.length} 个`}</span>
                  </div>
                </div>
              </div>
              {outputs.length === 0 ? (
                <div className="ve-strip-empty">暂无成片</div>
              ) : (
                <div className="ve-cards">
                  {outputs.map((out, idx) => {
                    const outId = `output_${idx}`;
                    const ar = metaMap[outId]?.ar ?? defaultAR;
                    const dur = metaMap[outId]?.dur ?? out.duration;
                    const outPlaying = playingId === outId;
                    return (
                      <div
                        className={`ve-card${outPlaying ? " playing" : ""}`}
                        key={idx}
                        style={cardStyle(ar)}
                        onClick={() => togglePlay(outId)}
                      >
                          <div className="ve-card-thumb">
                            <video
                              key={`out-v-${idx}`}
                              ref={setVideoRef(outId)}
                              className="ve-card-video"
                              src={convertFileSrc(out.output_path)}
                              muted={!outPlaying}
                              preload="metadata"
                              playsInline
                              onPlay={() => onVideoPlay(outId)}
                              onPause={() => onVideoPause(outId)}
                              onTimeUpdate={(e) => onTimeUpdate(outId, e.currentTarget)}
                              onLoadedMetadata={(e) =>
                                onSegMetadata(outId, e.currentTarget)
                              }
                            />
                            {outPlaying && renderControls(outId)}
                            {!outPlaying && (
                              <button
                                className="ve-card-play"
                                title="播放成片"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePlay(outId);
                                }}
                              >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M8 5v14l11-7z" />
                                </svg>
                              </button>
                            )}
                            <span className="ve-card-seq ve-card-seq--output">成片</span>
                            <button
                              className="ve-card-del"
                              title="删除成片"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteOutput(out);
                              }}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          </div>
                          <div className="ve-card-meta">
                            <span className="ve-output-card-meta-line">
                              <span className="ve-card-dur">{fmtClock(dur)}</span>
                              <span className="ve-output-card-btns">
                                <button
                                  className="ve-link-btn"
                                  title="打开所在文件夹"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openInFolderHandler(out.output_path);
                                  }}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                  </svg>
                                </button>
                              </span>
                            </span>
                          </div>
                        </div>
                    );
                  })}
                </div>
              )}
            </section>
        </div>
      </div>
    </div>
  );
}
