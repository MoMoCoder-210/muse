/**
 * Canonical read-only hierarchy plus the three-center production-canvas projection.
 * No IPC or business mutation happens in this module.
 */
import { MarkerType, type Edge, type Node } from "reactflow";
import type { AssetType } from "../../types/project";
import type { CanvasAssetRead, CanvasConcatOutputRead, CanvasStoryboardRead, ProjectCanvasReadModel } from "../../services/tauri";
import { CANVAS_LAYOUT, createProductionRows } from "./layout";
import type {
  AssetNodeData, CanvasCenterKind, CanvasCenterNodeData, CanvasFlowNodeData, CanvasNodeBase, ClipNodeData,
  EpisodeEntryNodeData, ImageNodeData, MaterialCategoryNodeData, ProjectNodeData, ReleaseOutputNodeData,
  ReleaseSummaryNodeData, ReleaseTaskNodeData, ShotAnchorNodeData, ShotTrackNodeData, StoryboardAssetReference,
  StoryboardNodeData, TaskNodeData, VideoNodeData,
} from "./node-data";

const encode = (value: string) => encodeURIComponent(value);
export const canonicalProjectId = (id: string) => `project:${encode(id)}`;
export const canonicalClipId = (id: string) => `clip:${encode(id)}`;
export const canonicalAssetId = (id: string) => `asset:${encode(id)}`;
export const canonicalStoryboardId = (id: string) => `storyboard:${encode(id)}`;
export const canonicalImageId = (id: string) => `image:${encode(id)}`;
export const canonicalVideoId = (id: string) => `video:${encode(id)}`;
export const canonicalTaskId = (id: string) => `task:${encode(id)}`;
export const canvasCenterId = (kind: CanvasCenterKind) => `center:${kind}`;
export const episodeExpansionId = (clipId: string) => `episode:${encode(clipId)}`;
const materialCategoryId = (clipId: string | null, type: AssetType, projectId: string) => `material-category:${clipId ? encode(clipId) : `shared:${encode(projectId)}`}:${type}`;
const sharedCategoryId = (projectId: string, type: AssetType) => materialCategoryId(null, type, projectId);
const episodeEntryId = (kind: CanvasCenterKind, clipId: string) => `entry:${kind}:${encode(clipId)}`;
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
  for (const task of storyboard.upscale_tasks) {
    const taskId = canonicalTaskId(task.id);
    addNode(hierarchy, { id: taskId, parentId: id, type: "TaskNode", data: {
      ...base(storyboard.project_id, taskId, id, "task", task.id, "视频超分", task.status), taskKind: "upscale", targetName: `${storyboard.sbid} · 超分输出`, model: task.model, scale: task.scale, error: task.error_message,
    } satisfies TaskNodeData });
  }
  for (const video of storyboard.videos) {
    const upscale = upscaleByVideoId.get(video.id);
    if (video.source === "upscale" && !upscale) continue;
    const parent = id;
    const videoId = canonicalVideoId(video.id);
    addNode(hierarchy, { id: videoId, parentId: parent, type: "VideoNode", data: {
      ...base(storyboard.project_id, videoId, parent, "video", video.id, video.file_name || "镜头视频"), storyboardId: storyboard.id,
      filePath: video.file_path, fileName: video.file_name, duration: video.duration, source: video.source, isUpscaleOutput: Boolean(upscale), isOutputReady: !upscale || upscale.status === "done",
    } satisfies VideoNodeData });
  }
}

/** Semantic owner hierarchy used by expansion and disclosure, not the old visual tree. */
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
    const episodeId = episodeExpansionId(clip.id);
    const owned = model.assets.filter((asset) => asset.clip_id === clip.id);
    const boards = boardsByClip.get(clip.id) ?? [];
    addNode(hierarchy, { id: clipId, parentId: rootId, type: "ClipNode", data: {
      ...base(model.project.id, clipId, rootId, "clip", clip.id, clip.title, clip.status), summary: clip.summary, assetCount: owned.length, storyboardCount: boards.length, estimatedDuration: clip.estimated_duration, expansionId: episodeId,
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
  const expanded = new Set<string>([canvasCenterId("materials"), canvasCenterId("shots"), canvasCenterId("release")]);
  for (const node of hierarchy.byId.values()) {
    if (node.data.hasChildren) expanded.add(node.id);
    if (node.data.entityType === "clip") expanded.add(episodeExpansionId(node.data.entityId));
  }
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
function bezierEdge(id: string, source: string, target: string, external = false): Edge {
  return {
    id, source, target, sourceHandle: "source", targetHandle: "target", type: "bezier",
    markerEnd: external ? { type: MarkerType.ArrowClosed, color: "rgba(136, 177, 206, .76)", width: 13, height: 13 } : undefined,
    style: external ? { stroke: "rgba(136, 177, 206, .66)", strokeWidth: 1.7 } : { stroke: "rgba(119, 151, 173, .48)", strokeWidth: 1.25 },
    className: external ? "cn-edge cn-edge--production" : "cn-edge cn-edge--local",
  };
}
const MATERIAL_CATEGORY_MIN_WIDTH = 280;
const MATERIAL_CATEGORY_MIN_HEIGHT = 96;
const MATERIAL_CATEGORY_GAP = 18;
const MATERIAL_CATEGORY_CONTENT_X = 144;
type CanvasPositionOverride = { x: number; y: number };
type MaterialCategoryLayout = { width: number; height: number; assetPositions: Map<string, CanvasPositionOverride>; };
function materialAssetSize(asset: CanvasAssetRead, expandedIds: ReadonlySet<string>): { width: number; height: number } {
  return expandedIds.has(canonicalAssetId(asset.id)) ? { width: 320, height: 190 } : { width: 146, height: 64 };
}
function createMaterialCategoryLayout(assets: readonly CanvasAssetRead[], categoryOpen: boolean, expandedIds: ReadonlySet<string>, positionOverrides: Readonly<Record<string, CanvasPositionOverride>>): MaterialCategoryLayout {
  if (!categoryOpen) return { width: MATERIAL_CATEGORY_MIN_WIDTH, height: 38, assetPositions: new Map() };
  const assetPositions = new Map<string, CanvasPositionOverride>();
  let cursorX = 12;
  let width = MATERIAL_CATEGORY_MIN_WIDTH;
  let height = MATERIAL_CATEGORY_MIN_HEIGHT;
  for (const asset of assets) {
    const id = canonicalAssetId(asset.id);
    const size = materialAssetSize(asset, expandedIds);
    const saved = positionOverrides[id];
    const position = { x: Math.max(12, saved?.x ?? cursorX), y: Math.max(48, saved?.y ?? 48) };
    assetPositions.set(id, position);
    width = Math.max(width, position.x + size.width + 12);
    height = Math.max(height, position.y + size.height + 12);
    cursorX += size.width + 12;
  }
  return { width, height, assetPositions };
}
function materialLaneWidth(layouts: readonly MaterialCategoryLayout[]): number {
  return layouts.reduce((width, layout, index) => width + layout.width + (index ? MATERIAL_CATEGORY_GAP : 0), 0);
}

/** Build the visual three-center production line from the one project read snapshot. */
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
  const maxStoryboardCount = Math.max(0, ...[...boardsByClip.values()].map((boards) => boards.length));
  const shotsWidth = Math.max(CANVAS_LAYOUT.shotsWidth, 403 + Math.max(0, maxStoryboardCount - 1) * 282);

  const materialOpen = expandedIds.has(canvasCenterId("materials"));
  const shotsOpen = expandedIds.has(canvasCenterId("shots"));
  const releaseOpen = expandedIds.has(canvasCenterId("release"));
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
  const materialLaneWidths = [materialLaneWidth(sharedLayouts), ...model.clips.map((clip) => materialLaneWidth(clipLayouts.get(clip.id) ?? []))];
  const materialWidth = Math.max(CANVAS_LAYOUT.materialWidth, MATERIAL_CATEGORY_CONTENT_X + Math.max(...materialLaneWidths, 0) + 18);
  const shotsX = CANVAS_LAYOUT.materialX + materialWidth + 40;
  const releaseX = shotsX + shotsWidth + 40;
  const sharedHeight = materialOpen ? Math.max(...sharedLayouts.map((layout) => layout.height), 0) + 28 : 0;
  const rowHeights = new Map<string, number>();
  for (const clip of model.clips) {
    const rowOpen = expandedIds.has(episodeExpansionId(clip.id));
    if (!rowOpen) { rowHeights.set(clip.id, 112); continue; }
    const materialHeight = Math.max(...(clipLayouts.get(clip.id) ?? []).map((layout) => layout.height), 0) + 100;
    const boards = boardsByClip.get(clip.id) ?? [];
    const boardDetails = boards.some((board) => expandedIds.has(canonicalStoryboardId(board.id)));
    const release = outputsByClip.get(clip.id) ?? [];
    const releaseHeight = release.length > 1 && expandedIds.has(outputNodeId(release[0].id)) ? 250 : 162;
    rowHeights.set(clip.id, Math.max(materialHeight, boardDetails ? 350 : 250, releaseHeight));
  }
  const rowStart = CANVAS_LAYOUT.top + sharedHeight;
  const rows = createProductionRows(model.clips, rowHeights, rowStart);
  const totalHeight = Math.max(420, [...rows.values()].reduce((max, row) => Math.max(max, row.y + row.height + 24), rowStart + 96));

  const centerData = (kind: CanvasCenterKind, title: string, itemCount: number, width: number): CanvasCenterNodeData => ({
    ...base(model.project.id, canvasCenterId(kind), null, "center", kind, title), centerKind: kind, itemCount, width, height: totalHeight,
  });
  nodes.push(
    asNode(canvasCenterId("materials"), "CanvasCenterNode", { x: CANVAS_LAYOUT.materialX, y: 16 }, centerData("materials", "素材中心", model.assets.length, materialWidth), { width: materialWidth, height: totalHeight }, 0),
    asNode(canvasCenterId("shots"), "CanvasCenterNode", { x: shotsX, y: 16 }, centerData("shots", "镜头中心", model.storyboards.length, shotsWidth), { width: shotsWidth, height: totalHeight }, 0),
    asNode(canvasCenterId("release"), "CanvasCenterNode", { x: releaseX, y: 16 }, centerData("release", "成片中心", model.concat_outputs?.length ?? 0, CANVAS_LAYOUT.releaseWidth), { width: CANVAS_LAYOUT.releaseWidth, height: totalHeight }, 0),
  );

  if (materialOpen) {
    let x = CANVAS_LAYOUT.materialX + 18;
    for (const [index, type] of MATERIAL_TYPES.entries()) {
      const categoryId = sharedCategoryId(model.project.id, type);
      const categoryAssets = sharedAssets.filter((asset) => asset.type === type);
      const categoryOpen = expandedIds.has(categoryId);
      const layout = sharedLayouts[index];
      const categoryData: MaterialCategoryNodeData = { ...base(model.project.id, categoryId, canonicalProjectId(model.project.id), "material-category", categoryId, "项目共享 · " + type), clipId: null, category: type, itemCount: categoryAssets.length, expansionId: categoryId, hasChildren: categoryAssets.length > 0 };
      nodes.push(asNode(categoryId, "MaterialCategoryNode", { x, y: 58 }, categoryData, { width: layout.width, height: layout.height }, 1));
      if (categoryOpen) addMaterialAssets(nodes, hierarchy, categoryAssets, x, 58, expandedIds, layout);
      x += layout.width + MATERIAL_CATEGORY_GAP;
    }
  }

  for (const clip of model.clips) {
    const row = rows.get(clip.id);
    if (!row) continue;
    const semanticClip = hierarchy.byId.get(canonicalClipId(clip.id));
    if (!semanticClip || semanticClip.data.entityType !== "clip") continue;
    const clipData = semanticClip.data;
    nodes.push(asNode(clipData.canonicalId, "ClipNode", { x: CANVAS_LAYOUT.clipX, y: row.y + CANVAS_LAYOUT.entryY }, clipData));
    const rowOpen = expandedIds.has(episodeExpansionId(clip.id));
    const boards = boardsByClip.get(clip.id) ?? [];
    const owned = model.assets.filter((asset) => asset.clip_id === clip.id);
    const outputs = outputsByClip.get(clip.id) ?? [];
    const entryData = (kind: CanvasCenterKind, count: number, title: string): EpisodeEntryNodeData => ({
      ...base(model.project.id, episodeEntryId(kind, clip.id), canonicalClipId(clip.id), "episode-entry", clip.id, title, clip.status), centerKind: kind, clipId: clip.id,
      expansionId: episodeExpansionId(clip.id), summary: clip.summary, itemCount: count, detailOpen: rowOpen, hasChildren: true,
    });
    const materialEntry = episodeEntryId("materials", clip.id);
    const shotEntry = episodeEntryId("shots", clip.id);
    const releaseEntry = episodeEntryId("release", clip.id);
    if (materialOpen) nodes.push(asNode(materialEntry, "EpisodeEntryNode", { x: CANVAS_LAYOUT.materialX + 18, y: row.y + CANVAS_LAYOUT.entryY }, entryData("materials", owned.length, "素材区")));
    if (shotsOpen) nodes.push(asNode(shotEntry, "EpisodeEntryNode", { x: shotsX + 18, y: row.y + CANVAS_LAYOUT.entryY }, entryData("shots", boards.length, "镜头区")));
    if (releaseOpen) nodes.push(asNode(releaseEntry, "EpisodeEntryNode", { x: releaseX + 18, y: row.y + CANVAS_LAYOUT.entryY }, entryData("release", outputs.length, "成片区")));
    if (materialOpen && shotsOpen && releaseOpen) {
      edges.push(bezierEdge(`production:${clip.id}:material`, clipData.canonicalId, materialEntry, true));
      edges.push(bezierEdge(`production:${clip.id}:shots`, materialEntry, shotEntry, true));
      edges.push(bezierEdge(`production:${clip.id}:release`, shotEntry, releaseEntry, true));
    }
    if (!rowOpen) continue;

    if (materialOpen) {
      let categoryX = CANVAS_LAYOUT.materialX + MATERIAL_CATEGORY_CONTENT_X;
      const layouts = clipLayouts.get(clip.id) ?? [];
      for (const [index, type] of MATERIAL_TYPES.entries()) {
        const categoryId = materialCategoryId(clip.id, type, model.project.id);
        const categoryAssets = owned.filter((asset) => asset.type === type);
        const categoryOpen = expandedIds.has(categoryId);
        const layout = layouts[index];
        const data: MaterialCategoryNodeData = { ...base(model.project.id, categoryId, canonicalClipId(clip.id), "material-category", categoryId, type), clipId: clip.id, category: type, itemCount: categoryAssets.length, expansionId: categoryId, hasChildren: categoryAssets.length > 0 };
        nodes.push(asNode(categoryId, "MaterialCategoryNode", { x: categoryX, y: row.y + 72 }, data, { width: layout.width, height: layout.height }, 1));
        edges.push(bezierEdge(`material:${clip.id}:${type}`, materialEntry, categoryId));
        if (categoryOpen) addMaterialAssets(nodes, hierarchy, categoryAssets, categoryX, row.y + 72, expandedIds, layout);
        categoryX += layout.width + MATERIAL_CATEGORY_GAP;
      }
    }
    if (shotsOpen) addShotTrack(nodes, edges, hierarchy, model, clip.id, boards, row.y, expandedIds, shotEntry, shotsX);
    if (releaseOpen) addReleaseChain(nodes, edges, model, clip.id, outputs, boards, row.y, expandedIds, releaseEntry, releaseX);
  }
  return { hierarchy, nodes, edges };
}

function addMaterialAssets(nodes: Node<CanvasFlowNodeData>[], hierarchy: CanvasHierarchy, assets: readonly CanvasAssetRead[], categoryX: number, categoryY: number, expandedIds: ReadonlySet<string>, layout: MaterialCategoryLayout): void {
  for (const asset of assets) {
    const semantic = hierarchy.byId.get(canonicalAssetId(asset.id));
    const position = layout.assetPositions.get(semantic?.id ?? "");
    if (!semantic || semantic.data.entityType !== "asset" || !position) continue;
    const expanded = expandedIds.has(semantic.id);
    nodes.push(asNode(semantic.id, "AssetNode", { x: categoryX + position.x, y: categoryY + position.y }, semantic.data, expanded ? { width: 320 } : undefined));
  }
}
function addShotTrack(nodes: Node<CanvasFlowNodeData>[], edges: Edge[], hierarchy: CanvasHierarchy, model: ProjectCanvasReadModel, clipId: string, boards: CanvasStoryboardRead[], rowY: number, expandedIds: ReadonlySet<string>, entryId: string, shotsX: number): void {
  const trackId = shotTrackId(clipId);
  const trackWidth = Math.max(CANVAS_LAYOUT.shotTrackWidth, 185 + Math.max(0, boards.length - 1) * 282);
  const trackData: ShotTrackNodeData = { ...base(model.project.id, trackId, canonicalClipId(clipId), "shot-track", clipId, "镜头轨"), clipId, shotCount: boards.length, width: trackWidth };
  nodes.push(asNode(trackId, "ShotTrackNode", { x: shotsX + CANVAS_LAYOUT.shotTrackX, y: rowY + 70 }, trackData, { width: trackWidth }, 1));
  boards.forEach((board, index) => {
    const anchorId = shotAnchorId(board.id);
    const anchorData: ShotAnchorNodeData = { ...base(model.project.id, anchorId, canonicalStoryboardId(board.id), "shot-anchor", board.id, `镜头 ${board.seq_num}`, board.video_state), clipId, storyboardId: board.id, seqNum: board.seq_num };
    const x = shotsX + 261 + index * 282;
    nodes.push(asNode(anchorId, "ShotAnchorNode", { x, y: rowY + 58 }, anchorData, undefined, 3));
    if (index === 0) edges.push(bezierEdge(`track-entry:${clipId}`, entryId, anchorId));
    const boardNode = hierarchy.byId.get(canonicalStoryboardId(board.id));
    if (!boardNode || boardNode.data.entityType !== "storyboard") return;
    nodes.push(asNode(boardNode.id, "StoryboardNode", { x: shotsX + 145 + index * 282, y: rowY + 104 }, boardNode.data));
    edges.push(bezierEdge(`shot-hang:${board.id}`, anchorId, boardNode.id));
    if (!expandedIds.has(boardNode.id)) return;
    const details = hierarchy.childrenById.get(boardNode.id) ?? [];
    details.forEach((detailId, detailIndex) => {
      const detail = hierarchy.byId.get(detailId);
      if (!detail) return;
      nodes.push(asNode(detail.id, detail.type, { x: shotsX + 145 + index * 282, y: rowY + 270 + detailIndex * 62 }, detail.data));
      edges.push(bezierEdge(`shot-detail:${board.id}:${detail.id}`, boardNode.id, detail.id));
    });
  });
}
function addReleaseChain(nodes: Node<CanvasFlowNodeData>[], edges: Edge[], model: ProjectCanvasReadModel, clipId: string, outputs: CanvasConcatOutputRead[], boards: CanvasStoryboardRead[], rowY: number, expandedIds: ReadonlySet<string>, entryId: string, releaseX: number): void {
  const readyShots = readyStoryboardCount(boards);
  const summaryId = releaseSummaryId(clipId);
  const taskId = releaseTaskId(clipId);
  const summary: ReleaseSummaryNodeData = { ...base(model.project.id, summaryId, canonicalClipId(clipId), "release-summary", clipId, "镜头就绪汇总"), clipId, readyShots, totalShots: boards.length };
  const task: ReleaseTaskNodeData = { ...base(model.project.id, taskId, canonicalClipId(clipId), "release-task", clipId, readyShots === boards.length && boards.length > 0 ? "等待合成" : "等待镜头"), clipId, readyShots, totalShots: boards.length, status: readyShots === boards.length && boards.length > 0 ? "ready" : "pending" };
  nodes.push(asNode(summaryId, "ReleaseSummaryNode", { x: releaseX + 136, y: rowY + CANVAS_LAYOUT.entryY }, summary));
  nodes.push(asNode(taskId, "ReleaseTaskNode", { x: releaseX + 252, y: rowY + CANVAS_LAYOUT.entryY }, task));
  const current = outputs[0];
  const releaseId = current ? outputNodeId(current.id) : emptyReleaseId(clipId);
  const output: ReleaseOutputNodeData = current ? {
    ...base(model.project.id, releaseId, canonicalClipId(clipId), "release-output", current.id, current.file_name || "当前成片"), clipId, fileName: current.file_name, filePath: current.output_path, duration: current.duration, segmentCount: current.segment_count, source: current.source, isEmpty: false, hasChildren: outputs.length > 1,
  } : {
    ...base(model.project.id, releaseId, canonicalClipId(clipId), "release-output", clipId, "尚无成片"), clipId, fileName: null, filePath: null, duration: null, segmentCount: 0, source: null, isEmpty: true,
  };
  nodes.push(asNode(releaseId, "ReleaseOutputNode", { x: releaseX + 364, y: rowY + 5 }, output));
  edges.push(bezierEdge(`release:${clipId}:summary`, entryId, summaryId));
  edges.push(bezierEdge(`release:${clipId}:task`, summaryId, taskId));
  edges.push(bezierEdge(`release:${clipId}:output`, taskId, releaseId));
  if (!current || !expandedIds.has(releaseId)) return;
  outputs.slice(1).forEach((history, index) => {
    const id = outputNodeId(history.id);
    const historyData: ReleaseOutputNodeData = { ...base(model.project.id, id, releaseId, "release-output", history.id, history.file_name || "历史成片"), clipId, fileName: history.file_name, filePath: history.output_path, duration: history.duration, segmentCount: history.segment_count, source: history.source, isEmpty: false };
    nodes.push(asNode(id, "ReleaseOutputNode", { x: releaseX + 388, y: rowY + 164 + index * 58 }, historyData));
  });
}
