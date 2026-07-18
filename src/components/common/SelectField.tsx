import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type SelectOption<T extends string> = {
  label: string;
  value: T;
};

type SelectFieldProps<T extends string> = {
  label: string;
  value: T;
  options: readonly SelectOption<T>[] | readonly T[];
  onChange: (value: T) => void;
};

function toOption<T extends string>(item: SelectOption<T> | T): SelectOption<T> {
  return typeof item === "string" ? { label: item, value: item as T } : item;
}

/**
 * 通用下拉选择字段
 *
 * 支持自定义选项或字符串列表，菜单通过 Portal 渲染到 body，不受父容器 overflow 限制。
 *
 */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: SelectFieldProps<T>) {
  const [open, setOpen] = useState(false);
  /** 控制菜单动画阶段："closed" | "entering" | "open" | "exiting" */
  const [phase, setPhase] = useState<"closed" | "entering" | "open" | "exiting">("closed");
  const shellRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

  const updatePosition = useCallback(() => {
    if (!shellRef.current) return;
    const rect = shellRef.current.getBoundingClientRect();
    setMenuStyle({
      top: rect.bottom + 8 + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
    });
  }, []);

  // 打开菜单：先定位 → 下一帧播入场动画
  useEffect(() => {
    if (!open) return;
    updatePosition();
    requestAnimationFrame(() => setPhase("entering"));
  }, [open, updatePosition]);

  // 滚动/窗口大小变化时更新位置
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  // 关闭菜单：先播退出动画 → animationend 后彻底移除
  const closeMenu = useCallback(() => {
    setPhase("exiting");
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open && phase === "exiting") {
      const menu = menuRef.current;
      if (!menu) {
        setPhase("closed");
        return;
      }
      const handler = () => setPhase("closed");
      menu.addEventListener("animationend", handler, { once: true });
      return () => menu.removeEventListener("animationend", handler);
    }
    // open 变 true 时会由上面的 useEffect 接管，这里不做额外处理
  }, [open, phase]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (shellRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") closeMenu();
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open, closeMenu]);

  const normalized = (options as ReadonlyArray<SelectOption<T> | T>).map(toOption);
  const selected = normalized.find((o) => o.value === value);

  const menuVisible = phase !== "closed";

  const menuElement = (
    <div
      ref={menuRef}
      className={`select-menu ${phase === "entering" || phase === "open" ? "select-menu--in" : ""} ${phase === "exiting" ? "select-menu--out" : ""}`}
      role="listbox"
      aria-label={label}
      style={{
        position: "fixed",
        top: menuStyle.top,
        left: menuStyle.left,
        width: menuStyle.width,
        zIndex: 1000,
        visibility: menuVisible ? "visible" : "hidden",
        pointerEvents: menuVisible ? "auto" : "none",
      } as React.CSSProperties}
    >
      {normalized.map((option) => (
        <button
          key={option.value}
          type="button"
          role="option"
          className={`select-option ${option.value === value ? "active" : ""}`}
          aria-selected={option.value === value}
          onClick={() => {
            onChange(option.value);
            closeMenu();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  return (
    <label className="field">
      <span>{label}</span>
      <div className="select-shell" ref={shellRef}>
        <button
          type="button"
          className={`select-trigger ${open ? "open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            if (open) {
              closeMenu();
            } else {
              setOpen(true);
            }
          }}
        >
          <span>{selected?.label ?? value}</span>
          <span className="select-caret" aria-hidden="true" />
        </button>

        {createPortal(menuElement, document.body)}
      </div>
    </label>
  );
}
