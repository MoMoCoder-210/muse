/**
 * 共享类型定义
 * 基于模块 08（任务运行时、状态机与恢复）的规范
 */

// ===== 协议版本 =====
export const PROTOCOL_VERSION = 1 as const;

// ===== 任务类型 =====
export type TaskType =
  | "split_script"          // 剧本拆分
  | "generate_clip_script"  // 剧本理解
  | "generate_asset_image"  // 资产生图
  | "generate_storyboard"   // 分镜生成
  | "generate_voice"        // 语音生成
  | "generate_video"        // 视频生成
  | "import_storyboard_voice" // 导入分镜语音
  | "export_video"          // 导出成片
  | "concat_video";        // 视频拼接

// ===== 任务状态 =====
export type TaskStatus =
  | "pending"          // 待执行
  | "running"          // 执行中
  | "waiting_remote"   // 等待远端结果
  | "downloading"      // 下载中
  | "success"          // 成功
  | "failed"           // 失败
  | "invalidated";     // 已失效

// ===== API 类型分类 =====
export type ApiType = "text" | "image" | "voice" | "video" | "local";

// ===== 任务事件 =====
export type TaskEvent =
  | { type: "task_started"; taskId: string; taskType: TaskType }
  | { type: "task_progress"; taskId: string; progress: number; message?: string }
  | { type: "task_success"; taskId: string; outputJson?: string }
  | { type: "task_failed"; taskId: string; errorMessage: string }
  | { type: "task_invalidated"; taskId: string; reason: string }
  | { type: "batch_progress"; batchId: string; total: number; completed: number; failed: number }
  | { type: "worker_crashed"; workerId: string; message: string }
  | { type: "worker_restarted"; workerId: string; recoveredTasks: number }
  | { type: "worker_failed"; message: string }
  | { type: "quota_exhausted"; apiType: ApiType; message: string }
  | { type: "quota_resumed"; apiType: ApiType }
  /** 资产生图进度推送（供前端实时刷新生成中状态） */
  | { type: "asset_image_progress"; clipId: string; assetType: string; name: string; status: "running" | "success" | "failed" }
  /** 单张资产生成图片状态更新（供 AssetDrawer 画廊即时刷新） */
  | { type: "asset_image_task_update"; clipId: string; assetType: string; name: string; imageId: string; status: "ready" | "failed" }
  /** 片段拆解任务完成/失败（供片段列表即时刷新） */
  | { type: "clip_script_ready"; projectId: string; clipId: string; status: "success" | "failed"; errorMessage?: string };

// ===== 批量进度事件 =====
export interface BatchProgressEvent {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
}

// ===== stdio 通信协议 =====
export type WorkerCommand =
  | { version: number; cmd: "enqueue"; taskId: string; taskType?: string }
  | { version: number; cmd: "cancel"; taskId: string }
  | { version: number; cmd: "shutdown"; timeoutMs: number }
  | { version: number; cmd: "reload_config" }
  | { version: number; cmd: "ping" };

export type WorkerMessage =
  | { version: number; msg: "ready"; workerId: string; protocolVersion: number }
  | { version: number; msg: "heartbeat"; workerId: string; activeTasks: number }
  | { version: number; msg: "task_event"; event: TaskEvent }
  | { version: number; msg: "batch_progress"; batchId: string; total: number; completed: number; failed: number }
  | { version: number; msg: "quota_exhausted"; apiType: ApiType; message: string }
  | { version: number; msg: "log"; level: "info" | "warn" | "error"; message: string }
  | { version: number; msg: "error"; message: string; stack?: string; taskId?: string }
  | { version: number; msg: "shutting_down"; pendingTasks: number };

// ===== TaskContext =====
export interface TaskContext {
  workspacePath: string;
  taskId: string;
  taskInput: unknown;      // 已解析的 input_json 对象
  db: import("better-sqlite3").Database;
  emit: (event: TaskEvent) => void;
  rateLimiter: RateLimiter;
  signal: AbortSignal;
  clients?: import("./clients/index.js").ApiClients;
  ffmpeg: import("./ffmpeg.js").FFmpegHelper;
}

// ===== RateLimiter 接口 =====
export interface RateLimiter {
  acquire(apiType: ApiType): boolean;
  release(apiType: ApiType): void;
  canAcquire(apiType: ApiType): boolean;
  getActiveCount(apiType: ApiType): number;
  reportRateLimit(apiType: ApiType): void;
  reportQuotaExhausted(apiType: ApiType): void;
  resume(apiType: ApiType): void;
}

// ===== 任务类型到 API 类型映射 =====
export const TASK_TYPE_TO_API: Record<TaskType, ApiType> = {
  split_script: "text",
  generate_clip_script: "text",
  generate_asset_image: "image",
  generate_storyboard: "text",
  generate_voice: "voice",
  generate_video: "video",
  import_storyboard_voice: "local",
  export_video: "local",
  concat_video: "local",
};
