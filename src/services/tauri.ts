/**
 * Tauri IPC 调用封装
 *
 * 所有 invoke 调用集中在这里，组件不直接引入 @tauri-apps/api
 *
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ProjectInfo,
  CreateProjectInput,
  ImportScriptInput,
  ImportScriptResult,
  Clip,
  ScriptSource,
  ScriptSourceListItem,
  UpdateClipInput,
  SplitClipInput,
  SplitClipResult,
  AssetType,
  Storyboard,
  StoryboardAssetInfo,
} from "../types/project";
import type { AppSettings } from "../types/settings";

/**
 * 获取应用版本号
 *
 */
export async function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

/** 应用运行时服务健康状态（由 Tauri 启动流程维护）。 */
export interface StartupStatusPayload {
  status: "ready" | "error";
  db_ok: boolean;
  ffmpeg_ok: boolean;
  worker_ok: boolean;
  message: string;
}

/** 查询最近一次启动健康检查结果。 */
export async function getStartupStatus(): Promise<StartupStatusPayload | null> {
  return invoke<StartupStatusPayload | null>("get_startup_status");
}

/** 实时检查后端、数据库、FFmpeg 与 Worker 的运行状态。 */
export async function getRuntimeStatus(): Promise<StartupStatusPayload> {
  return invoke<StartupStatusPayload>("get_runtime_status");
}

/** 打开应用数据目录（settings.json / workspace / logs 等） */
export async function openAppDataDir(): Promise<void> {
  return invoke<void>("open_app_data_dir");
}

/** 打开日志文件所在目录 */
export async function openLogDir(): Promise<void> {
  return invoke<void>("open_log_dir");
}

/**
 * 列出所有作品
 *
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  return invoke<ProjectInfo[]>("list_projects");
}

/**
 * 获取单个作品详情
 *
 */
export async function getProject(projectId: string): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("get_project", { projectId });
}

/**
 * 创建新作品
 *
 */
export async function createProject(input: CreateProjectInput): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("create_project", { input });
}

/**
 * 启动工作进程
 *
 */
export async function startWorker(projectId?: string): Promise<string> {
  return invoke<string>("start_worker", { projectId });
}

/**
 * 导入剧本
 *
 */
export async function importScript(input: ImportScriptInput): Promise<ImportScriptResult> {
  return invoke<ImportScriptResult>("import_script", { input });
}

/**
 * 手动创建单个分集（无剧本归属）
 *
 */
export async function createClip(input: { project_id: string; title: string; source_text: string }): Promise<Clip> {
  return invoke<Clip>("create_clip", { input });
}

/**
 * 列出作品下的所有分集
 *
 */
export async function listClips(projectId: string): Promise<Clip[]> {
  return invoke<Clip[]>("list_clips", { projectId });
}

/**
 * 获取剧本源内容
 *
 */
export async function getScriptSource(projectId: string): Promise<ScriptSource | null> {
  return invoke<ScriptSource | null>("get_script_source", { projectId });
}

/**
 * 列出作品所有剧本源
 *
 */
export async function listScriptSources(projectId: string): Promise<ScriptSourceListItem[]> {
  return invoke<ScriptSourceListItem[]>("list_script_sources", { projectId });
}

/**
 * 删除作品
 *
 */
export async function deleteProject(projectId: string, deleteFiles: boolean): Promise<FileDeletionResult> {
  return invoke<FileDeletionResult>("delete_project", { projectId, deleteFiles });
}

/** 新增分集级写操作 IPC */

/** 所有删除命令共用的本地文件清理统计。 */
export interface FileDeletionResult {
  deleted_file_count: number;
  skipped_file_count: number;
  failed_file_count: number;
}

export type DeleteClipsResult = FileDeletionResult;

/**
 * 批量软删除分集，支持单条（传长度1数组）或多条。
 * `deleteFiles` 默认关闭；开启时仅删除数据库记录引用的作品工作区内文件。
 */
export async function deleteClips(clipIds: string[], deleteFiles = false): Promise<DeleteClipsResult> {
  return invoke<DeleteClipsResult>("delete_clips", {
    input: { clip_ids: clipIds, delete_files: deleteFiles },
  });
}

/**
 * 更新分集标题/摘要/正文，返回更新后的分集
 *
 */
export async function updateClip(input: UpdateClipInput): Promise<Clip> {
  return invoke<Clip>("update_clip", { input });
}

/**
 * 在指定字符位置把一个分集拆成两个，返回两段 id
 *
 */
export async function splitClip(input: SplitClipInput): Promise<SplitClipResult> {
  return invoke<SplitClipResult>("split_clip", { input });
}

/**
 * 确保工作进程已启动后导入剧本
 *
 */
export async function ensureWorkerAndImportScript(
  projectId: string,
  input: Omit<ImportScriptInput, "project_id">,
): Promise<ImportScriptResult> {
  await startWorker(projectId);
  return importScript({ ...input, project_id: projectId });
}

// ── 设置 ──────────────────────────────────────────────────

/**
 * 获取应用设置
 *
 */
export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

/**
 * 保存应用设置
 *
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

/**
 * 检查指定渠道类型是否还有未完成任务
 *
 * @param channelType — "text" | "image" | "video"
 * @returns true 表示队列为空（可安全删除），false 表示有 pending/running 任务
 *
 */
export async function checkChannelPendingTasks(channelType: string): Promise<boolean> {
  return invoke<boolean>("check_channel_pending_tasks", { channelType });
}

// ── 分集拆解 ──────────────────────────────────────────────
import type { ClipScriptInfo, GenerateClipScriptInput } from "../types/project";

/**
 * 触发分集拆解任务
 *
 */
export async function generateClipScript(input: GenerateClipScriptInput): Promise<{ task_id: string }> {
  return invoke<{ task_id: string }>("generate_clip_script", { input });
}

// ── 剧本优化 ──────────────────────────────────────────────

export interface OptimizeScriptInput {
  projectId: string;
  clipId: string;
  text: string;
  mode: "polish" | "expand" | "condense";
  instruction?: string;
}

export interface OptimizeScriptResult {
  taskId: string;
  optimizationId: string;
}

/** 发起剧本优化任务，返回 taskId + optimizationId（前端可立即切换 Tab） */
export async function optimizeScript(input: OptimizeScriptInput): Promise<OptimizeScriptResult> {
  return invoke<OptimizeScriptResult>("optimize_script", { input });
}

/** 轮询任务结果 */
export async function pollTaskResult(taskId: string): Promise<{
  status: string;
  errorMessage?: string;
  output?: string;
}> {
  return invoke("poll_task_result", { taskId });
}

// ── 剧本优化：版本管理 ──────────────────────────────────────

export interface OptimizationRecord {
  id: string;
  project_id: string;
  clip_id: string;
  source_text: string;
  optimized_text: string;
  mode: "polish" | "expand" | "condense";
  instruction: string;
  char_count_before: number;
  char_count_after: number;
  task_id: string | null;
  status: string;
  created_at: string;
}

export interface OptimizationsResult {
  active_id: string | null;
  items: OptimizationRecord[];
}

/** 列出分集的全部优化版本及当前生效版本 */
export async function listOptimizations(clipId: string): Promise<OptimizationsResult> {
  return invoke<OptimizationsResult>("list_optimizations", { clipId });
}

/** 选定某优化版本为生效版本 */
export async function selectOptimization(clipId: string, optimizationId: string): Promise<void> {
  return invoke("select_optimization", { clipId, optimizationId });
}

/** 删除某优化版本（若为生效版本则一并清除） */
export async function deleteOptimization(optimizationId: string): Promise<void> {
  return invoke("delete_optimization", { optimizationId });
}

/** 更新优化记录的结果文本（编辑后实时落库） */
export async function updateOptimizationText(optimizationId: string, optimizedText: string): Promise<void> {
  return invoke("update_optimization_text", { optimizationId, optimizedText });
}

/** 监听剧本优化流式输出，返回取消监听函数（防 Strict Mode 双注册） */
export function onOptimizeStream(
  cb: (taskId: string, chunk: string, index: number) => void,
): UnlistenFn {
  let cancelled = false;
  let unlistenFn: UnlistenFn | null = null;
  listen<{ task_id: string; chunk: string; index: number }>(
    "optimize-script-stream",
    (e) => {
      if (!cancelled) cb(e.payload.task_id, e.payload.chunk, e.payload.index);
    },
  ).then((fn) => {
    unlistenFn = fn;
    if (cancelled) fn(); // 已取消则立即注销
  });
  return () => {
    cancelled = true;
    if (unlistenFn) unlistenFn();
  };
}

/**
 * 素材生图
 *
 * 根据素材拆解阶段生成的 prompt 创建 image 生成任务。
 *
 */
export async function generateAssetImage(input: {
  project_id: string;
  clip_id: string;
  asset_type: AssetType;
  name: string;
  prompt: string;
  size?: string;
  n?: number;
  style?: string;
}): Promise<{ task_id: string }> {
  return invoke<{ task_id: string }>("generate_asset_image", { input });
}

/**
 * 重试失败的素材生图任务
 *
 * 将已有 failed 任务重置为 pending 并重新入队，在原记录上重试。
 */
export async function retryAssetImageTask(input: {
  task_id: string;
}): Promise<void> {
  return invoke<void>("retry_asset_image_task", { input });
}

/**
 * 添加素材到分集拆解结果
 *
 */
export async function addAssetToClip(input: {
  clip_id: string;
  asset_type: string;
  name: string;
  description: string;
  prompt: string;
}): Promise<void> {
  return invoke<void>("add_asset_to_clip", { input });
}

/**
 * 更新素材的提示词与描述（按 clip_id + type + name 匹配）。
 */
export async function updateAssetInClip(input: {
  clip_id: string;
  asset_type: string;
  name: string;
  description: string;
  prompt: string;
  voice_binding?: string;
}): Promise<void> {
  return invoke<void>("update_asset_in_clip", { input });
}

/**
 * 试听公共音色
 */
export interface PreviewVoiceResult {
  /** 缓存文件绝对路径*/
  sample_path: string;
  /** 是否命中本地缓存（true=复用，false=本次新生成） */
  cached: boolean;
}
export async function previewPublicVoice(voiceId: string): Promise<PreviewVoiceResult> {
  return invoke<PreviewVoiceResult>("preview_public_voice", { voiceId });
}

export interface VoiceFileEntry {
  file_path: string;
  file_name: string;
}

export async function listWorkspaceVoiceFiles(clipId: string): Promise<VoiceFileEntry[]> {
  return invoke<VoiceFileEntry[]>("list_workspace_voice_files", { clipId });
}

export interface ImportVoiceResult {
  file_path: string;
  file_name: string;
}

export async function importVoiceFile(clipId: string, sourcePath: string): Promise<ImportVoiceResult> {
  return invoke<ImportVoiceResult>("import_voice_file", { clipId, sourcePath });
}

/** 批量查询已缓存的公共音色（复用试听缓存逻辑，不触发合成） */
export async function checkVoicesCached(voiceIds: string[]): Promise<string[]> {
  return invoke<string[]>("check_voices_cached", { voiceIds });
}

/**
 * 获取素材图片信息
 *
 */
export async function getAssetImageInfo(input: {
  clip_id: string;
  asset_type: string;
  name: string;
}): Promise<{
  generated_image_path: string | null;
  selected_image_id: string | null;
  status: string;
  image_count: number;
}> {
  return invoke("get_asset_image_info", { input });
}

/**
 * 批量获取分集下所有素材的选定图片路径
 *
 * AssetPanel 快速渲染卡片缩略图用。
 *
 */
export async function batchGetAssetSelectedImages(input: {
  clip_id: string;
}): Promise<{ asset_type: string; name: string; selected_image_path: string | null }[]> {
  return invoke("batch_get_asset_selected_images", { input });
}

/**
 * 查询分集下正在生成图片的素材（实时展示「生成中」角标用）。
 */
export async function batchGetAssetGenerating(input: {
  clip_id: string;
}): Promise<{ asset_type: string; name: string }[]> {
  return invoke("batch_get_asset_generating", { input });
}

/**
 * 导入本地图片到指定素材（复制到作品目录 + 注册 + 自动绑定）
 *
 */
export async function importLocalAssetImage(input: {
  clip_id: string;
  asset_type: string;
  name: string;
  local_file_path: string;
}): Promise<{ image_id: string; image_path: string; is_selected: boolean }> {
  return invoke("import_local_asset_image", { input });
}

/**
 * 查询作品下指定类型的所有素材及其选中图片（素材选择器用）
 *
 */
export async function listProjectAssetImages(input: {
  projectId: string;
  assetType: string;
  excludeClipId: string;
}): Promise<{
  asset_id: string;
  clip_id: string;
  asset_type: string;
  name: string;
  description: string;
  prompt: string;
  selected_image_path: string;
  selected_image_id: string;
}[]> {
  return invoke("list_project_asset_images", input);
}

/**
 * 从作品内另一个素材复制选中图片到当前素材
 *
 */
export async function copyAssetImageFrom(input: {
  source_image_id: string;
  target_clip_id: string;
  target_asset_type: string;
  target_name: string;
}): Promise<{ image_id: string; image_path: string; is_selected: boolean }> {
  return invoke("copy_asset_image_from", { input });
}

/**
 * 获取素材所有生成图片列表
 *
 */
export async function listAssetImages(input: {
  clip_id: string;
  asset_type: string;
  name: string;
}): Promise<{
  id: string;
  image_path: string;
  size: string | null;
  style: string | null;
  is_selected: boolean;
  created_at: string;
}[]> {
  return invoke("list_asset_images", { input });
}

/**
 * 获取素材图片+任务混合列表（含 pending / running / failed 任务）
 *
 * 供抽屉实时展示：已完成图片 + 进行中任务统一排序。
 *
 */
export async function listAssetImageTasks(input: {
  clip_id: string;
  asset_type: string;
  name: string;
}): Promise<{
  id: string;
  image_path: string | null;
  size: string | null;
  style: string | null;
  is_selected: boolean;
  status: string;       // "ready" | "pending" | "running" | "failed"
  error_message: string | null;
  created_at: string;
}[]> {
  return invoke("list_asset_image_tasks", { input });
}

/**
 * 选中素材的指定图片作为最终使用图片
 *
 */
export async function selectAssetImage(input: {
  clip_id: string;
  asset_type: string;
  name: string;
  image_id: string;
}): Promise<void> {
  return invoke("select_asset_image", { input });
}

/**
 * 删除单张素材图片（可选同时删除文件）
 *
 */
export async function deleteAssetImage(input: {
  clip_id: string;
  asset_type: string;
  name: string;
  image_id: string;
  delete_file: boolean;
}): Promise<FileDeletionResult> {
  return invoke<FileDeletionResult>("delete_asset_image", { input });
}

export type ManagedFileDeletionResult = FileDeletionResult;

/**
 * 从分集拆解结果中删除素材，可选清理作品工作区内关联的本地文件。
 */
export async function deleteAssetFromClip(input: {
  clip_id: string;
  asset_type: string;
  name: string;
  delete_files?: boolean;
}): Promise<ManagedFileDeletionResult> {
  return invoke<ManagedFileDeletionResult>("delete_asset_from_clip", { input });
}

/**
 * 删除素材（批量）
 *
 */
export async function deleteAssets(assetIds: string[]): Promise<void> {
  return invoke<void>("delete_assets", { input: { asset_ids: assetIds } });
}


/**
 * 查询作品所有拆解记录（按 clip_id 去重，最新一条为准）
 *
 */
export async function getClipScripts(projectId: string): Promise<ClipScriptInfo[]> {
  return invoke<ClipScriptInfo[]>("get_clip_scripts", { projectId });
}

/**
 * 取消分集拆解任务
 *
 */
export async function cancelClipScript(clipId: string): Promise<void> {
  return invoke<void>("cancel_clip_script", { input: { clip_id: clipId } });
}

// ── 镜头 ─────────────────────────────────────────────────────────

/**
 * 查询指定分集的镜头列表
 *
 */
export async function listStoryboards(clipId: string): Promise<Storyboard[]> {
  return invoke<Storyboard[]>("list_storyboards", { clipId });
}

/**
 * 查询指定分集的所有素材（含绑定图片路径）
 *
 */
export async function listClipAssets(
  clipId: string,
  storyboardId?: string,
): Promise<StoryboardAssetInfo[]> {
  return invoke<StoryboardAssetInfo[]>("list_clip_assets", { clipId, storyboardId });
}

/**
 * 更新镜头关联素材
 *
 */
export async function updateStoryboardAssets(input: {
  storyboard_id: string;
  character_ids: string[];
  scene_ids: string[];
  item_ids: string[];
}): Promise<void> {
  return invoke<void>("update_storyboard_assets", { input });
}

/**
 * 在当前分集末尾新增一个空白镜头
 *
 */
export async function createStoryboard(input: {
  clip_id: string;
  project_id: string;
}): Promise<Storyboard> {
  return invoke<Storyboard>("create_storyboard", { input });
}

/**
 * 在指定镜头后插入新镜头，自动重排序号
 *
 */
export async function insertStoryboard(input: {
  clip_id: string;
  project_id: string;
  after_storyboard_id: string | null;
}): Promise<Storyboard> {
  return invoke<Storyboard>("insert_storyboard", { input });
}

/**
 * 删除一个镜头及其关联记录；可选清理关联视频批次的工作区文件。
 */
export async function deleteStoryboard(input: {
  storyboard_id: string;
  delete_files?: boolean;
}): Promise<FileDeletionResult> {
  return invoke<FileDeletionResult>("delete_storyboard", { input });
}

/**
 * 更新镜头的视频生成参数与提示词（失焦保存）
 *
 */
export async function updateStoryboardParams(input: {
  storyboard_id: string;
  video_param_json: string | null;
  video_prompt: string | null;
}): Promise<void> {
  return invoke<void>("update_storyboard_params", { input });
}

/** 提交一个镜头视频生成任务。入队时后端会冻结当前提示词和参数快照。 */
export async function generateStoryboardVideo(input: {
  storyboard_id: string;
}): Promise<{ task_id: string }> {
  return invoke<{ task_id: string }>("generate_storyboard_video", { input });
}

/**
 * 实时更新镜头时长（秒），写回镜头记录本身。
 */
export async function updateStoryboardDuration(input: {
  storyboard_id: string;
  duration: number | null;
}): Promise<void> {
  return invoke<void>("update_storyboard_duration", { input });
}

export interface ImportVideoResult {
  file_path: string;
  file_name: string;
}

export async function importVideoFile(clipId: string, sourcePath: string): Promise<ImportVideoResult> {
  return invoke<ImportVideoResult>("import_video_file", { clipId, sourcePath });
}

export async function selectStoryboardVideo(input: {
  storyboard_id: string;
  video_id: string;
}): Promise<void> {
  return invoke<void>("select_storyboard_video", { input });
}

export interface StoryboardVideoInfo {
  id: string;
  storyboard_id: string;
  file_path: string;
  file_name: string;
  source: string;
  /** 生成该视频的任务；手动上传视频为 null。 */
  task_id: string | null;
  duration: number | null;
}

/** 镜头视频的未完成或失败任务，可在组件重挂载后恢复批次状态。 */
export interface StoryboardVideoTaskInfo {
  task_id: string;
  status: "pending" | "running" | "failed";
}

export async function listStoryboardVideos(storyboardId: string): Promise<StoryboardVideoInfo[]> {
  return invoke<StoryboardVideoInfo[]>("list_storyboard_videos", { storyboardId });
}

export async function listStoryboardVideoTasks(storyboardId: string): Promise<StoryboardVideoTaskInfo[]> {
  return invoke<StoryboardVideoTaskInfo[]>("list_storyboard_video_tasks", { storyboardId });
}

export async function addStoryboardVideo(input: {
  storyboard_id: string;
  video_path: string;
  file_name?: string;
}): Promise<StoryboardVideoInfo> {
  return invoke<StoryboardVideoInfo>("add_storyboard_video", { input });
}

export async function deleteStoryboardVideoTask(input: {
  storyboard_id: string;
  task_id: string;
}): Promise<void> {
  return invoke<void>("delete_storyboard_video_task", { input });
}

export async function deleteStoryboardVideo(input: {
  storyboard_id: string;
  video_id: string;
  delete_file?: boolean;
}): Promise<ManagedFileDeletionResult> {
  return invoke<ManagedFileDeletionResult>("delete_storyboard_video", { input });
}

// ── 视频拼接 ─────────────────────────────────────────────

/** 可拼接的镜头视频分集（含选中视频路径、时长） */
export interface ConcatSegment {
  seq: number;
  clip_title: string;
  storyboard_id: string;
  file_path: string;
  file_name: string;
  duration: number | null;
}

/** 拼接结果 */
/** 拼接结果（前端统一视图：拼接返回 + DB 持久化记录合并，id 持久化后才有） */
export interface ConcatResult {
  id?: string;
  output_path: string;
  file_name: string;
  duration: number;
  segment_count: number;
  audio_included: boolean;
  /** 记录来源：concat（拼接成片）| upscale（超分产物） */
  source?: string;
}

/** 拼接进度事件载荷（后端通过 Tauri event 推送） */
export interface ConcatProgressEvent {
  percent: number;
  stage: string;
}

/** 查询分集下「已选中镜头视频」的有序列表 */
export async function listClipConcatVideos(clipId: string): Promise<ConcatSegment[]> {
  return invoke<ConcatSegment[]>("list_clip_concat_videos", { clipId });
}

/** 持久化一条拼接成片记录 */
export interface SaveConcatOutputInput {
  clip_id: string;
  output_path: string;
  file_name: string;
  duration: number;
  segment_count: number;
  audio_included: boolean;
  /** 记录来源：concat（拼接成片）| upscale（超分产物） */
  source?: string;
}
export async function saveConcatOutput(input: SaveConcatOutputInput): Promise<string> {
  return invoke<string>("save_concat_output", { input });
}

/** 删除一条拼接成片（数据库记录，可选同时删除文件） */
export async function deleteConcatOutput(id: string, deleteFile = true): Promise<FileDeletionResult> {
  return invoke<FileDeletionResult>("delete_concat_output", { input: { id, delete_file: deleteFile } });
}

/** 成片列表行 */
export interface ConcatOutputRow {
  id: string;
  output_path: string;
  file_name: string;
  duration: number;
  segment_count: number;
  audio_included: boolean;
  source: string;
  created_at: string;
}

/** 查询指定分集的所有拼接成片 */
export async function listConcatOutputs(clipId: string): Promise<ConcatOutputRow[]> {
  return invoke<ConcatOutputRow[]>("list_concat_outputs", { clipId });
}
export async function concatStoryboardVideos(input: {
  clip_id: string;
  segments: string[];
  height?: number;
  aspect_ratio?: string;
  output_name?: string;
}): Promise<ConcatResult> {
  return invoke<ConcatResult>("concat_clip_videos", { input });
}

/**
 * 检测当前机器是否支持 Vulkan（ncnn）GPU 超分。
 * 返回 true 表示有可用 GPU；false 表示无 GPU，超分不可用。
 */
export async function detectGpuSupport(): Promise<boolean> {
  return invoke<boolean>("detect_gpu_support");
}

/** 超分任务状态 */
export type UpscaleJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** 超分任务（后端 UpscaleManager 唯一事实来源，前端订阅事件渲染） */
export interface UpscaleJob {
  id: string;
  storyboard_id: string;
  video_id: string;
  input_path: string;
  output_path: string;
  model: string;
  scale: number;
  status: UpscaleJobStatus;
  /** 进度 0-100 */
  percent: number;
  stage: string;
  error: string | null;
  created_at: string;
}

/** 超分任务入队输入 */
export interface UpscaleEnqueueInput {
  storyboard_id: string;
  video_id: string;
  model?: string;
  scale?: number;
}

/**
 * 入队超分任务（同一时刻只执行一个，其余排队等待）。
 * 返回创建的任务；进度/状态经 `upscale-changed` 事件推送。
 */
export async function enqueueUpscale(input: UpscaleEnqueueInput): Promise<UpscaleJob> {
  return invoke<UpscaleJob>("enqueue_upscale", { input });
}

/** 查询全量超分任务（应用启动时用于恢复状态） */
export async function listUpscaleJobs(): Promise<UpscaleJob[]> {
  return invoke<UpscaleJob[]>("list_upscale_jobs");
}

/** 取消超分任务（排队中移除 / 运行中置取消标志） */
export async function cancelUpscaleJob(jobId: string): Promise<boolean> {
  return invoke<boolean>("cancel_upscale_job", { jobId });
}

/** 重试失败的超分任务（仅 failed 可重试，复用原批次与参数重新入队） */
export async function retryUpscaleJob(jobId: string): Promise<UpscaleJob> {
  return invoke<UpscaleJob>("retry_upscale_job", { jobId });
}

/** 超分任务状态变化事件载荷（后端广播完整 UpscaleJob，可直接替换） */
export type UpscaleChangedEvent = UpscaleJob;

/** 超分完成/失败/取消事件载荷（前端据此刷新视频列表） */
export interface UpscaleDoneEvent {
  storyboard_id: string;
  video_id: string;
  result_id: string;
  status: UpscaleJobStatus;
  output_path: string;
  file_name: string;
}

/**
 * 检测 FFmpeg/FFprobe 是否可用
 *
 */
export async function detectFFmpeg(): Promise<{
  available: boolean;
  ffmpeg_path: string;
  ffprobe_path: string;
  ffmpeg_exists: boolean;
  ffprobe_exists: boolean;
}> {
  return invoke("detect_ffmpeg");
}

/**
 * 在系统文件管理器中打开文件所在文件夹（并选中该文件）
 *
 */
export async function openInFolder(path: string): Promise<void> {
  return invoke<void>("open_in_folder", { path });
}

/**
 * 测试渠道连通性（OpenAI 兼容端点）
 */
export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

export async function testConnection(input: {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}): Promise<TestConnectionResult> {
  return invoke<TestConnectionResult>("test_connection", {
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
  });
}
