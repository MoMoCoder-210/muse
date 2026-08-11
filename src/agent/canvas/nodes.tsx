/** Read-only production-canvas node renderers. All expansion remains UI-owned. */
import { createContext, memo, type CSSProperties, type MouseEvent, type ReactNode, useContext } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Handle, Position, type NodeProps } from "reactflow";
import type {
  AssetNodeData, CanvasCenterNodeData, ClipNodeData, ImageNodeData, MaterialCategoryNodeData,
  ReleaseOutputNodeData, ReleaseSummaryNodeData, ReleaseTaskNodeData, ShotAnchorNodeData, ShotTrackNodeData,
  StoryboardAssetReference, StoryboardNodeData, TaskNodeData, VideoNodeData,
} from "./node-data";
import { assetTypeColor, assetTypeLabel, clipStatusColor, storyboardStateColor, taskStatusColor } from "./node-data";

type CanvasInteraction = { expandedIds?: ReadonlySet<string>; onToggleExpanded?: (canonicalId: string) => void; onAssetPillClick?: (asset: StoryboardAssetReference) => void; };
const CanvasInteractionContext = createContext<CanvasInteraction>({});
export function CanvasInteractionProvider({ children, expandedIds, onToggleExpanded, onAssetPillClick }: CanvasInteraction & { children: ReactNode }) {
  return <CanvasInteractionContext.Provider value={{ expandedIds, onToggleExpanded, onAssetPillClick }}>{children}</CanvasInteractionContext.Provider>;
}

function useExpansion(canonicalId: string) {
  const { expandedIds, onToggleExpanded } = useContext(CanvasInteractionContext);
  const expanded = expandedIds?.has(canonicalId) ?? false;
  const toggle = (event: MouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); onToggleExpanded?.(canonicalId); };
  return { expanded, toggle };
}
function ExpandButton({ id, title }: { id: string; title: string }) {
  const { expanded, toggle } = useExpansion(id);
  return <button className="cn-chevron nodrag nopan" type="button" aria-label={expanded ? `收起 ${title}` : `展开 ${title}`} aria-expanded={expanded} onClick={toggle}><ChevronIcon /></button>;
}

type CardShellProps = {
  canonicalId: string; expansionId?: string; hasChildren: boolean; color: string; icon: ReactNode; title: string; subtitle?: string; badge?: string;
  thumbnail?: ReactNode; children?: ReactNode; className?: string; targetHandle?: boolean; sourceHandle?: boolean;
};
const CardShell = memo(function CardShell({ canonicalId, expansionId = canonicalId, hasChildren, color, icon, title, subtitle, badge, thumbnail, children, className, targetHandle = true, sourceHandle = true }: CardShellProps) {
  return <div className={`cn-card${thumbnail ? " cn-card--media" : ""}${className ? ` ${className}` : ""}`} style={{ "--cn-accent": color } as CSSProperties}>
    {targetHandle && <Handle id="target" type="target" position={Position.Left} className="cn-handle cn-handle--left" />}
    {thumbnail && <div className="cn-card__media">{thumbnail}</div>}
    <div className="cn-card__body"><div className="cn-card__header"><span className="cn-card__icon">{icon}</span><span className="cn-card__title" title={title}>{title}</span>{badge && <span className="cn-card__badge">{badge}</span>}{hasChildren && <ExpandButton id={expansionId} title={title} />}</div>
      {(subtitle || children) && <div className="cn-card__meta">{subtitle && <span className="cn-card__subtitle" title={subtitle}>{subtitle}</span>}{children}</div>}
    </div>
    {sourceHandle && <Handle id="source" type="source" position={Position.Right} className="cn-handle cn-handle--right" />}
  </div>;
});

export const CanvasCenterNode = memo(function CanvasCenterNode({ data }: NodeProps<CanvasCenterNodeData>) {
  const { expanded, toggle } = useExpansion(data.canonicalId);
  return <section className={`cn-center cn-center--${data.centerKind}${expanded ? "" : " cn-center--collapsed"}`} aria-label={data.title}>
    <header className="cn-center__header"><Handle id="target" type="target" position={Position.Left} className="cn-handle cn-handle--left" /><span className="cn-center__eyebrow">PRODUCTION CANVAS</span><strong>{data.title}</strong><span>{data.itemCount} 项</span><button className="cn-center__toggle nodrag nopan" type="button" aria-label={expanded ? `收起 ${data.title}` : `展开 ${data.title}`} aria-expanded={expanded} onClick={toggle}><ChevronIcon /></button><Handle id="source" type="source" position={Position.Right} className="cn-handle cn-handle--right" /><Handle id="content-source" type="source" position={Position.Bottom} className="cn-handle cn-handle--content-source" /></header>
    {!expanded && <p className="cn-center__collapsed">已收起该子画布</p>}
  </section>;
});
export const ClipNode = memo(function ClipNode({ data }: NodeProps<ClipNodeData>) {
  const duration = data.estimatedDuration ? `${Math.round(data.estimatedDuration)} 秒` : "时长待定";
  return <CardShell canonicalId={data.canonicalId} hasChildren={false} color={tone(clipStatusColor(data.status ?? "pending"))} className="cn-card--clip" icon={<ClipIcon />} title={data.title || "未命名分集"} subtitle={`${data.assetCount} 素材 · ${data.storyboardCount} 镜头 · ${duration}`} badge={data.status} />;
});
export const MaterialCategoryNode = memo(function MaterialCategoryNode({ data }: NodeProps<MaterialCategoryNodeData>) {
  const label = assetTypeLabel(data.category);
  return <section className="cn-category" style={{ "--cn-category": tone(assetTypeColor(data.category)) } as CSSProperties}>
    <Handle id="target" type="target" position={Position.Left} className="cn-handle cn-handle--left" />
    <div className="cn-category__header"><span className="cn-category__mark" /><strong>{data.clipId ? label : `共享${label}`}</strong><span>{data.itemCount} 项</span>{data.hasChildren && <ExpandButton id={data.expansionId} title={label} />}</div>
    <Handle id="asset-source" type="source" position={Position.Top} className="cn-handle cn-handle--top" />
    <Handle id="source" type="source" position={Position.Right} className="cn-handle cn-handle--right" />
  </section>;
});
export const MaterialSpineNode = memo(function MaterialSpineNode() { return <div className="cn-material-spine" aria-hidden="true"><span /></div>; });
export const AssetNode = memo(function AssetNode({ data }: NodeProps<AssetNodeData>) {
  const selectedIndex = data.previewImages.findIndex((image) => image.isSelected);
  const selectedImage = selectedIndex >= 0 ? data.previewImages[selectedIndex] : data.previewImages[0] ?? null;
  const indexedImages = data.previewImages.map((image, index) => ({ image, index }));
  const firstImages = indexedImages.slice(0, 3);
  const visibleImages = selectedIndex >= 3 ? [...firstImages.slice(0, 2), indexedImages[selectedIndex]] : firstImages;
  return <CardShell canonicalId={data.canonicalId} hasChildren={false} color={tone(assetTypeColor(data.type))} className="cn-card--asset" icon={<AssetIcon type={data.type} />} title={data.name} thumbnail={selectedImage ? <img src={mediaSrc(selectedImage.imagePath)} alt="" loading="lazy" draggable={false} /> : <span className="cn-asset-placeholder"><AssetIcon type={data.type} /></span>}>
    <div className="cn-asset-batch-gallery nodrag nopan" aria-label={`${data.name} 的图片批次`}>
      {visibleImages.map(({ image, index }) => <span key={image.id} className={`cn-asset-thumbnail${image.isSelected ? " cn-asset-thumbnail--selected" : ""}`} title={image.isSelected ? `当前选中 · 图片 ${index + 1}` : `图片 ${index + 1}`}><img src={mediaSrc(image.imagePath)} alt="" loading="lazy" draggable={false} /></span>)}
    </div>
  </CardShell>;
});
export const ImageNode = memo(function ImageNode({ data }: NodeProps<ImageNodeData>) {
  return <CardShell canonicalId={data.canonicalId} hasChildren={false} color="#7895ad" className="cn-card--image" icon={<ImageIcon />} title={data.assetName} subtitle={[data.size, data.isSelected ? "主图" : "图片"].filter(Boolean).join(" · ")} thumbnail={<img src={mediaSrc(data.imagePath)} alt="" loading="lazy" draggable={false} />} />;
});
export const StoryboardNode = memo(function StoryboardNode({ data }: NodeProps<StoryboardNodeData>) {
  const { onAssetPillClick } = useContext(CanvasInteractionContext);
  const visibleAssets = data.assetReferences.slice(0, 3);
  const hiddenAssetCount = Math.max(0, data.assetReferences.length - visibleAssets.length);
  const reveal = (event: MouseEvent<HTMLButtonElement>, asset: StoryboardAssetReference) => { event.preventDefault(); event.stopPropagation(); onAssetPillClick?.(asset); };
  const description = data.summary || data.dialogue || "镜头内容待完善";
  return <CardShell canonicalId={data.canonicalId} hasChildren={data.hasChildren} color={tone(storyboardStateColor(data.status ?? "pending"))} className="cn-card--storyboard" icon={<ClapperIcon />} title={`${data.sbid || "镜头"} · ${String(data.seqNum).padStart(2, "0")}`} subtitle={`${data.duration ? `${Math.round(data.duration)} 秒` : "时长待定"} · ${description.slice(0, 34)}`} badge={data.assetReferences.length ? `引用 ${data.assetReferences.length}` : undefined}>
    {visibleAssets.length > 0 && <div className="cn-storyboard-assets" aria-label="镜头引用素材">{visibleAssets.map((asset) => <button key={asset.assetId} className={`cn-asset-pill nodrag nopan${asset.sourceScope === "owned" ? "" : " cn-asset-pill--shared"}`} type="button" title={`定位 ${asset.name} 的真实所属素材`} onClick={(event) => reveal(event, asset)}><span>{asset.assetTag || asset.name}</span></button>)}{hiddenAssetCount > 0 && <span className="cn-asset-pill cn-asset-pill--more">+{hiddenAssetCount}</span>}</div>}
  </CardShell>;
});
export const ShotTrackNode = memo(function ShotTrackNode({ data }: NodeProps<ShotTrackNodeData>) { return <div className="cn-shot-track" aria-label={`连续镜头轨，共 ${data.shotCount} 个镜头`}><span>按序镜头轨</span>{data.shotCount > 7 && <em>+{data.shotCount - 7}</em>}</div>; });
export const ShotAnchorNode = memo(function ShotAnchorNode({ data }: NodeProps<ShotAnchorNodeData>) { return <div className="cn-shot-anchor" title={`镜头 ${data.seqNum}`}><Handle id="target" type="target" position={Position.Left} className="cn-handle cn-handle--left" /><span>{String(data.seqNum).padStart(2, "0")}</span><Handle id="source" type="source" position={Position.Bottom} className="cn-handle cn-handle--bottom" /></div>; });
export const VideoNode = memo(function VideoNode({ data }: NodeProps<VideoNodeData>) {
  const ready = data.filePath && (!data.isUpscaleOutput || data.isOutputReady);
  const source = videoSourceLabel(data.source, data.isUpscaleOutput);
  const subtitle = ready ? `${source} · ${data.duration ? `${Math.round(data.duration)} 秒` : "视频产物"}` : `${source} · 处理中`;
  return <CardShell canonicalId={data.canonicalId} hasChildren={false} color="#7895ad" className="cn-card--task" icon={<PlayIcon />} title={data.fileName || "镜头视频"} subtitle={subtitle} badge={source} thumbnail={ready ? <video src={mediaSrc(data.filePath)} muted preload="metadata" playsInline /> : undefined} />;
});
export const TaskNode = memo(function TaskNode({ data }: NodeProps<TaskNodeData>) { const title = data.taskKind === "upscale" ? "视频超分" : data.taskKind === "asset" ? "素材任务" : "视频生成"; return <CardShell canonicalId={data.canonicalId} hasChildren={false} color={tone(taskStatusColor(data.status ?? "pending"))} className={`cn-card--task${data.status === "failed" ? " cn-card--failed" : ""}`} icon={<TaskIcon />} title={title} subtitle={data.error ? `失败：${data.error}` : data.targetName} badge={taskLabel(data.status)} />; });
export const ReleaseSummaryNode = memo(function ReleaseSummaryNode({ data }: NodeProps<ReleaseSummaryNodeData>) { return <CardShell canonicalId={data.canonicalId} hasChildren={false} color="#86b4a0" className="cn-card--release-summary" icon={<ReadyIcon />} title={`${data.readyShots}/${data.totalShots}`} subtitle="镜头就绪" />; });
export const ReleaseTaskNode = memo(function ReleaseTaskNode({ data }: NodeProps<ReleaseTaskNodeData>) { const ready = data.totalShots > 0 && data.readyShots === data.totalShots; return <CardShell canonicalId={data.canonicalId} hasChildren={false} color={ready ? "#86b4a0" : "#a5a0a0"} className="cn-card--release-task" icon={<TaskIcon />} title={data.title} subtitle={ready ? "可在工作区合成" : `${data.totalShots - data.readyShots} 个镜头待就绪`} />; });
export const ReleaseOutputNode = memo(function ReleaseOutputNode({ data }: NodeProps<ReleaseOutputNodeData>) { const subtitle = data.isEmpty ? "等待真实合成记录" : `${data.segmentCount} 段 · ${data.duration ? `${Math.round(data.duration)} 秒` : "时长待定"}`; return <CardShell canonicalId={data.canonicalId} hasChildren={data.hasChildren} color={data.isEmpty ? "#89949d" : "#88b69d"} className={`cn-card--release-output${data.isEmpty ? " cn-card--release-empty" : ""}`} icon={<FilmIcon />} title={data.isEmpty ? "尚无成片" : data.fileName || "当前成片"} subtitle={subtitle} badge={data.isEmpty ? "等待" : data.source === "upscale" ? "超分" : "当前"} thumbnail={data.filePath ? <video src={mediaSrc(data.filePath)} muted preload="metadata" playsInline /> : undefined} />; });

export const agentNodeTypes = { CanvasCenterNode, ClipNode, MaterialCategoryNode, MaterialSpineNode, AssetNode, ImageNode, StoryboardNode, ShotTrackNode, ShotAnchorNode, VideoNode, TaskNode, ReleaseSummaryNode, ReleaseTaskNode, ReleaseOutputNode };
function mediaSrc(path: string): string { return path.startsWith("http") ? path : convertFileSrc(path); }
function tone(color: string): string { return ({ gray: "#8e9aa7", blue: "#78a8cf", green: "#7ea990", orange: "#b69a70", red: "#b37a78", purple: "#9a8bb6" } as Record<string, string>)[color] ?? color; }
function taskLabel(status?: string): string { return ({ pending: "排队", queued: "排队", running: "处理中", failed: "失败", done: "完成", success: "完成" } as Record<string, string>)[status ?? ""] ?? status ?? "待处理"; }
function videoSourceLabel(source: string, isUpscaleOutput: boolean): string {
  const normalized = source.toLowerCase();
  if (isUpscaleOutput || normalized === "upscale") return "超分";
  if (normalized.includes("upload") || normalized.includes("local") || normalized === "import") return "本地上传";
  return "生成";
}
function ChevronIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m8 10 4 4 4-4" /></svg>; }
function ClipIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 15h6"/></svg>; }
function ClapperIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m4 7 3-3 13 5-3 3zM3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>; }
function ImageIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>; }
function PlayIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m8 5 11 7-11 7z"/></svg>; }
function TaskIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 12 2.5 2.5L16 9"/></svg>; }
function ReadyIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m4 12 5 5L20 6"/></svg>; }
function FilmIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M10 9h4M10 15h4"/></svg>; }
function AssetIcon({ type }: { type: string }) { return type === "character" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 21c.6-4 3.1-6 8-6s7.4 2 8 6"/></svg> : type === "scene" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m3 10 9-7 9 7v10H3zM9 20v-6h6v6"/></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12h8M12 8v8"/></svg>; }
