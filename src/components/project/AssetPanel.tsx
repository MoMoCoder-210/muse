import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo, Clip, ClipScriptInfo, AssetType, ParsedAssets } from "../../types/project";
import { listClips, getClipScripts, generateAssetImage, addAssetToClip, deleteAssetFromClip, batchGetAssetSelectedImages, batchGetAssetGenerating, importLocalAssetImage, copyAssetImageFrom } from "../../services/tauri";
import { useToast } from "../../hooks/useToast";
import { countResources } from "../../utils/assets";
import { AssetCard, buildAssetCards, type AssetCardData, type AssetCardId } from "./AssetCard";
import type { VoiceBinding } from "../../types/project";
import { DeleteAssetConfirm } from "./DeleteAssetConfirm";
import { AddAssetModal, type AddAssetInput } from "./AddAssetModal";
import { AssetDrawer, type GenerateParams } from "./AssetDrawer";
import { VoiceBindingDrawer } from "./VoiceBindingDrawer";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { STYLE_VALUE_MAP, type StyleMode } from "../../config/muse";

/** Worker → 前端的资产生图进度事件 */
type AssetImageProgressEvent = {
  clip_id: string;
  asset_type: string;
  name: string;
  status: "running" | "success" | "failed";
};

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

const RAIL_HOTZONE = 30;
const RAIL_WIDTH = 206;

type AssetPanelProps = {
  project: ProjectInfo;
};

/**
 * 资产管理面板
 *
 * 左侧展示已拆解完成的片段列表，右侧展示选中片段的资产（角色/场景/物品）。
 *
 */
export function AssetPanel({ project }: AssetPanelProps) {
  const { toast } = useToast();
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<AssetCardId>>(new Set());
  const [operating, setOperating] = useState(false);
  const [railLocked, setRailLocked] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);

  // ── 鼠标追踪：30px 进入 → 展开，260px 离开 → 收起（滞后防抖） ──
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

  // 弹窗/抽屉状态
  const [deleteTarget, setDeleteTarget] = useState<AssetCardData[] | null>(null);
  const [addAssetOpen, setAddAssetOpen] = useState<AssetType | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<AssetCardData[] | null>(null);
  const [drawerClosing, setDrawerClosing] = useState(false);
  const [voiceTarget, setVoiceTarget] = useState<AssetCardData | null>(null);
  const [voiceClosing, setVoiceClosing] = useState(false);

  // 卡片绑定图片路径映射：key = `${type}:${name}`
  const [selectedImageMap, setSelectedImageMap] = useState<Record<string, string>>({});

  // 正在生成图片的资产集合：key = `${type}:${name}`，实时轮询
  const [generatingMap, setGeneratingMap] = useState<Record<string, boolean>>({});
  const generatingRef = useRef<Record<string, boolean>>({});
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingRef = useRef(false);

  // 强制卡片重渲染 key（图片绑定路径不变但文件内容被替换，需重建 DOM 绕过浏览器缓存）
  const [cardRenderKey, setCardRenderKey] = useState(0);

  // 资产提示词/描述编辑覆盖（key = card.id，生成时使用最新值）
  const [assetOverrides, setAssetOverrides] = useState<Record<string, { prompt: string; description: string }>>({});

  // 切换片段时清空覆盖，避免不同片段同名资产复用过期 prompt
  useEffect(() => {
    setAssetOverrides({});
  }, [selectedClipId]);

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

  // 监听 Worker 实时推送的资产生图进度，替代纯轮询，实现即时状态更新
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<AssetImageProgressEvent>("asset-image-progress", (e) => {
      const { clip_id, asset_type, name, status } = e.payload;
      if (clip_id !== selectedClipId) return;
      const key = `${asset_type}:${name}`;
      if (status === "running") {
        setGeneratingMap((prev) => {
          const next = { ...prev, [key]: true };
          generatingRef.current = next;
          return next;
        });
      } else {
        // success / failed：任务结束，移出生成中集合并刷新缩略图
        setGeneratingMap((prev) => {
          const next = { ...prev };
          delete next[key];
          generatingRef.current = next;
          return next;
        });
        setCardRenderKey((k) => k + 1);
        loadSelectedImages(clip_id);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [selectedClipId, loadSelectedImages]);

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

  // 查询片段下「生成中」的资产集合；若检测到任务刚完成则刷新缩略图
  const loadGenerating = useCallback(async (clipId: string) => {
    if (!clipId) return;
    try {
      const items = await batchGetAssetGenerating({ clip_id: clipId });
      const map: Record<string, boolean> = {};
      for (const it of items) map[`${it.asset_type}:${it.name}`] = true;
      const prev = generatingRef.current;
      const completed = Object.keys(prev).some((k) => prev[k] && !map[k]);
      generatingRef.current = map;
      setGeneratingMap(map);
      if (completed) {
        setCardRenderKey((k) => k + 1);
        loadSelectedImages(clipId);
      }
    } catch {
      /* 轮询错误忽略 */
    }
  }, [loadSelectedImages]);

  // 轮询控制：有生成中任务时每 2.5s 刷新，全部完成后自动停止
  const stopPoll = useCallback(() => {
    pollingRef.current = false;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPoll = useCallback((clipId: string) => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const loop = async () => {
      if (!pollingRef.current) return;
      await loadGenerating(clipId);
      if (!pollingRef.current) return;
      if (Object.keys(generatingRef.current).length > 0) {
        pollRef.current = setTimeout(loop, 2500);
      } else {
        pollingRef.current = false;
      }
    };
    loop();
  }, [loadGenerating]);

  // 切换片段时启动生成状态轮询；无选中片段则清空
  useEffect(() => {
    if (!selectedClipId) {
      stopPoll();
      generatingRef.current = {};
      setGeneratingMap({});
      return;
    }
    startPoll(selectedClipId);
    return () => stopPoll();
  }, [selectedClipId, startPoll, stopPoll]);

  // 点击卡片图片/生成按钮 → 打开抽屉（单个）
  const handleOpenDrawer = useCallback((data: AssetCardData) => {
    setDrawerTarget([data]);
  }, []);

  // 点击卡片声音按钮 → 打开声音绑定抽屉
  const handleOpenVoiceDrawer = useCallback((data: AssetCardData) => {
    setVoiceClosing(false);
    setVoiceTarget(data);
  }, []);

  // 声音绑定抽屉关闭：先播退出动画再移除 DOM
  const voiceCloseTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleCloseVoiceDrawer = useCallback(() => {
    setVoiceClosing(true);
    voiceCloseTimerRef.current = setTimeout(() => {
      setVoiceTarget(null);
      setVoiceClosing(false);
    }, 260);
  }, []);

  useEffect(() => {
    return () => {
      if (voiceCloseTimerRef.current) clearTimeout(voiceCloseTimerRef.current);
    };
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
    const appearance = assetOverrides[card.id]?.prompt ?? card.resource.prompt;
    const styleValue = resolveStyle(style);
    if (card.type === "character") {
      return `[风格:${styleValue}] 角色设定图，纯白背景。画面左侧为一张大幅的脸部与半身特写，右侧排布三个全身视图（正面、侧面、背面），三视图比例协调、姿态清晰。${appearance}`;
    }
    if (card.type === "item") {
      return `[风格:${styleValue}] 产品摄影，主体独立置于纯白背景上，居中构图，无遮挡，展现清晰的材质与细节纹理，柔光均匀布光。${appearance}`;
    }
    // scene
    return `[风格:${styleValue}] 场景概念图，注重空间层次与氛围营造，不能出现任何一个人物。${appearance}`;
  }, [resolveStyle, assetOverrides]);

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
      startPoll(selectedClipId ?? "");
    } catch (_err) {
      toast("图片生成失败，请检查图片模型配置与后端日志。", "error");
    } finally {
      setOperating(false);
    }
  }, [project.id, buildImagePrompt, resolveStyle, toast, selectedClipId, startPoll]);

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
      startPoll(selectedClipId ?? "");
    } catch (_err) {
      toast("图片生成失败，请检查图片模型配置与后端日志。", "error");
    } finally {
      setOperating(false);
    }
  }, [project.id, toast, selectedClipId, startPoll]);

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

  // 抽屉内保存提示词/描述后：更新覆盖值，使生成使用最新 prompt
  const handleAssetUpdated = useCallback((card: AssetCardData, patch: { prompt: string; description: string }) => {
    setAssetOverrides((prev) => ({ ...prev, [card.id]: patch }));
    // 同步底层数据源 clipScripts，使退出抽屉后重新打开卡片时展示最新 prompt/description
    // （clipScripts 才是 allAssetCards 的真正来源；不更新则重新打开会读到编辑前的旧值）
    setClipScripts((prev) =>
      prev.map((cs) => {
        if (cs.clip_id !== card.clipId || !cs.extracted_resources_json) return cs;
        try {
          const parsed = JSON.parse(cs.extracted_resources_json) as ParsedAssets;
          const key = TYPE_TO_KEY[card.type];
          const list = parsed[key] ?? [];
          const updated = list.map((r) =>
            r.name === card.resource.name
              ? { ...r, prompt: patch.prompt, description: patch.description }
              : r
          );
          return { ...cs, extracted_resources_json: JSON.stringify({ ...parsed, [key]: updated }) };
        } catch {
          return cs;
        }
      })
    );
    setDrawerTarget((prev) =>
      prev?.map((c) =>
        c.id === card.id
          ? { ...c, resource: { ...c.resource, prompt: patch.prompt, description: patch.description } }
          : c
      ) ?? null
    );
  }, []);

  // 抽屉内绑定声音后：合并回 clipScripts 与当前抽屉卡片，使重新打开时展示最新绑定
  const handleVoiceBindingChanged = useCallback((card: AssetCardData, binding: VoiceBinding | undefined) => {
    setClipScripts((prev) =>
      prev.map((cs) => {
        if (cs.clip_id !== card.clipId || !cs.extracted_resources_json) return cs;
        try {
          const parsed = JSON.parse(cs.extracted_resources_json) as ParsedAssets;
          const key = TYPE_TO_KEY[card.type];
          const list = parsed[key] ?? [];
          const updated = list.map((r) =>
            r.name === card.resource.name ? { ...r, voiceBinding: binding } : r
          );
          return { ...cs, extracted_resources_json: JSON.stringify({ ...parsed, [key]: updated }) };
        } catch {
          return cs;
        }
      })
    );
    setDrawerTarget((prev) =>
      prev?.map((c) =>
        c.id === card.id ? { ...c, resource: { ...c.resource, voiceBinding: binding } } : c
      ) ?? null
    );
    setVoiceTarget((prev) =>
      prev && prev.id === card.id
        ? { ...prev, resource: { ...prev.resource, voiceBinding: binding } }
        : prev
    );
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
    <div className="rail-layout" ref={layoutRef} onMouseMove={handleMouseMove}>
      {/* ── 左侧：悬停展开式片段栏 ── */}
      <div
        className={`rail-clips${
          railLocked ? " is-locked" : selectedClipId ? (railExpanded ? " is-expanded" : "") : " is-locked-open"
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
          ) : disassembledClips.length === 0 ? (
            <p className="rail-clips-empty">暂无片段</p>
          ) : (
            <div className="rail-clips-list">
              {disassembledClips.map((clip) => {
                const cs = clipScripts.find((s) => s.clip_id === clip.id);
                const isSelected = clip.id === selectedClipId;
                return (
                  <button
                    key={clip.id}
                    type="button"
                    className={`rail-clips-item${isSelected ? " on" : ""}`}
                    onClick={() => {
                      setSelectedClipId(clip.id);
                      setRailLocked(true);
                    }}
                    title={clip.title}
                  >
                    <span className="rail-clips-item-num">{clip.sort_index}</span>
                    <span className="rail-clips-item-text">
                      <span className="rail-clips-item-title">{clip.title}</span>
                      {cs && (
                        <span className="rail-clips-item-cnt">{countResources(cs.extracted_resources_json)} 资产</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── 右侧：资产展示 ── */}
      <div className="rail-main">
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
                          generating={generatingMap[`${card.type}:${card.resource.name}`] ?? false}
                          renderKey={cardRenderKey}
                          onToggle={toggleSelect}
                          onDelete={(data) => handleDeleteClick([data])}
                          onDetail={(data) => handleOpenDrawer(data)}
                          onVoice={(data) => handleOpenVoiceDrawer(data)}
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
          onAssetUpdated={handleAssetUpdated}
          disabled={operating}
        />
      ) : null}
      {/* 声音绑定抽屉 */}
      {voiceTarget ? (
        <VoiceBindingDrawer
          card={voiceTarget}
          onClose={handleCloseVoiceDrawer}
          onVoiceBound={handleVoiceBindingChanged}
          closing={voiceClosing}
          disabled={operating}
        />
      ) : null}
    </div>
  );
}
