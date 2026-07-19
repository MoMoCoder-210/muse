import { useCallback, useEffect, useRef } from "react";

interface MenuFlipResult {
  /** 绑定到菜单 DOM 元素的 ref（React ref callback） */
  menuRef: React.RefCallback<HTMLDivElement | null>;
  /** 菜单 DOM 节点引用（供调用方读取，如 animationend 监听、外部点击判断） */
  menuElRef: React.RefObject<HTMLDivElement | null>;
  /** 手动触发重新定位（scroll/resize 时用） */
  position: () => void;
}

const FLIP_CLASSES = ["select-field-menu--flip", "sd-param-menu--flip", "mention-drop--flip"] as const;

/**
 * 根据菜单的 CSS class 推断对应的 flip class 名称。
 * 约定：菜单 class 名为 `xxx-menu` / `xxx-drop`，flip class 为 `xxx-menu--flip` / `xxx-drop--flip`。
 */
function getFlipClass(menu: HTMLDivElement): string | null {
  for (const name of menu.classList) {
    if (name.endsWith("-menu") || name.endsWith("-drop")) {
      return `${name}--flip`;
    }
  }
  return null;
}

/**
 * 通用下拉菜单翻转定位 Hook
 *
 * 支持两种定位模式：
 * 1. 基于 triggerRef（SelectField / ParamSelect）：从触发器 DOM 元素获取位置
 * 2. 基于坐标 getter（MentionDropdown）：从光标坐标获取位置
 *
 * 策略：菜单 DOM 节点通过 ref 回调挂载时，立即同步定位（写 DOM style）。
 * 菜单初始 visibility: hidden（由调用方控制），定位完成后再显示。
 *
 * @param triggerRef - 触发器元素的 ref（模式1）
 * @param gap - 菜单与触发器之间的间距，默认 6
 * @param maxH - 菜单最大高度（CSS 中需同步设置），默认 220
 * @param open - 菜单是否打开，打开时注册 scroll/resize 监听
 * @param getAnchorRect - 可选的坐标 getter（模式2），返回锚点矩形，优先级高于 triggerRef
 */
export function useMenuFlip(
  triggerRef: React.RefObject<HTMLElement | null>,
  gap = 6,
  maxH = 220,
  open = true,
  getAnchorRect?: () => { top: number; left: number; width?: number; bottom?: number; height?: number } | null,
): MenuFlipResult {
  const menuElRef = useRef<HTMLDivElement | null>(null);

  const position = useCallback(() => {
    const menu = menuElRef.current;
    if (!menu) return;

    // 锚点矩形：top/left 是锚点顶部左角，bottom 是锚点底部
    let anchorTop: number;
    let anchorBottom: number;
    let anchorLeft: number;
    let anchorWidth: number;

    if (getAnchorRect) {
      // 模式2：坐标 getter（MentionDropdown）
      const rect = getAnchorRect();
      if (!rect) return;
      anchorTop = rect.top;
      // 如果调用方只传了 top（视为光标顶部），则 bottom = top
      // 如果调用方传了 bottom（光标底部），翻转时用 bottom 计算
      anchorBottom = rect.bottom ?? rect.top;
      anchorLeft = rect.left;
      anchorWidth = rect.width ?? 200;
    } else {
      // 模式1：从触发器 DOM 获取
      const trigger = triggerRef.current;
      if (!trigger) return;
      const domRect = trigger.getBoundingClientRect();
      anchorTop = domRect.top;
      anchorBottom = domRect.bottom;
      anchorLeft = domRect.left;
      anchorWidth = domRect.width;
    }

    const realH = Math.min(menu.scrollHeight, maxH);
    const menuW = menu.offsetWidth;

    // 默认放下方：从锚点底部 + gap 开始
    const belowTop = anchorBottom + gap;
    const fitsBelow = belowTop + realH <= window.innerHeight;

    // 如果下方放不下，翻到上方：菜单底部贴在锚点顶部 - gap
    const aboveTop = anchorTop - realH - gap;

    const top = fitsBelow ? belowTop : aboveTop;

    // 水平边界处理：如果右侧超出窗口，向左对齐到窗口右边缘
    let left = anchorLeft;
    if (left + menuW > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - 8 - menuW);
    }
    if (left < 8) left = 8;

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.width = `${anchorWidth}px`;

    // 翻转 class：根据菜单自身 class 推断对应的 --flip 变体
    const flipClass = getFlipClass(menu);
    for (const cls of FLIP_CLASSES) menu.classList.remove(cls);
    if (!fitsBelow && flipClass) {
      menu.classList.add(flipClass);
    }
  }, [triggerRef, gap, maxH, getAnchorRect]);

  // ref callback：DOM 挂载时立即定位
  const menuRef = useCallback(
    (node: HTMLDivElement | null) => {
      menuElRef.current = node;
      if (node && open) {
        // DOM 一挂载就同步定位，避免任何绘制延迟
        position();
      }
    },
    [open, position],
  );

  // 滚动/窗口变化时更新
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open, position]);

  return { menuRef, menuElRef, position };
}
