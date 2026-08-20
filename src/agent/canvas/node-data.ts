/** Immutable data used by the Agent production canvas projection. */
import type { AssetType } from "../../types/project";

export type CanvasEntityType =
  | "project" | "clip" | "asset" | "storyboard" | "video" | "task"
  | "center" | "material-category" | "shot-track" | "shot-anchor"
  | "release-summary" | "release-output";
export type CanvasCenterKind = "materials" | "shots" | "release";
export type CanvasTaskKind = "video-generation" | "upscale";

export type CanvasRole = "root" | "context" | "center" | "category" | "track" | "content";

export interface CanvasNodeBase {
  canonicalId: string;
  parentCanonicalId: string | null;
  /** Business mirror of the logical owner used for disclosure and grouping. */
  canvasParentId: string | null;
  /** Flat-canvas group owner used to translate a center and its contents together. */
  canvasGroupId?: string | null;
  canvasRole: CanvasRole;
  projectId: string;
  entityId: string;
  entityType: CanvasEntityType;
  title: string;
  hasChildren: boolean;
  status?: string;
}

export interface ProjectNodeData extends CanvasNodeBase { entityType: "project"; name: string; description: string; clipCount: number; }
export interface ClipNodeData extends CanvasNodeBase {
  entityType: "clip"; summary: string; assetCount: number; storyboardCount: number; estimatedDuration: number | null;
}
export function materialContentSourceHandle(index: number): string { return `content-source-material-${index}`; }

export interface CanvasCenterNodeData extends CanvasNodeBase {
  entityType: "center"; centerKind: CanvasCenterKind; clipId: string | null; itemCount: number; width: number; height: number;
  /** Header-relative x positions for the three material category content sources. */
  materialSourcePositions?: readonly number[];
  /** Stable projection dimensions used as the lower bound when runtime bounds shrink. */
  baseWidth?: number; baseHeight?: number;
}
export interface MaterialCategoryNodeData extends CanvasNodeBase {
  entityType: "material-category"; clipId: string | null; category: AssetType; itemCount: number; expansionId: string;
}
export interface AssetPreviewImage {
  id: string;
  imagePath: string;
  thumbnailPath: string | null;
  prompt: string;
  size: string | null;
  style: string | null;
  source: string;
  createdAt: string;
  isSelected: boolean;
}
export interface AssetTaskPreview {
  id: string;
  taskType: string;
  status: string;
  error: string | null;
}
export interface AssetNodeData extends CanvasNodeBase {
  entityType: "asset";
  assetId: string;
  type: AssetType;
  name: string;
  description: string;
  prompt: string;
  imageCount: number;
  selectedImagePath: string | null;
  previewImages: AssetPreviewImage[];
  taskPreviews: AssetTaskPreview[];
}
export interface StoryboardAssetReference {
  assetId: string; type: AssetType; name: string; assetTag: string; imagePath: string | null; sourceScope: "owned" | "project-shared" | "clip"; sourceClipId: string | null;
}
export interface StoryboardNodeData extends CanvasNodeBase {
  entityType: "storyboard";
  storyboardId: string;
  sbid: string;
  seqNum: number;
  summary: string;
  dialogue: string;
  visualDescription: string;
  videoPrompt: string;
  videoParamJson: string | null;
  selectedVideoId: string | null;
  duration: number | null;
  assetReferences: StoryboardAssetReference[];
  videoTasks: { id: string; status: string; error: string | null; createdAt: string }[];
  videos: { id: string; filePath: string; fileName: string; source: string; taskId: string | null; duration: number | null; createdAt: string; coverPath: string | null; isUpscaleOutput: boolean; isOutputReady: boolean }[];
}
export interface ShotTrackNodeData extends CanvasNodeBase { entityType: "shot-track"; clipId: string; shotCount: number; width: number; }
export interface ShotAnchorNodeData extends CanvasNodeBase { entityType: "shot-anchor"; clipId: string; storyboardId: string; seqNum: number; }
export interface VideoNodeData extends CanvasNodeBase {
  entityType: "video"; storyboardId: string; batchIndex: number; isSelected: boolean; filePath: string; fileName: string; duration: number | null; createdAt: string; source: string; coverPath: string | null; isUpscaleOutput: boolean; isOutputReady: boolean;
}
export interface TaskNodeData extends CanvasNodeBase {
  entityType: "task"; taskKind: CanvasTaskKind; targetName: string; progress?: number; model?: string; scale?: number; error?: string | null;
}
export interface ReleaseShotPreview {
  storyboardId: string;
  seqNum: number;
  sbid: string;
  summary: string;
  videoPath: string | null;
  videoCoverPath: string | null;
  videoDuration: number | null;
  batchIndex: number | null;
  isReady: boolean;
}
export interface ReleaseSummaryNodeData extends CanvasNodeBase {
  entityType: "release-summary"; clipId: string; readyShots: number; totalShots: number; shots: ReleaseShotPreview[]; totalDuration: number | null;
}
export interface ReleaseOutputNodeData extends CanvasNodeBase {
  entityType: "release-output"; clipId: string; fileName: string | null; filePath: string | null; coverPath: string | null; duration: number | null; segmentCount: number; source: string | null; createdAt: string | null; audioIncluded: boolean; isEmpty: boolean; isHistory?: boolean;
}

export type CanvasNodeData = ProjectNodeData | ClipNodeData | AssetNodeData | StoryboardNodeData | VideoNodeData | TaskNodeData;
export type CanvasFlowNodeData = CanvasNodeData | CanvasCenterNodeData | MaterialCategoryNodeData | ShotTrackNodeData | ShotAnchorNodeData | ReleaseSummaryNodeData | ReleaseOutputNodeData;

/** Shared readiness rule for any video output shown by the canvas. */
export function isCanvasVideoReady(
  filePath: string | null | undefined,
  isUpscaleOutput: boolean,
  isOutputReady: boolean,
): boolean {
  return Boolean(filePath) && (!isUpscaleOutput || isOutputReady);
}

export type NodeStateColor = "gray" | "blue" | "green" | "orange" | "red" | "purple";
export function assetTypeColor(type: AssetType): NodeStateColor { return type === "character" ? "orange" : type === "scene" ? "green" : "purple"; }
export function taskStatusColor(status: string): NodeStateColor { return status === "failed" ? "red" : status === "running" ? "blue" : status === "done" || status === "ready" || status === "success" ? "green" : "gray"; }
export function storyboardStateColor(status: string): NodeStateColor { return status === "ready" ? "green" : status === "failed" ? "red" : status === "running" ? "blue" : status === "invalidated" ? "purple" : "gray"; }
export function clipStatusColor(status: string): NodeStateColor { return status === "done" ? "green" : status === "failed" ? "red" : status === "running" ? "blue" : "gray"; }
export function assetTypeLabel(type: AssetType): string { return type === "character" ? "人物" : type === "scene" ? "场景" : "道具"; }
