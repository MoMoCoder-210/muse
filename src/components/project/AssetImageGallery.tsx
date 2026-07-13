import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";

export type GalleryImage = {
  id: string;
  path: string | null;       // null for pending/running/failed tasks
  is_selected: boolean;
  status: "ready" | "pending" | "running" | "failed";  // per-item status
  error_message?: string;
  ark_upload_status?: "pending" | "uploaded" | "failed" | null;
  ark_upload_error?: string;
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
  /** 重试上传回调（上传失败时） */
  onRetryUpload?: (imageId: string) => Promise<void>;
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
  onRetryUpload,
  importing,
  disabled,
}: AssetImageGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteFile, setDeleteFile] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragInfo = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  // 鼠标拖动平移
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return; // 未放大时不触发拖动
    e.preventDefault();
    dragInfo.current = { startX: e.clientX, startY: e.clientY, originX: offset.x, originY: offset.y };
    setIsDragging(true);
  }, [zoom, offset]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragInfo.current) return;
    const dx = e.clientX - dragInfo.current.startX;
    const dy = e.clientY - dragInfo.current.startY;
    setOffset({ x: dragInfo.current.originX + dx, y: dragInfo.current.originY + dy });
  }, []);

  const handleMouseUp = useCallback(() => {
    dragInfo.current = null;
    setIsDragging(false);
  }, []);

  // 拖动期间监听全局 mousemove / mouseup
  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // 键盘操作：lightbox 打开时支持 Esc 关闭、左右切换
  const handleLightboxKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") setLightboxOpen(false);
    if (e.key === "ArrowLeft") goPrev();
    if (e.key === "ArrowRight") goNext();
  }, [images.length]);

  // 滚轮缩放：放大/缩小
  const handleLightboxWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setZoom((prev) => Math.min(5, Math.max(1, prev + delta)));
  }, []);

  useEffect(() => {
    if (!lightboxOpen) return;
    window.addEventListener("keydown", handleLightboxKeyDown);
    window.addEventListener("wheel", handleLightboxWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", handleLightboxKeyDown);
      window.removeEventListener("wheel", handleLightboxWheel);
    };
  }, [lightboxOpen, handleLightboxKeyDown, handleLightboxWheel]);

  // 关闭 lightbox 时重置缩放和位移
  useEffect(() => {
    if (!lightboxOpen) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    }
  }, [lightboxOpen]);

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

  // 切换图片时重置缩放和位移
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [currentIndex]);

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

  // 计算总体任务统计
  const pendingCount = images.filter((img) => img.status === "pending").length;
  const runningCount = images.filter((img) => img.status === "running").length;
  const readyCount = images.filter((img) => img.status === "ready").length;

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
      const uploadFailed = currentImage.ark_upload_status === "failed";
      const uploadPending = currentImage.ark_upload_status === "pending";
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
          {uploadFailed && (
            <div className="asset-gallery-upload-error" title={currentImage.ark_upload_error ?? "上传失败"}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 1L15 14H1L8 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M8 6V9.5M8 11.5V12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              <span>上传失败</span>
              {onRetryUpload && (
                <button
                  type="button"
                  className="asset-gallery-upload-retry"
                  onClick={(e) => { e.stopPropagation(); onRetryUpload(currentImage.id); }}
                  disabled={disabled}
                >
                  重试
                </button>
              )}
            </div>
          )}
          {uploadPending && (
            <div className="asset-gallery-upload-pending">
              <span className="spinner" aria-hidden />
              <span>上传中…</span>
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
  const pendingTotal = pendingCount + runningCount;

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

        {/* 任务进度角标 */}
        {pendingTotal > 0 && (
          <div className="asset-gallery-generating">
            <span className="spinner" aria-hidden />
            <span>{readyCount}/{images.length} 已完成</span>
          </div>
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
                `${img.status === "failed" ? " asset-gallery-thumb--error" : ""}` +
                `${img.ark_upload_status === "failed" ? " asset-gallery-thumb--upload-error" : ""}` +
                `${img.ark_upload_status === "pending" ? " asset-gallery-thumb--upload-pending" : ""}`
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
            className="primary-button btn-sm"
            disabled
          >
            已绑定
          </button>
        ) : currentImage && currentImage.status === "ready" && onSelect ? (
          <button
            type="button"
            className="primary-button btn-sm"
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
              className="secondary-button btn-sm"
              onClick={onSelectFromProject}
              disabled={disabled}
            >
              选择其他图片
            </button>
          )}
          {onSelectLocal && (
            <button
              type="button"
              className="primary-button btn-sm"
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
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setDeleteTarget(null)}>
          <div className="modal-panel clip-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="delete-confirm-title">删除图片</h2>
              <button
                type="button"
                className="icon-button modal-close-button"
                aria-label="关闭"
                onClick={() => setDeleteTarget(null)}
                disabled={disabled}
              >
                ×
              </button>
            </div>
            <p className="clip-delete-modal-text">
              确认删除此图片？
            </p>
            <label className="delete-files-option">
              <input
                type="checkbox"
                checked={deleteFile}
                onChange={(e) => setDeleteFile(e.target.checked)}
              />
              同时删除磁盘文件
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary-button btn-sm" onClick={() => setDeleteTarget(null)} disabled={disabled}>
                取消
              </button>
              <button
                type="button"
                className="danger-button btn-sm"
                onClick={() => { onDelete(deleteTarget, deleteFile); setDeleteTarget(null); }}
                disabled={disabled}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 大图预览 Lightbox（Portal 到 body，避免抽屉 transform 导致 fixed 定位失效） */}
      {lightboxOpen && currentImage?.status === "ready" && currentImage?.path && createPortal(
        <div
          className="asset-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="图片大图预览"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="asset-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <img
              className="asset-lightbox-img"
              src={convertFileSrc(currentImage.path)}
              alt={altName}
              draggable={false}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                transition: isDragging ? "none" : "transform 120ms ease",
                cursor: zoom > 1 ? (isDragging ? "grabbing" : "grab") : "default",
              }}
              onMouseDown={handleMouseDown}
            />

            {/* 关闭按钮 */}
            <button
              type="button"
              className="asset-lightbox-close"
              onClick={() => setLightboxOpen(false)}
              aria-label="关闭大图"
            >
              <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
                <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>

            {/* 多图切换 */}
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

            {/* 缩放比例 */}
            {zoom !== 1 && (
              <div className="asset-lightbox-zoom">
                {Math.round(zoom * 100)}%
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
