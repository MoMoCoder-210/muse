/**
 * ParamSelect — 参数区自定义下拉（macOS 浮层菜单风格）
 */
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";

export function ParamSelect<T extends string>({
  value,
  options,
  disabled,
  onChange,
  onBlur,
}: {
  value: T;
  options: readonly { label: string; value: T }[];
  disabled?: boolean;
  onChange: (v: T) => void;
  onBlur?: () => void;
}) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const { menuElementProps, open, openMenu, closeMenu } = useDropdownMenu(
    triggerRef,
    { gap: 6, maxH: 220, menuClass: "sd-param-menu" },
  );

  const sel = options.find((o) => o.value === value);

  return (
    <div className="sd-param-select-shell" ref={triggerRef}>
      <button
        type="button"
        className={`sd-param-select-btn${open ? " open" : ""}`}
        disabled={disabled}
        onClick={() => { if (open) closeMenu(); else openMenu(); }}
      >
        <span className="sd-param-select-label">{sel?.label ?? value}</span>
        <span className="sd-param-select-caret" />
      </button>
      {createPortal(
        <div {...menuElementProps} style={{ ...menuElementProps.style, zIndex: 2000 }}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`select-option${o.value === value ? " active" : ""}`}
              onClick={() => { onChange(o.value); closeMenu(); if (onBlur) setTimeout(onBlur, 0); }}
            >
              {o.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
