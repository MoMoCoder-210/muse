import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { STYLE_OPTIONS, type StyleMode } from "../../config/muse";
import { SelectField } from "../common/SelectField";
import { listAssetImageTasks, selectAssetImage, deleteAssetImage, updateAssetInClip, retryAssetImageTask, enqueueAssetUpscale, type UpscaleDoneEvent } from "../../services/tauri";
import { useGpuDetect } from "../../services/gpu";
import { useToast } from "../../hooks/useToast";
import { formatDeleteResult } from "../../utils/delete-result";
import type { AssetCardData } from "./AssetCard";
import { AssetImageGallery, type GalleryImage } from "./AssetImageGallery";
import { AssetPickerDrawer } from "./AssetPickerDrawer";

/** Worker → 前端的单张素材生成图片更新事件 */
type AssetImageTaskUpdateEvent = {
  clip_id: string;
  asset_type: string;
  name: string;
  imageId: string;
  status: "ready" | "failed";
};

/** Worker → 前端的素材生图任务级进度事件 */
type AssetImageProgressEvent = {
  clip_id: string;
  asset_type: string;
  name: string;
  status: "running" | "success" | "failed";
};

/** 画幅比例 */
type AspectRatio = "16:9" | "9:16" | "4:3" | "3:4" | "1:1";

/** 分辨率档位 */
type ResolutionTier = "1K" | "2K" | "4K";

const TYPE_LABELS: Record<string, string> = {
  character: "人物",
  scene: "场景",
  item: "道具",
};

const TYPE_ICONS: Record<string, string> = {
  character: "👤",
  scene: "🏞",
  item: "📦",
};

/** 超分模型选项（复用于素材图片超分） */
const UPSCALE_MODELS: { value: string; label: string; tag: string; desc: string }[] = [
  { value: "anime", label: "动漫视频", tag: "2x/3x/4x · 不限分辨率", desc: "专为动漫视频优化，不限输入分辨率，速度最快，支持 2x/3x/4x" },
  { value: "x4plus-anime", label: "动漫高清", tag: "固定 4x · 限 1080p", desc: "动漫场景的高细节版，画质优于动漫视频但更慢；固定 4x，最高支持 1080p 输入" },
  { value: "x4plus", label: "真人写实", tag: "固定 4x · 限 1080p", desc: "适合真人写实与普通画面，细节最丰富；固定 4x ，最高支持 1080p 输入" },
];
const UPSCALE_SCALES: { value: number; label: string }[] = [
  { value: 2, label: "2x" }, { value: 3, label: "3x" }, { value: 4, label: "4x" },
];
const FIXED_4X = new Set(["x4plus", "x4plus-anime"]);
const INFO_ICON_SVG = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
  </svg>
);

/**
 * 根据比例和分辨率档位计算实际像素尺寸。
 * 需满足 OpenAI 兼容端点限制：总像素 [3686400, 16777216]，宽高比 [1/16, 16]。
 */
function calcSize(ratio: AspectRatio, tier: ResolutionTier): string {
  const bases: Record<ResolutionTier, number> = { "1K": 1024, "2K": 2048, "4K": 4096 };
  const [wRatio, hRatio] = ratio.split(":").map(Number);
  const base = bases[tier];
  const scale = Math.sqrt(base * base / (wRatio * hRatio));
  let w = Math.round(scale * wRatio);
  let h = Math.round(scale * hRatio);

  const maxPixels = 16777216;
  const minPixels = 3686400;
  if (w * h > maxPixels) {
    const factor = Math.sqrt(maxPixels / (w * h));
    w = Math.round(w * factor);
    h = Math.round(h * factor);
  }
  if (w * h < minPixels) {
    const factor = Math.sqrt(minPixels / (w * h));
    w = Math.round(w * factor);
    h = Math.round(h * factor);
  }

  w = Math.round(w / 16) * 16;
  h = Math.round(h / 16) * 16;

  return `${w}x${h}`;
}

/** 根据当前画幅比例生成分辨率选项列表 */
function buildResOptions(ratio: AspectRatio): { label: string; value: ResolutionTier }[] {
  return (["1K", "2K", "4K"] as ResolutionTier[]).map((t) => ({
    label: `${t} · ${calcSize(ratio, t)}`,
    value: t,
  }));
}

export type GenerateParams = {
  size: string;
  style: string;
  n: number;
};

type AssetDrawerProps = {
  /** 素材列表（单个或批量） */
  cards: AssetCardData[];
  /** 当前作品 ID（用于素材选择器查询同作品素材） */
  projectId: string;
  /** 关闭抽屉 */
  onClose: () => void;
  /** 确认生成单个素材 */
  onGenerate: (data: AssetCardData, params: GenerateParams) => void;
  /** 确认批量生成 */
  onBatchGenerate?: (cards: AssetCardData[], params: GenerateParams) => void;
  /** 选择本地图片 */
  onSelectLocal?: (data: AssetCardData) => Promise<void>;
  /** 从作品内其他素材复制图片 */
  onCopyFromProject?: (data: AssetCardData, sourceImageId: string) => Promise<void>;
  /** 绑定图片后通知外部刷新卡片列表 */
  onImageSelected?: () => void;
  /** 素材提示词/描述被更新后通知外部（用于生成时使用最新值） */
  onAssetUpdated?: (card: AssetCardData, patch: { prompt: string; description: string }) => void;
  /** 抽屉是否正在执行关闭动画 */
  closing?: boolean;
  disabled?: boolean;
  /** 默认创作风格，不传则取 STYLE_OPTIONS 第一项 */
  defaultStyle?: StyleMode;
};

/**
 * 素材详情 + 生成参数抽屉。
 *
 * 右侧悬浮抽屉。单个素材直接展示详情；批量模式可左右切换素材，
 * 生成参数统一设置后可单个生成或批量生成。
 *
 */
export function AssetDrawer({ cards, projectId, onClose, onGenerate, onBatchGenerate, onSelectLocal, onCopyFromProject, onImageSelected, onAssetUpdated, closing, disabled, defaultStyle }: AssetDrawerProps) {
  const { toast } = useToast();
  const [ratio, setRatio] = useState<AspectRatio>("16:9");
  const [tier, setTier] = useState<ResolutionTier>("2K");
  const [style, setStyle] = useState<StyleMode>(defaultStyle ?? STYLE_OPTIONS[0]);
  const [imageCount, setImageCount] = useState(1);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [imgStatus, setImgStatus] = useState<"loading" | "ready" | "failed" | "none">("none");
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([]);
  const [pollKey, setPollKey] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [importing, setImporting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerClosing, setPickerClosing] = useState(false);
  // 抽屉动画完成后启用 backdrop-filter
  const [settled, setSettled] = useState(false);

  // 超分模式
  const [upscaleMode, setUpscaleMode] = useState(false);
  const [upscaleModel, setUpscaleModel] = useState("anime");
  const [upscaleScale, setUpscaleScale] = useState(2);
  const upscaleGpuOk = useGpuDetect();

  const isBatch = cards.length > 1;
  const current = cards[currentIndex] ?? cards[0];
  const size = useMemo(() => calcSize(ratio, tier), [ratio, tier]);
  const resOptions = useMemo(() => buildResOptions(ratio), [ratio]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : cards.length - 1));
  }, [cards.length]);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => (prev < cards.length - 1 ? prev + 1 : 0));
  }, [cards.length]);

  // 监听 Worker 推送的图片生成/超分事件，即时刷新画廊（事件驱动 + 轮询兜底）
  useEffect(() => {
    if (!current) return;
    let unlistenTask: UnlistenFn | undefined;
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenUpscaleDone: UnlistenFn | undefined;

    const matches = (payload: { clip_id: string; asset_type: string; name: string }) =>
      payload.clip_id === current.clipId &&
      payload.asset_type === current.type &&
      payload.name === current.resource.name;

    listen<AssetImageTaskUpdateEvent>("asset-image-task-update", (e) => {
      if (matches(e.payload)) setPollKey((k) => k + 1);
    }).then((fn) => { unlistenTask = fn; });

    listen<AssetImageProgressEvent>("asset-image-progress", (e) => {
      if (matches(e.payload) && e.payload.status !== "running") {
        setPollKey((k) => k + 1);
      }
    }).then((fn) => { unlistenProgress = fn; });

    // 图片超分完成事件：task_type='image' 且 status='done' 时刷新画廊
    listen<UpscaleDoneEvent>("upscale-done", (e) => {
      if (e.payload.task_type === "image" && e.payload.status === "done") {
        setPollKey((k) => k + 1);
      }
    }).then((fn) => { unlistenUpscaleDone = fn; });

    return () => {
      unlistenTask?.();
      unlistenProgress?.();
      unlistenUpscaleDone?.();
    };
  }, [current?.clipId, current?.type, current?.resource.name]);

  // 抽屉 mount 550ms 后启用 blur（避开滑入动画 + 首帧图片拉取）
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 550);
    return () => clearTimeout(t);
  }, []);

  // 轮询当前素材的图片+任务状态（含 pending / running / failed）
  useEffect(() => {
    if (!current) return;

    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const query = {
          clip_id: current.clipId,
          asset_type: current.type,
          name: current.resource.name,
        };

        // 获取图片+任务混合列表
        const tasks = await listAssetImageTasks(query);
        if (cancelled) return;

        const galleryItems: GalleryImage[] = tasks.map((t) => ({
          id: t.id,
          path: t.image_path,
          is_selected: t.is_selected,
          status: t.status as GalleryImage["status"],
          error_message: t.error_message ?? undefined,
          source: (t as { source?: string }).source,
        }));

        setGalleryImages(galleryItems);

        // 计算全局状态
        const hasPending = tasks.some((t) => t.status === "pending" || t.status === "running");
        const hasFailed = tasks.some((t) => t.status === "failed") && !tasks.some((t) => t.status === "running");
        const hasReady = tasks.some((t) => t.status === "ready");

        if (hasPending) {
          setImgStatus("loading");
        } else if (hasReady) {
          setImgStatus("ready");
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        } else if (hasFailed && !hasReady) {
          setImgStatus("failed");
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        } else {
          setImgStatus(galleryItems.length > 0 ? "ready" : "none");
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      } catch {
        // 保持当前状态
      }
    };

    // 首帧延迟 400ms：滑入动画 280ms + blur 启用 500ms，完全结束后再拉取图片
    const delayMs = pollKey > 0 ? 0 : 400;
    const timeout = setTimeout(() => {
      if (cancelled) return;
      fetchStatus();
      pollRef.current = setInterval(fetchStatus, 3000);
    }, delayMs);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [current?.clipId, current?.type, current?.resource.name, pollKey]);

  // 切换素材时恢复生成模式（超分参数不跨素材复用）
  useEffect(() => {
    setUpscaleMode(false);
    setUpscaleModel("anime");
    setUpscaleScale(2);
  }, [current?.clipId, current?.type, current?.resource.name]);

  // 点击生成后重新开始轮询（不清空已有图片）
  const handleGenerateClick = (fn: () => void) => {
    setPollKey((k) => k + 1);
    fn();
  };

  // 图片超分：找到画廊当前选中图片，发起超分任务
  const handleStartAssetUpscale = useCallback(async () => {
    if (!current) return;
    const currentImg = galleryImages.find(
      (img) => img.status === "ready" && img.path,
    );
    if (!currentImg || !currentImg.path) {
      toast("没有可用的图片进行超分", "error");
      return;
    }
    try {
      await enqueueAssetUpscale({
        clip_id: current.clipId,
        asset_type: current.type,
        asset_name: current.resource.name,
        image_id: currentImg.id,
        image_path: currentImg.path,
        model: upscaleModel,
        scale: upscaleScale,
      });
      toast("超分任务已提交", "success");
      setUpscaleMode(false);
      setPollKey((k) => k + 1);
    } catch (e) {
      toast(e instanceof Error ? e.message : "超分提交失败", "error");
    }
  }, [current, galleryImages, upscaleModel, upscaleScale, toast]);

  // 选中某张图片作为最终使用
  const handleSelectImage = useCallback(async (imageId: string) => {
    if (!current) return;
    try {
      await selectAssetImage({
        clip_id: current.clipId,
        asset_type: current.type,
        name: current.resource.name,
        image_id: imageId,
      });
      setGalleryImages((prev) => prev.map((img) => ({ ...img, is_selected: img.id === imageId })));
      onImageSelected?.();
    } catch {
      toast("绑定图片失败，请重试", "error");
    }
  }, [current, toast, onImageSelected]);

  // 删除图片
  const handleDeleteImage = useCallback(async (imageId: string, deleteFile: boolean) => {
    if (!current) return;
    try {
      const result = await deleteAssetImage({
        clip_id: current.clipId,
        asset_type: current.type,
        name: current.resource.name,
        image_id: imageId,
        delete_file: deleteFile,
      });
      const feedback = formatDeleteResult(result);
      toast(feedback.text, feedback.kind);
      // 刷新图片列表
      setPollKey((k) => k + 1);
    } catch {
      const feedback = formatDeleteResult(undefined, true);
      toast(feedback.text, feedback.kind);
    }
  }, [current, toast]);

  // 打开作品内素材选择器
  const handleOpenPicker = useCallback(() => {
    setPickerOpen(true);
    setPickerClosing(false);
  }, []);

  // 关闭作品内素材选择器（带动画）
  const handleClosePicker = useCallback(() => {
    setPickerClosing(true);
    setTimeout(() => {
      setPickerOpen(false);
      setPickerClosing(false);
    }, 260);
  }, []);

  // 从选择器中选中某个素材的图片 → 复制
  const handlePickAsset = useCallback(async (sourceImageId: string, _sourceName: string) => {
    if (!current || !onCopyFromProject) return;
    setImporting(true);
    handleClosePicker();
    try {
      await onCopyFromProject(current, sourceImageId);
      setPollKey((k) => k + 1);
    } catch (err) {
      toast(`复制图片失败：${String(err)}`, "error");
    } finally {
      setImporting(false);
    }
  }, [current, onCopyFromProject, toast, handleClosePicker]);

  const { resource } = current;
  const typeLabel = TYPE_LABELS[current.type] ?? current.type;
  const icon = TYPE_ICONS[current.type] ?? "📄";

  // 可编辑的提示词/描述草稿，切换素材时同步重置
  const [promptDraft, setPromptDraft] = useState(resource.prompt ?? "");
  const [descDraft, setDescDraft] = useState(resource.description ?? "");
  const [savingAsset, setSavingAsset] = useState(false);

  useEffect(() => {
    setPromptDraft(resource.prompt ?? "");
    setDescDraft(resource.description ?? "");
  }, [resource.prompt, resource.description]);

  // 失焦时保存提示词/描述到后端
  const handleSaveAsset = useCallback(async () => {
    if (!current) return;
    const prompt = promptDraft;
    const description = descDraft;
    // 无变化则跳过
    if (prompt === (resource.prompt ?? "") && description === (resource.description ?? "")) return;
    setSavingAsset(true);
    try {
      await updateAssetInClip({
        clip_id: current.clipId,
        asset_type: current.type,
        name: current.resource.name,
        description,
        prompt,
      });
      onAssetUpdated?.(current, { prompt, description });
    } catch (err) {
      toast(`保存失败：${String(err)}`, "error");
      // 失败回滚草稿
      setPromptDraft(resource.prompt ?? "");
      setDescDraft(resource.description ?? "");
    } finally {
      setSavingAsset(false);
    }
  }, [current, resource.prompt, resource.description, promptDraft, descDraft, toast, onAssetUpdated]);

  return (
    <>
      {/* 遮罩层 */}
      <div className={`asset-drawer-backdrop${closing ? " asset-drawer-backdrop--closing" : ""}`} onClick={onClose} />

      {/* 抽屉面板 */}
      <aside className={`asset-drawer${closing ? " asset-drawer--closing" : ""}${settled && !closing ? " asset-drawer--settled" : ""}`} onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="asset-drawer-header">
          <div className="asset-drawer-title-row">
            <h2 className="asset-drawer-title">{resource.name}</h2>
            <span className="asset-detail-type-tag">{typeLabel}</span>
          </div>
          <button
            type="button"
            className="icon-button modal-close-button"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* 批量模式导航条：独立一行，大厂 pagination 风格 */}
        {isBatch && (
          <div className="asset-drawer-nav-strip">
            <button
              type="button"
              className="asset-drawer-nav-pill"
              onClick={goPrev}
              disabled={disabled || currentIndex === 0}
              aria-label="上一个"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            <div className="asset-drawer-nav-progress">
              {cards.map((_c, i) => (
                <span
                  key={i}
                  className={`asset-drawer-nav-dot${i === currentIndex ? " asset-drawer-nav-dot--active" : ""}`}
                />
              ))}
              <span className="asset-drawer-nav-count">
                {currentIndex + 1} / {cards.length}
              </span>
            </div>

            <button
              type="button"
              className="asset-drawer-nav-pill"
              onClick={goNext}
              disabled={disabled || currentIndex >= cards.length - 1}
              aria-label="下一个"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6 3L10 8L6 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        )}

        {/* 滚动内容区 */}
        <div className="asset-drawer-body">
          {/* 图片预览（独立组件） */}
          <AssetImageGallery
            images={galleryImages}
            status={imgStatus}
            placeholderIcon={icon}
            altName={resource.name}
            assetTypeLabel={typeLabel}
            onSelect={handleSelectImage}
            onDelete={handleDeleteImage}
            onRetry={async (taskId) => {
              try {
                await retryAssetImageTask({ task_id: taskId });
                setPollKey((k) => k + 1);
              } catch {
                toast("重试失败，请稍后再试", "error");
              }
            }}
            onSelectLocal={onSelectLocal ? async () => {
              setImporting(true);
              try {
                await onSelectLocal(current);
                setPollKey((k) => k + 1);
              } finally {
                setImporting(false);
              }
            } : undefined}
            onSelectFromProject={onCopyFromProject ? handleOpenPicker : undefined}
            importing={importing}
            disabled={disabled}
            onUpscaleToggle={() => setUpscaleMode((v) => !v)}
            upscaleActive={upscaleMode}
            upscaleGpuOk={upscaleGpuOk}
          />

          {!upscaleMode ? (
            <>
              {/* 素材信息（提示词/描述可编辑，失焦保存） */}
              <div className="add-asset-form">
                <div className="add-asset-field">
                  <label className="add-asset-label">描述</label>
                  <textarea
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    onBlur={handleSaveAsset}
                    placeholder="暂无描述"
                    rows={2}
                    disabled={disabled || savingAsset}
                  />
                </div>
                <div className="add-asset-field">
                  <label className="add-asset-label">提示词</label>
                  <textarea
                    className="add-asset-prompt"
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    onBlur={handleSaveAsset}
                    placeholder="暂无"
                    rows={4}
                    disabled={disabled || savingAsset}
                  />
                </div>
              </div>

              {/* 分隔线 */}
              <div className="asset-drawer-divider" />

              {/* 生成参数 */}
              <div className="asset-drawer-section-title">生成参数</div>
              <div className="generate-asset-form">
                <div className="field">
                  <span>画幅比例</span>
                  <div className="segmented segmented--cols5">
                    {(["16:9", "9:16", "4:3", "3:4", "1:1"] as AspectRatio[]).map((r) => (
                      <button
                        key={r}
                        type="button"
                        className={ratio === r ? "active" : ""}
                        onClick={() => setRatio(r)}
                        disabled={disabled}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <span>生成数量</span>
                  <div className="segmented segmented--cols4">
                    {([1, 2, 3, 4] as number[]).map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={imageCount === n ? "active" : ""}
                        onClick={() => setImageCount(n)}
                        disabled={disabled}
                      >
                        {n} 张
                      </button>
                    ))}
                  </div>
                </div>

                <SelectField
                  label="分辨率"
                  value={tier}
                  options={resOptions}
                  onChange={(v) => setTier(v as ResolutionTier)}
                />

                <SelectField
                  label="创作风格"
                  value={style}
                  options={STYLE_OPTIONS}
                  onChange={(v) => setStyle(v as StyleMode)}
                />
              </div>
            </>
          ) : (
            <>
              {/* 显卡提醒 */}
              <div className={`sbu-gpu-tip${upscaleGpuOk === false ? " sbu-gpu-tip--warn" : ""}`}>
                {upscaleGpuOk === false ? (
                  INFO_ICON_SVG
                ) : (
                  <span className="sbu-gpu-tip-more" tabIndex={0} role="tooltip" aria-label="查看详细硬件配置要求">
                    {INFO_ICON_SVG}
                    <div className="sbu-gpu-tip-popover">
                      <div className="sbu-gpu-tip-popover-title">需要什么显卡？</div>
                      <ul className="sbu-gpu-tip-popover-list">
                        <li>支持 NVIDIA / AMD / Intel 显卡</li>
                        <li>显卡内存（显存）建议 4GB 以上</li>
                        <li>没有可用显卡加速时超分会禁用</li>
                      </ul>
                    </div>
                  </span>
                )}
                <span>
                  {upscaleGpuOk === false
                    ? "你的电脑没有可用的显卡，无法使用画质增强"
                    : "画质增强使用显卡加速"}
                </span>
              </div>

              {/* 模型选择 */}
              <div className="sbu-section">
                <div className="sbu-section-head">
                  <span className="sbu-section-label">模型</span>
                </div>
                <div className="segmented segmented--cols3">
                  {UPSCALE_MODELS.map((m) => {
                    const isFixed4x = FIXED_4X.has(m.value);
                    return (
                      <button
                        key={m.value}
                        type="button"
                        className={upscaleModel === m.value ? "active" : ""}
                        onClick={() => {
                          setUpscaleModel(m.value);
                          if (isFixed4x) setUpscaleScale(4);
                        }}
                        disabled={disabled || upscaleGpuOk === false}
                      >
                        <span className="sbu-model-name">{m.label}</span>
                        <span className="sbu-model-tag">{m.tag}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="sbu-section-desc">
                  {UPSCALE_MODELS.find((m) => m.value === upscaleModel)?.desc ?? ""}
                </p>
              </div>

              {/* 倍率选择（仅动漫优化模型可选） */}
              {!FIXED_4X.has(upscaleModel) && (
                <div className="sbu-section">
                  <div className="sbu-section-head">
                    <span className="sbu-section-label">倍率</span>
                  </div>
                  <div className="segmented segmented--cols3">
                    {UPSCALE_SCALES.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        className={upscaleScale === s.value ? "active" : ""}
                        onClick={() => setUpscaleScale(s.value)}
                        disabled={disabled || upscaleGpuOk === false}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <p className="sbu-section-desc">输出按图片分辨率的 {upscaleScale} 倍放大</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="asset-drawer-footer">
          {upscaleMode ? (
            <button
              type="button"
              className="asset-drawer-btn asset-drawer-btn--primary"
              onClick={handleStartAssetUpscale}
              disabled={disabled || upscaleGpuOk === false || upscaleGpuOk === null}
            >
              {upscaleGpuOk === null ? "检查显卡中…" : "开始"}
            </button>
          ) : isBatch && onBatchGenerate ? (
            <>
              <button
                type="button"
                className="asset-drawer-btn asset-drawer-btn--secondary"
                onClick={() => handleGenerateClick(() => onGenerate(current, { size, style, n: imageCount }))}
                disabled={disabled}
              >
                生成当前
              </button>
              <button
                type="button"
                className="asset-drawer-btn asset-drawer-btn--primary"
                onClick={() => handleGenerateClick(() => onBatchGenerate(cards, { size, style, n: imageCount }))}
                disabled={disabled}
              >
                批量生成（{cards.length}）
              </button>
            </>
          ) : (
            <button
              type="button"
              className="asset-drawer-btn asset-drawer-btn--primary"
              onClick={() => handleGenerateClick(() => onGenerate(current, { size, style, n: imageCount }))}
              disabled={disabled}
            >
              开始生成
            </button>
          )}
        </div>
      </aside>

      {/* 作品内素材图片选择器（左侧抽屉） */}
      {pickerOpen && current && (
        <AssetPickerDrawer
          projectId={projectId}
          assetType={current.type}
          excludeClipId={current.clipId}
          onPick={handlePickAsset}
          onClose={handleClosePicker}
          closing={pickerClosing}
        />
      )}
    </>
  );
}
