import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useMenuFlip } from "./useMenuFlip";

/**
 * 通用下拉菜单 Hook：统一 SelectField / ParamSelect 的动画状态机与外部点击关闭逻辑。
 *
 * 使用方式：
 *   const { menuRef, menuElRef, phase, open, openMenu, closeMenu, menuElementProps } = useDropdownMenu(triggerRef, options);
 *   // menuElementProps 展开到菜单 div 上（ref + className + style）
 *
 * @param triggerRef - 触发器元素的 ref
 * @param options.gap - 菜单与触发器间距
 * @param options.maxH - 菜单最大高度
 * @param options.menuClass - 菜单 CSS 类名（用于翻转判断）
 */
export function useDropdownMenu(
  triggerRef: React.RefObject<HTMLElement | null>,
  options?: {
    gap?: number;
    maxH?: number;
    menuClass?: string;
  },
) {
  const gap = options?.gap ?? 6;
  const maxH = options?.maxH ?? 220;
  const menuClass = options?.menuClass ?? "";

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"closed" | "entering" | "open" | "exiting">("closed");

  const { menuRef, menuElRef, position } = useMenuFlip(triggerRef, gap, maxH, open);

  // useLayoutEffect：Portal DOM commit 后同步定位，然后下一帧播动画
  useLayoutEffect(() => {
    if (!open) return;
    position();
    const raf = requestAnimationFrame(() => setPhase("entering"));
    return () => cancelAnimationFrame(raf);
  }, [open, position]);

  // 打开后滚动到当前选中项
  useEffect(() => {
    if (phase !== "entering") return;
    const menu = menuElRef.current;
    if (!menu) return;
    const active = menu.querySelector(".select-option.active") as HTMLElement | null;
    if (active) active.scrollIntoView({ block: "nearest" });
  }, [phase, menuElRef]);

  // 关闭菜单：先播退出动画 → animationend 后彻底移除
  const closeMenu = useCallback(() => {
    setPhase("exiting");
    setOpen(false);
  }, []);

  const openMenu = useCallback(() => {
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open && phase === "exiting") {
      const menu = menuElRef.current;
      if (!menu) {
        setPhase("closed");
        return;
      }
      const handler = () => setPhase("closed");
      menu.addEventListener("animationend", handler, { once: true });
      return () => menu.removeEventListener("animationend", handler);
    }
  }, [open, phase, menuElRef]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuElRef.current?.contains(target)) return;
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
  }, [open, closeMenu, triggerRef, menuElRef]);

  const menuVisible = phase !== "closed";

  /**
   * 展开到菜单 div 上的 props（ref + className + style）。
   * 调用方只需 `{...menuElementProps}` 即可，无需手写重复代码。
   */
  const menuElementProps = {
    ref: menuRef,
    className: `select-menu ${menuClass} ${phase === "entering" || phase === "open" ? "select-menu--in" : ""} ${phase === "exiting" ? "select-menu--out" : ""}`.trim(),
    style: {
      position: "fixed" as const,
      zIndex: 1000,
      visibility: menuVisible ? ("visible" as const) : ("hidden" as const),
      pointerEvents: menuVisible ? ("auto" as const) : ("none" as const),
    } satisfies React.CSSProperties,
  };

  return {
    menuRef,
    menuElRef,
    phase,
    open,
    openMenu,
    closeMenu,
    position,
    menuElementProps,
  };
}
