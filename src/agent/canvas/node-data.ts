/** Immutable data used by the Agent production canvas projection. */
import type { AssetType } from "../../types/project";

export type CanvasEntityType =
  | "project" | "clip" | "asset" | "image" | "storyboard" | "video" | "task"
  | "center" | "episode-entry" | "material-category" | "shot-track" | "shot-anchor"
  | "release-summary" | "release-task" | "release-output";
export type CanvasCenterKind = "materials" | "shots" | "release";
export type CanvasTaskKind = "asset" | "video-generation" | "upscale";

export interface CanvasNodeBase {
  canonicalId: string;
  parentCanonicalId: string | null;
  projectId: string;
  entityId: string;
  entityType: CanvasEntityType;
  title: string;
  hasChildren: boolean;
  status?: string;
}

export interface ProjectNodeData extends CanvasNodeBase { entityType: "project"; name: string; description: string; clipCount: number; }
export interface ClipNodeData extends CanvasNodeBase {
  entityType: "clip"; summary: string; assetCount: number; storyboardCount: number; estimatedDuration: number | null; expansionId: string;
}
export interface CanvasCenterNodeData extends CanvasNodeBase {
  entityType: "center"; centerKind: CanvasCenterKind; itemCount: number; width: number; height: number;
}
export interface EpisodeEntryNodeData extends CanvasNodeBase {
  entityType: "episode-entry"; centerKind: CanvasCenterKind; clipId: string; expansionId: string; summary: string; itemCount: number; detailOpen: boolean;
}
export interface MaterialCategoryNodeData extends CanvasNodeBase {
  entityType: "material-category"; clipId: string | null; category: AssetType; itemCount: number; expansionId: string;
}
export interface AssetPreviewImage {
  id: string;
  imagePath: string;
  size: string | null;
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
  imageCount: number;
  selectedImagePath: string | null;
  previewImages: AssetPreviewImage[];
  taskPreviews: AssetTaskPreview[];
}
export interface ImageNodeData extends CanvasNodeBase {
  entityType: "image"; assetId: string; assetName: string; imagePath: string; size: string | null; isSelected: boolean;
}
export interface StoryboardAssetReference {
  assetId: string; type: AssetType; name: string; assetTag: string; sourceScope: "owned" | "project-shared" | "clip"; sourceClipId: string | null;
}
export interface StoryboardNodeData extends CanvasNodeBase {
  entityType: "storyboard"; storyboardId: string; sbid: string; seqNum: number; summary: string; dialogue: string; duration: number | null; assetReferences: StoryboardAssetReference[];
}
export interface ShotTrackNodeData extends CanvasNodeBase { entityType: "shot-track"; clipId: string; shotCount: number; width: number; }
export interface ShotAnchorNodeData extends CanvasNodeBase { entityType: "shot-anchor"; clipId: string; storyboardId: string; seqNum: number; }
export interface VideoNodeData extends CanvasNodeBase {
  entityType: "video"; storyboardId: string; filePath: string; fileName: string; duration: number | null; source: string; isUpscaleOutput: boolean; isOutputReady: boolean;
}
export interface TaskNodeData extends CanvasNodeBase {
  entityType: "task"; taskKind: CanvasTaskKind; targetName: string; progress?: number; model?: string; scale?: number; error?: string | null;
}
export interface ReleaseSummaryNodeData extends CanvasNodeBase { entityType: "release-summary"; clipId: string; readyShots: number; totalShots: number; }
export interface ReleaseTaskNodeData extends CanvasNodeBase { entityType: "release-task"; clipId: string; readyShots: number; totalShots: number; }
export interface ReleaseOutputNodeData extends CanvasNodeBase {
  entityType: "release-output"; clipId: string; fileName: string | null; filePath: string | null; duration: number | null; segmentCount: number; source: string | null; isEmpty: boolean;
}

export type CanvasNodeData = ProjectNodeData | ClipNodeData | AssetNodeData | ImageNodeData | StoryboardNodeData | VideoNodeData | TaskNodeData;
export type CanvasFlowNodeData = CanvasNodeData | CanvasCenterNodeData | EpisodeEntryNodeData | MaterialCategoryNodeData | ShotTrackNodeData | ShotAnchorNodeData | ReleaseSummaryNodeData | ReleaseTaskNodeData | ReleaseOutputNodeData;

export type NodeStateColor = "gray" | "blue" | "green" | "orange" | "red" | "purple";
export function assetTypeColor(type: AssetType): NodeStateColor { return type === "character" ? "orange" : type === "scene" ? "green" : "purple"; }
export function taskStatusColor(status: string): NodeStateColor { return status === "failed" ? "red" : status === "running" ? "blue" : status === "done" || status === "ready" || status === "success" ? "green" : "gray"; }
export function storyboardStateColor(status: string): NodeStateColor { return status === "ready" ? "green" : status === "failed" ? "red" : status === "running" ? "blue" : status === "invalidated" ? "purple" : "gray"; }
export function clipStatusColor(status: string): NodeStateColor { return status === "done" ? "green" : status === "failed" ? "red" : status === "running" ? "blue" : "gray"; }
export function assetTypeLabel(type: AssetType): string { return type === "character" ? "人物" : type === "scene" ? "场景" : "道具"; }
