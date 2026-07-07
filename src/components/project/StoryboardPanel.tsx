import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ProjectInfo, Clip, ClipScriptInfo, Storyboard, StoryboardAssetInfo, AssetType } from "../../types/project";
import { listClips, getClipScripts, listStoryboards, listClipAssets, updateStoryboardAssets } from "../../services/tauri";
import { useToast } from "../../hooks/useToast";

type StoryboardPanelProps = {
  project: ProjectInfo;
};

/** 资产分类配置 */
const ASSET_CATEGORIES: { type: AssetType; label: string; icon: string }[] = [
  { type: "character", label: "角色", icon: "👤" },
  { type: "scene", label: "场景", icon: "🏞" },
  { type: "item", label: "物品", icon: "📦" },
];

/** 状态标签映射 */
const STATE_LABELS: Record<string, { text: string; className: string }> = {
  pending: { text: "待生成", className: "sb-state--pending" },
  running: { text: "生成中", className: "sb-state--running" },
  ready: { text: "已完成", className: "sb-state--ready" },
  failed: { text: "失败", className: "sb-state--failed" },
  invalidated: { text: "已失效", className: "sb-state--invalidated" },
};

/** 每个片段的分镜 + 资产缓存 */
type ClipSbData = {
  storyboards: Storyboard[];
  assets: StoryboardAssetInfo[];
  loaded: boolean;
};

/** 解析 JSON 数组字符串为 Set */
function parseIds(json: string): Set<string> {
  try {
    const arr = JSON.parse(json) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

/**
 * 分镜编辑面板（树形结构）
 *
 * 片段为一级节点，分镜为二级节点，点击分镜可展开详情。
 * 关联资产区域支持点击切换绑定。
 *
 * @author yt @date 20260707
 */
export function StoryboardPanel({ project }: StoryboardPanelProps) {
  const { toast } = useToast();
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[]>([]);
  const [loading, setLoading] = useState(true);

  /** 展开的片段 ID */
  const [expandedClips, setExpandedClips] = useState<Set<string>>(new Set());
  /** 展开的分镜 ID */
  const [expandedSbs, setExpandedSbs] = useState<Set<string>>(new Set());
  /** 每个片段的分镜数据缓存 */
  const [clipDataMap, setClipDataMap] = useState<Record<string, ClipSbData>>({});
  const clipDataMapRef = useRef(clipDataMap);
  clipDataMapRef.current = clipDataMap;
  /** 正在保存关联的分镜 ID */
  const [savingSbId, setSavingSbId] = useState<string | null>(null);

  // 加载片段和拆解数据
  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const [clipList, csList] = await Promise.all([
        listClips(project.id),
        getClipScripts(project.id),
      ]);
      setClips(clipList);
      setClipScripts(csList);
    } catch (_err) {
      toast("分镜数据加载失败，请检查后端日志。", "error");
    } finally {
      setLoading(false);
    }
  }, [project?.id]);

  useEffect(() => {
    load();
  }, [load]);

  // 已拆解成功的片段
  const disassembledClips = clips.filter((c) => {
    const cs = clipScripts.find((s) => s.clip_id === c.id);
    return cs?.status === "success";
  });

  // 展开片段时懒加载分镜数据
  const loadClipSbData = useCallback(async (clipId: string) => {
    if (clipDataMapRef.current[clipId]?.loaded) return;
    try {
      const [sbList, assets] = await Promise.all([
        listStoryboards(clipId),
        listClipAssets(clipId),
      ]);
      setClipDataMap((prev) => ({
        ...prev,
        [clipId]: { storyboards: sbList, assets, loaded: true },
      }));
    } catch (_err) {
      toast("分镜数据加载失败", "error");
    }
  }, [toast]);

  // 切换片段展开/收起
  const toggleClip = useCallback((clipId: string) => {
    setExpandedClips((prev) => {
      const next = new Set(prev);
      if (next.has(clipId)) {
        next.delete(clipId);
      } else {
        next.add(clipId);
        loadClipSbData(clipId);
      }
      return next;
    });
  }, [loadClipSbData]);

  // 切换分镜展开/收起
  const toggleSb = useCallback((sbId: string) => {
    setExpandedSbs((prev) => {
      const next = new Set(prev);
      if (next.has(sbId)) next.delete(sbId);
      else next.add(sbId);
      return next;
    });
  }, []);

  // 切换某个分镜的资产关联
  const toggleAssetLink = useCallback(async (sb: Storyboard, asset: StoryboardAssetInfo) => {
    const charIds = parseIds(sb.character_ids_json);
    const sceneIds = parseIds(sb.scene_ids_json);
    const itemIds = parseIds(sb.item_ids_json);

    const ids = asset.type === "character" ? charIds : asset.type === "scene" ? sceneIds : itemIds;
    if (ids.has(asset.asset_id)) {
      ids.delete(asset.asset_id);
    } else {
      ids.add(asset.asset_id);
    }

    const input = {
      storyboard_id: sb.id,
      character_ids: [...charIds],
      scene_ids: [...sceneIds],
      item_ids: [...itemIds],
    };

    setSavingSbId(sb.id);
    try {
      await updateStoryboardAssets(input);
      // 更新本地缓存
      setClipDataMap((prev) => {
        const data = prev[sb.clip_id];
        if (!data) return prev;
        const updatedSb = {
          ...sb,
          character_ids_json: JSON.stringify(input.character_ids),
          scene_ids_json: JSON.stringify(input.scene_ids),
          item_ids_json: JSON.stringify(input.item_ids),
        };
        return {
          ...prev,
          [sb.clip_id]: {
            ...data,
            storyboards: data.storyboards.map((s) => (s.id === sb.id ? updatedSb : s)),
          },
        };
      });
    } catch (_err) {
      toast("更新关联资产失败", "error");
    } finally {
      setSavingSbId(null);
    }
  }, [toast]);

  // 获取状态标签
  const getStateLabel = (state: string) => STATE_LABELS[state] ?? STATE_LABELS.pending;

  return (
    <div className="sb-tree-panel">
      {loading ? (
        <p className="empty-clip-list">加载中…</p>
      ) : disassembledClips.length === 0 ? (
        <p className="empty-clip-list">暂无已拆解片段，请先完成片段拆解</p>
      ) : (
        <div className="sb-tree">
          {disassembledClips.map((clip) => {
            const isClipOpen = expandedClips.has(clip.id);
            const data = clipDataMap[clip.id];
            const sbList = data?.storyboards ?? [];
            const assets = data?.assets ?? [];
            const isLoading = isClipOpen && !data?.loaded;

            return (
              <div key={clip.id} className="sb-tree-clip">
                {/* 片段节点 */}
                <button
                  type="button"
                  className="sb-tree-clip-header"
                  onClick={() => toggleClip(clip.id)}
                >
                  <span className={`sb-tree-chevron ${isClipOpen ? "sb-tree-chevron--open" : ""}`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="9 6 15 12 9 18" />
                    </svg>
                  </span>
                  <span className="sb-tree-clip-index">第 {clip.sort_index} 集</span>
                  <span className="sb-tree-clip-title">{clip.title}</span>
                  {data?.loaded && (
                    <span className="sb-tree-clip-count">{sbList.length} 个分镜</span>
                  )}
                </button>

                {/* 分镜子节点 */}
                {isClipOpen && (
                  <div className="sb-tree-children">
                    {isLoading ? (
                      <p className="sb-tree-loading">加载分镜中…</p>
                    ) : sbList.length === 0 ? (
                      <p className="sb-tree-loading">该片段暂无分镜数据</p>
                    ) : (
                      sbList.map((sb) => {
                        const isSbOpen = expandedSbs.has(sb.id);
                        const imgState = getStateLabel(sb.image_state);
                        const voiceState = getStateLabel(sb.voice_state);
                        const videoState = getStateLabel(sb.video_state);

                        // 当前分镜关联的资产 ID 集合
                        const linkedCharIds = parseIds(sb.character_ids_json);
                        const linkedSceneIds = parseIds(sb.scene_ids_json);
                        const linkedItemIds = parseIds(sb.item_ids_json);
                        const isLinked = (asset: StoryboardAssetInfo) => {
                          if (asset.type === "character") return linkedCharIds.has(asset.asset_id);
                          if (asset.type === "scene") return linkedSceneIds.has(asset.asset_id);
                          return linkedItemIds.has(asset.asset_id);
                        };
                        const isSaving = savingSbId === sb.id;

                        return (
                          <div key={sb.id} className={`sb-tree-sb${isSbOpen ? " sb-tree-sb--open" : ""}`}>
                            {/* 分镜摘要行 */}
                            <button
                              type="button"
                              className="sb-tree-sb-header"
                              onClick={() => toggleSb(sb.id)}
                            >
                              <span className={`sb-tree-chevron ${isSbOpen ? "sb-tree-chevron--open" : ""}`}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="9 6 15 12 9 18" />
                                </svg>
                              </span>
                              <span className="sb-tree-sb-sbid">{sb.sbid || `#${sb.seq_num}`}</span>
                              <span className="sb-tree-sb-thumb sb-tree-sb-thumb--placeholder">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                  <rect x="3" y="3" width="18" height="18" rx="2" />
                                  <circle cx="8.5" cy="8.5" r="1.5" />
                                  <path d="M21 15l-5-5L5 21" />
                                </svg>
                              </span>
                              <span className="sb-tree-sb-desc">{sb.visual_description || "暂无描述"}</span>
                              <span className={`sb-state-badge ${imgState.className}`}>{imgState.text}</span>
                            </button>

                            {/* 分镜详情 */}
                            {isSbOpen && (
                              <div className="sb-tree-sb-body">
                                {/* 状态行 */}
                                <div className="sb-detail-section">
                                  <div className="sb-state-row">
                                    <span className="sb-state-item">
                                      <span className="sb-state-key">画面</span>
                                      <span className={`sb-state-badge ${imgState.className}`}>{imgState.text}</span>
                                    </span>
                                    <span className="sb-state-item">
                                      <span className="sb-state-key">配音</span>
                                      <span className={`sb-state-badge ${voiceState.className}`}>{voiceState.text}</span>
                                    </span>
                                    <span className="sb-state-item">
                                      <span className="sb-state-key">视频</span>
                                      <span className={`sb-state-badge ${videoState.className}`}>{videoState.text}</span>
                                    </span>
                                  </div>
                                </div>

                                {/* 描述 */}
                                {(sb.dialogue || sb.visual_description) && (
                                  <div className="sb-detail-section">
                                    {sb.dialogue && (
                                      <>
                                        <h5 className="sb-detail-label">对白</h5>
                                        <p className="sb-detail-text sb-detail-text--dialogue">{sb.dialogue}</p>
                                      </>
                                    )}
                                    {sb.visual_description && (
                                      <>
                                        <h5 className="sb-detail-label">画面描述</h5>
                                        <p className="sb-detail-text">{sb.visual_description}</p>
                                      </>
                                    )}
                                  </div>
                                )}

                                {/* 提示词 */}
                                {sb.video_prompt && (
                                  <div className="sb-detail-section">
                                    <h5 className="sb-detail-label">视频提示词</h5>
                                    <p className="sb-detail-text sb-detail-text--prompt">{sb.video_prompt}</p>
                                  </div>
                                )}

                                {/* 关联资产 — 大卡片 + 可切换 */}
                                <div className="sb-detail-section">
                                  <h5 className="sb-detail-label">
                                    关联资产
                                    <span className="sb-detail-hint">点击资产卡片切换关联</span>
                                  </h5>
                                  {assets.length === 0 ? (
                                    <p className="sb-detail-empty">该片段暂无资产</p>
                                  ) : (
                                    ASSET_CATEGORIES.map((cat) => {
                                      const catAssets = assets.filter((a) => a.type === cat.type);
                                      if (catAssets.length === 0) return null;
                                      return (
                                        <div key={cat.type} className="sb-asset-group">
                                          <span className="sb-asset-group-label">
                                            {cat.icon} {cat.label}
                                          </span>
                                          <div className="sb-asset-grid">
                                            {catAssets.map((asset) => {
                                              const src = asset.selected_image_path
                                                ? convertFileSrc(asset.selected_image_path)
                                                : null;
                                              const linked = isLinked(asset);
                                              return (
                                                <button
                                                  key={asset.asset_id}
                                                  type="button"
                                                  className={`sb-asset-card${linked ? " sb-asset-card--linked" : ""}`}
                                                  disabled={isSaving}
                                                  onClick={() => toggleAssetLink(sb, asset)}
                                                  title={linked ? "点击取消关联" : "点击关联此资产"}
                                                >
                                                  <div className="sb-asset-card-img-wrap">
                                                    {src ? (
                                                      <img className="sb-asset-card-img" src={src} alt={asset.name} />
                                                    ) : (
                                                      <span className="sb-asset-card-img sb-asset-card-img--empty">
                                                        {cat.icon}
                                                      </span>
                                                    )}
                                                    {linked && (
                                                      <span className="sb-asset-card-check">
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                                          <polyline points="20 6 9 17 4 12" />
                                                        </svg>
                                                      </span>
                                                    )}
                                                  </div>
                                                  <span className="sb-asset-card-name">{asset.name}</span>
                                                </button>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
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
