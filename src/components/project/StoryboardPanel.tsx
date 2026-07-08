import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ProjectInfo, Clip, ClipScriptInfo, Storyboard, StoryboardAssetInfo, AssetType } from "../../types/project";
import {
  listClips, getClipScripts, listStoryboards, listClipAssets,
  updateStoryboardAssets, addAssetToClip, createStoryboard, deleteStoryboard,
} from "../../services/tauri";
import { useToast } from "../../hooks/useToast";
import { AddAssetModal, type AddAssetInput } from "./AddAssetModal";

/* ========================================================================
   StoryboardPanel — 悬停展开式左侧片段栏 + 分镜场景块

   @author yt @date 20260708
   ======================================================================== */

type Props = { project: ProjectInfo };

/** 资产分类配置（与 AssetPanel 的 ASSET_CATEGORIES 保持一致） */
const CATS: { type: AssetType; label: string; icon: string }[] = [
  { type: "character", label: "角色", icon: "👤" },
  { type: "scene", label: "场景", icon: "🏞" },
  { type: "item", label: "物品", icon: "📦" },
];

type ClipData = { storyboards: Storyboard[]; assets: StoryboardAssetInfo[]; loaded: boolean };

const parseIds = (j: string): Set<string> => {
  try { return new Set(JSON.parse(j) as string[]); } catch { return new Set(); }
};

const RAIL_HOTZONE = 30;
const RAIL_WIDTH = 240;

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
  const [saving, setSaving] = useState<string | null>(null);
  const [addDlg, setAddDlg] = useState<{ clipId: string; type: AssetType } | null>(null);

  // ── 鼠标追踪：200px 进入 → 展开，260px 离开 → 收起（滞后防抖） ──
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!layoutRef.current) return;
    const rect = layoutRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setRailExpanded((prev) => {
      if (prev && x > RAIL_WIDTH) return false;
      if (!prev && x < RAIL_HOTZONE) return true;
      return prev;
    });
  }, []);

  // ── 加载 ──────────────────────────────────────────

  const loadAll = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const [c, cs] = await Promise.all([listClips(project.id), getClipScripts(project.id)]);
      setClips(c); setCsList(cs);
    } catch { toast("加载失败", "error"); }
    finally { setLoading(false); }
  }, [project?.id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const filtered = useMemo(
    () => clips.filter((c) => csList.find((s) => s.clip_id === c.id)?.status === "success"),
    [clips, csList],
  );

  // 确保选中片段在列表中
  useEffect(() => {
    if (clipId && !filtered.find((c) => c.id === clipId)) setClipId(null);
  }, [filtered, clipId]);

  const clip = filtered.find((c) => c.id === clipId) ?? null;

  // ── 分镜数据 ──────────────────────────────────────

  const loadSb = useCallback(async (cid: string) => {
    if (dataMapRef.current[cid]?.loaded) return;
    try {
      const [sb, as] = await Promise.all([listStoryboards(cid), listClipAssets(cid)]);
      setDataMap((p) => ({ ...p, [cid]: { storyboards: sb, assets: as, loaded: true } }));
    } catch { toast("加载分镜失败", "error"); }
  }, [toast]);

  useEffect(() => { if (clip) loadSb(clip.id); }, [clip?.id, loadSb]);

  const data = clip ? dataMap[clip.id] : null;
  const sbList = data?.storyboards ?? [];
  const assets = data?.assets ?? [];

  // ── 资产关联 ──────────────────────────────────────

  const toggleLink = useCallback(async (sb: Storyboard, a: StoryboardAssetInfo) => {
    const cIds = parseIds(sb.character_ids_json);
    const sIds = parseIds(sb.scene_ids_json);
    const iIds = parseIds(sb.item_ids_json);
    const ids = a.type === "character" ? cIds : a.type === "scene" ? sIds : iIds;
    ids.has(a.asset_id) ? ids.delete(a.asset_id) : ids.add(a.asset_id);
    setSaving(sb.id);
    try {
      await updateStoryboardAssets({ storyboard_id: sb.id, character_ids: [...cIds], scene_ids: [...sIds], item_ids: [...iIds] });
      setDataMap((p) => {
        const d = p[sb.clip_id]; if (!d) return p;
        return { ...p, [sb.clip_id]: { ...d, storyboards: d.storyboards.map((s) =>
          s.id === sb.id ? { ...s, character_ids_json: JSON.stringify([...cIds]), scene_ids_json: JSON.stringify([...sIds]), item_ids_json: JSON.stringify([...iIds]) } : s
        ) } };
      });
    } catch { toast("更新失败", "error"); }
    finally { setSaving(null); }
  }, [toast]);

  // ── 新增资产 ──────────────────────────────────────

  const handleAddAsset = useCallback(async (inp: AddAssetInput) => {
    if (!addDlg) return;
    setSaving("__add__");
    try {
      await addAssetToClip({ clip_id: addDlg.clipId, asset_type: inp.type, name: inp.name, description: inp.description, prompt: inp.prompt });
      toast("已添加"); setAddDlg(null);
      await loadSb(addDlg.clipId);
    } catch { toast("添加失败", "error"); }
    finally { setSaving(null); }
  }, [addDlg, toast, loadSb]);

  // ── 新增/删除分镜 ────────────────────────────────

  const addSb = useCallback(async () => {
    if (!clip) return;
    setSaving("__new__");
    try {
      await createStoryboard({ clip_id: clip.id, project_id: project.id });
      setDataMap((p) => ({ ...p, [clip.id]: { ...p[clip.id], loaded: false } }));
      await loadSb(clip.id);
      toast("已添加分镜");
    } catch { toast("添加失败", "error"); }
    finally { setSaving(null); }
  }, [clip, project.id, toast, loadSb]);

  const delSb = useCallback(async (sb: Storyboard) => {
    if (!confirm(`删除 ${sb.sbid || `#${sb.seq_num}`}？`)) return;
    setSaving(sb.id);
    try {
      await deleteStoryboard({ storyboard_id: sb.id });
      setDataMap((p) => {
        const d = p[sb.clip_id]; if (!d) return p;
        return { ...p, [sb.clip_id]: { ...d, storyboards: d.storyboards.filter((s) => s.id !== sb.id) } };
      });
    } catch { toast("删除失败", "error"); }
    finally { setSaving(null); }
  }, [toast]);

  const busy = saving !== null;

  return (
    <div className="rail-layout" ref={layoutRef} onMouseMove={handleMouseMove}>
      {/* ================================================================
          左侧：悬停展开式片段栏
          ================================================================ */}
      <div
        className={`rail-clips${
          railLocked ? " is-locked" : clip ? (railExpanded ? " is-expanded" : "") : " is-locked-open"
        }`}
        onMouseLeave={() => setRailLocked(false)}
      >
        <div className="rail-clips-inner">
          <div className="rail-clips-head">
            <span className="rail-clips-head-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            </span>
            <span className="rail-clips-head-text">片段列表</span>
          </div>
          {loading ? (
            <p className="rail-clips-empty">加载中…</p>
          ) : filtered.length === 0 ? (
            <p className="rail-clips-empty">暂无片段</p>
          ) : (
            <div className="rail-clips-list">
              {filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`rail-clips-item${c.id === clipId ? " on" : ""}`}
                  onClick={() => {
                    setClipId(c.id);
                    setRailLocked(true);
                  }}
                  title={c.title}
                >
                  <span className="rail-clips-item-num">{c.sort_index}</span>
                  <span className="rail-clips-item-text">
                    <span className="rail-clips-item-title">{c.title}</span>
                    {dataMap[c.id]?.loaded && (
                      <span className="rail-clips-item-cnt">{dataMap[c.id].storyboards.length} 镜</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ================================================================
          主内容：分镜场景块
          ================================================================ */}
      <div className="rail-main">
        <div className="sb-scroll">
          {!clip ? (
            <div className="sb-empty">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
              <p>从左侧选择片段</p>
              <span>鼠标移到左边缘自动展开片段列表</span>
            </div>
          ) : !data?.loaded ? (
            <div className="sb-empty"><p>加载中…</p></div>
          ) : sbList.length === 0 ? (
            <div className="sb-empty">
              <p>暂无分镜</p>
            </div>
          ) : (
            <div className="sb-blocks">
              {sbList.map((sb, i) => (
                <SceneBlock
                  key={sb.id}
                  sb={sb}
                  index={i + 1}
                  assets={assets}
                  busy={busy}
                  saving={saving === sb.id}
                  onToggle={(a) => toggleLink(sb, a)}
                  onDelete={() => delSb(sb)}
                  onAddAsset={(t) => setAddDlg({ clipId: sb.clip_id, type: t })}
                />
              ))}
            </div>
          )}

          {/* 新增分镜 */}
          {data?.loaded && clip && (
            <button className="sb-add-btn" onClick={addSb} disabled={busy}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              新增分镜
            </button>
          )}
        </div>
      </div>

      {addDlg && (
        <AddAssetModal
          assetType={addDlg.type}
          onConfirm={handleAddAsset}
          onCancel={() => setAddDlg(null)}
          disabled={saving === "__add__"}
        />
      )}
    </div>
  );
}

/**
 * SceneBlock — 分镜场景块
 *
 * 展示单个分镜的对白、画面描述、视频提示词及关联资产。
 *
 * @author yt @date 20260708
 */
type SBProps = {
  sb: Storyboard; index: number;
  assets: StoryboardAssetInfo[];
  busy: boolean; saving: boolean;
  onToggle: (a: StoryboardAssetInfo) => void;
  onDelete: () => void;
  onAddAsset: (t: AssetType) => void;
};

function SceneBlock({ sb, index, assets, busy, saving, onToggle, onDelete, onAddAsset }: SBProps) {
  const cIds = parseIds(sb.character_ids_json);
  const sIds = parseIds(sb.scene_ids_json);
  const iIds = parseIds(sb.item_ids_json);
  const linked = (a: StoryboardAssetInfo) =>
    a.type === "character" ? cIds.has(a.asset_id) : a.type === "scene" ? sIds.has(a.asset_id) : iIds.has(a.asset_id);

  return (
    <div className={`sc${saving ? " is-busy" : ""}`}>
      {/* 头部 */}
      <div className="sc-head">
        <span className="sc-num">{sb.sbid || `#${sb.seq_num}`}</span>
        <span className="sc-idx">镜 {index}</span>
        <button className="sc-del" onClick={onDelete} disabled={busy} title="删除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>

      {/* 对白 */}
      {sb.dialogue && (
        <blockquote className="sc-dialogue">{sb.dialogue}</blockquote>
      )}

      {/* 画面描述 */}
      <p className="sc-desc">{sb.visual_description || "暂无画面描述"}</p>

      {/* 提示词 */}
      {sb.video_prompt && (
        <details className="sc-prompt">
          <summary className="sc-prompt-trig">视频提示词</summary>
          <pre className="sc-prompt-body">{sb.video_prompt}</pre>
        </details>
      )}

      {/* 关联资产 */}
      <div className="sc-assets">
        {CATS.map((cat) => {
          const list = assets.filter((a) => a.type === cat.type);
          return (
            <div key={cat.type} className="sc-asset-row">
              <span className="sc-asset-icon">{cat.icon}</span>
              <div className="sc-asset-chips">
                {list.map((a) => {
                  const on = linked(a);
                  const img = a.selected_image_path ? convertFileSrc(a.selected_image_path) : null;
                  return (
                    <button
                      key={a.asset_id}
                      className={`sc-chip${on ? " on" : ""}`}
                      disabled={busy}
                      onClick={() => onToggle(a)}
                      title={a.description || a.name}
                    >
                      {img && <span className="sc-chip-img"><img src={img} alt="" /></span>}
                      <span className="sc-chip-name">{a.name}</span>
                    </button>
                  );
                })}
                <button className="sc-chip sc-chip-add" disabled={busy} onClick={() => onAddAsset(cat.type)}>+</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
