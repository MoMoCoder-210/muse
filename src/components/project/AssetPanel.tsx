import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo, Clip, ClipScriptInfo } from "../../types/project";
import { listClips, getClipScripts } from "../../services/tauri";
import { useToast } from "../../hooks/useToast";
import { countResources } from "../../utils/assets";

/** 资产资源类型 */
type AssetType = "character" | "scene" | "item";

/** 单个资产资源 */
interface AssetResource {
  type: AssetType;
  name: string;
  description: string;
  prompt: string;
  tags?: string[];
}

/** 拆解输出的资源集合 */
interface ParsedResources {
  characters: AssetResource[];
  scenes: AssetResource[];
  items: AssetResource[];
}

/** type → 属性名映射 */
const TYPE_TO_KEY: Record<AssetType, keyof ParsedResources> = {
  character: "characters",
  scene: "scenes",
  item: "items",
};

/** 分类配置 */
const ASSET_CATEGORIES: { type: AssetType; label: string; icon: string }[] = [
  { type: "character", label: "角色", icon: "👤" },
  { type: "scene", label: "场景", icon: "🏞" },
  { type: "item", label: "物品", icon: "📦" },
];

type AssetPanelProps = {
  project: ProjectInfo;
};

/**
 * 资产管理面板
 *
 * 左侧展示已拆解完成的片段列表，右侧展示选中片段的资产（角色/场景/物品）。
 *
 * @author yt @date 20260703
 */
export function AssetPanel({ project }: AssetPanelProps) {
  const { toast } = useToast();
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

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
    } catch (err) {
      toast("资产数据加载失败，请检查后端的日志。", "error");
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
    return cs?.status === "success" && cs.extracted_resources_json;
  });

  // 选中片段的资产数据
  const selectedScript = clipScripts.find((s) => s.clip_id === selectedClipId);
  const selectedClip = clips.find((c) => c.id === selectedClipId);

  let parsedResources: ParsedResources | null = null;
  if (selectedScript?.extracted_resources_json) {
    try {
      parsedResources = JSON.parse(selectedScript.extracted_resources_json) as ParsedResources;
    } catch {
      // JSON 解析失败
    }
  }

  // 自动选中第一个已拆解片段
  useEffect(() => {
    if (disassembledClips.length > 0 && !selectedClipId) {
      setSelectedClipId(disassembledClips[0].id);
    }
  }, [disassembledClips, selectedClipId]);

  return (
    <div className="workspace-split-layout">
      {/* ── 左侧：已拆解片段列表 ── */}
      <div className="asset-clip-panel">
        <div className="panel-header">
          <h3>片段列表</h3>
        </div>
        {loading ? (
          <p className="empty-clip-list">加载中…</p>
        ) : disassembledClips.length === 0 ? (
          <p className="empty-clip-list">暂无已拆解片段</p>
        ) : (
          <div className="asset-clip-list">
            {disassembledClips.map((clip) => {
              const cs = clipScripts.find((s) => s.clip_id === clip.id);
              const isSelected = clip.id === selectedClipId;
              return (
                <button
                  key={clip.id}
                  type="button"
                  className={`asset-clip-item${isSelected ? " asset-clip-item--selected" : ""}`}
                  onClick={() => setSelectedClipId(clip.id)}
                >
                  <span className="asset-clip-index">第 {clip.sort_index} 集</span>
                  <span className="asset-clip-title">{clip.title}</span>
                  {cs && (
                    <span className="asset-clip-count">
                      {countResources(cs.extracted_resources_json)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 右侧：资产展示 ── */}
      <div className="workspace-right-panel">
        <div className="asset-display-panel">
          <div className="panel-header">
            <h3>
              {selectedClip
                ? `第 ${selectedClip.sort_index} 集 · 资产`
                : "资产管理"}
            </h3>
          </div>

          {!selectedClipId ? (
            <p className="empty-clip-list">请从左侧选择已拆解的片段</p>
          ) : !parsedResources ? (
            <p className="empty-clip-list">暂无资产数据</p>
          ) : (
            <div className="asset-display-body">
              {ASSET_CATEGORIES.map((cat) => {
                const resources = parsedResources![TYPE_TO_KEY[cat.type]] ?? [];
                if (resources.length === 0) return null;
                return (
                  <div key={cat.type} className="asset-category">
                    <div className="asset-category-header">
                      <span className="asset-category-icon">{cat.icon}</span>
                      <h4 className="asset-category-title">
                        {cat.label}
                        <span className="asset-category-count">{resources.length}</span>
                      </h4>
                    </div>
                    <div className="asset-card-grid">
                      {resources.map((res, i) => (
                        <div key={`${cat.type}-${i}`} className="asset-card">
                          <div className="asset-card-frame">
                            <svg
                              className="asset-card-placeholder"
                              viewBox="0 0 120 120"
                              fill="none"
                              xmlns="http://www.w3.org/2000/svg"
                            >
                              <rect width="120" height="120" rx="10" fill="var(--chip-bg)" />
                              <path
                                d="M40 70 L55 50 L70 60 L85 40 L100 55"
                                stroke="var(--text-muted)"
                                strokeWidth="1.5"
                                fill="none"
                                opacity="0.5"
                              />
                              <circle cx="45" cy="40" r="8" stroke="var(--text-muted)" strokeWidth="1.5" opacity="0.5" />
                            </svg>
                          </div>
                          <div className="asset-card-info">
                            <span className="asset-card-name">{res.name}</span>
                            <span className="asset-card-desc">{res.description}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
