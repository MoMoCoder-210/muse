import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STYLE_OPTIONS, type StyleMode } from "../../config/muse";
import { SelectField } from "../common/SelectField";
import { listAssetImageTasks, selectAssetImage, deleteAssetImage } from "../../services/tauri";
import { useToast } from "../../hooks/useToast";
import type { AssetCardData } from "./AssetCard";
import { AssetImageGallery, type GalleryImage } from "./AssetImageGallery";

/** 画幅比例 */
type AspectRatio = "16:9" | "9:16" | "4:3" | "3:4" | "1:1";

/** 分辨率档位 */
type ResolutionTier = "1K" | "2K" | "4K";

const TYPE_LABELS: Record<string, string> = {
  character: "角色",
  scene: "场景",
  item: "物品",
};

const TYPE_ICONS: Record<string, string> = {
  character: "👤",
  scene: "🏞",
  item: "📦",
};

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
  /** 资产列表（单个或批量） */
  cards: AssetCardData[];
  /** 关闭抽屉 */
  onClose: () => void;
  /** 确认生成单个资产 */
  onGenerate: (data: AssetCardData, params: GenerateParams) => void;
  /** 确认批量生成 */
  onBatchGenerate?: (cards: AssetCardData[], params: GenerateParams) => void;
  /** 选择本地图片 */
  onSelectLocal?: (data: AssetCardData) => Promise<void>;
  /** 绑定图片后通知外部刷新卡片列表 */
  onImageSelected?: () => void;
  /** 抽屉是否正在执行关闭动画 */
  closing?: boolean;
  disabled?: boolean;
};

/**
 * 资产详情 + 生成参数抽屉。
 *
 * 右侧悬浮抽屉。单个资产直接展示详情；批量模式可左右切换资产，
 * 生成参数统一设置后可单个生成或批量生成。
 *
 * @author yt @date 20260705
 */
export function AssetDrawer({ cards, onClose, onGenerate, onBatchGenerate, onSelectLocal, onImageSelected, closing, disabled }: AssetDrawerProps) {
  const { toast } = useToast();
  const [ratio, setRatio] = useState<AspectRatio>("16:9");
  const [tier, setTier] = useState<ResolutionTier>("2K");
  const [style, setStyle] = useState<StyleMode>(STYLE_OPTIONS[0]);
  const [imageCount, setImageCount] = useState(1);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [imgStatus, setImgStatus] = useState<"loading" | "ready" | "failed" | "none">("none");
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([]);
  const [pollKey, setPollKey] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // 轮询当前资产的图片+任务状态（含 pending / running / failed）
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

    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 3000);

    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [current?.clipId, current?.type, current?.resource.name, pollKey]);

  // 点击生成后重新开始轮询（不清空已有图片）
  const handleGenerateClick = (fn: () => void) => {
    setPollKey((k) => k + 1);
    fn();
  };

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
      await deleteAssetImage({
        clip_id: current.clipId,
        asset_type: current.type,
        name: current.resource.name,
        image_id: imageId,
        delete_file: deleteFile,
      });
      // 刷新图片列表
      setPollKey((k) => k + 1);
    } catch {
      toast("删除图片失败，请重试", "error");
    }
  }, [current, toast]);

  const { resource } = current;
  const typeLabel = TYPE_LABELS[current.type] ?? current.type;
  const icon = TYPE_ICONS[current.type] ?? "📄";

  return (
    <>
      {/* 遮罩层 */}
      <div className={`asset-drawer-backdrop${closing ? " asset-drawer-backdrop--closing" : ""}`} onClick={onClose} />

      {/* 抽屉面板 */}
      <aside className={`asset-drawer${closing ? " asset-drawer--closing" : ""}`} onClick={(e) => e.stopPropagation()}>
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
            onRegenerate={() => handleGenerateClick(() => onGenerate(current, { size, style, n: imageCount }))}
            onSelectLocal={onSelectLocal ? async () => { await onSelectLocal(current); setPollKey((k) => k + 1); } : undefined}
            disabled={disabled}
          />

          {/* 资产信息 */}
          <div className="add-asset-form">
            <div className="add-asset-field">
              <label className="add-asset-label">描述</label>
              <div className="add-asset-readonly">{resource.description || "暂无描述"}</div>
            </div>
            <div className="add-asset-field">
              <label className="add-asset-label">提示词</label>
              <div className="add-asset-readonly add-asset-prompt">{resource.prompt || "暂无"}</div>
            </div>
          </div>

          {/* 分隔线 */}
          <div className="asset-drawer-divider" />

          {/* 生成参数 */}
          <div className="asset-drawer-section-title">生成参数</div>
          <div className="generate-asset-form">
            <div className="field">
              <span>画幅比例</span>
              <div className="segmented" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
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
              <div className="segmented" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
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
        </div>

        {/* 底部操作栏 */}
        <div className="asset-drawer-footer">
          {isBatch && onBatchGenerate ? (
            <>
              <button
                type="button"
                className="secondary-button btn-sm"
                onClick={() => handleGenerateClick(() => onGenerate(current, { size, style, n: imageCount }))}
                disabled={disabled}
              >
                生成当前
              </button>
              <button
                type="button"
                className="primary-button btn-sm"
                onClick={() => handleGenerateClick(() => onBatchGenerate(cards, { size, style, n: imageCount }))}
                disabled={disabled}
              >
                批量生成（{cards.length}）
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary-button btn-sm"
              onClick={() => handleGenerateClick(() => onGenerate(current, { size, style, n: imageCount }))}
              disabled={disabled}
            >
              开始生成
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
