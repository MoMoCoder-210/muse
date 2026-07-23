/**
 * 镜头模块共享类型与常量
 */
import type { Storyboard, StoryboardAssetInfo, AssetType } from "../../types/project";
import type { StoryboardVideoInfo } from "../../services/tauri";

// ── 素材分类 ──────────────────────────────────────────

export const CATS: { type: AssetType; label: string; icon: string }[] = [
  { type: "character", label: "人物", icon: "👤" },
  { type: "scene", label: "场景", icon: "🏞" },
  { type: "item", label: "道具", icon: "📦" },
];

// ── 视频任务状态 ──────────────────────────────────────

export type VideoTaskStatus = "pending" | "running" | "failed";
export type VideoTaskState = { taskId: string; status: VideoTaskStatus };
export type VideoTaskTerminalEvent = {
  task_id: string;
  clip_id: string;
  storyboard_id: string;
  status: "success" | "failed";
};
export const EMPTY_VIDEO_TASKS: VideoTaskState[] = [];

export type DisplayStoryboardVideo = StoryboardVideoInfo & { taskStatus?: VideoTaskStatus };

// ── 数据加载 ──────────────────────────────────────────

export type ClipData = { storyboards: Storyboard[]; assets: StoryboardAssetInfo[]; loaded: boolean };

// ── 视频参数 ──────────────────────────────────────────

export interface VideoParams {
  model: string;
  duration: number;
  resolution: string;
  aspect_ratio: string;
}

// ── DetailView Props ──────────────────────────────────

export type DetailProps = {
  sb: Storyboard;
  assets: StoryboardAssetInfo[];
  busy: boolean;
  saving: boolean;
  /** 设置里配置的视频模型 → 支持分辨率映射；为空表示未配置 */
  videoModels: Record<string, string[]>;
  onToggle: (a: StoryboardAssetInfo) => void;
  onBatchToggle: (sb: Storyboard, ids: { character: Set<string>; scene: Set<string>; item: Set<string> }) => Promise<void>;
  /** 实时写回镜头时长的回调（镜头记录上的秒数，可编辑） */
  onDurationWrite: (sb: Storyboard, duration: number | null) => void;
  /** 视频变更后同步 dataMap/videosMap → 底部缩略图条即时刷新 */
  onVideoRefresh: (sbId: string) => void;
  /** 当前镜头尚未落库为真实视频的生成批次。 */
  videoTaskStates: VideoTaskState[];
  /** 成功入队后立即创建前端临时视频批次。 */
  onVideoTaskQueued: (storyboardId: string, taskId: string) => void;
  /** 分集中已有绑定视频时锁定的分辨率+宽高比；null 表示未锁定 */
  lockedRatio: { resolution: string; aspect_ratio: string } | null;
};
