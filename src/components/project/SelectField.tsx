import { useEffect, useRef, useState } from "react";

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
 * 支持自定义选项或字符串列表，带搜索/点击外部关闭行为。
 *
 * @author yt @date 20260702
 */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: SelectFieldProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const normalized = (options as ReadonlyArray<SelectOption<T> | T>).map(toOption);
  const selected = normalized.find((o) => o.value === value);

  return (
    <label className="field">
      <span>{label}</span>
      <div className="select-shell" ref={ref}>
        <button
          type="button"
          className={`select-trigger ${open ? "open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span>{selected?.label ?? value}</span>
          <span className="select-caret" aria-hidden="true" />
        </button>

        {open ? (
          <div className="select-menu" role="listbox" aria-label={label}>
            {normalized.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                className={`select-option ${option.value === value ? "active" : ""}`}
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </label>
  );
}
