/**
 * @mention 素材选择下拉组件。
 *
 * 由 Tiptap suggestion 的 clientRect 定位，选中后插入素材引用节点。
 */
import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useMenuFlip } from "../../hooks/useMenuFlip";
import type { MentionAnchor } from "../../types/mention";
// mention-dropdown.css 已迁移至 styles.css 全局导入

export interface AssetMention {
  assetId: string;
  name: string;
  type: string;
  imagePath: string | null;
  /** 完整标记字符串，如 `老兵A(@图片1)`，用于提示词水合时精确字符串匹配 */
  assetTag: string;
  /** 图片序号 N */
  index: number;
  /** 素材是否已被删除（仅渲染标记，不持久化） */
  deleted?: boolean;
}

interface Props {
  /** 可被引用的素材列表 */
  assets: AssetMention[];
  /** 是否显示下拉 */
  isOpen: boolean;
  /** 用于过滤的文本（@ 后面的字符） */
  filter: string;
  /** 光标位置（视口坐标），top/left/bottom 来自 Tiptap 的 clientRect */
  position: MentionAnchor | null;
  /** 选中后的回调 */
  onSelect: (asset: AssetMention) => void;
  /** 关闭回调 */
  onClose: () => void;
  /** 下一个可用序号（用于尚未引用的素材） */
  nextIndex: number;
  /** assetId -> 已分配序号（已在 prompt 中引用过的素材，选择时复用此序号） */
  existingIndexMap?: Map<string, number>;
}

const typeIcons: Record<string, string> = {
  character: "👤",
  scene: "🏞",
  item: "📦",
};

const typeLabels: Record<string, string> = {
  character: "人物",
  scene: "场景",
  item: "道具",
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
  const [selectedIdx, setSelectedIdx] = useState(0);

  // 使用 useMenuFlip 统一定位：将 position prop 包装为坐标 getter
  const triggerRef = useRef<HTMLElement | null>(null); // 不需要 trigger DOM，仅用于满足接口

  const getAnchorRect = useCallback(() => {
    if (!position) return null;
    return { top: position.top, left: position.left, bottom: position.bottom };
  }, [position]);

  const { menuRef, menuElRef } = useMenuFlip(triggerRef, 4, 240, isOpen, getAnchorRect);

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

  // filter 变化或列表变化时重置高亮项
  useEffect(() => { setSelectedIdx(0); }, [filter, items.length]);

  // 统一设置高亮项（确保不越界 + 滚动可视）
  const setSelected = useCallback((idx: number) => {
    if (items.length === 0) return;
    const next = Math.max(0, Math.min(idx, items.length - 1));
    setSelectedIdx(next);
    menuElRef.current?.querySelector<HTMLElement>(`[data-midx="${next}"]`)?.scrollIntoView({ block: "nearest" });
  }, [items.length, menuElRef]);

  // 键盘导航（全局捕获，父组件在 onKeyDown 中已 preventDefault）
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "ArrowDown") {
        setSelected(selectedIdx + 1);
      } else if (e.key === "ArrowUp") {
        setSelected(selectedIdx - 1);
      } else if (e.key === "Enter") {
        if (items[selectedIdx]) {
          onSelect(items[selectedIdx].asset);
        }
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [isOpen, items, selectedIdx, setSelected, onClose, onSelect]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuElRef.current && !menuElRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // mousedown 而非 click，确保在 textarea onBlur 之前捕获
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose, menuElRef]);

  if (!isOpen || !position) return null;

  const flatIdx = (gi: number) => {
    let cnt = -1;
    for (let i = 0; i <= gi; i++) {
      if (groups[i].kind === "item") cnt++;
    }
    return cnt;
  };

  const menuElement = (
    <div
      ref={menuRef}
      className="mention-drop"
      style={{
        position: "fixed",
        zIndex: 3000,
        maxHeight: 240,
        minWidth: 200,
        maxWidth: 320,
        visibility: "visible",
        pointerEvents: "auto",
      }}
    >
      {groups.length === 0 ? (
        <div className="mention-empty">
          {filter.trim() ? `没有匹配 "${filter}" 的素材` : "暂无可用素材"}
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
              className={`mention-item${mi === selectedIdx ? " on" : ""}`}
              onMouseDown={(e) => {
                // mousedown 而非 click，防止 textarea onBlur 先触发导致弹窗消失
                e.preventDefault();
                onSelect(g.asset);
              }}
              onMouseEnter={() => setSelected(mi)}
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

  return createPortal(menuElement, document.body);
}
