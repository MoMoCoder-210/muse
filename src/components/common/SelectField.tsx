import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";

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
 */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: SelectFieldProps<T>) {
  const triggerRef = useRef<HTMLDivElement | null>(null);

  const { menuElementProps, open, openMenu, closeMenu } = useDropdownMenu(
    triggerRef,
    { gap: 8, maxH: 220, menuClass: "select-field-menu" },
  );

  const normalized = (options as ReadonlyArray<SelectOption<T> | T>).map(toOption);
  const selected = normalized.find((o) => o.value === value);

  const menuElement = (
    <div
      {...menuElementProps}
      role="listbox"
      aria-label={label}
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
      <div
        className="select-shell"
        ref={triggerRef}
      >
        <button
          type="button"
          className={`select-trigger ${open ? "open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            if (open) {
              closeMenu();
            } else {
              openMenu();
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
