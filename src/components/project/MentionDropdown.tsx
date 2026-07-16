/**
 * @mention 资产选择下拉组件
 *
 * 用户在提示词 textarea 中输入 @ 时弹出，从当前片段已关联的资产中选择，
 * 选中后插入 (@图片N) 格式的引用标记。
 */
import { useEffect, useRef, useMemo, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { StoryboardAssetInfo } from "../../types/project";
import "../../styles/mention-dropdown.css";

export interface AssetMention {
  assetId: string;
  name: string;
  type: string;
  imagePath: string | null;
}

interface Props {
  /** 可被引用的资产列表 */
  assets: AssetMention[];
  /** 是否显示下拉 */
  isOpen: boolean;
  /** 用于过滤的文本（@ 后面的字符） */
  filter: string;
  /** 下拉挂载到的 textarea 元素 */
  anchorEl: HTMLTextAreaElement | null;
  /** 选中后的回调 */
  onSelect: (asset: AssetMention) => void;
  /** 关闭回调 */
  onClose: () => void;
  /** 当前已用的最大序号（用于生成“图片N”标签） */
  nextIndex: number;
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
  anchorEl,
  onSelect,
  onClose,
  nextIndex,
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
    // 返回有序列表：角色 → 场景 → 物品，每组包含类型名 + 资产
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

  // 可选择的列表项（仅 item 行）
  const items = useMemo(
    () => groups.filter((g) => g.kind === "item") as { kind: "item"; asset: AssetMention }[],
    [groups]
  );

  // 重置已选下标
  useEffect(() => { selectedRef.current = 0; }, [filter]);

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (items.length === 0) return;
          selectedRef.current = Math.min(selectedRef.current + 1, items.length - 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (items.length === 0) return;
          selectedRef.current = Math.max(selectedRef.current - 1, 0);
          break;
        case "Enter":
          e.preventDefault();
          if (items[selectedRef.current]) {
            onSelect(items[selectedRef.current].asset);
          }
          return;
        case "Escape":
          onClose();
          return;
      }
      // 滚动到可见
      const idx = selectedRef.current;
      const child = ref.current?.querySelector(
        `[data-midx="${idx}"]`
      ) as HTMLElement | null;
      child?.scrollIntoView({ block: "nearest" });
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
      if (ref.current && !ref.current.contains(e.target as Node) && e.target !== anchorEl) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose, anchorEl]);

  // 计算下拉位置：紧贴在 textarea 底部
  const position = useMemo(() => {
    if (!anchorEl || !isOpen) return undefined;
    const rect = anchorEl.getBoundingClientRect();
    return {
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(240, window.innerHeight - rect.bottom - 16),
    } as const;
  }, [anchorEl, isOpen]);

  if (!isOpen || !position) return null;

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
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
    >
      {groups.length === 0 ? (
        <div className="mention-empty">
          {filter.trim() ? `没有匹配 “${filter}” 的资产` : "暂无可用资产"}
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
          return (
            <button
              key={g.asset.assetId}
              data-midx={mi}
              className={`mention-item${mi === selectedRef.current ? " on" : ""}`}
              onClick={() => onSelect(g.asset)}
              onMouseEnter={() => (selectedRef.current = mi)}
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
              <span className="mention-item-badge">
                @图片{nextIndex}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
