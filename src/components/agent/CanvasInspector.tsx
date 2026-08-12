import { useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Node } from "reactflow";
import { isCanvasVideoReady } from "../../agent/canvas";
import type { CanvasNodeData, ReleaseOutputNodeData, ReleaseSummaryNodeData, StoryboardNodeData } from "../../agent/canvas";
import { PromptEditor } from "../project/PromptEditor";
import { annotatePrompt, hydratePromptDoc, isPromptDoc, normalizeMentions, plainTextToPromptDoc, type PromptDoc, type PromptMention } from "../../utils/promptDocument";

type CanvasInspectorData = CanvasNodeData | ReleaseSummaryNodeData | ReleaseOutputNodeData;

export function CanvasInspector({ node, className, onClose }: { node: Node<CanvasInspectorData>; className: string; onClose: () => void }) {
  const data = node.data;
  if (isReleaseInspectorData(data)) return <ReleaseCanvasInspector data={data} className={className} onClose={onClose} />;
  const preview = getPreview(data);
  const videoPreviewMessage = getVideoPreviewMessage(data);
  const summary = data.entityType === "video" ? "" : inspectorSummary(data);
  return <aside className={`agent-inspector${className}`} aria-label="画布对象检查器">
    <InspectorHeader data={data} onClose={onClose} />
    <div className="agent-inspector__body">
      {preview ? <div className="agent-inspector__preview">{preview.kind === "image" ? <img src={toMediaUrl(preview.path)} alt={data.title} decoding="async" /> : <video src={toMediaUrl(preview.path)} controls preload="metadata" playsInline />}</div> : videoPreviewMessage && <div className="agent-inspector__preview"><span>{videoPreviewMessage}</span></div>}
      {data.entityType === "storyboard" ? <StoryboardInspector data={data} /> : data.entityType === "asset" ? <AssetInspector data={data} /> : <>
        {summary && <div className="agent-inspector__summary">{summary}</div>}
      </>}
    </div>
  </aside>;
}

function InspectorHeader({ data, onClose }: { data: CanvasInspectorData; onClose: () => void }) {
  const title = data.entityType === "release-summary" ? "编排" : data.entityType === "release-output" ? "成片" : entityLabel(data.entityType);
  return <div className="agent-inspector__header"><div className="agent-inspector__title"><span className="agent-inspector__kind">{title}</span></div><div className="agent-inspector__actions"><button type="button" onClick={onClose} aria-label="关闭检查器">×</button></div></div>;
}

function isReleaseInspectorData(data: CanvasInspectorData): data is ReleaseSummaryNodeData | ReleaseOutputNodeData {
  return data.entityType === "release-summary" || data.entityType === "release-output";
}

function ReleaseCanvasInspector({ data, className, onClose }: { data: ReleaseSummaryNodeData | ReleaseOutputNodeData; className: string; onClose: () => void }) {
  return <aside className={`agent-inspector${className}`} aria-label="成片详情检查器">
    <InspectorHeader data={data} onClose={onClose} />
    <div className="agent-inspector__body agent-inspector__release-body">
      {data.entityType === "release-summary" ? <ReleaseArrangementInspector data={data} /> : <ReleaseOutputInspector data={data} />}
    </div>
  </aside>;
}

function ReleaseArrangementInspector({ data }: { data: ReleaseSummaryNodeData }) {
  const selectedCount = data.shots.filter((shot) => shot.videoPath).length;
  return <div className="agent-inspector__release">
    <div className="agent-inspector__release-stats"><div><span>镜头</span><strong>{data.totalShots}</strong></div><div><span>已就绪</span><strong>{data.readyShots}/{data.totalShots}</strong></div><div><span>视频批次</span><strong>{selectedCount}</strong></div><div><span>总时长</span><strong>{formatReleaseDuration(data.totalDuration)}</strong></div></div>
    <section className="agent-inspector__section"><div className="agent-inspector__section-heading"><h3>镜头顺序</h3><span>{data.shots.length} 个</span></div>
      {data.shots.length > 0 ? <div className="agent-inspector__release-shot-list">{data.shots.map((shot) => <div key={shot.storyboardId} className={`agent-inspector__release-shot${shot.isReady ? " is-ready" : ""}`}><span className="agent-inspector__release-shot-index">{String(shot.seqNum).padStart(2, "0")}</span><div className="agent-inspector__release-shot-thumb">{shot.videoPath ? <video src={toMediaUrl(shot.videoPath)} muted preload="metadata" playsInline /> : <span>暂无视频</span>}<em>{shot.batchIndex ? `B${shot.batchIndex}` : "—"}</em></div><div className="agent-inspector__release-shot-content"><strong>{shot.sbid || `镜头 ${shot.seqNum}`}</strong>{shot.summary && <p>{shot.summary}</p>}<div><span>{formatReleaseDuration(shot.videoDuration)}</span><span className={shot.isReady ? "is-ready" : "is-pending"}>{shot.isReady ? "已就绪" : "待处理"}</span></div></div></div>)}</div> : <p className="agent-inspector__empty">还没有可用于合成的镜头。</p>}
    </section>
  </div>;
}

function ReleaseOutputInspector({ data }: { data: ReleaseOutputNodeData }) {
  return <div className="agent-inspector__release">
    {data.filePath ? <div className="agent-inspector__release-output-preview"><video src={toMediaUrl(data.filePath)} controls preload="metadata" playsInline /></div> : <div className="agent-inspector__release-output-empty"><strong>尚无成片</strong><span>请在手动区域完成镜头编排并点击合成。</span></div>}
    <dl className="agent-inspector__release-facts"><div><dt>时长</dt><dd>{formatReleaseDuration(data.duration)}</dd></div><div><dt>片段数量</dt><dd>{data.isEmpty ? "—" : `${data.segmentCount} 段`}</dd></div><div><dt>生成时间</dt><dd>{data.createdAt ? formatCreatedAt(data.createdAt) : "—"}</dd></div><div><dt>文件路径</dt><dd title={data.filePath ?? undefined}>{data.filePath || "—"}</dd></div></dl>
  </div>;
}

function StoryboardInspector({ data }: { data: StoryboardNodeData }) {
  const promptDocument = useMemo(() => createStoryboardPromptDocument(data), [data]);
  const selectedVideo = data.selectedVideoId ? data.videos.find((video) => video.id === data.selectedVideoId) ?? null : null;
  return <div className="agent-inspector__storyboard">
    {selectedVideo && <section className="agent-inspector__selected-video">
      <div className="agent-inspector__selected-video-preview">{isCanvasVideoReady(selectedVideo.filePath, selectedVideo.isUpscaleOutput, selectedVideo.isOutputReady) ? <video src={toMediaUrl(selectedVideo.filePath)} controls preload="metadata" playsInline /> : <span>{videoPreviewMessageFor(selectedVideo.isUpscaleOutput, selectedVideo.isOutputReady, selectedVideo.filePath)}</span>}</div>
      <div className="agent-inspector__selected-video-label">当前绑定视频</div>
    </section>}
    <section className="agent-inspector__section">
      <h3>镜头描述</h3>
      <p>{data.visualDescription || "暂无画面描述。"}</p>
      {data.summary && <div><span>摘要</span><p>{data.summary}</p></div>}
      {data.dialogue && <div><span>台词</span><p>{data.dialogue}</p></div>}
    </section>
    <section className="agent-inspector__section">
      <div className="agent-inspector__section-heading"><h3>绑定素材</h3><span>{data.assetReferences.length} 个</span></div>
      {data.assetReferences.length > 0 ? <div className="agent-inspector__asset-list">{data.assetReferences.map((asset) => <span key={asset.assetId} className={`agent-inspector__asset-pill agent-inspector__asset-pill--${asset.type}`}>{asset.name}</span>)}</div> : <p className="agent-inspector__empty">暂无绑定素材。</p>}
    </section>
    <section className="agent-inspector__section agent-inspector__prompt-section">
      <div className="agent-inspector__section-heading"><h3>提示词</h3><span>{data.videoPrompt ? "视频生成提示词" : "暂无"}</span></div>
      {data.videoPrompt || promptDocument.content?.some((node) => node.content?.length) ? <div className="agent-inspector__prompt"><PromptEditor document={promptDocument} resetKey={data.storyboardId} onChange={() => {}} disabled placeholder="暂无提示词" /></div> : <p className="agent-inspector__empty">暂无视频提示词。</p>}
    </section>
    <section className="agent-inspector__section agent-inspector__video-batches">
      <div className="agent-inspector__section-heading"><h3>视频批次</h3><span>{data.videos.length + data.videoTasks.length} 条</span></div>
      {data.videos.length > 0 || data.videoTasks.length > 0 ? <div className="agent-inspector__video-grid">
        {data.videoTasks.map((task, index) => <div key={`task-${task.id}`} className={`agent-inspector__video-card agent-inspector__video-card--task agent-inspector__video-card--${task.status}`}>
          <div className="agent-inspector__video-thumb"><div className={`agent-inspector__video-task-thumb${task.status === "failed" ? " is-failed" : ""}`}><span className="agent-inspector__video-task-icon">{task.status === "failed" ? "×" : ""}</span></div><span className="agent-inspector__video-type-badge">生成</span><span className="agent-inspector__video-batch-label">{videoTaskLabel(task.status)}</span></div>
          <div className="agent-inspector__video-card-meta"><strong>生成任务 {index + 1}</strong><small>{task.error || `创建时间：${task.createdAt}`}</small></div>
        </div>)}
        {data.videos.map((video, index) => <InspectorVideoCard key={video.id} video={video} index={index} selected={video.id === data.selectedVideoId} />)}
      </div> : <p className="agent-inspector__empty">暂无视频批次。</p>}
    </section>
  </div>;
}

function InspectorVideoCard({ video, index, selected }: { video: StoryboardNodeData["videos"][number]; index: number; selected: boolean }) {
  const ready = isCanvasVideoReady(video.filePath, video.isUpscaleOutput, video.isOutputReady);
  const duration = video.duration && Number.isFinite(video.duration) ? `${Math.round(video.duration)} 秒` : ready ? "时长待定" : videoPreviewMessageFor(video.isUpscaleOutput, video.isOutputReady, video.filePath);
  const sourceLabel = videoSourceLabel(video.source, video.isUpscaleOutput);
  return <div className={`agent-inspector__video-card${selected ? " is-selected" : ""}`}>
    <div className="agent-inspector__video-thumb agent-inspector__video-thumb--deferred">
      {video.coverPath ? <img src={toMediaUrl(video.coverPath)} alt="" loading="lazy" decoding="async" draggable={false} /> : <span className="agent-inspector__video-thumb-placeholder">暂无封面</span>}
      <span className={`agent-inspector__video-type-badge${sourceLabel === "超分" ? " agent-inspector__video-type-badge--upscale" : ""}`}>{sourceLabel}</span><span className="agent-inspector__video-batch-label">B{index + 1}</span>{selected && <span className="agent-inspector__video-selected-badge">✓</span>}
    </div>
    <div className="agent-inspector__video-card-meta"><strong>时长：{duration}</strong><small>生成时间：{video.createdAt}</small></div>
  </div>;
}

function createStoryboardPromptDocument(data: StoryboardNodeData): PromptDoc {
  let params: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(data.videoParamJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed as Record<string, unknown>;
  } catch { /* 使用纯文本提示词回退 */ }

  const referencesById = new Map(data.assetReferences.map((asset) => [asset.assetId, asset]));
  const mentionsByAssetId = new Map<string, PromptMention>();
  for (const mention of normalizeMentions(params.mention_map)) {
    const reference = referencesById.get(mention.assetId);
    mentionsByAssetId.set(mention.assetId, {
      ...mention,
      name: reference?.name ?? mention.name,
      type: reference?.type ?? mention.type,
      imagePath: reference?.imagePath ?? mention.imagePath,
      assetTag: reference?.assetTag || mention.assetTag,
    });
  }
  for (const reference of data.assetReferences) {
    if (mentionsByAssetId.has(reference.assetId)) continue;
    const tagMatch = reference.assetTag.match(/\(@图片(\d+)\)$/);
    const promptMatch = tagMatch ?? (reference.name
      ? new RegExp(`${escapePromptRegExp(reference.name)}\\(@图片(\\d+)\\)`, "u").exec(data.videoPrompt)
      : null);
    if (!promptMatch) continue;
    const index = Number(promptMatch[1]);
    const assetTag = reference.assetTag || `${reference.name}(@图片${index})`;
    mentionsByAssetId.set(reference.assetId, {
      n: index,
      assetId: reference.assetId,
      name: reference.name,
      type: reference.type,
      imagePath: reference.imagePath,
      assetTag,
    });
  }
  const mentions = [...mentionsByAssetId.values()].sort((left, right) => left.n - right.n);
  const storedDoc = params.prompt_doc;
  if (isPromptDoc(storedDoc)) return hydratePromptDoc(storedDoc, mentions);
  const annotated = annotatePrompt(data.videoPrompt || "", mentions);
  return plainTextToPromptDoc(annotated, mentions);
}

function videoTaskLabel(status: string): string { return status === "running" ? "处理中" : status === "failed" ? "失败" : "排队"; }
function videoSourceLabel(source: string, isUpscaleOutput: boolean): string { const normalized = source.toLowerCase(); return normalized.includes("upload") || normalized.includes("local") || source === "import" ? "本地上传" : isUpscaleOutput || normalized === "upscale" ? "超分" : "生成"; }
function assetImageSourceLabel(source: string): string { const normalized = source.toLowerCase(); return videoSourceLabel(source, normalized === "upscale" || normalized.includes("upscale")); }
function escapePromptRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function AssetInspector({ data }: { data: Extract<CanvasNodeData, { entityType: "asset" }> }) {
  return <div className="agent-inspector__asset">
    <section className="agent-inspector__section">
      <div className="agent-inspector__section-heading"><h3>素材描述</h3><span>{data.type === "character" ? "人物" : data.type === "scene" ? "场景" : "道具"}</span></div>
      <p>{data.description || "暂无素材描述。"}</p>
    </section>
    <AssetPromptInspector data={data} />
    <AssetImageBatchInspector data={data} />
  </div>;
}

function AssetPromptInspector({ data }: { data: Extract<CanvasNodeData, { entityType: "asset" }> }) {
  const promptDocument = useMemo(() => plainTextToPromptDoc(data.prompt, []), [data.prompt]);
  return <section className="agent-inspector__section agent-inspector__asset-prompt">
    <div className="agent-inspector__section-heading"><h3>提示词</h3></div>
    {data.prompt ? <div className="agent-inspector__prompt"><PromptEditor document={promptDocument} resetKey={data.assetId} onChange={() => {}} disabled placeholder="暂无提示词" /></div> : <p className="agent-inspector__empty">此素材尚未填写提示词。</p>}
  </section>;
}

function AssetImageBatchInspector({ data }: { data: Extract<CanvasNodeData, { entityType: "asset" }> }) {
  return <section className="agent-inspector__section agent-inspector__batches" aria-label="图片批次">
    <header><div><span>图片批次</span></div><em>{data.imageCount} 张</em></header>
    {data.previewImages.length > 0 ? <div className="agent-inspector__image-grid" aria-label="图片批次列表">
      {data.previewImages.map((image, index) => <article key={image.id} className={`agent-inspector__video-card agent-inspector__image-card${image.isSelected ? " is-selected" : ""}`}>
        <div className="agent-inspector__video-thumb"><img src={toMediaUrl(image.thumbnailPath ?? image.imagePath)} alt={`${data.name} 图片 ${index + 1}`} loading="lazy" decoding="async" draggable={false} /><span className={`agent-inspector__video-type-badge${assetImageSourceLabel(image.source) === "超分" ? " agent-inspector__video-type-badge--upscale" : ""}`}>{assetImageSourceLabel(image.source)}</span><span className="agent-inspector__video-batch-label">图片 #{index + 1}</span>{image.isSelected && <span className="agent-inspector__video-selected-badge">✓</span>}</div>
        <div className="agent-inspector__video-card-meta"><strong>分辨率：{image.size || "—"}</strong><small>生成时间：{formatCreatedAt(image.createdAt)}</small></div>
      </article>)}
    </div> : <p className="agent-inspector__batch-empty">当前批次暂无图片。</p>}
  </section>;
}
function getPreview(data: CanvasNodeData): { kind: "image" | "video"; path: string } | null {
  if (data.entityType === "video" && isCanvasVideoReady(data.filePath, data.isUpscaleOutput, data.isOutputReady)) return { kind: "video", path: data.filePath };
  if (data.entityType === "asset" && data.selectedImagePath) return { kind: "image", path: data.selectedImagePath };
  return null;
}
function getVideoPreviewMessage(data: CanvasNodeData): string | null {
  if (data.entityType !== "video" || isCanvasVideoReady(data.filePath, data.isUpscaleOutput, data.isOutputReady)) return null;
  return videoPreviewMessageFor(data.isUpscaleOutput, data.isOutputReady, data.filePath);
}
function videoPreviewMessageFor(isUpscaleOutput: boolean, isOutputReady: boolean, filePath: string | null | undefined): string {
  return isUpscaleOutput && !isOutputReady ? "处理中" : filePath ? "处理中" : "暂无可预览文件";
}
function toMediaUrl(path: string): string { return path.startsWith("http") ? path : convertFileSrc(path); }
function formatReleaseDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "时长待定";
  const totalSeconds = Math.max(0, Math.round(value));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "时间未知";
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function entityLabel(type: CanvasInspectorData["entityType"]): string { return ({ project: "作品", clip: "分集", asset: "素材", storyboard: "镜头", video: "视频", task: "任务", "release-summary": "编排", "release-output": "成片" })[type]; }
function inspectorSummary(data: CanvasNodeData): string { if (data.entityType === "asset") return data.description || "此素材尚未填写描述。"; if (data.entityType === "storyboard") return data.summary || data.dialogue || "此镜头尚未填写摘要。"; if (data.entityType === "task") return data.error ? `任务失败：${data.error}` : `目标：${data.targetName}`; if (data.entityType === "clip") return data.summary || `${data.assetCount} 个素材，${data.storyboardCount} 个镜头。`; if (data.entityType === "project") return data.description || `${data.clipCount} 个分集。`; return ""; }
