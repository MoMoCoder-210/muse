/**
 * Canonical read-only hierarchy plus per-episode three-center canvas projections.
 * No IPC or business mutation happens in this module.
 */
import { MarkerType, type Edge, type Node } from "reactflow";
import type { AssetType } from "../../types/project";
import type { CanvasAssetRead, CanvasConcatOutputRead, CanvasStoryboardRead, ProjectCanvasReadModel } from "../../services/tauri";
import { CANVAS_LAYOUT, createProductionRows } from "./layout";
import type {
  AssetNodeData, CanvasCenterKind, CanvasCenterNodeData, CanvasFlowNodeData, CanvasNodeBase, ClipNodeData,
  ImageNodeData, MaterialCategoryNodeData, ProjectNodeData, ReleaseOutputNodeData, ReleaseSummaryNodeData,
  ReleaseTaskNodeData, ShotAnchorNodeData, ShotTrackNodeData, StoryboardAssetReference, StoryboardNodeData,
  TaskNodeData, VideoNodeData,
} from "./node-data";

const encode = (value: string) => encodeURIComponent(value);
export const canonicalProjectId = (id: string) => `project:${encode(id)}`;
export const canonicalClipId = (id: string) => `clip:${encode(id)}`;
export const canonicalAssetId = (id: string) => `asset:${encode(id)}`;
export const canonicalStoryboardId = (id: string) => `storyboard:${encode(id)}`;
export const canonicalImageId = (id: string) => `image:${encode(id)}`;
export const canonicalVideoId = (id: string) => `video:${encode(id)}`;
export const canonicalTaskId = (id: string) => `task:${encode(id)}`;
export const canvasCenterId = (kind: CanvasCenterKind, clipId: string | null) => `center:${kind}:${clipId ? encode(clipId) : "shared"}`;
const materialCategoryId = (clipId: string | null, type: AssetType, projectId: string) => `material-category:${clipId ? encode(clipId) : `shared:${encode(projectId)}`}:${type}`;
const sharedCategoryId = (projectId: string, type: AssetType) => materialCategoryId(null, type, projectId);
const shotTrackId = (clipId: string) => `shot-track:${encode(clipId)}`;
const shotAnchorId = (storyboardId: string) => `shot-anchor:${encode(storyboardId)}`;
const releaseSummaryId = (clipId: string) => `release-summary:${encode(clipId)}`;
const releaseTaskId = (clipId: string) => `release-task:${encode(clipId)}`;
const emptyReleaseId = (clipId: string) => `release-empty:${encode(clipId)}`;
const outputNodeId = (outputId: string) => `output:${encode(outputId)}`;
const MATERIAL_TYPES: AssetType[] = ["character", "scene", "item"];

type HierarchyNode = { id: string; parentId: string | null; type: string; data: CanvasFlowNodeData; };
export interface CanvasHierarchy { projectId: string; rootId: string; byId: Map<string, HierarchyNode>; childrenById: Map<string, string[]>; }
export interface CanvasProjection { hierarchy: CanvasHierarchy; nodes: Node<CanvasFlowNodeData>[]; edges: Edge[]; }

function addNode(hierarchy: CanvasHierarchy, node: HierarchyNode): void {
  hierarchy.byId.set(node.id, node);
  if (!node.parentId) return;
  const children = hierarchy.childrenById.get(node.parentId) ?? [];
  children.push(node.id);
  hierarchy.childrenById.set(node.parentId, children);
}
function base<T extends CanvasNodeBase["entityType"]>(projectId: string, id: string, parentId: string | null, entityType: T, entityId: string, title: string, status?: string): Omit<CanvasNodeBase, "entityType"> & { entityType: T } {
  return { canonicalId: id, parentCanonicalId: parentId, projectId, entityId, entityType, title, hasChildren: false, status };
}
function assetReference(asset: CanvasAssetRead, ownerClipId: string, assetTag: string): StoryboardAssetReference {
  return { assetId: asset.id, type: asset.type, name: asset.name, assetTag, sourceScope: asset.clip_id === ownerClipId ? "owned" : asset.clip_id ? "clip" : "project-shared", sourceClipId: asset.clip_id };
}
function addAsset(hierarchy: CanvasHierarchy, asset: CanvasAssetRead, parentId: string): void {
  const id = canonicalAssetId(asset.id);
  addNode(hierarchy, { id, parentId, type: "AssetNode", data: {
    ...base(asset.project_id, id, parentId, "asset", asset.id, asset.name, asset.status), assetId: asset.id, type: asset.type, name: asset.name,
    description: asset.description, imageCount: asset.images.length, selectedImagePath: asset.selected_image_path,
    previewImages: asset.images.map((image) => ({ id: image.id, imagePath: image.image_path, size: image.size, isSelected: image.is_selected })),
    taskPreviews: asset.tasks.map((task) => ({ id: task.id, taskType: task.task_type, status: task.status, error: task.error_message })),
  } satisfies AssetNodeData });
  for (const image of asset.images) {
    const imageId = canonicalImageId(image.id);
    addNode(hierarchy, { id: imageId, parentId: id, type: "ImageNode", data: {
      ...base(asset.project_id, imageId, id, "image", image.id, asset.name), assetId: asset.id, assetName: asset.name, imagePath: image.image_path, size: image.size, isSelected: image.is_selected,
    } satisfies ImageNodeData });
  }
  for (const task of asset.tasks) {
    const taskId = canonicalTaskId(task.id);
    addNode(hierarchy, { id: taskId, parentId: id, type: "TaskNode", data: {
      ...base(asset.project_id, taskId, id, "task", task.id, "素材任务", task.status), taskKind: "asset", targetName: `${asset.name} · ${task.task_type}`, error: task.error_message,
    } satisfies TaskNodeData });
  }
}
function addStoryboard(hierarchy: CanvasHierarchy, storyboard: CanvasStoryboardRead, parentId: string, assetsById: Map<string, CanvasAssetRead>): void {
  const id = canonicalStoryboardId(storyboard.id);
  const references = storyboard.asset_references.map((reference) => {
    const asset = assetsById.get(reference.asset_id);
    return asset ? assetReference(asset, storyboard.clip_id, reference.asset_tag) : null;
  }).filter((reference): reference is StoryboardAssetReference => reference !== null);
  addNode(hierarchy, { id, parentId, type: "StoryboardNode", data: {
    ...base(storyboard.project_id, id, parentId, "storyboard", storyboard.id, storyboard.sbid, storyboard.video_state), storyboardId: storyboard.id,
    sbid: storyboard.sbid, seqNum: storyboard.seq_num, summary: storyboard.summary, dialogue: storyboard.dialogue, duration: storyboard.video_duration, assetReferences: references,
  } satisfies StoryboardNodeData });
  for (const task of storyboard.video_tasks) {
    const taskId = canonicalTaskId(task.id);
    addNode(hierarchy, { id: taskId, parentId: id, type: "TaskNode", data: {
      ...base(storyboard.project_id, taskId, id, "task", task.id, "视频生成", task.status), taskKind: "video-generation", targetName: `${storyboard.sbid} · 镜头 ${storyboard.seq_num}`, error: task.error_message,
    } satisfies TaskNodeData });
  }
  const upscaleByVideoId = new Map(storyboard.upscale_tasks.map((task) => [task.video_id, task]));
  for (const video of storyboard.videos) {
    const upscale = upscaleByVideoId.get(video.id);
    if (video.source === "upscale" && !upscale) continue;
    const videoId = canonicalVideoId(video.id);
    addNode(hierarchy, { id: videoId, parentId: id, type: "VideoNode", data: {
      ...base(storyboard.project_id, videoId, id, "video", video.id, video.file_name || "镜头视频"), storyboardId: storyboard.id,
      filePath: video.file_path, fileName: video.file_name, duration: video.duration, source: video.source, isUpscaleOutput: Boolean(upscale), isOutputReady: !upscale || upscale.status === "done",
    } satisfies VideoNodeData });
  }
}

/** Semantic owner hierarchy used by expansion and disclosure, not the visual canvas layout. */
export function createCanvasHierarchy(model: ProjectCanvasReadModel): CanvasHierarchy {
  const rootId = canonicalProjectId(model.project.id);
  const hierarchy: CanvasHierarchy = { projectId: model.project.id, rootId, byId: new Map(), childrenById: new Map() };
  addNode(hierarchy, { id: rootId, parentId: null, type: "ProjectNode", data: {
    ...base(model.project.id, rootId, null, "project", model.project.id, model.project.name, model.project.status), name: model.project.name, description: model.project.description, clipCount: model.clips.length,
  } satisfies ProjectNodeData });
  const assetsById = new Map(model.assets.map((asset) => [asset.id, asset]));
  for (const type of MATERIAL_TYPES) {
    const id = sharedCategoryId(model.project.id, type);
    const items = model.assets.filter((asset) => asset.clip_id === null && asset.type === type);
    addNode(hierarchy, { id, parentId: rootId, type: "MaterialCategoryNode", data: {
      ...base(model.project.id, id, rootId, "material-category", id, "项目共享素材"), clipId: null, category: type, itemCount: items.length, expansionId: id,
    } satisfies MaterialCategoryNodeData });
    for (const asset of items) addAsset(hierarchy, asset, id);
  }
  const boardsByClip = new Map<string, CanvasStoryboardRead[]>();
  for (const storyboard of model.storyboards) {
    const list = boardsByClip.get(storyboard.clip_id) ?? [];
    list.push(storyboard); boardsByClip.set(storyboard.clip_id, list);
  }
  for (const clip of model.clips) {
    const clipId = canonicalClipId(clip.id);
    const owned = model.assets.filter((asset) => asset.clip_id === clip.id);
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
  if (model.assets.some((asset) => asset.clip_id === null)) expanded.add(canvasCenterId("materials", null));
  for (const node of hierarchy.byId.values()) if (node.data.hasChildren) expanded.add(node.id);
  for (const output of model.concat_outputs ?? []) expanded.add(outputNodeId(output.id));
  return expanded;
}

/** Keeps the full production context visible while a queued or running Agent task is active. */
export function agentExecutingCanvasExpandedIds(model: ProjectCanvasReadModel): Set<string> {
  const hasActiveTask = model.assets.some((asset) => asset.tasks.some((task) => task.status === "queued" || task.status === "running"))
    || model.storyboards.some((storyboard) => storyboard.video_tasks.some((task) => task.status === "queued" || task.status === "running")
      || storyboard.upscale_tasks.some((task) => task.status === "queued" || task.status === "running"));
  return hasActiveTask ? defaultCanvasExpandedIds(model) : new Set<string>();
}

function readyStoryboardCount(boards: readonly CanvasStoryboardRead[]): number {
  return boards.filter((storyboard) => {
    if (storyboard.selected_video_id) return storyboard.videos.some((video) => video.id === storyboard.selected_video_id);
    return storyboard.videos.some((video) => video.source !== "upscale" || storyboard.upscale_tasks.some((task) => task.video_id === video.id && task.status === "done"));
  }).length;
}
function asNode<T extends CanvasFlowNodeData>(id: string, type: string, position: { x: number; y: number }, data: T, style?: Node["style"], zIndex = 2): Node<CanvasFlowNodeData> {
  return { id, type, position, data, style, zIndex };
}
function bezierEdge(id: string, source: string, target: string, external = false, sourceHandle = "source"): Edge {
  return {
    id, source, target, sourceHandle, targetHandle: "target", type: "bezier",
    markerEnd: external ? { type: MarkerType.ArrowClosed, color: "rgba(136, 177, 206, .76)", width: 13, height: 13 } : undefined,
    style: external ? { stroke: "rgba(136, 177, 206, .66)", strokeWidth: 1.7 } : { stroke: "rgba(119, 151, 173, .48)", strokeWidth: 1.25 },
    className: external ? "cn-edge cn-edge--production" : "cn-edge cn-edge--local",
  };
}
const MATERIAL_CATEGORY_MIN_WIDTH = 280;
const MATERIAL_CATEGORY_MIN_HEIGHT = 96;
const MATERIAL_CATEGORY_GAP = 18;
type CanvasPositionOverride = { x: number; y: number };
type MaterialCategoryLayout = { width: number; height: number; assetPositions: Map<string, CanvasPositionOverride>; };
function materialAssetSize(_asset: CanvasAssetRead, _expandedIds: ReadonlySet<string>): { width: number; height: number } {
  return { width: 252, height: 152 };
}
function createMaterialCategoryLayout(assets: readonly CanvasAssetRead[], categoryOpen: boolean, expandedIds: ReadonlySet<string>, positionOverrides: Readonly<Record<string, CanvasPositionOverride>>): MaterialCategoryLayout {
  if (!categoryOpen) return { width: MATERIAL_CATEGORY_MIN_WIDTH, height: 38, assetPositions: new Map() };
  const assetPositions = new Map<string, CanvasPositionOverride>();
  let cursorY = 48;
  let width = MATERIAL_CATEGORY_MIN_WIDTH;
  let height = MATERIAL_CATEGORY_MIN_HEIGHT;
  for (const asset of assets) {
    const id = canonicalAssetId(asset.id);
    const size = materialAssetSize(asset, expandedIds);
    const saved = positionOverrides[id];
    const position = { x: Math.max(12, saved?.x ?? 12), y: Math.max(48, saved?.y ?? cursorY) };
    assetPositions.set(id, position);
    width = Math.max(width, position.x + size.width + 12);
    height = Math.max(height, position.y + size.height + 12);
    cursorY += size.height + 12;
  }
  return { width, height, assetPositions };
}
function materialLaneWidth(layouts: readonly MaterialCategoryLayout[]): number {
  return layouts.reduce((width, layout, index) => width + layout.width + (index ? MATERIAL_CATEGORY_GAP : 0), 0);
}

/** Build independent material, shot, and release centers for every clip. */
export function buildCanvas(model: ProjectCanvasReadModel, expandedIds: ReadonlySet<string>, positionOverrides: Readonly<Record<string, CanvasPositionOverride>> = {}): CanvasProjection {
  const hierarchy = createCanvasHierarchy(model);
  const nodes: Node<CanvasFlowNodeData>[] = [];
  const edges: Edge[] = [];
  const boardsByClip = new Map<string, CanvasStoryboardRead[]>();
  const outputsByClip = new Map<string, CanvasConcatOutputRead[]>();
  for (const storyboard of model.storyboards) { const list = boardsByClip.get(storyboard.clip_id) ?? []; list.push(storyboard); boardsByClip.set(storyboard.clip_id, list); }
  for (const output of model.concat_outputs ?? []) { const list = outputsByClip.get(output.clip_id) ?? []; list.push(output); outputsByClip.set(output.clip_id, list); }
  for (const list of boardsByClip.values()) list.sort((left, right) => left.seq_num - right.seq_num || left.id.localeCompare(right.id));
  for (const list of outputsByClip.values()) list.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));

  const sharedAssets = model.assets.filter((asset) => asset.clip_id === null);
  const sharedLayouts = MATERIAL_TYPES.map((type) => createMaterialCategoryLayout(
    sharedAssets.filter((asset) => asset.type === type), expandedIds.has(sharedCategoryId(model.project.id, type)), expandedIds, positionOverrides,
  ));
  const clipLayouts = new Map<string, MaterialCategoryLayout[]>();
  for (const clip of model.clips) {
    const owned = model.assets.filter((asset) => asset.clip_id === clip.id);
    clipLayouts.set(clip.id, MATERIAL_TYPES.map((type) => createMaterialCategoryLayout(
      owned.filter((asset) => asset.type === type), expandedIds.has(materialCategoryId(clip.id, type, model.project.id)), expandedIds, positionOverrides,
    )));
  }

  const materialLaneWidths = model.clips.map((clip) => materialLaneWidth(clipLayouts.get(clip.id) ?? []));
  if (sharedAssets.length > 0) materialLaneWidths.push(materialLaneWidth(sharedLayouts));
  const materialWidth = Math.max(CANVAS_LAYOUT.materialWidth, Math.max(...materialLaneWidths, 0) + 36);
  const maxStoryboardCount = Math.max(0, ...[...boardsByClip.values()].map((boards) => boards.length));
  const shotsWidth = Math.max(CANVAS_LAYOUT.shotsWidth, 403 + Math.max(0, maxStoryboardCount - 1) * 282);
  const shotsX = CANVAS_LAYOUT.materialX + materialWidth + 40;
  const releaseX = shotsX + shotsWidth + 40;
  const centerOpen = (kind: CanvasCenterKind, clipId: string | null) => expandedIds.has(canvasCenterId(kind, clipId));

  const rowHeights = new Map<string, number>();
  for (const clip of model.clips) {
    const layouts = clipLayouts.get(clip.id) ?? [];
    const materialHeight = centerOpen("materials", clip.id) ? Math.max(120, ...layouts.map((layout) => layout.height + 58)) : 62;
    const boards = boardsByClip.get(clip.id) ?? [];
    const hasBoardDetails = boards.some((board) => expandedIds.has(canonicalStoryboardId(board.id)));
    const shotsHeight = centerOpen("shots", clip.id) ? hasBoardDetails ? 374 : 272 : 62;
    const outputs = outputsByClip.get(clip.id) ?? [];
    const hasOutputHistory = outputs.length > 1 && expandedIds.has(outputNodeId(outputs[0].id));
    const releaseHeight = centerOpen("release", clip.id) ? hasOutputHistory ? 278 : 174 : 62;
    rowHeights.set(clip.id, Math.max(materialHeight, shotsHeight, releaseHeight));
  }
  const rows = createProductionRows(model.clips, rowHeights);
  const clipBottom = [...rows.values()].reduce<number>((bottom, row) => Math.max(bottom, row.y + row.height), CANVAS_LAYOUT.top);
  const sharedHeight = sharedAssets.length > 0 ? Math.max(120, ...sharedLayouts.map((layout) => layout.height + 58)) : 0;
  const sharedY = model.clips.length > 0 ? clipBottom + CANVAS_LAYOUT.rowGap : CANVAS_LAYOUT.top;

  const centerData = (kind: CanvasCenterKind, clipId: string | null, title: string, itemCount: number, width: number, height: number, parentId: string | null): CanvasCenterNodeData => {
    const id = canvasCenterId(kind, clipId);
    return { ...base(model.project.id, id, parentId, "center", clipId ? `${clipId}:${kind}` : kind, title), centerKind: kind, clipId, itemCount, width, height };
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
    const owned = model.assets.filter((asset) => asset.clip_id === clip.id);
    const boards = boardsByClip.get(clip.id) ?? [];
    const outputs = outputsByClip.get(clip.id) ?? [];

    nodes.push(
      asNode(clipData.canonicalId, "ClipNode", { x: CANVAS_LAYOUT.clipX, y: row.y + 6 }, clipData),
      asNode(materialCenter, "CanvasCenterNode", { x: CANVAS_LAYOUT.materialX, y: row.y }, centerData("materials", clip.id, "素材中心", owned.length, materialWidth, row.height, clipParentId), { width: materialWidth, height: row.height }, 0),
      asNode(shotsCenter, "CanvasCenterNode", { x: shotsX, y: row.y }, centerData("shots", clip.id, "镜头中心", boards.length, shotsWidth, row.height, clipParentId), { width: shotsWidth, height: row.height }, 0),
      asNode(releaseCenter, "CanvasCenterNode", { x: releaseX, y: row.y }, centerData("release", clip.id, "成片中心", outputs.length, CANVAS_LAYOUT.releaseWidth, row.height, clipParentId), { width: CANVAS_LAYOUT.releaseWidth, height: row.height }, 0),
    );
    edges.push(bezierEdge(`production:${clip.id}:shots`, materialCenter, shotsCenter, true));
    edges.push(bezierEdge(`production:${clip.id}:release`, shotsCenter, releaseCenter, true));

    if (centerOpen("materials", clip.id)) {
      let categoryX = CANVAS_LAYOUT.materialX + 18;
      const layouts = clipLayouts.get(clip.id) ?? [];
      for (const [index, type] of MATERIAL_TYPES.entries()) {
        const categoryId = materialCategoryId(clip.id, type, model.project.id);
        const categoryAssets = owned.filter((asset) => asset.type === type);
        const categoryOpen = expandedIds.has(categoryId);
        const layout = layouts[index];
        const data: MaterialCategoryNodeData = { ...base(model.project.id, categoryId, clipParentId, "material-category", categoryId, type), clipId: clip.id, category: type, itemCount: categoryAssets.length, expansionId: categoryId, hasChildren: categoryAssets.length > 0 };
        nodes.push(asNode(categoryId, "MaterialCategoryNode", { x: categoryX, y: row.y + 58 }, data, { width: layout.width, height: layout.height }, 1));
        edges.push(bezierEdge(`material-entry:${clip.id}:${type}`, materialCenter, categoryId, false, "content-source"));
        if (categoryOpen) addMaterialAssets(nodes, edges, hierarchy, categoryId, categoryAssets, categoryX, row.y + 58, expandedIds, layout);
        categoryX += layout.width + MATERIAL_CATEGORY_GAP;
      }
    }
    if (centerOpen("shots", clip.id)) addShotTrack(nodes, edges, hierarchy, model, clip.id, boards, row.y + 58, expandedIds, shotsCenter, shotsX);
    if (centerOpen("release", clip.id)) addReleaseChain(nodes, edges, model, clip.id, outputs, boards, row.y + 58, expandedIds, releaseCenter, releaseX);
  }

  if (sharedAssets.length > 0) {
    const sharedCenter = canvasCenterId("materials", null);
    nodes.push(asNode(sharedCenter, "CanvasCenterNode", { x: CANVAS_LAYOUT.materialX, y: sharedY }, centerData("materials", null, "共享素材", sharedAssets.length, materialWidth, sharedHeight, canonicalProjectId(model.project.id)), { width: materialWidth, height: sharedHeight }, 0));
    if (centerOpen("materials", null)) {
      let categoryX = CANVAS_LAYOUT.materialX + 18;
      for (const [index, type] of MATERIAL_TYPES.entries()) {
        const categoryId = sharedCategoryId(model.project.id, type);
        const categoryAssets = sharedAssets.filter((asset) => asset.type === type);
        const categoryOpen = expandedIds.has(categoryId);
        const layout = sharedLayouts[index];
        const categoryData: MaterialCategoryNodeData = { ...base(model.project.id, categoryId, canonicalProjectId(model.project.id), "material-category", categoryId, "项目共享 · " + type), clipId: null, category: type, itemCount: categoryAssets.length, expansionId: categoryId, hasChildren: categoryAssets.length > 0 };
        nodes.push(asNode(categoryId, "MaterialCategoryNode", { x: categoryX, y: sharedY + 58 }, categoryData, { width: layout.width, height: layout.height }, 1));
        edges.push(bezierEdge(`material-entry:shared:${type}`, sharedCenter, categoryId, false, "content-source"));
        if (categoryOpen) addMaterialAssets(nodes, edges, hierarchy, categoryId, categoryAssets, categoryX, sharedY + 58, expandedIds, layout);
        categoryX += layout.width + MATERIAL_CATEGORY_GAP;
      }
    }
  }
  return { hierarchy, nodes, edges };
}

function addMaterialAssets(nodes: Node<CanvasFlowNodeData>[], edges: Edge[], hierarchy: CanvasHierarchy, categoryId: string, assets: readonly CanvasAssetRead[], categoryX: number, categoryY: number, _expandedIds: ReadonlySet<string>, layout: MaterialCategoryLayout): void {
  for (const asset of assets) {
    const semantic = hierarchy.byId.get(canonicalAssetId(asset.id));
    const position = layout.assetPositions.get(semantic?.id ?? "");
    if (!semantic || semantic.data.entityType !== "asset" || !position) continue;
    nodes.push(asNode(semantic.id, "AssetNode", { x: categoryX + position.x, y: categoryY + position.y }, semantic.data, { width: 252 }));
    edges.push(bezierEdge(`material-detail:${categoryId}:${semantic.id}`, categoryId, semantic.id, false, "asset-source"));
  }
}
function addShotTrack(nodes: Node<CanvasFlowNodeData>[], edges: Edge[], hierarchy: CanvasHierarchy, model: ProjectCanvasReadModel, clipId: string, boards: CanvasStoryboardRead[], contentY: number, expandedIds: ReadonlySet<string>, centerId: string, shotsX: number): void {
  const trackId = shotTrackId(clipId);
  const trackWidth = Math.max(CANVAS_LAYOUT.shotTrackWidth, 185 + Math.max(0, boards.length - 1) * 282);
  const trackData: ShotTrackNodeData = { ...base(model.project.id, trackId, canonicalClipId(clipId), "shot-track", clipId, "镜头轨"), clipId, shotCount: boards.length, width: trackWidth };
  nodes.push(asNode(trackId, "ShotTrackNode", { x: shotsX + CANVAS_LAYOUT.shotTrackX, y: contentY + 12 }, trackData, { width: trackWidth }, 1));
  boards.forEach((board, index) => {
    const anchorId = shotAnchorId(board.id);
    const anchorData: ShotAnchorNodeData = { ...base(model.project.id, anchorId, canonicalStoryboardId(board.id), "shot-anchor", board.id, `镜头 ${board.seq_num}`, board.video_state), clipId, storyboardId: board.id, seqNum: board.seq_num };
    const x = shotsX + 261 + index * 282;
    nodes.push(asNode(anchorId, "ShotAnchorNode", { x, y: contentY }, anchorData, undefined, 3));
    if (index === 0) edges.push(bezierEdge(`track-entry:${clipId}`, centerId, anchorId, false, "content-source"));
    const boardNode = hierarchy.byId.get(canonicalStoryboardId(board.id));
    if (!boardNode || boardNode.data.entityType !== "storyboard") return;
    nodes.push(asNode(boardNode.id, "StoryboardNode", { x: shotsX + 145 + index * 282, y: contentY + 46 }, boardNode.data));
    edges.push(bezierEdge(`shot-hang:${board.id}`, anchorId, boardNode.id));
    if (!expandedIds.has(boardNode.id)) return;
    const details = hierarchy.childrenById.get(boardNode.id) ?? [];
    let detailY = contentY + 212;
    for (const detailId of details) {
      const detail = hierarchy.byId.get(detailId);
      if (!detail) continue;
      nodes.push(asNode(detail.id, detail.type, { x: shotsX + 145 + index * 282, y: detailY }, detail.data));
      edges.push(bezierEdge(`shot-detail:${board.id}:${detail.id}`, boardNode.id, detail.id));
      const isReadyVideo = detail.data.entityType === "video" && detail.data.filePath && (!detail.data.isUpscaleOutput || detail.data.isOutputReady);
      detailY += (isReadyVideo ? 134 : 58) + 8;
    }
  });
}
function addReleaseChain(nodes: Node<CanvasFlowNodeData>[], edges: Edge[], model: ProjectCanvasReadModel, clipId: string, outputs: CanvasConcatOutputRead[], boards: CanvasStoryboardRead[], contentY: number, expandedIds: ReadonlySet<string>, centerId: string, releaseX: number): void {
  const readyShots = readyStoryboardCount(boards);
  const summaryId = releaseSummaryId(clipId);
  const taskId = releaseTaskId(clipId);
  const summary: ReleaseSummaryNodeData = { ...base(model.project.id, summaryId, canonicalClipId(clipId), "release-summary", clipId, "镜头就绪汇总"), clipId, readyShots, totalShots: boards.length };
  const task: ReleaseTaskNodeData = { ...base(model.project.id, taskId, canonicalClipId(clipId), "release-task", clipId, readyShots === boards.length && boards.length > 0 ? "等待合成" : "等待镜头"), clipId, readyShots, totalShots: boards.length, status: readyShots === boards.length && boards.length > 0 ? "ready" : "pending" };
  nodes.push(asNode(summaryId, "ReleaseSummaryNode", { x: releaseX + 136, y: contentY + 17 }, summary));
  nodes.push(asNode(taskId, "ReleaseTaskNode", { x: releaseX + 252, y: contentY + 17 }, task));
  const current = outputs[0];
  const releaseId = current ? outputNodeId(current.id) : emptyReleaseId(clipId);
  const output: ReleaseOutputNodeData = current ? {
    ...base(model.project.id, releaseId, canonicalClipId(clipId), "release-output", current.id, current.file_name || "当前成片"), clipId, fileName: current.file_name, filePath: current.output_path, duration: current.duration, segmentCount: current.segment_count, source: current.source, isEmpty: false,
  } : {
    ...base(model.project.id, releaseId, canonicalClipId(clipId), "release-output", clipId, "尚无成片"), clipId, fileName: null, filePath: null, duration: null, segmentCount: 0, source: null, isEmpty: true,
  };
  nodes.push(asNode(releaseId, "ReleaseOutputNode", { x: releaseX + 364, y: contentY }, output));
  edges.push(bezierEdge(`release:${clipId}:summary`, centerId, summaryId, false, "content-source"));
  edges.push(bezierEdge(`release:${clipId}:task`, summaryId, taskId));
  edges.push(bezierEdge(`release:${clipId}:output`, taskId, releaseId));
  if (!current || !expandedIds.has(releaseId)) return;
  outputs.slice(1).forEach((history, index) => {
    const id = outputNodeId(history.id);
    const historyData: ReleaseOutputNodeData = { ...base(model.project.id, id, releaseId, "release-output", history.id, history.file_name || "历史成片"), clipId, fileName: history.file_name, filePath: history.output_path, duration: history.duration, segmentCount: history.segment_count, source: history.source, isEmpty: false };
    nodes.push(asNode(id, "ReleaseOutputNode", { x: releaseX + 388, y: contentY + 110 + index * 58 }, historyData));
  });
}
