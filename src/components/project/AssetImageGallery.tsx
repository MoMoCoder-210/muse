import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageLightbox } from "../common/ImageLightbox";
import { DeleteConfirmModal } from "./DeleteConfirmModal";

export type GalleryImage = {
  id: string;
  path: string | null;       // null for pending/running/failed tasks
  is_selected: boolean;
  status: "ready" | "pending" | "running" | "failed";  // per-item status
  error_message?: string;
};

type AssetImageGalleryProps = {
  /** 该资产的所有图片+任务（含 pending / running / failed） */
  images: GalleryImage[];
  /** 全局加载状态（初始拉取时） */
  status: "loading" | "ready" | "failed" | "none";
  /** 占位图标（无图时显示） */
  placeholderIcon?: string;
  /** 资产名称（用于 alt） */
  altName: string;
  /** 资产类型中文标签，如 "角色" / "场景" / "物品" */
  assetTypeLabel?: string;
  /** 选中某张图片回调 */
  onSelect?: (imageId: string) => void;
  /** 删除图片回调：imageId + 是否同时删除文件 */
  onDelete?: (imageId: string, deleteFile: boolean) => void;
  /** 重新生成回调 */
  onRegenerate?: () => void;
  /** 选择本地图片回调 */
  onSelectLocal?: () => Promise<void>;
  /** 从项目内其他资产选择图片回调 */
  onSelectFromProject?: () => void;
  /** 是否正在导入本地图片 */
  importing?: boolean;
  disabled?: boolean;
};

/**
 * 资产图片预览组件
 *
 */
export function AssetImageGallery({
  images,
  status: globalStatus,
  placeholderIcon = "📄",
  altName,
  assetTypeLabel,
  onSelect,
  onDelete,
  onRegenerate,
  onSelectLocal,
  onSelectFromProject,
  importing,
  disabled,
}: AssetImageGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteFile, setDeleteFile] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // 图片列表变化时重置 activeIndex，优先跳到选中图片
  useEffect(() => {
    if (images.length === 0) {
      setActiveIndex(0);
      return;
    }
    const selIdx = images.findIndex((img) => img.is_selected);
    setActiveIndex(selIdx >= 0 ? selIdx : 0);
  }, [images.length, images.find((img) => img.is_selected)?.id]);

  // 边界保护
  const currentIndex = images.length === 0 ? 0 : Math.min(activeIndex, images.length - 1);
  const currentImage = images[currentIndex] ?? null;

  const goPrev = () => {
    if (images.length <= 1) return;
    setActiveIndex((i) => (i > 0 ? i - 1 : images.length - 1));
  };

  const goNext = () => {
    if (images.length <= 1) return;
    setActiveIndex((i) => (i < images.length - 1 ? i + 1 : 0));
  };

  // 判断画廊是否有任何可展示的项目
  const hasItems = images.length > 0;
  const showGlobalLoading = !hasItems && globalStatus === "loading";

  // 缩略图内容渲染
  const renderThumbContent = (img: GalleryImage) => {
    if (img.status === "ready" && img.path) {
      return <img src={convertFileSrc(img.path)} alt="" draggable={false} />;
    }
    if (img.status === "pending" || img.status === "running") {
      return (
        <div className="asset-gallery-thumb-status asset-gallery-thumb-status--pending">
          <span className="spinner" aria-hidden />
        </div>
      );
    }
    if (img.status === "failed") {
      return (
        <div className="asset-gallery-thumb-status asset-gallery-thumb-status--failed">
          <span>✕</span>
        </div>
      );
    }
    return null;
  };

  // 主图渲染
  const renderMainContent = () => {
    if (!hasItems) {
      // 无任何项时的全局占位
      if (globalStatus === "loading") {
        return (
          <div className="asset-gallery-status">
            <span className="spinner" aria-hidden />
            <span>加载中…</span>
          </div>
        );
      }
      if (globalStatus === "failed") {
        return (
          <div className="asset-gallery-status asset-gallery-status--failed">
            <span className="asset-gallery-status-icon">✕</span>
            <span>加载失败</span>
          </div>
        );
      }
      return <span className="asset-gallery-placeholder">{placeholderIcon}</span>;
    }

    // 有项目：根据当前选中项的 status 渲染不同内容
    if (!currentImage) {
      return <span className="asset-gallery-placeholder">{placeholderIcon}</span>;
    }

    // 当前项有图片
    if (currentImage.status === "ready" && currentImage.path) {
      return (
        <>
          <img
            className="asset-gallery-img asset-gallery-img--clickable"
            src={convertFileSrc(currentImage.path)}
            alt={altName}
            draggable={false}
            onClick={() => setLightboxOpen(true)}
          />
          {importing && (
            <div className="asset-gallery-importing-overlay">
              <span className="spinner spinner--lg" aria-hidden />
              <span>导入中…</span>
            </div>
          )}
          {currentImage.is_selected && (
            <div className="asset-gallery-badge">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path d="M3 8L7 12L13 4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              已选定
            </div>
          )}
          {onDelete && (
            <button
              type="button"
              className="asset-gallery-delete"
              onClick={() => { setDeleteTarget(currentImage.id); setDeleteFile(false); }}
              disabled={disabled}
              aria-label="删除此图片"
              title="删除此图片"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M2 4H14M5 4V2.5C5 2.22 5.22 2 5.5 2H10.5C10.78 2 11 2.22 11 2.5V4M6.5 7V12M9.5 7V12M3.5 4L4.2 13.5C4.22 13.78 4.45 14 4.74 14H11.26C11.55 14 11.78 13.78 11.8 13.5L12.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
        </>
      );
    }

    // 当前项生成中
    if (currentImage.status === "pending" || currentImage.status === "running") {
      return (
        <div className="asset-gallery-status">
          <span className="spinner" aria-hidden />
          <span>{currentImage.status === "pending" ? "等待中…" : "生成中…"}</span>
        </div>
      );
    }

    // 当前项失败
    if (currentImage.status === "failed") {
      return (
        <div className="asset-gallery-status asset-gallery-status--failed">
          <span className="asset-gallery-status-icon">✕</span>
          <span>{currentImage.error_message ?? "生成失败"}</span>
          <div className="asset-gallery-failed-actions">
            {onRegenerate && (
              <button
                type="button"
                className="asset-gallery-retry"
                onClick={onRegenerate}
                disabled={disabled}
              >
                重试
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className="asset-gallery-delete"
                onClick={() => { setDeleteTarget(currentImage.id); setDeleteFile(false); }}
                disabled={disabled}
                aria-label="删除此图片"
                title="删除此图片"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M2 4H14M5 4V2.5C5 2.22 5.22 2 5.5 2H10.5C10.78 2 11 2.22 11 2.5V4M6.5 7V12M9.5 7V12M3.5 4L4.2 13.5C4.22 13.78 4.45 14 4.74 14H11.26C11.55 14 11.78 13.78 11.8 13.5L12.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      );
    }

    // 导入中状态
    if (importing) {
      return (
        <div className="asset-gallery-status">
          <span className="spinner" aria-hidden />
          <span>导入中…</span>
        </div>
      );
    }

    return <span className="asset-gallery-placeholder">{placeholderIcon}</span>;
  };

  const showNavButtons = images.length > 1;

  return (
    <div className={`asset-gallery ${showGlobalLoading ? "asset-gallery--loading" : ""}`}>
      {/* 主图区域 */}
      <div className="asset-gallery-main">
        {renderMainContent()}

        {/* 多图切换 */}
        {showNavButtons && (
          <>
            <button
              type="button"
              className="asset-gallery-nav asset-gallery-nav--prev"
              onClick={goPrev}
              aria-label="上一张"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button
              type="button"
              className="asset-gallery-nav asset-gallery-nav--next"
              onClick={goNext}
              aria-label="下一张"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <div className="asset-gallery-counter">
              {currentIndex + 1} / {images.length}
            </div>
          </>
        )}

      </div>

      {/* 缩略图条：含状态标记 */}
      {hasItems && (
        <div className="asset-gallery-thumbs">
          {images.map((img, i) => (
            <button
              key={img.id}
              type="button"
              className={
                `asset-gallery-thumb` +
                `${i === currentIndex ? " asset-gallery-thumb--active" : ""}` +
                `${img.is_selected ? " asset-gallery-thumb--selected" : ""}` +
                `${img.status === "failed" ? " asset-gallery-thumb--error" : ""}`
              }
              onClick={() => setActiveIndex(i)}
              aria-label={`第 ${i + 1} 张`}
            >
              {renderThumbContent(img)}
              {img.is_selected && <span className="asset-gallery-thumb-check" />}
            </button>
          ))}
        </div>
      )}

      {/* 底部操作行：始终占位，避免高度跳动 */}
      <div className="asset-gallery-action">
        {currentImage && currentImage.is_selected ? (
          <button
            type="button"
            className="asset-gallery-action-btn asset-gallery-action-btn--primary"
            disabled
          >
            已绑定
          </button>
        ) : currentImage && currentImage.status === "ready" && onSelect ? (
          <button
            type="button"
            className="asset-gallery-action-btn asset-gallery-action-btn--primary"
            onClick={() => onSelect(currentImage.id)}
            disabled={disabled}
          >
            确认{assetTypeLabel ?? "图片"}
          </button>
        ) : null}
      </div>

      {/* 选择图片按钮行：本地图片 + 项目内其他资产 */}
      {(onSelectLocal || onSelectFromProject) && (
        <div className="asset-gallery-local-row">
          {onSelectFromProject && (
            <button
              type="button"
              className="asset-gallery-local-btn asset-gallery-local-btn--secondary"
              onClick={onSelectFromProject}
              disabled={disabled}
            >
              选择其他图片
            </button>
          )}
          {onSelectLocal && (
            <button
              type="button"
              className="asset-gallery-local-btn asset-gallery-local-btn--secondary"
              onClick={async () => { await onSelectLocal(); }}
              disabled={disabled}
            >
              选择本地图片
            </button>
          )}
        </div>
      )}

      {/* 删除图片确认弹窗 */}
      {deleteTarget && onDelete && (
        <DeleteConfirmModal
          title="删除图片"
          description={<>确认删除此图片？</>}
          checkbox={{
            label: "同时删除磁盘文件",
            checked: deleteFile,
            onChange: setDeleteFile,
          }}
          onConfirm={() => {
            onDelete(deleteTarget, deleteFile);
            setDeleteTarget(null);
            setDeleteFile(false);
          }}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteFile(false);
          }}
          disabled={disabled}
        />
      )}

      {/* 大图预览 */}
      {lightboxOpen && currentImage?.status === "ready" && currentImage.path && (
        <ImageLightbox
          src={convertFileSrc(currentImage.path)}
          alt={altName}
          onClose={() => setLightboxOpen(false)}
        >
          {images.length > 1 && (
            <>
              <button
                type="button"
                className="asset-lightbox-nav asset-lightbox-nav--prev"
                onClick={goPrev}
                aria-label="上一张"
              >
                <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
                  <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <button
                type="button"
                className="asset-lightbox-nav asset-lightbox-nav--next"
                onClick={goNext}
                aria-label="下一张"
              >
                <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
                  <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <div className="asset-lightbox-counter">
                {currentIndex + 1} / {images.length}
              </div>
            </>
          )}
        </ImageLightbox>
      )}
    </div>
  );
}
