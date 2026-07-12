import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ProjectInfo, Clip, ClipScriptInfo, Storyboard, StoryboardAssetInfo, AssetType } from "../../types/project";
import {
  listClips, getClipScripts, listStoryboards, listClipAssets,
  updateStoryboardAssets, createStoryboard, deleteStoryboard, insertStoryboard,
  updateStoryboardParams, updateStoryboardDuration, getSettings,
} from "../../services/tauri";
import { getActiveChannel } from "../../types/settings";
import { useToast } from "../../hooks/useToast";
import { DeleteStoryboardConfirm } from "./DeleteStoryboardConfirm";
import { StoryboardConfirm } from "./StoryboardConfirm";
import {
  VIDEO_DURATION_MIN, VIDEO_DURATION_MAX, VIDEO_ASPECT_OPTIONS,
  VIDEO_DEFAULT_MODEL, VIDEO_DEFAULT_DURATION, VIDEO_DEFAULT_RESOLUTION, VIDEO_DEFAULT_ASPECT,
  VIDEO_RESOLUTION_OPTIONS,
} from "../../config/muse";

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
  // 用户在设置里为「视频」激活渠道配置的模型 → 其支持的分辨率；未配置则为空对象
  const [videoModels, setVideoModels] = useState<Record<string, string[]>>({});

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
                  videoModels={videoModels}
                  onToggle={(a) => toggleLink(activeSb, a)}
                  onBatchToggle={batchToggleLink}
                  onDurationWrite={updateSbDuration}
                />
              )}

              {/* ========== 下方：缩略图条 ========== */}
              <div
                className="sb-strip-wrap"
                onWheel={(e) => {
                  const el = e.currentTarget;
                  el.scrollLeft += e.deltaY;
                }}
              >
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
                        </div>

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
     左侧：视频批次缩略图（横排）
     右侧：视频生成参数（模型/时长/分辨率/宽高比 + 生成按钮）
   所有参数失焦保存。
   ======================================================================== */

type DetailProps = {
  sb: Storyboard; assets: StoryboardAssetInfo[];
  busy: boolean; saving: boolean;
  /** 设置里配置的视频模型 → 支持分辨率映射；为空表示未配置 */
  videoModels: Record<string, string[]>;
  onToggle: (a: StoryboardAssetInfo) => void;
  onBatchToggle: (sb: Storyboard, ids: { character: Set<string>; scene: Set<string>; item: Set<string> }) => Promise<void>;
  /** 实时写回分镜时长的回调（分镜记录上的秒数，可编辑） */
  onDurationWrite: (sb: Storyboard, duration: number | null) => void;
};

/** 视频参数结构 */
interface VideoParams {
  model: string;
  duration: number;
  resolution: string;
  aspect_ratio: string;
}

const DEFAULT_VIDEO_PARAMS: VideoParams = {
  model: VIDEO_DEFAULT_MODEL,
  duration: VIDEO_DEFAULT_DURATION,
  resolution: VIDEO_DEFAULT_RESOLUTION,
  aspect_ratio: VIDEO_DEFAULT_ASPECT,
};

/** 根据模型 ID 获取支持的分辨率列表（取设置里配置的支持分辨率；未配置则回退到全部分辨率选项） */
function getResolutions(modelId: string, modelResMap: Record<string, string[]>): string[] {
  return (modelResMap[modelId] && modelResMap[modelId].length)
    ? modelResMap[modelId]
    : [...VIDEO_RESOLUTION_OPTIONS];
}

/** 将任意时长值夹取到合法范围内的整数 */
function clampDuration(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return Math.min(VIDEO_DURATION_MAX, Math.max(VIDEO_DURATION_MIN, Math.round(v)));
}

/**
 * 解析视频参数。
 * @param json         已保存的 video_param_json
 * @param dbDuration   分镜数据库中存储的时长（video_duration ?? voice_duration），用作时长回退
 * @param videoModels  设置里配置的视频模型 → 分辨率映射，用于校验/回退模型与分辨率；为空表示未配置
 */
function parseVideoParams(json: string | null, dbDuration: number | null, videoModels: Record<string, string[]>): VideoParams {
  const fallbackDuration = clampDuration(dbDuration) ?? DEFAULT_VIDEO_PARAMS.duration;
  // 默认模型取用户配置的第一个；未配置则为空字符串（下拉展示空）
  const defaultModel = Object.keys(videoModels)[0] ?? "";
  const base: VideoParams = { ...DEFAULT_VIDEO_PARAMS, model: defaultModel, duration: fallbackDuration };
  if (!json) return base;
  try {
    const obj = JSON.parse(json);
    // 模型：不在用户配置的模型映射中则回退到第一个（无配置则为空）
    const model = Object.prototype.hasOwnProperty.call(videoModels, obj.model) ? obj.model : defaultModel;
    // 分辨率：不在该模型支持列表中则取第一个
    const allowed = getResolutions(model, videoModels);
    const resolution = allowed.includes(obj.resolution) ? obj.resolution : allowed[0];
    return {
      model,
      // 时长以分镜记录本身（模型拆解出来的秒数）为准，忽略参数 JSON 中的值
      duration: base.duration,
      resolution,
      aspect_ratio: VIDEO_ASPECT_OPTIONS.includes(obj.aspect_ratio) ? obj.aspect_ratio : base.aspect_ratio,
    };
  } catch {
    return base;
  }
}

function DetailView({ sb, assets, busy, saving, videoModels, onToggle, onBatchToggle, onDurationWrite }: DetailProps) {
  const cIds = parseIds(sb.character_ids_json), sIds = parseIds(sb.scene_ids_json), iIds = parseIds(sb.item_ids_json);
  const linked = (a: StoryboardAssetInfo) => a.type === "character" ? cIds.has(a.asset_id) : a.type === "scene" ? sIds.has(a.asset_id) : iIds.has(a.asset_id);
  const videoPaths = useMemo<string[]>(() => {
    const paths: string[] = [];
    if (sb.video_path) paths.push(sb.video_path);
    return paths;
  }, [sb.video_path]);
  const [activeVideoIdx, setActiveVideoIdx] = useState(0);
  const currentVideoSrc = videoPaths[activeVideoIdx] ? convertFileSrc(videoPaths[activeVideoIdx]) : null;

  // ── 视频参数状态（从 sb.video_param_json 初始化，时长回退到数据库存储时长） ──
  const [params, setParams] = useState<VideoParams>(() => parseVideoParams(sb.video_param_json, sb.video_duration ?? sb.voice_duration, videoModels));
  const [prompt, setPrompt] = useState(sb.video_prompt || "");
  const paramsRef = useRef(params); paramsRef.current = params;
  const promptRef = useRef(prompt); promptRef.current = prompt;
  const sbIdRef = useRef(sb.id); sbIdRef.current = sb.id;

  // 格式化显示：c01/c02... 前换行（兼容前面有空格或无空格）
  const formatPrompt = (raw: string) => raw.replace(/\s*(c\d{2,},\d+s,)/g, "\n\n$1").trim();
  const displayPrompt = useMemo(() => formatPrompt(prompt), [prompt]);

  // 切换分镜、或设置里模型列表就绪时重置参数
  useEffect(() => {
    setParams(parseVideoParams(sb.video_param_json, sb.video_duration ?? sb.voice_duration, videoModels));
    setPrompt(sb.video_prompt || "");
  }, [sb.id, sb.video_param_json, sb.video_prompt, sb.video_duration, sb.voice_duration, videoModels]);

  // 失焦保存（保存原始文本，去掉显示用的换行）
  const saveParams = useCallback(async () => {
    try {
      const raw = promptRef.current.replace(/\n\n(c\d{2,},\d+s,)/g, " $1");
      await updateStoryboardParams({
        storyboard_id: sbIdRef.current,
        video_param_json: JSON.stringify(paramsRef.current),
        video_prompt: raw || null,
      });
    } catch {
      // 静默失败，失焦保存不需要 toast
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
              value={displayPrompt}
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
          <div className="sd-params-grid">
            <label className="sd-param-field">
              <span className="sd-param-label">模型</span>
              <select className="sd-param-select" value={params.model} onChange={(e) => updateParam("model", e.target.value)} onBlur={saveParams}>
                {Object.keys(videoModels).length === 0
                  ? <option value="">未配置模型</option>
                  : Object.keys(videoModels).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="sd-param-field">
              <span className="sd-param-label">时长</span>
              <div className="sd-param-duration">
                <input
                  type="number"
                  className="sd-param-input"
                  min={VIDEO_DURATION_MIN}
                  max={VIDEO_DURATION_MAX}
                  value={params.duration}
                  disabled={busy}
                  onChange={(e) => {
                    const raw = Number(e.target.value);
                    if (!Number.isFinite(raw)) return;
                    const dv = clampDuration(raw);
                    setParams((prev) => ({ ...prev, duration: Math.max(VIDEO_DURATION_MIN, Math.min(VIDEO_DURATION_MAX, Math.round(raw))) }));
                    // 实时写回分镜记录（模型拆解的分镜秒数）
                    onDurationWrite(sb, dv);
                  }}
                  onBlur={saveParams}
                />
                <span className="sd-param-unit">s</span>
              </div>
            </label>
            <label className="sd-param-field">
              <span className="sd-param-label">分辨率</span>
              <select className="sd-param-select" value={params.resolution} onChange={(e) => updateParam("resolution", e.target.value)} onBlur={saveParams}>
                {getResolutions(params.model, videoModels).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="sd-param-field">
              <span className="sd-param-label">宽高比</span>
              <select className="sd-param-select" value={params.aspect_ratio} onChange={(e) => updateParam("aspect_ratio", e.target.value)} onBlur={saveParams}>
                {VIDEO_ASPECT_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          </div>
          {/* 视频生成后端 handler（generate_video）尚未实现，先禁用并明确提示，避免「死按钮」 */}
          <button
            className="sd-generate-btn primary-button"
            disabled
            title={Object.keys(videoModels).length === 0 ? "请先在设置中配置视频模型" : "视频生成功能即将开放"}
          >
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
