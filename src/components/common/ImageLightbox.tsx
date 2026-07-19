import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type ImageLightboxProps = {
  src: string;
  alt: string;
  onClose: () => void;
  children?: ReactNode;
};

type Offset = { x: number; y: number };

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.2;

/**
 * Full-content image preview that keeps the window title bar interactive.
 * It owns its portal, keyboard handling, dragging, and the single wheel-zoom listener.
 */
export function ImageLightbox({ src, alt, onClose, children }: ImageLightboxProps) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<{ clientX: number; clientY: number; offset: Offset } | null>(null);

  const resetView = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    resetView();
  }, [src]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (event: MouseEvent) => {
      const start = dragStart.current;
      if (!start) return;
      setOffset({
        x: start.offset.x + event.clientX - start.clientX,
        y: start.offset.y + event.clientY - start.clientY,
      });
    };
    const handleMouseUp = () => {
      dragStart.current = null;
      setIsDragging(false);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  const changeZoom = (amount: number) => {
    setZoom((current) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current + amount)));
  };

  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片大图预览"
      onClick={onClose}
      onWheel={(event) => {
        event.preventDefault();
        changeZoom(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
      }}
    >
      <img
        className="image-lightbox__image"
        src={src}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          transition: isDragging ? "none" : "transform 80ms ease",
          cursor: isDragging ? "grabbing" : "grab",
        }}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => {
          event.preventDefault();
          dragStart.current = { clientX: event.clientX, clientY: event.clientY, offset };
          setIsDragging(true);
        }}
      />
      <button
        type="button"
        className="image-lightbox__close"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        aria-label="关闭"
      >×</button>
      {children && <div className="image-lightbox__actions" onClick={(event) => event.stopPropagation()}>{children}</div>}
      <div className="image-lightbox__zoom-bar" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="image-lightbox__zoom-button" onClick={() => changeZoom(-ZOOM_STEP)} aria-label="缩小">−</button>
        <span className="image-lightbox__zoom-value">{Math.round(zoom * 100)}%</span>
        <button type="button" className="image-lightbox__zoom-button" onClick={() => changeZoom(ZOOM_STEP)} aria-label="放大">+</button>
        <button type="button" className="image-lightbox__zoom-reset" onClick={resetView} aria-label="重置">重置</button>
      </div>
    </div>,
    document.body,
  );
}
