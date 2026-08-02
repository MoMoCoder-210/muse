/**
 * 镜头模块共享类型与常量
 */
import type { Storyboard, StoryboardAssetInfo, AssetType } from "../../types/project";
import type { StoryboardVideoInfo } from "../../services/tauri";
import type { UpscaleJob } from "../../services/tauri";

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

export type DisplayStoryboardVideo = StoryboardVideoInfo & {
  taskStatus?: VideoTaskStatus;
  /** 超分中的临时批次标记（尚未落库） */
  upscaling?: boolean;
  /** 超分进度（0-100），供超分中临时批次显示进度条 */
  upscalePercent?: number;
};

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
  /** 分集中已有绑定视频时锁定的宽高比；null 表示未锁定（分辨率不锁定） */
  lockedRatio: { aspect_ratio: string } | null;
  /** 镜头视频超分：当前超分运行状态（null 表示无超分；来自后端 UpscaleManager） */
  upscaleRun: UpscaleJob | null;
  /** 排队等待超分的任务列表（同一时刻只运行一个） */
  upscaleQueue: UpscaleJob[];
  /** 是否支持 GPU 超分（false=无 GPU，禁用按钮） */
  upscaleGpuOk: boolean | null;
  /** 发起镜头视频超分（仅请求，无副作用），返回新的任务或 null */
  onStartUpscale: (
    storyboardId: string,
    videoId: string,
    opts?: { model?: string; scale?: number },
  ) => Promise<UpscaleJob | null>;
  /** 取消当前超分任务 */
  onCancelUpscale: () => void;
  /** 视频刷新信号（每次超分完成/任务终态时递增，DetailView 据此重载批次列表） */
  videoRefreshTick: number;
};
