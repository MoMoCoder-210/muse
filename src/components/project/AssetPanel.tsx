import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo, Clip, ClipScriptInfo, AssetType, ParsedAssets } from "../../types/project";
import { listClips, getClipScripts, generateAssetImage, addAssetToClip, deleteAssetFromClip, batchGetAssetSelectedImages, importLocalAssetImage, copyAssetImageFrom } from "../../services/tauri";
import { useToast } from "../../hooks/useToast";
import { countResources } from "../../utils/assets";
import { AssetCard, buildAssetCards, type AssetCardData, type AssetCardId } from "./AssetCard";
import { DeleteAssetConfirm } from "./DeleteAssetConfirm";
import { AddAssetModal, type AddAssetInput } from "./AddAssetModal";
import { AssetDrawer, type GenerateParams } from "./AssetDrawer";
import { open } from "@tauri-apps/plugin-dialog";
import { STYLE_VALUE_MAP, type StyleMode } from "../../config/muse";

/** type → 属性名映射 */
const TYPE_TO_KEY: Record<AssetType, keyof ParsedAssets> = {
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
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<AssetCardId>>(new Set());
  const [operating, setOperating] = useState(false);

  // 弹窗/抽屉状态
  const [deleteTarget, setDeleteTarget] = useState<AssetCardData[] | null>(null);
  const [addAssetOpen, setAddAssetOpen] = useState<AssetType | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<AssetCardData[] | null>(null);
  const [drawerClosing, setDrawerClosing] = useState(false);

  // 卡片绑定图片路径映射：key = `${type}:${name}`
  const [selectedImageMap, setSelectedImageMap] = useState<Record<string, string>>({});

  // 强制卡片重渲染 key（图片绑定路径不变但文件内容被替换，需重建 DOM 绕过浏览器缓存）
  const [cardRenderKey, setCardRenderKey] = useState(0);

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

  let parsedResources: ParsedAssets | null = null;
  if (selectedScript?.extracted_resources_json) {
    try {
      parsedResources = JSON.parse(selectedScript.extracted_resources_json) as ParsedAssets;
    } catch {
      // JSON 解析失败
    }
  }

  // 当前片段所有资产卡片
  const allAssetCards = useMemo<AssetCardData[]>(() => {
    if (!selectedClipId || !parsedResources) return [];
    return ASSET_CATEGORIES.flatMap((cat) =>
      buildAssetCards(selectedClipId, cat.type, parsedResources[TYPE_TO_KEY[cat.type]] ?? [])
    );
  }, [selectedClipId, parsedResources]);

  const allSelected = allAssetCards.length > 0 && selectedAssetIds.size === allAssetCards.length;

  // 切换单个资产选中
  const toggleSelect = (id: AssetCardId) => {
    setSelectedAssetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 全选 / 取消全选
  const toggleSelectAll = () => {
    if (allSelected) setSelectedAssetIds(new Set());
    else setSelectedAssetIds(new Set(allAssetCards.map((card) => card.id)));
  };

  // 切换片段时：清空跨片段选中项 + 加载选定图片映射
  const loadSelectedImages = useCallback(async (clipId: string) => {
    if (!clipId) { setSelectedImageMap({}); return; }
    try {
      const items = await batchGetAssetSelectedImages({ clip_id: clipId });
      const map: Record<string, string> = {};
      for (const item of items) {
        if (item.selected_image_path) {
          map[`${item.asset_type}:${item.name}`] = item.selected_image_path;
        }
      }
      setSelectedImageMap(map);
    } catch {
      setSelectedImageMap({});
    }
  }, []);

  useEffect(() => {
    setSelectedAssetIds((prev) => {
      const next = new Set<AssetCardId>();
      for (const id of prev) {
        if (id.startsWith(`${selectedClipId}:`)) next.add(id);
      }
      return next;
    });
    loadSelectedImages(selectedClipId ?? "");
  }, [selectedClipId, loadSelectedImages]);

  // 抽屉关闭时刷新卡片缩略图（可能新绑定了图片）
  useEffect(() => {
    if (!drawerTarget && selectedClipId) {
      loadSelectedImages(selectedClipId);
    }
  }, [drawerTarget, selectedClipId, loadSelectedImages]);

  // 点击卡片图片/生成按钮 → 打开抽屉（单个）
  const handleOpenDrawer = useCallback((data: AssetCardData) => {
    setDrawerTarget([data]);
  }, []);

  // 批量生成 → 打开抽屉（多个）
  const handleOpenBatchDrawer = useCallback((cards: AssetCardData[]) => {
    if (cards.length === 0) return;
    setDrawerTarget(cards);
  }, []);

  // 风格名称 → 提示词值
  const resolveStyle = useCallback((style: string) => STYLE_VALUE_MAP[style as StyleMode] ?? style, []);

  // 构建最终生图 prompt（按资产类型拼系统指令）
  const buildImagePrompt = useCallback((card: AssetCardData, style: string): string => {
    const appearance = card.resource.prompt;
    const styleValue = resolveStyle(style);
    if (card.type === "character") {
      return `[风格:${styleValue}] Character design drawing, on a pure white background. On the left is a large facial and half-body close-up, while on the right are three full-body views (front, side, and back). ${appearance}`;
    }
    if (card.type === "item") {
      return `[风格:${styleValue}] product photography, isolated object on white background, detailed texture. ${appearance}`;
    }
    // scene
    return `[风格:${styleValue}] ${appearance}`;
  }, [resolveStyle]);

  // 抽屉内单个生成
  const handleDrawerGenerate = useCallback(async (data: AssetCardData, params: GenerateParams) => {
    setOperating(true);
    try {
      const styleValue = resolveStyle(params.style);
      const prompt = buildImagePrompt(data, params.style);
      await generateAssetImage({
        project_id: project.id,
        clip_id: data.clipId,
        asset_type: data.type,
        name: data.resource.name,
        prompt,
        size: params.size,
        n: params.n,
        style: styleValue,
      });
      toast(`已为资产「${data.resource.name}」发起图片生成`, "success");
    } catch (_err) {
      toast("图片生成失败，请检查图片模型配置与后端日志。", "error");
    } finally {
      setOperating(false);
    }
  }, [project.id, buildImagePrompt, resolveStyle, toast]);

  // 抽屉内批量生成
  const handleDrawerBatchGenerate = useCallback(async (cards: AssetCardData[], params: GenerateParams) => {
    setDrawerTarget(null);
    setOperating(true);
    try {
      const styleValue = resolveStyle(params.style);
      await Promise.all(
        cards.map((card) =>
          generateAssetImage({
            project_id: project.id,
            clip_id: card.clipId,
            asset_type: card.type,
            name: card.resource.name,
            prompt: buildImagePrompt(card, params.style),
            size: params.size,
            n: params.n,
            style: styleValue,
          })
        )
      );
      toast(`已为 ${cards.length} 个资产发起图片生成`, "success");
    } catch (_err) {
      toast("图片生成失败，请检查图片模型配置与后端日志。", "error");
    } finally {
      setOperating(false);
    }
  }, [project.id, toast]);

  // 选择本地图片（返回 Promise 供抽屉刷新）
  const handleSelectLocalImage = useCallback(async (data: AssetCardData): Promise<void> => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
      title: `选择「${data.resource.name}」的本地图片`,
    });
    if (!selected || typeof selected !== "string") return;
    try {
      const result = await importLocalAssetImage({
        clip_id: data.clipId,
        asset_type: data.type,
        name: data.resource.name,
        local_file_path: selected,
      });
      const msg = result.is_selected
        ? `已导入并绑定图片`
        : `已导入图片`;
      toast(msg, "success");
    } catch (err) {
      toast(`导入图片失败：${String(err)}`, "error");
    }
  }, [toast]);

  // 从项目内其他资产复制图片到当前资产
  const handleCopyFromProject = useCallback(async (data: AssetCardData, sourceImageId: string): Promise<void> => {
    try {
      const result = await copyAssetImageFrom({
        source_image_id: sourceImageId,
        target_clip_id: data.clipId,
        target_asset_type: data.type,
        target_name: data.resource.name,
      });
      const msg = result.is_selected
        ? `已复制并绑定图片`
        : `已复制图片`;
      toast(msg, "success");
    } catch (err) {
      toast(`复制图片失败：${String(err)}`, "error");
    }
  }, [toast]);

  // 抽屉内确认绑定图片后强制卡片 DOM 重建（路径不变但文件被替换，需绕过浏览器 img 缓存）
  const handleImageSelected = useCallback(() => {
    setCardRenderKey((k) => k + 1);
  }, []);

  // 抽屉关闭：先播退出动画再移除 DOM
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleCloseDrawer = useCallback(() => {
    setDrawerClosing(true);
    closeTimerRef.current = setTimeout(() => {
      setDrawerTarget(null);
      setDrawerClosing(false);
    }, 260);
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // 点击删除 → 弹出确认弹窗
  const handleDeleteClick = useCallback((cards: AssetCardData[]) => {
    if (cards.length === 0) return;
    setDeleteTarget(cards);
  }, []);

  // 删除确认 → 执行删除
  const handleDeleteConfirm = useCallback(async (cards: AssetCardData[]) => {
    setDeleteTarget(null);
    setOperating(true);
    try {
      await Promise.all(
        cards.map((card) =>
          deleteAssetFromClip({
            clip_id: card.clipId,
            asset_type: card.type,
            name: card.resource.name,
          })
        )
      );
      toast(`已删除 ${cards.length} 个资产`, "success");
      setSelectedAssetIds(new Set());
      await load();
    } catch (_err) {
      toast("删除资产失败，请检查后端的日志。", "error");
    } finally {
      setOperating(false);
    }
  }, [load, toast]);

  // 添加资产确认
  const handleAddAsset = useCallback(async (input: AddAssetInput) => {
    setAddAssetOpen(null);
    if (!selectedClipId) return;
    setOperating(true);
    try {
      await addAssetToClip({
        clip_id: selectedClipId,
        asset_type: input.type,
        name: input.name,
        description: input.description,
        prompt: input.prompt,
      });
      toast(`已添加资产「${input.name}」`, "success");
      await load();
    } catch (_err) {
      toast("添加资产失败，请检查后端的日志。", "error");
    } finally {
      setOperating(false);
    }
  }, [selectedClipId, load, toast]);

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
          {!selectedClipId ? (
            <p className="empty-clip-list">请从左侧选择已拆解的片段</p>
          ) : !parsedResources ? (
            <p className="empty-clip-list">暂无资产数据</p>
          ) : (
            <div className="asset-display-body">
              {allAssetCards.length > 0 && (
                <div className="asset-toolbar">
                  <label className="asset-select-all">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      disabled={operating}
                    />
                    <span>全选</span>
                  </label>
                  <span className="asset-selected-count">
                    {selectedAssetIds.size > 0 ? `已选 ${selectedAssetIds.size}` : ""}
                  </span>
                  <button
                    type="button"
                    className="primary-button btn-sm"
                    style={{ visibility: selectedAssetIds.size > 0 ? "visible" : "hidden" }}
                    onClick={() => handleOpenBatchDrawer(allAssetCards.filter((c) => selectedAssetIds.has(c.id)))}
                    disabled={operating || selectedAssetIds.size === 0}
                  >
                    批量生成（{selectedAssetIds.size}）
                  </button>
                  <button
                    type="button"
                    className="danger-button btn-sm"
                    style={{ visibility: selectedAssetIds.size > 0 ? "visible" : "hidden" }}
                    onClick={() => handleDeleteClick(allAssetCards.filter((c) => selectedAssetIds.has(c.id)))}
                    disabled={operating || selectedAssetIds.size === 0}
                  >
                    批量删除
                  </button>
                </div>
              )}

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
                      <button
                        type="button"
                        className="ghost-button btn-sm asset-add-btn"
                        onClick={() => setAddAssetOpen(cat.type)}
                        disabled={operating}
                        title={`添加${cat.label}`}
                      >
                        + 添加
                      </button>
                    </div>
                    <div className="asset-card-grid">
                      {buildAssetCards(selectedClipId, cat.type, resources).map((card) => (
                        <AssetCard
                          key={`${card.id}-r${cardRenderKey}`}
                          data={card}
                          icon={cat.icon}
                          selected={selectedAssetIds.has(card.id)}
                          selectedImagePath={selectedImageMap[`${card.type}:${card.resource.name}`] ?? null}
                          renderKey={cardRenderKey}
                          onToggle={toggleSelect}
                          onDelete={(data) => handleDeleteClick([data])}
                          onDetail={(data) => handleOpenDrawer(data)}
                          disabled={operating}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 资产删除确认弹窗 */}
      {deleteTarget ? (
        <DeleteAssetConfirm
          cards={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          disabled={operating}
        />
      ) : null}

      {/* 添加资产弹窗 */}
      {addAssetOpen ? (
        <AddAssetModal
          assetType={addAssetOpen}
          onConfirm={handleAddAsset}
          onCancel={() => setAddAssetOpen(null)}
          disabled={operating}
        />
      ) : null}

      {/* 资产详情+生成抽屉 */}
      {drawerTarget ? (
        <AssetDrawer
          cards={drawerTarget}
          projectId={project.id}
          closing={drawerClosing}
          onClose={handleCloseDrawer}
          onGenerate={handleDrawerGenerate}
          onBatchGenerate={handleDrawerBatchGenerate}
          onSelectLocal={handleSelectLocalImage}
          onCopyFromProject={handleCopyFromProject}
          onImageSelected={handleImageSelected}
          disabled={operating}
        />
      ) : null}
    </div>
  );
}
