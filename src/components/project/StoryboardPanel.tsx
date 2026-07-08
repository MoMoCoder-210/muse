import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ProjectInfo, Clip, ClipScriptInfo, Storyboard, StoryboardAssetInfo, AssetType } from "../../types/project";
import {
  listClips, getClipScripts, listStoryboards, listClipAssets,
  updateStoryboardAssets, createStoryboard, deleteStoryboard, insertStoryboard,
  updateStoryboardParams,
} from "../../services/tauri";
import { useToast } from "../../hooks/useToast";
import { DeleteStoryboardConfirm } from "./DeleteStoryboardConfirm";
import { StoryboardConfirm } from "./StoryboardConfirm";

/* ========================================================================
   StoryboardPanel — 分镜管理（含视频生成）

   上方：选中分镜的视频 + 提示词 + 资产
   下方：分镜缩略图条，点击切换
   @author yt @date 20260708
   ======================================================================== */

type Props = { project: ProjectInfo };

const CATS: { type: AssetType; label: string; icon: string }[] = [
  { type: "character", label: "角色", icon: "👤" },
  { type: "scene", label: "场景", icon: "🏞" },
  { type: "item", label: "物品", icon: "📦" },
];

type ClipData = { storyboards: Storyboard[]; assets: StoryboardAssetInfo[]; loaded: boolean };

const parseIds = (j: string): Set<string> => { try { return new Set(JSON.parse(j) as string[]); } catch { return new Set(); } };

const RAIL_HOTZONE = 30;
const RAIL_WIDTH = 206;

export function StoryboardPanel({ project }: Props) {
  const { toast } = useToast();
  const [clips, setClips] = useState<Clip[]>([]);
  const [csList, setCsList] = useState<ClipScriptInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const [dataMap, setDataMap] = useState<Record<string, ClipData>>({});
  const dataMapRef = useRef(dataMap); dataMapRef.current = dataMap;
  const [railLocked, setRailLocked] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);

  const [clipId, setClipId] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Storyboard | null>(null);
  // 新增分镜：undefined=不弹窗, "__end__"=末尾添加, null=最前插入, string=在某分镜后插入
  const [insertAfterId, setInsertAfterId] = useState<string | null | undefined>(undefined);

  // ── 数据 ────────────────────────────────────────

  const loadAll = useCallback(async () => {
    if (!project) return; setLoading(true);
    try { const [c, cs] = await Promise.all([listClips(project.id), getClipScripts(project.id)]); setClips(c); setCsList(cs); }
    catch { toast("加载失败", "error"); } finally { setLoading(false); }
  }, [project?.id]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const filtered = useMemo(() => clips.filter((c) => csList.find((s) => s.clip_id === c.id)?.status === "success"), [clips, csList]);
  useEffect(() => { if (clipId && !filtered.find((c) => c.id === clipId)) setClipId(null); }, [filtered, clipId]);
  const clip = filtered.find((c) => c.id === clipId) ?? null;

  const loadSb = useCallback(async (cid: string) => {
    if (dataMapRef.current[cid]?.loaded) return;
    try { const [sb, as] = await Promise.all([listStoryboards(cid), listClipAssets(cid)]); setDataMap((p) => ({ ...p, [cid]: { storyboards: sb, assets: as, loaded: true } })); }
    catch { toast("加载分镜失败", "error"); }
  }, [toast]);
  useEffect(() => { if (clip) loadSb(clip.id); }, [clip?.id, loadSb]);

  // 切片段时重置选中索引
  useEffect(() => { setActiveIdx(0); }, [clipId]);

  const data = clip ? dataMap[clip.id] : null;
  const sbList = data?.storyboards ?? [];
  const assets = data?.assets ?? [];

  // 确保 activeIdx 不越界
  const safeIdx = Math.min(activeIdx, Math.max(sbList.length - 1, 0));
  const activeSb = sbList[safeIdx] ?? null;

  // ── 鼠标展开 ────────────────────────────────────

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!layoutRef.current) return;
    const x = e.clientX - layoutRef.current.getBoundingClientRect().left;
    setRailExpanded((p) => { if (p && x > RAIL_WIDTH) return false; if (!p && x < RAIL_HOTZONE) return true; return p; });
  }, []);

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
    setSaving(deleteTarget.id); setDeleteTarget(null);
    try {
      await deleteStoryboard({ storyboard_id: deleteTarget.id });
      // 删除后重新加载，确保 seq_num 与数据库一致
      setDataMap((p) => ({ ...p, [deleteTarget.clip_id]: { ...p[deleteTarget.clip_id], loaded: false } }));
      dataMapRef.current = { ...dataMapRef.current, [deleteTarget.clip_id]: { ...dataMapRef.current[deleteTarget.clip_id], loaded: false } };
      await loadSb(deleteTarget.clip_id);
    }
    catch { toast("删除失败", "error"); } finally { setSaving(null); }
  }, [deleteTarget, toast, loadSb]);

  const busy = saving !== null;

  return (
    <div className="rail-layout" ref={layoutRef} onMouseMove={handleMouseMove}>
      {/* ── 左侧轨道 ── */}
      <div className={`rail-clips${railLocked ? " is-locked" : clip ? (railExpanded ? " is-expanded" : "") : " is-locked-open"}`} onMouseLeave={() => setRailLocked(false)}>
        <div className="rail-clips-inner">
          <div className="rail-clips-head">
            <span className="rail-clips-head-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg></span>
            <span className="rail-clips-head-text">片段列表</span>
          </div>
          {loading ? <p className="rail-clips-empty">加载中…</p> : filtered.length === 0 ? <p className="rail-clips-empty">暂无片段</p> : (
            <div className="rail-clips-list">
              {filtered.map((c) => (
                <button key={c.id} className={`rail-clips-item${c.id === clipId ? " on" : ""}`} onClick={() => { setClipId(c.id); setRailLocked(true); }} title={c.title}>
                  <span className="rail-clips-item-num">{c.sort_index}</span>
                  <span className="rail-clips-item-text"><span className="rail-clips-item-title">{c.title}</span>{dataMap[c.id]?.loaded && <span className="rail-clips-item-cnt">{dataMap[c.id].storyboards.length} 镜</span>}</span>
                </button>
              ))}
            </div>
          )}
        </div>
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
                  onToggle={(a) => toggleLink(activeSb, a)}
                  onBatchToggle={batchToggleLink}
                />
              )}

              {/* ========== 下方：缩略图条 ========== */}
              <div className="sb-strip-wrap">
                <div className="sb-strip">
                  {/* 最前插入 */}
                  <button className="sb-strip-insert" onClick={() => setInsertAfterId("__first__")} disabled={busy} title="在最前插入">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  </button>

                  {sbList.map((sb, i) => {
                    const videoSrc = sb.video_path ? convertFileSrc(sb.video_path) : null;
                    const sec = Math.round(sb.video_duration ?? sb.voice_duration ?? 0);
                    return (
                      <div key={sb.id} className="sb-strip-group">
                        <button
                          className={`sb-strip-item${i === safeIdx ? " on" : ""}`}
                          onClick={() => setActiveIdx(i)}
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
                            <button
                              className="sb-strip-del"
                              onClick={(ev) => { ev.stopPropagation(); setDeleteTarget(sb); }}
                              disabled={busy}
                              title="删除"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                          </div>
                          <span className="sb-strip-dur">#{String(sb.seq_num).padStart(2, "0")} · {sec > 0 ? `${sec}S` : "--S"}</span>
                        </button>

                        {/* 卡片间插入 */}
                        <button className="sb-strip-insert" onClick={() => setInsertAfterId(sb.id)} disabled={busy} title="在此后插入">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </button>
                      </div>
                    );
                  })}

                  {/* 末尾添加 */}
                  <button className="sb-strip-item sb-strip-item--add" onClick={() => setInsertAfterId(null)} disabled={busy} title="追加到末尾">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 删除确认框 */}
      {deleteTarget && (
        <DeleteStoryboardConfirm
          sb={deleteTarget}
          onConfirm={delSb}
          onCancel={() => setDeleteTarget(null)}
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
     左侧：批次缩略图列表（竖列）
     右侧：视频生成参数（模型/时长/分辨率/宽高比 + 生成按钮）
   所有参数失焦保存。
   ======================================================================== */

type DetailProps = {
  sb: Storyboard; assets: StoryboardAssetInfo[];
  busy: boolean; saving: boolean;
  onToggle: (a: StoryboardAssetInfo) => void;
  onBatchToggle: (sb: Storyboard, ids: { character: Set<string>; scene: Set<string>; item: Set<string> }) => Promise<void>;
};

/** 视频参数结构 */
interface VideoParams {
  model: string;
  duration: number;
  resolution: string;
  aspect_ratio: string;
}

const DEFAULT_VIDEO_PARAMS: VideoParams = {
  model: "kling-v1",
  duration: 5,
  resolution: "1080p",
  aspect_ratio: "16:9",
};

const MODEL_OPTIONS = ["kling-v1", "kling-v1.5", "sora-v1", "veo-v1"];
const DURATION_OPTIONS = [5, 10, 15, 30, 60];
const RESOLUTION_OPTIONS = ["720p", "1080p", "2K", "4K"];
const ASPECT_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

function parseVideoParams(json: string | null): VideoParams {
  if (!json) return { ...DEFAULT_VIDEO_PARAMS };
  try {
    const obj = JSON.parse(json);
    return {
      model: obj.model || DEFAULT_VIDEO_PARAMS.model,
      duration: obj.duration || DEFAULT_VIDEO_PARAMS.duration,
      resolution: obj.resolution || DEFAULT_VIDEO_PARAMS.resolution,
      aspect_ratio: obj.aspect_ratio || DEFAULT_VIDEO_PARAMS.aspect_ratio,
    };
  } catch {
    return { ...DEFAULT_VIDEO_PARAMS };
  }
}

function DetailView({ sb, assets, busy, saving, onToggle, onBatchToggle }: DetailProps) {
  const cIds = parseIds(sb.character_ids_json), sIds = parseIds(sb.scene_ids_json), iIds = parseIds(sb.item_ids_json);
  const linked = (a: StoryboardAssetInfo) => a.type === "character" ? cIds.has(a.asset_id) : a.type === "scene" ? sIds.has(a.asset_id) : iIds.has(a.asset_id);
  const videoPaths = useMemo<string[]>(() => {
    const paths: string[] = [];
    if (sb.video_path) paths.push(sb.video_path);
    return paths;
  }, [sb.video_path]);
  const [activeVideoIdx, setActiveVideoIdx] = useState(0);
  const currentVideoSrc = videoPaths[activeVideoIdx] ? convertFileSrc(videoPaths[activeVideoIdx]) : null;

  // ── 视频参数状态（从 sb.video_param_json 初始化） ──
  const [params, setParams] = useState<VideoParams>(() => parseVideoParams(sb.video_param_json));
  const [prompt, setPrompt] = useState(sb.video_prompt || "");
  const paramsRef = useRef(params); paramsRef.current = params;
  const promptRef = useRef(prompt); promptRef.current = prompt;
  const sbIdRef = useRef(sb.id); sbIdRef.current = sb.id;

  // 切换分镜时重置参数
  useEffect(() => {
    setParams(parseVideoParams(sb.video_param_json));
    setPrompt(sb.video_prompt || "");
  }, [sb.id, sb.video_param_json, sb.video_prompt]);

  // 失焦保存
  const saveParams = useCallback(async () => {
    try {
      await updateStoryboardParams({
        storyboard_id: sbIdRef.current,
        video_param_json: JSON.stringify(paramsRef.current),
        video_prompt: promptRef.current || null,
      });
    } catch {
      // 静默失败，失焦保存不需要 toast
    }
  }, []);

  const updateParam = useCallback(<K extends keyof VideoParams>(key: K, value: VideoParams[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  const [pickerCat, setPickerCat] = useState<AssetType | null>(null);
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());

  return (
    <div className={`sd-detail${saving ? " is-busy" : ""}`}>
      {/* 上方两栏：视频播放器 50% | 提示词 50% */}
      <div className="sd-detail-top">
        {/* 左侧：视频播放器 */}
        <div className="sd-detail-left">
          {currentVideoSrc ? (
            <video className="sd-detail-video-el" src={currentVideoSrc} controls preload="metadata" />
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
            <textarea
              className="sd-detail-prompt-text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={saveParams}
              placeholder="暂无提示词"
              rows={4}
            />
          </div>
        </div>
      </div>

      {/* 下方批次区：全宽 */}
      <div className="sd-section">
        <div className="sd-batch-thumbs">
          {videoPaths.map((path, i) => (
            <button
              key={i}
              className={`sd-video-thumb${i === activeVideoIdx ? " on" : ""}`}
              onClick={() => setActiveVideoIdx(i)}
            >
              <video src={convertFileSrc(path)} muted preload="metadata" />
              <span className="sd-video-thumb-label">B{i + 1}</span>
            </button>
          ))}
          {videoPaths.length === 0 && (
            <button className="sd-video-thumb sd-video-thumb--empty" disabled>
              <svg viewBox="0 0 80 60" fill="none" width="22" height="16">
                <rect width="80" height="60" rx="4" fill="var(--bg-input)" />
                <rect x="10" y="20" width="4" height="6" rx="1" fill="rgba(var(--text-muted-rgb),0.25)" />
                <rect x="10" y="34" width="4" height="6" rx="1" fill="rgba(var(--text-muted-rgb),0.25)" />
                <rect x="66" y="20" width="4" height="6" rx="1" fill="rgba(var(--text-muted-rgb),0.25)" />
                <rect x="66" y="34" width="4" height="6" rx="1" fill="rgba(var(--text-muted-rgb),0.25)" />
                <circle cx="40" cy="30" r="9" fill="rgba(0,0,0,0.22)" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" />
                <polygon points="37,25 37,35 43,30" fill="rgba(255,255,255,0.35)" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 底部两栏：左资产 | 右参数 */}
      <div className="sd-bottom-row">
        {/* 左侧：资产 */}
        <div className="sd-section sd-section--assets">
          <span className="sd-section-label">关联资产</span>
          <div className="sd-detail-assets">
            {CATS.map((cat) => {
              const linkedList = assets.filter((a) => a.type === cat.type && linked(a));
              return (
                <div key={cat.type} className="sd-detail-asset-row">
                  <span className="sd-detail-asset-icon">{cat.icon}</span>
                  <div className="sd-detail-asset-chips">
                    {linkedList.map((a) => {
                      const img = a.selected_image_path ? convertFileSrc(a.selected_image_path) : null;
                      return (
                        <span key={a.asset_id} className="sd-detail-chip on" title={a.description || a.name}>
                          {img && <span className="sd-detail-chip-img"><img src={img} alt="" /></span>}
                          <span className="sd-detail-chip-name">{a.name}</span>
                          <button className="sd-detail-chip-x" disabled={busy} onClick={() => onToggle(a)} title="取消关联">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        </span>
                      );
                    })}
                    <button className="sd-detail-chip sd-detail-chip--add" disabled={busy} onClick={() => setPickerCat(cat.type)} title={`关联${cat.label}`}>+</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 右侧：视频生成参数 */}
        <div className="sd-section sd-section--params">
          <span className="sd-section-label">生成参数</span>
          <div className="sd-params-labels">
            <span className="sd-param-label">模型</span>
            <span className="sd-param-label">时长</span>
            <span className="sd-param-label">分辨率</span>
            <span className="sd-param-label">宽高比</span>
          </div>
          <div className="sd-params-controls">
            <select className="sd-param-select" value={params.model} onChange={(e) => updateParam("model", e.target.value)} onBlur={saveParams}>
              {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select className="sd-param-select" value={params.duration} onChange={(e) => updateParam("duration", Number(e.target.value))} onBlur={saveParams}>
              {DURATION_OPTIONS.map((d) => <option key={d} value={d}>{d}s</option>)}
            </select>
            <select className="sd-param-select" value={params.resolution} onChange={(e) => updateParam("resolution", e.target.value)} onBlur={saveParams}>
              {RESOLUTION_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select className="sd-param-select" value={params.aspect_ratio} onChange={(e) => updateParam("aspect_ratio", e.target.value)} onBlur={saveParams}>
              {ASPECT_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <button className="sd-generate-btn primary-button" disabled={busy}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5,3 19,12 5,21"/></svg>
            生成视频
          </button>
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
                  <button type="button" className="primary-button btn-sm" onClick={confirmPick} disabled={busy || !hasSelection}>
                    确定{hasSelection ? ` (${pickerSelected.size})` : ""}
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
