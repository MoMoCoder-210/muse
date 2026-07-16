/**
 * @mention 资产选择下拉组件
 *
 * 用户在提示词 textarea 中输入 @ 时弹出，从当前片段已关联的资产中选择，
 * 选中后插入 资产名(@图片N) 格式的引用标记。
 * - 已在 prompt 中引用过的资产显示已有序号（复用，不新增）
 * - 尚未引用的资产显示将分配的新序号
 * - 定位跟随光标（由父组件通过 getCaretCoords 计算后传入 position）
 */
import { useEffect, useRef, useMemo, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import "../../styles/mention-dropdown.css";

export interface AssetMention {
  assetId: string;
  name: string;
  type: string;
  imagePath: string | null;
  /** 完整标记字符串，如 `老兵A(@图片1)`，用于提示词水合时精确字符串匹配 */
  assetTag: string;
  /** 图片序号 N */
  index: number;
}

interface Props {
  /** 可被引用的资产列表 */
  assets: AssetMention[];
  /** 是否显示下拉 */
  isOpen: boolean;
  /** 用于过滤的文本（@ 后面的字符） */
  filter: string;
  /** 下拉显示位置（视口坐标），由父组件通过 getCaretCoords 计算传入 */
  position: { top: number; left: number } | null;
  /** 选中后的回调 */
  onSelect: (asset: AssetMention) => void;
  /** 关闭回调 */
  onClose: () => void;
  /** 下一个可用序号（用于尚未引用的资产） */
  nextIndex: number;
  /** assetId -> 已分配序号（已在 prompt 中引用过的资产，选择时复用此序号） */
  existingIndexMap?: Map<string, number>;
}

const typeIcons: Record<string, string> = {
  character: "👤",
  scene: "🏞",
  item: "📦",
};

const typeLabels: Record<string, string> = {
  character: "角色",
  scene: "场景",
  item: "物品",
};

export function MentionDropdown({
  assets,
  isOpen,
  filter,
  position,
  onSelect,
  onClose,
  nextIndex,
  existingIndexMap,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<number>(0);

  // 按类型分组 + 按 filter 过滤
  const groups = useMemo(() => {
    const f = filter.toLowerCase().trim();
    const filtered = f
      ? assets.filter(
          (a) =>
            a.name.toLowerCase().includes(f) ||
            (typeLabels[a.type] || "").includes(f)
        )
      : assets;

    const map = new Map<string, AssetMention[]>();
    for (const a of filtered) {
      const list = map.get(a.type) || [];
      list.push(a);
      map.set(a.type, list);
    }
    const result: Array<
      { kind: "header"; label: string; count: number } | { kind: "item"; asset: AssetMention }
    > = [];
    for (const cat of ["character", "scene", "item"]) {
      const list = map.get(cat);
      if (list && list.length > 0) {
        result.push({
          kind: "header",
          label: `${typeIcons[cat] || ""} ${typeLabels[cat] || cat}`,
          count: list.length,
        });
        for (const a of list) result.push({ kind: "item", asset: a });
      }
    }
    return result;
  }, [assets, filter]);

  const items = useMemo(
    () => groups.filter((g) => g.kind === "item") as { kind: "item"; asset: AssetMention }[],
    [groups]
  );

  // filter 变化时重置高亮项
  useEffect(() => { selectedRef.current = 0; }, [filter]);

  // 键盘导航（全局捕获，父组件在 onKeyDown 中已 preventDefault）
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "ArrowDown") {
        selectedRef.current = Math.min(selectedRef.current + 1, items.length - 1);
        ref.current?.querySelector<HTMLElement>(`[data-midx="${selectedRef.current}"]`)?.scrollIntoView({ block: "nearest" });
        // 强制重渲染高亮（selectedRef 是 ref，不触发 re-render，用一个轻量技巧）
        ref.current?.querySelectorAll<HTMLElement>(".mention-item").forEach((el, i) => {
          el.classList.toggle("on", i === selectedRef.current);
        });
      } else if (e.key === "ArrowUp") {
        selectedRef.current = Math.max(selectedRef.current - 1, 0);
        ref.current?.querySelector<HTMLElement>(`[data-midx="${selectedRef.current}"]`)?.scrollIntoView({ block: "nearest" });
        ref.current?.querySelectorAll<HTMLElement>(".mention-item").forEach((el, i) => {
          el.classList.toggle("on", i === selectedRef.current);
        });
      } else if (e.key === "Enter") {
        if (items[selectedRef.current]) {
          onSelect(items[selectedRef.current].asset);
        }
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [isOpen, items, onClose, onSelect]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // mousedown 而非 click，确保在 textarea onBlur 之前捕获
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose]);

  // 计算实际显示位置：防止超出视口底部
  const safePosition = useMemo(() => {
    if (!position) return null;
    const dropH = 240; // 最大高度
    const vp = window.innerHeight;
    const top = position.top + dropH > vp
      ? position.top - dropH - 4  // 翻转到光标上方
      : position.top;
    return { top, left: position.left };
  }, [position]);

  if (!isOpen || !safePosition) return null;

  const flatIdx = (gi: number) => {
    let cnt = -1;
    for (let i = 0; i <= gi; i++) {
      if (groups[i].kind === "item") cnt++;
    }
    return cnt;
  };

  return (
    <div
      ref={ref}
      className="mention-drop"
      style={{
        position: "fixed",
        top: safePosition.top,
        left: safePosition.left,
        maxHeight: 240,
        minWidth: 200,
        maxWidth: 320,
      }}
    >
      {groups.length === 0 ? (
        <div className="mention-empty">
          {filter.trim() ? `没有匹配 "${filter}" 的资产` : "暂无可用资产"}
        </div>
      ) : (
        groups.map((g, gi) => {
          if (g.kind === "header") {
            return (
              <div key={`h-${gi}`} className="mention-group-hdr">
                {g.label}
                <span className="mention-group-cnt">{g.count}</span>
              </div>
            );
          }
          const mi = flatIdx(gi);
          const existingIdx = existingIndexMap?.get(g.asset.assetId);
          const badgeIndex = existingIdx ?? nextIndex;
          const isExisting = existingIdx !== undefined;
          return (
            <button
              key={g.asset.assetId}
              data-midx={mi}
              className={`mention-item${mi === 0 ? " on" : ""}`}
              onMouseDown={(e) => {
                // mousedown 而非 click，防止 textarea onBlur 先触发导致弹窗消失
                e.preventDefault();
                onSelect(g.asset);
              }}
              onMouseEnter={() => {
                selectedRef.current = mi;
                ref.current?.querySelectorAll<HTMLElement>(".mention-item").forEach((el, i) => {
                  el.classList.toggle("on", i === mi);
                });
              }}
            >
              <span className="mention-item-thumb">
                {g.asset.imagePath ? (
                  <img src={convertFileSrc(g.asset.imagePath)} alt="" />
                ) : (
                  <span className="mention-item-icon">
                    {typeIcons[g.asset.type] || "📎"}
                  </span>
                )}
              </span>
              <span className="mention-item-name">{g.asset.name}</span>
              <span className={`mention-item-badge${isExisting ? " is-existing" : ""}`}>
                {isExisting ? `图片${badgeIndex} ↩` : `@图片${badgeIndex}`}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
