/**
 * Canonical hierarchy plus a deterministic three-center projection.
 *
 * The semantic hierarchy and the React Flow hierarchy are deliberately kept
 * separate. React Flow receives flat absolute positions; business ownership
 * and drag grouping remain in node data and the semantic hierarchy.
 */
import { MarkerType, type Edge, type Node } from "reactflow";
import type { AssetType } from "../../types/project";
import type { CanvasAssetRead, CanvasConcatOutputRead, CanvasStoryboardRead, ProjectCanvasReadModel } from "../../services/tauri";
import { CANVAS_LAYOUT, createProductionRows } from "./layout";
import type {
  AssetNodeData, CanvasCenterKind, CanvasCenterNodeData, CanvasFlowNodeData, CanvasNodeBase, ClipNodeData,
  MaterialCategoryNodeData, ProjectNodeData, ReleaseOutputNodeData, ReleaseShotPreview, ReleaseSummaryNodeData,
  ShotAnchorNodeData, ShotTrackNodeData, StoryboardAssetReference, StoryboardNodeData,
  TaskNodeData, VideoNodeData,
} from "./node-data";
import { isCanvasVideoReady, materialContentSourceHandle } from "./node-data";

const encode = (value: string) => encodeURIComponent(value);
export const canonicalProjectId = (id: string) => `project:${encode(id)}`;
export const canonicalClipId = (id: string) => `clip:${encode(id)}`;
export const canonicalAssetId = (id: string) => `asset:${encode(id)}`;
export const canonicalStoryboardId = (id: string) => `storyboard:${encode(id)}`;
export const canonicalVideoId = (id: string) => `video:${encode(id)}`;
export const canonicalTaskId = (id: string) => `task:${encode(id)}`;
export const canvasCenterId = (kind: CanvasCenterKind, clipId: string | null) => `center:${kind}:${clipId ? encode(clipId) : "shared"}`;
const materialCategoryId = (clipId: string | null, type: AssetType, projectId: string) => `material-category:${clipId ? encode(clipId) : `shared:${encode(projectId)}`}:${type}`;
const sharedCategoryId = (projectId: string, type: AssetType) => materialCategoryId(null, type, projectId);
const shotTrackId = (clipId: string) => `shot-track:${encode(clipId)}`;
const shotAnchorId = (storyboardId: string) => `shot-anchor:${encode(storyboardId)}`;
const releaseSummaryId = (clipId: string) => `release-summary:${encode(clipId)}`;
const emptyReleaseId = (clipId: string) => `release-empty:${encode(clipId)}`;
const outputNodeId = (outputId: string) => `output:${encode(outputId)}`;
const MATERIAL_TYPES: AssetType[] = ["character", "scene", "item"];

type HierarchyNode = { id: string; parentId: string | null; type: string; data: CanvasFlowNodeData };
export interface CanvasHierarchy { projectId: string; rootId: string; byId: Map<string, HierarchyNode>; childrenById: Map<string, string[]>; }
export interface CanvasProjection { hierarchy: CanvasHierarchy; nodes: Node<CanvasFlowNodeData>[]; edges: Edge[]; }

type CanvasPosition = { x: number; y: number };
type MaterialCategoryLayout = { width: number; height: number; assetPositions: Map<string, CanvasPosition> };

function canvasRoleForEntity(entityType: CanvasNodeBase["entityType"]): CanvasNodeBase["canvasRole"] {
  if (entityType === "project" || entityType === "clip") return "context";
  if (entityType === "center") return "center";
  if (entityType === "material-category") return "category";
  if (entityType === "shot-track" || entityType === "shot-anchor") return "track";
  return "content";
}

function addNode(hierarchy: CanvasHierarchy, node: HierarchyNode): void {
  hierarchy.byId.set(node.id, node);
  if (!node.parentId) return;
  const children = hierarchy.childrenById.get(node.parentId) ?? [];
  children.push(node.id);
  hierarchy.childrenById.set(node.parentId, children);
}

function base<T extends CanvasNodeBase["entityType"]>(projectId: string, id: string, parentId: string | null, entityType: T, entityId: string, title: string, status?: string): Omit<CanvasNodeBase, "entityType"> & { entityType: T } {
  return {
    canonicalId: id,
    parentCanonicalId: parentId,
    canvasParentId: parentId,
    canvasRole: canvasRoleForEntity(entityType),
    projectId,
    entityId,
    entityType,
    title,
    hasChildren: false,
    status,
  };
}

function assetReference(asset: CanvasAssetRead, ownerClipId: string, assetTag: string): StoryboardAssetReference {
  const linkedToOwner = asset.clip_ids.includes(ownerClipId);
  const sharedAcrossClips = asset.clip_ids.length > 1;
  return {
    assetId: asset.id,
    type: asset.type,
    name: asset.name,
    assetTag,
    imagePath: asset.selected_image_path,
    sourceScope: linkedToOwner && !sharedAcrossClips ? "owned" : asset.clip_ids.length ? "clip" : "project-shared",
    sourceClipId: asset.clip_ids.length === 1 ? asset.clip_ids[0] : null,
  };
}

function addAsset(hierarchy: CanvasHierarchy, asset: CanvasAssetRead, parentId: string): void {
  const id = canonicalAssetId(asset.id);
  addNode(hierarchy, { id, parentId, type: "AssetNode", data: {
    ...base(asset.project_id, id, parentId, "asset", asset.id, asset.name, asset.status), assetId: asset.id, type: asset.type, name: asset.name,
    description: asset.description, prompt: asset.prompt, imageCount: asset.images.length, selectedImagePath: asset.selected_image_path,
    previewImages: asset.images.map((image) => ({ id: image.id, imagePath: image.image_path, thumbnailPath: image.thumbnail_path, prompt: image.prompt, size: image.size, style: image.style, source: image.source, createdAt: image.created_at, isSelected: image.is_selected })),
    taskPreviews: asset.tasks.map((task) => ({ id: task.id, taskType: task.task_type, status: task.status, error: task.error_message })),
  } satisfies AssetNodeData });
}

function videoReadiness(storyboard: CanvasStoryboardRead, video: CanvasStoryboardRead["videos"][number]): Pick<VideoNodeData, "isUpscaleOutput" | "isOutputReady"> {
  const upscaleTask = video.source === "upscale"
    ? storyboard.upscale_tasks.find((task) => task.video_id === video.id)
    : undefined;
  return {
    isUpscaleOutput: video.source === "upscale",
    isOutputReady: video.source !== "upscale" || upscaleTask?.status === "done",
  };
}

function addStoryboard(hierarchy: CanvasHierarchy, storyboard: CanvasStoryboardRead, parentId: string, assetsById: Map<string, CanvasAssetRead>): void {
  const id = canonicalStoryboardId(storyboard.id);
  const references = storyboard.asset_references.map((reference) => {
    const asset = assetsById.get(reference.asset_id);
    return asset ? assetReference(asset, storyboard.clip_id, reference.asset_tag) : null;
  }).filter((reference): reference is StoryboardAssetReference => reference !== null);
  const upscaleByVideoId = new Map(storyboard.upscale_tasks.map((task) => [task.video_id, task]));
  const projectedVideos = storyboard.videos.filter((video) => video.source !== "upscale" || upscaleByVideoId.has(video.id));
  addNode(hierarchy, { id, parentId, type: "StoryboardNode", data: {
    ...base(storyboard.project_id, id, parentId, "storyboard", storyboard.id, storyboard.sbid, storyboard.video_state), storyboardId: storyboard.id,
    sbid: storyboard.sbid, seqNum: storyboard.seq_num, summary: storyboard.summary, dialogue: storyboard.dialogue,
    visualDescription: storyboard.visual_description, videoPrompt: storyboard.video_prompt, videoParamJson: storyboard.video_param_json,
    selectedVideoId: storyboard.selected_video_id, duration: storyboard.video_duration, assetReferences: references,
    videoTasks: storyboard.video_tasks.map((task) => ({ id: task.id, status: task.status, error: task.error_message, createdAt: task.created_at })),
    videos: projectedVideos.map((video) => {
      const readiness = videoReadiness(storyboard, video);
      return { id: video.id, filePath: video.file_path, fileName: video.file_name, source: video.source, taskId: video.task_id, duration: video.duration, createdAt: video.created_at, coverPath: video.cover_path, ...readiness };
    }),
  } satisfies StoryboardNodeData });
  for (const task of storyboard.video_tasks) {
    const taskId = canonicalTaskId(task.id);
    addNode(hierarchy, { id: taskId, parentId: id, type: "TaskNode", data: {
      ...base(storyboard.project_id, taskId, id, "task", task.id, "视频生成", task.status), taskKind: "video-generation", targetName: `${storyboard.sbid} · 镜头 ${storyboard.seq_num}`, error: task.error_message,
    } satisfies TaskNodeData });
  }
  for (const [batchIndex, video] of projectedVideos.entries()) {
    const videoId = canonicalVideoId(video.id);
    addNode(hierarchy, { id: videoId, parentId: id, type: "VideoNode", data: {
      ...base(storyboard.project_id, videoId, id, "video", video.id, ""), storyboardId: storyboard.id,
      batchIndex: batchIndex + 1, isSelected: video.id === storyboard.selected_video_id, filePath: video.file_path, fileName: video.file_name, duration: video.duration, createdAt: video.created_at, source: video.source, coverPath: video.cover_path,
      isUpscaleOutput: video.source === "upscale", isOutputReady: video.source !== "upscale" || upscaleByVideoId.get(video.id)?.status === "done",
    } satisfies VideoNodeData });
  }
}

/** Semantic owner hierarchy used by expansion and disclosure, not visual parents. */
export function createCanvasHierarchy(model: ProjectCanvasReadModel): CanvasHierarchy {
  const rootId = canonicalProjectId(model.project.id);
  const hierarchy: CanvasHierarchy = { projectId: model.project.id, rootId, byId: new Map(), childrenById: new Map() };
  addNode(hierarchy, { id: rootId, parentId: null, type: "ProjectNode", data: {
    ...base(model.project.id, rootId, null, "project", model.project.id, model.project.name, model.project.status), name: model.project.name, description: model.project.description, clipCount: model.clips.length,
  } satisfies ProjectNodeData });
  const assetsById = new Map(model.assets.map((asset) => [asset.id, asset]));
  for (const type of MATERIAL_TYPES) {
    const id = sharedCategoryId(model.project.id, type);
    const items = model.assets.filter((asset) => asset.clip_ids.length !== 1 && asset.type === type);
    addNode(hierarchy, { id, parentId: rootId, type: "MaterialCategoryNode", data: {
      ...base(model.project.id, id, rootId, "material-category", id, "项目共享素材"), clipId: null, category: type, itemCount: items.length, expansionId: id,
    } satisfies MaterialCategoryNodeData });
    for (const asset of items) addAsset(hierarchy, asset, id);
  }
  const boardsByClip = new Map<string, CanvasStoryboardRead[]>();
  for (const storyboard of model.storyboards) {
    const list = boardsByClip.get(storyboard.clip_id) ?? [];
    list.push(storyboard);
    boardsByClip.set(storyboard.clip_id, list);
  }
  for (const clip of model.clips) {
    const clipId = canonicalClipId(clip.id);
    const owned = model.assets.filter((asset) => asset.clip_ids.length === 1 && asset.clip_ids[0] === clip.id);
    const boards = boardsByClip.get(clip.id) ?? [];
    addNode(hierarchy, { id: clipId, parentId: rootId, type: "ClipNode", data: {
      ...base(model.project.id, clipId, rootId, "clip", clip.id, clip.title, clip.status), summary: clip.summary, assetCount: owned.length, storyboardCount: boards.length, estimatedDuration: clip.estimated_duration,
    } satisfies ClipNodeData });
    for (const type of MATERIAL_TYPES) {
      const id = materialCategoryId(clip.id, type, model.project.id);
      const items = owned.filter((asset) => asset.type === type);
      addNode(hierarchy, { id, parentId: clipId, type: "MaterialCategoryNode", data: {
        ...base(model.project.id, id, clipId, "material-category", id, type), clipId: clip.id, category: type, itemCount: items.length, expansionId: id,
      } satisfies MaterialCategoryNodeData });
      for (const asset of items) addAsset(hierarchy, asset, id);
    }
    for (const storyboard of boards) addStoryboard(hierarchy, storyboard, clipId, assetsById);
  }
  for (const node of hierarchy.byId.values()) {
    const semanticChildren = (hierarchy.childrenById.get(node.id)?.length ?? 0) > 0;
    node.data.hasChildren = node.data.entityType === "asset" ? semanticChildren || Boolean(node.data.description) : semanticChildren;
  }
  return hierarchy;
}

export function defaultCanvasExpandedIds(model: ProjectCanvasReadModel): Set<string> {
  const hierarchy = createCanvasHierarchy(model);
  const expanded = new Set<string>();
  for (const clip of model.clips) {
    expanded.add(canvasCenterId("materials", clip.id));
    expanded.add(canvasCenterId("shots", clip.id));
    expanded.add(canvasCenterId("release", clip.id));
  }
  if (model.assets.some((asset) => asset.clip_ids.length !== 1)) expanded.add(canvasCenterId("materials", null));
  for (const node of hierarchy.byId.values()) if (node.data.hasChildren) expanded.add(node.id);
  for (const output of model.concat_outputs ?? []) expanded.add(outputNodeId(output.id));
  return expanded;
}

export function agentExecutingCanvasExpandedIds(model: ProjectCanvasReadModel): Set<string> {
  const hasActiveTask = model.assets.some((asset) => asset.tasks.some((task) => task.status === "queued" || task.status === "running"))
    || model.storyboards.some((storyboard) => storyboard.video_tasks.some((task) => task.status === "queued" || task.status === "running")
      || storyboard.upscale_tasks.some((task) => task.status === "queued" || task.status === "running"));
  return hasActiveTask ? defaultCanvasExpandedIds(model) : new Set<string>();
}

function readModelVideoReady(storyboard: CanvasStoryboardRead, video: CanvasStoryboardRead["videos"][number]): boolean {
  const readiness = videoReadiness(storyboard, video);
  return isCanvasVideoReady(video.file_path, readiness.isUpscaleOutput, readiness.isOutputReady);
}

function readyStoryboardCount(boards: readonly CanvasStoryboardRead[]): number {
  return boards.filter((storyboard) => {
    if (storyboard.selected_video_id) {
      const selectedVideo = storyboard.videos.find((video) => video.id === storyboard.selected_video_id);
      return selectedVideo ? readModelVideoReady(storyboard, selectedVideo) : false;
    }
    return storyboard.videos.some((video) => readModelVideoReady(storyboard, video));
  }).length;
}

/** Create a flat React Flow node. `position` is always an absolute canvas coordinate. */
function asNode<T extends CanvasFlowNodeData>(id: string, type: string, position: CanvasPosition, data: T, style?: Node["style"], zIndex = 2, groupId: string | null = null, dragHandle?: string): Node<CanvasFlowNodeData> {
  return {
    id,
    type,
    position,
    data: { ...data, canvasGroupId: groupId },
    style,
    zIndex,
    dragHandle,
  };
}

function visualPosition(nodes: readonly Node<CanvasFlowNodeData>[], groupId: string | null, localPosition: CanvasPosition): CanvasPosition {
  if (!groupId) return { ...localPosition };
  const group = nodes.find((node) => node.id === groupId);
  return group
    ? { x: group.position.x + localPosition.x, y: group.position.y + localPosition.y }
    : { ...localPosition };
}

function bezierEdge(id: string, source: string, target: string, external = false, sourceHandle = "source", targetHandle = "target"): Edge {
  return {
    id, source, target, sourceHandle, targetHandle, type: "default",
    markerEnd: external ? { type: MarkerType.ArrowClosed, color: "rgba(136, 177, 206, .76)", width: 13, height: 13 } : undefined,
    style: external ? { stroke: "rgba(136, 177, 206, .66)", strokeWidth: 1.7 } : { stroke: "rgba(119, 151, 173, .48)", strokeWidth: 1.25 },
    className: external ? "cn-edge cn-edge--production" : "cn-edge cn-edge--local",
  };
}

function createMaterialCategoryLayout(assets: readonly CanvasAssetRead[], categoryOpen: boolean): MaterialCategoryLayout {
  if (!categoryOpen) return { width: 280, height: 38, assetPositions: new Map() };
  const assetPositions = new Map<string, CanvasPosition>();
  let cursorY = CANVAS_LAYOUT.materialAssetStartY;
  let width = 280;
  let height = 96;
  for (const asset of assets) {
    const id = canonicalAssetId(asset.id);
    const position = { x: CANVAS_LAYOUT.materialAssetInsetX, y: cursorY };
    assetPositions.set(id, position);
    width = Math.max(width, position.x + 252 + CANVAS_LAYOUT.materialAssetRightPadding);
    height = Math.max(height, position.y + 152 + 12);
    cursorY += 164;
  }
  return { width, height, assetPositions };
}
function materialLaneWidth(layouts: readonly MaterialCategoryLayout[]): number {
  return layouts.reduce((width, layout, index) => width + layout.width + (index ? CANVAS_LAYOUT.materialCategoryGap : 0), 0);
}
function materialSourcePositions(layouts: readonly MaterialCategoryLayout[]): number[] {
  let categoryX = CANVAS_LAYOUT.materialCategoryInset;
  return layouts.map((layout) => {
    const sourceX = categoryX + layout.width / 2;
    categoryX += layout.width + CANVAS_LAYOUT.materialCategoryGap;
    return sourceX;
  });
}
function shotDetailHeight(entityType: CanvasFlowNodeData["entityType"]): number {
  return entityType === "video" ? CANVAS_LAYOUT.videoCardHeight : CANVAS_LAYOUT.taskCardHeight;
}
function shotRowHeight(boards: readonly CanvasStoryboardRead[], expandedIds: ReadonlySet<string>): number {
  let height = 272;
  for (const board of boards) {
    if (!expandedIds.has(canonicalStoryboardId(board.id))) continue;
    const videoCount = board.videos.filter((video) => video.source !== "upscale" || board.upscale_tasks.some((task) => task.video_id === video.id)).length;
    const taskCount = board.video_tasks.length;
    const detailCount = taskCount + videoCount;
    const detailHeight = taskCount * CANVAS_LAYOUT.taskCardHeight
      + videoCount * CANVAS_LAYOUT.videoCardHeight
      + detailCount * CANVAS_LAYOUT.shotDetailGap;
    height = Math.max(height, 270 + detailHeight + 18);
  }
  return height;
}

function releaseCenterHeight(outputCount: number, centerOpen: boolean, historyOpen: boolean): number {
  if (!centerOpen) return 62;
  const baseHeight = 226;
  const historyCount = historyOpen ? Math.max(0, outputCount - 1) : 0;
  if (historyCount === 0) return baseHeight;
  const lastHistoryY = CANVAS_LAYOUT.centerContentTop
    + CANVAS_LAYOUT.releaseHistoryTop
    + (historyCount - 1) * (CANVAS_LAYOUT.releaseOutputHeight + CANVAS_LAYOUT.releaseHistoryGap);
  return Math.max(
    baseHeight,
    lastHistoryY + CANVAS_LAYOUT.releaseOutputHeight + CANVAS_LAYOUT.releaseContentBottomPadding,
  );
}

/** Build the stable three-center production canvas. */
export function buildCanvas(model: ProjectCanvasReadModel, expandedIds: ReadonlySet<string>): CanvasProjection {
  const hierarchy = createCanvasHierarchy(model);
  const nodes: Node<CanvasFlowNodeData>[] = [];
  const edges: Edge[] = [];
  const boardsByClip = new Map<string, CanvasStoryboardRead[]>();
  const outputsByClip = new Map<string, CanvasConcatOutputRead[]>();
  for (const storyboard of model.storyboards) {
    const list = boardsByClip.get(storyboard.clip_id) ?? [];
    list.push(storyboard);
    boardsByClip.set(storyboard.clip_id, list);
  }
  for (const output of model.concat_outputs ?? []) {
    const list = outputsByClip.get(output.clip_id) ?? [];
    list.push(output);
    outputsByClip.set(output.clip_id, list);
  }
  for (const list of boardsByClip.values()) list.sort((left, right) => left.seq_num - right.seq_num || left.id.localeCompare(right.id));
  for (const list of outputsByClip.values()) list.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));

  const sharedAssets = model.assets.filter((asset) => asset.clip_ids.length !== 1);
  const sharedLayouts = MATERIAL_TYPES.map((type) => createMaterialCategoryLayout(sharedAssets.filter((asset) => asset.type === type), expandedIds.has(sharedCategoryId(model.project.id, type))));
  const clipLayouts = new Map<string, MaterialCategoryLayout[]>();
  for (const clip of model.clips) {
    const owned = model.assets.filter((asset) => asset.clip_ids.length === 1 && asset.clip_ids[0] === clip.id);
    clipLayouts.set(clip.id, MATERIAL_TYPES.map((type) => createMaterialCategoryLayout(owned.filter((asset) => asset.type === type), expandedIds.has(materialCategoryId(clip.id, type, model.project.id)))));
  }

  const materialLaneWidths = model.clips.map((clip) => materialLaneWidth(clipLayouts.get(clip.id) ?? []));
  if (sharedAssets.length > 0) materialLaneWidths.push(materialLaneWidth(sharedLayouts));
  const materialWidth = Math.max(CANVAS_LAYOUT.materialWidth, Math.max(...materialLaneWidths, 0) + CANVAS_LAYOUT.materialCategoryInset * 2);
  const maxStoryboardCount = Math.max(0, ...[...boardsByClip.values()].map((boards) => boards.length));
  const shotsWidth = Math.max(CANVAS_LAYOUT.shotsWidth, CANVAS_LAYOUT.shotsSidePadding + CANVAS_LAYOUT.shotCardWidth + Math.max(0, maxStoryboardCount - 1) * CANVAS_LAYOUT.shotColumnStep + CANVAS_LAYOUT.shotsSidePadding);
  const shotsX = CANVAS_LAYOUT.materialX + materialWidth + 40;
  const releaseX = shotsX + shotsWidth + 40;
  const centerOpen = (kind: CanvasCenterKind, clipId: string | null) => expandedIds.has(canvasCenterId(kind, clipId));
  const rowHeights = new Map<string, number>();
  for (const clip of model.clips) {
    const layouts = clipLayouts.get(clip.id) ?? [];
    const materialHeight = centerOpen("materials", clip.id) ? Math.max(120, ...layouts.map((layout) => layout.height + CANVAS_LAYOUT.centerContentTop)) : 62;
    const boards = boardsByClip.get(clip.id) ?? [];
    const shotsHeight = centerOpen("shots", clip.id) ? shotRowHeight(boards, expandedIds) : 62;
    const outputs = outputsByClip.get(clip.id) ?? [];
    const hasOutputHistory = outputs.length > 1 && expandedIds.has(outputNodeId(outputs[0].id));
    const releaseHeight = releaseCenterHeight(outputs.length, centerOpen("release", clip.id), hasOutputHistory);
    rowHeights.set(clip.id, Math.max(materialHeight, shotsHeight, releaseHeight));
  }
  const rows = createProductionRows(model.clips, rowHeights);
  const clipBottom = [...rows.values()].reduce<number>((bottom, row) => Math.max(bottom, row.y + row.height), CANVAS_LAYOUT.top);
  const sharedHeight = sharedAssets.length > 0 ? Math.max(120, ...sharedLayouts.map((layout) => layout.height + CANVAS_LAYOUT.centerContentTop)) : 0;
  const sharedY = model.clips.length > 0 ? clipBottom + CANVAS_LAYOUT.rowGap : CANVAS_LAYOUT.top;

  const centerData = (kind: CanvasCenterKind, clipId: string | null, title: string, itemCount: number, width: number, height: number, semanticParentId: string | null, materialSourcePositions: readonly number[] = []): CanvasCenterNodeData => {
    const id = canvasCenterId(kind, clipId);
    return { ...base(model.project.id, id, semanticParentId, "center", clipId ? `${clipId}:${kind}` : kind, title), centerKind: kind, clipId, itemCount, width, height, baseWidth: width, baseHeight: height, materialSourcePositions: kind === "materials" ? materialSourcePositions : undefined };
  };

  for (const clip of model.clips) {
    const row = rows.get(clip.id);
    if (!row) continue;
    const semanticClip = hierarchy.byId.get(canonicalClipId(clip.id));
    if (!semanticClip || semanticClip.data.entityType !== "clip") continue;
    const clipData = semanticClip.data;
    const clipParentId = canonicalClipId(clip.id);
    const materialCenter = canvasCenterId("materials", clip.id);
    const shotsCenter = canvasCenterId("shots", clip.id);
    const releaseCenter = canvasCenterId("release", clip.id);
    const owned = model.assets.filter((asset) => asset.clip_ids.length === 1 && asset.clip_ids[0] === clip.id);
    const boards = boardsByClip.get(clip.id) ?? [];
    const outputs = outputsByClip.get(clip.id) ?? [];
    nodes.push(
      asNode(clipData.canonicalId, "ClipNode", { x: CANVAS_LAYOUT.clipX, y: row.y + 6 }, clipData),
      asNode(materialCenter, "CanvasCenterNode", { x: CANVAS_LAYOUT.materialX, y: row.y }, centerData("materials", clip.id, "素材中心", owned.length, materialWidth, row.height, clipParentId, materialSourcePositions(clipLayouts.get(clip.id) ?? [])), { width: materialWidth, height: row.height }, 0, null, ".cn-center__header"),
      asNode(shotsCenter, "CanvasCenterNode", { x: shotsX, y: row.y }, centerData("shots", clip.id, "镜头中心", boards.length, shotsWidth, row.height, clipParentId), { width: shotsWidth, height: row.height }, 0, null, ".cn-center__header"),
      asNode(releaseCenter, "CanvasCenterNode", { x: releaseX, y: row.y }, centerData("release", clip.id, "成片中心", outputs.length, CANVAS_LAYOUT.releaseWidth, row.height, clipParentId), { width: CANVAS_LAYOUT.releaseWidth, height: row.height }, 0, null, ".cn-center__header"),
    );
    edges.push(bezierEdge(`production:${clip.id}:materials`, clipData.canonicalId, materialCenter, true));
    edges.push(bezierEdge(`production:${clip.id}:shots`, materialCenter, shotsCenter, true));
    edges.push(bezierEdge(`production:${clip.id}:release`, shotsCenter, releaseCenter, true));

    if (centerOpen("materials", clip.id)) {
      let categoryX = CANVAS_LAYOUT.materialCategoryInset;
      const layouts = clipLayouts.get(clip.id) ?? [];
      for (const [index, type] of MATERIAL_TYPES.entries()) {
        const categoryId = materialCategoryId(clip.id, type, model.project.id);
        const categoryAssets = owned.filter((asset) => asset.type === type);
        const categoryOpen = expandedIds.has(categoryId);
        const layout = layouts[index];
        const data: MaterialCategoryNodeData = { ...base(model.project.id, categoryId, clipParentId, "material-category", categoryId, type), clipId: clip.id, category: type, itemCount: categoryAssets.length, expansionId: categoryId, hasChildren: categoryAssets.length > 0 };
        const categoryPosition = { x: categoryX, y: CANVAS_LAYOUT.centerContentTop };
        nodes.push(asNode(categoryId, "MaterialCategoryNode", visualPosition(nodes, materialCenter, categoryPosition), data, { width: layout.width, height: layout.height }, 1, materialCenter, ".cn-category__header"));
        if (categoryOpen) addMaterialAssets(nodes, edges, hierarchy, categoryId, categoryAssets, layout, index);
        categoryX += layout.width + CANVAS_LAYOUT.materialCategoryGap;
      }
    }
    if (centerOpen("shots", clip.id)) addShotTrack(nodes, edges, hierarchy, model, clip.id, boards, expandedIds, shotsCenter);
    if (centerOpen("release", clip.id)) addReleaseChain(nodes, edges, model, clip.id, outputs, boards, expandedIds, releaseCenter);
  }

  if (sharedAssets.length > 0) {
    const sharedCenter = canvasCenterId("materials", null);
    nodes.push(asNode(sharedCenter, "CanvasCenterNode", { x: CANVAS_LAYOUT.materialX, y: sharedY }, centerData("materials", null, "共享素材", sharedAssets.length, materialWidth, sharedHeight, canonicalProjectId(model.project.id), materialSourcePositions(sharedLayouts)), { width: materialWidth, height: sharedHeight }, 0, null, ".cn-center__header"));
    if (centerOpen("materials", null)) {
      let categoryX = CANVAS_LAYOUT.materialCategoryInset;
      for (const [index, type] of MATERIAL_TYPES.entries()) {
        const categoryId = sharedCategoryId(model.project.id, type);
        const categoryAssets = sharedAssets.filter((asset) => asset.type === type);
        const categoryOpen = expandedIds.has(categoryId);
        const layout = sharedLayouts[index];
        const categoryData: MaterialCategoryNodeData = { ...base(model.project.id, categoryId, canonicalProjectId(model.project.id), "material-category", categoryId, "项目共享 · " + type), clipId: null, category: type, itemCount: categoryAssets.length, expansionId: categoryId, hasChildren: categoryAssets.length > 0 };
        const categoryPosition = { x: categoryX, y: CANVAS_LAYOUT.centerContentTop };
        nodes.push(asNode(categoryId, "MaterialCategoryNode", visualPosition(nodes, sharedCenter, categoryPosition), categoryData, { width: layout.width, height: layout.height }, 1, sharedCenter, ".cn-category__header"));
        if (categoryOpen) addMaterialAssets(nodes, edges, hierarchy, categoryId, categoryAssets, layout, index);
        categoryX += layout.width + CANVAS_LAYOUT.materialCategoryGap;
      }
    }
  }
  if (import.meta.env.DEV) validateCanvasBindings(nodes);
  return { hierarchy, nodes, edges };
}

function validateCanvasBindings(nodes: readonly Node<CanvasFlowNodeData>[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const problems: string[] = [];
  for (const node of nodes) {
    const nativeParentId = node.parentId || node.parentNode;
    const groupId = node.data.canvasGroupId;
    if (nativeParentId) problems.push(`${node.id} still has a native React Flow parent`);
    if (groupId && !byId.has(groupId)) problems.push(`${node.id} -> missing canvas group ${groupId}`);
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) problems.push(`${node.id} has invalid absolute position`);
  }
  if (problems.length) console.warn("[Agent canvas] invalid flat projection bindings", problems);
}

function addMaterialAssets(nodes: Node<CanvasFlowNodeData>[], edges: Edge[], hierarchy: CanvasHierarchy, categoryId: string, assets: readonly CanvasAssetRead[], layout: MaterialCategoryLayout, categoryIndex: number): void {
  const categoryNode = nodes.find((node) => node.id === categoryId);
  const groupId = categoryNode?.data.canvasGroupId ?? null;
  for (const asset of assets) {
    const semantic = hierarchy.byId.get(canonicalAssetId(asset.id));
    const localPosition = layout.assetPositions.get(semantic?.id ?? "");
    if (!semantic || semantic.data.entityType !== "asset" || !localPosition) continue;
    nodes.push(asNode(semantic.id, "AssetNode", visualPosition(nodes, categoryId, localPosition), semantic.data, { width: 252, height: 152 }, 2, groupId));
    edges.push(bezierEdge(`material-detail:${categoryId}:${semantic.id}`, groupId ?? categoryId, semantic.id, false, groupId ? materialContentSourceHandle(categoryIndex) : "source"));
  }
}

function addShotTrack(nodes: Node<CanvasFlowNodeData>[], edges: Edge[], hierarchy: CanvasHierarchy, model: ProjectCanvasReadModel, clipId: string, boards: CanvasStoryboardRead[], expandedIds: ReadonlySet<string>, centerId: string): void {
  const trackId = shotTrackId(clipId);
  const trackWidth = Math.max(CANVAS_LAYOUT.shotTrackWidth, 185 + Math.max(0, boards.length - 1) * CANVAS_LAYOUT.shotColumnStep);
  const trackData: ShotTrackNodeData = { ...base(model.project.id, trackId, canonicalClipId(clipId), "shot-track", clipId, "镜头轨"), clipId, shotCount: boards.length, width: trackWidth };
  nodes.push(asNode(trackId, "ShotTrackNode", visualPosition(nodes, centerId, { x: CANVAS_LAYOUT.shotTrackX, y: CANVAS_LAYOUT.centerContentTop + 12 }), trackData, { width: trackWidth, height: 24 }, 1, centerId));
  let previousAnchorId: string | null = null;
  boards.forEach((board, index) => {
    const anchorId = shotAnchorId(board.id);
    const anchorData: ShotAnchorNodeData = { ...base(model.project.id, anchorId, canonicalStoryboardId(board.id), "shot-anchor", board.id, `镜头 ${board.seq_num}`, board.video_state), clipId, storyboardId: board.id, seqNum: board.seq_num };
    const x = CANVAS_LAYOUT.shotAnchorX + index * CANVAS_LAYOUT.shotColumnStep;
    const contentY = CANVAS_LAYOUT.centerContentTop;
    nodes.push(asNode(anchorId, "ShotAnchorNode", visualPosition(nodes, centerId, { x, y: contentY }), anchorData, undefined, 3, centerId));
    if (previousAnchorId) {
      edges.push(bezierEdge(`shot-track-link:${previousAnchorId}:${anchorId}`, previousAnchorId, anchorId, true, "track-source", "track-target"));
    }
    previousAnchorId = anchorId;
    if (index === 0) edges.push(bezierEdge(`track-entry:${clipId}`, centerId, anchorId, false, "content-source"));
    const boardNode = hierarchy.byId.get(canonicalStoryboardId(board.id));
    if (!boardNode || boardNode.data.entityType !== "storyboard") return;
    const boardLocalPosition = { x: CANVAS_LAYOUT.shotsSidePadding + index * CANVAS_LAYOUT.shotColumnStep, y: contentY + 46 };
    nodes.push(asNode(boardNode.id, "StoryboardNode", visualPosition(nodes, centerId, boardLocalPosition), boardNode.data, undefined, 2, centerId));
    edges.push(bezierEdge(`shot-hang:${board.id}`, anchorId, boardNode.id));
    if (!expandedIds.has(boardNode.id)) return;
    const details = hierarchy.childrenById.get(boardNode.id) ?? [];
    let detailY = contentY + 212;
    for (const detailId of details) {
      const detail = hierarchy.byId.get(detailId);
      if (!detail) continue;
      nodes.push(asNode(detail.id, detail.type, visualPosition(nodes, centerId, { x: boardLocalPosition.x, y: detailY }), detail.data, undefined, 2, centerId));
      edges.push(bezierEdge(`shot-detail:${board.id}:${detail.id}`, boardNode.id, detail.id));
      detailY += shotDetailHeight(detail.data.entityType) + CANVAS_LAYOUT.shotDetailGap;
    }
  });
}

function addReleaseChain(nodes: Node<CanvasFlowNodeData>[], edges: Edge[], model: ProjectCanvasReadModel, clipId: string, outputs: CanvasConcatOutputRead[], boards: CanvasStoryboardRead[], expandedIds: ReadonlySet<string>, centerId: string): void {
  const shotPreviews: ReleaseShotPreview[] = boards.map((board) => {
    const selectedVideo = board.selected_video_id ? board.videos.find((video) => video.id === board.selected_video_id) : undefined;
    const video = selectedVideo ?? board.videos.find((candidate) => readModelVideoReady(board, candidate)) ?? board.videos[0];
    const batchIndex = video ? board.videos.findIndex((candidate) => candidate.id === video.id) + 1 : null;
    return {
      storyboardId: board.id,
      seqNum: board.seq_num,
      sbid: board.sbid,
      summary: board.summary || board.dialogue,
      videoPath: video?.file_path || null,
      videoCoverPath: video?.cover_path || null,
      videoDuration: video?.duration ?? board.video_duration,
      batchIndex,
      isReady: video ? readModelVideoReady(board, video) : false,
    };
  });
  const durationValues = shotPreviews.map((shot) => shot.videoDuration).filter((duration): duration is number => duration !== null && Number.isFinite(duration));
  const totalDuration = durationValues.length > 0 ? durationValues.reduce((total, duration) => total + duration, 0) : null;
  const readyShots = readyStoryboardCount(boards);
  const summaryId = releaseSummaryId(clipId);
  const contentY = CANVAS_LAYOUT.centerContentTop;
  const summary: ReleaseSummaryNodeData = {
    ...base(model.project.id, summaryId, canonicalClipId(clipId), "release-summary", clipId, "手动编排"),
    clipId, readyShots, totalShots: boards.length, shots: shotPreviews, totalDuration,
  };
  nodes.push(asNode(summaryId, "ReleaseSummaryNode", visualPosition(nodes, centerId, { x: CANVAS_LAYOUT.releaseContentX, y: contentY + 17 }), summary, undefined, 2, centerId));
  const current = outputs[0];
  const releaseId = current ? outputNodeId(current.id) : emptyReleaseId(clipId);
  const output: ReleaseOutputNodeData = current ? {
    ...base(model.project.id, releaseId, canonicalClipId(clipId), "release-output", current.id, current.file_name || "当前成片"), hasChildren: outputs.length > 1, clipId, fileName: current.file_name, filePath: current.output_path, coverPath: current.cover_path, duration: current.duration, segmentCount: current.segment_count, source: current.source, createdAt: current.created_at, audioIncluded: current.audio_included, isEmpty: false, isHistory: false,
  } : {
    ...base(model.project.id, releaseId, canonicalClipId(clipId), "release-output", clipId, "尚无成片"), clipId, fileName: null, filePath: null, coverPath: null, duration: null, segmentCount: 0, source: null, createdAt: null, audioIncluded: false, isEmpty: true, isHistory: false,
  };
  nodes.push(asNode(releaseId, "ReleaseOutputNode", visualPosition(nodes, centerId, { x: CANVAS_LAYOUT.releaseOutputX, y: contentY }), output, undefined, 2, centerId));
  edges.push(bezierEdge(`release:${clipId}:summary`, centerId, summaryId, false, "content-source"));
  edges.push(bezierEdge(`release:${clipId}:output`, summaryId, releaseId));
  if (!current || !expandedIds.has(releaseId)) return;
  outputs.slice(1).forEach((history, index) => {
    const id = outputNodeId(history.id);
    const historyData: ReleaseOutputNodeData = { ...base(model.project.id, id, releaseId, "release-output", history.id, history.file_name || "历史成片"), clipId, fileName: history.file_name, filePath: history.output_path, coverPath: history.cover_path, duration: history.duration, segmentCount: history.segment_count, source: history.source, createdAt: history.created_at, audioIncluded: history.audio_included, isEmpty: false, isHistory: true };
    nodes.push(asNode(id, "ReleaseOutputNode", visualPosition(nodes, centerId, { x: CANVAS_LAYOUT.releaseHistoryX, y: contentY + CANVAS_LAYOUT.releaseHistoryTop + index * (CANVAS_LAYOUT.releaseOutputHeight + CANVAS_LAYOUT.releaseHistoryGap) }), historyData, undefined, 2, centerId));
  });
}
