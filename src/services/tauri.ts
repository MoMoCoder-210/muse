/**
 * Tauri IPC 调用封装
 *
 * 所有 invoke 调用集中在这里，组件不直接引入 @tauri-apps/api
 *
 */
import { invoke } from "@tauri-apps/api/core";
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

/**
 * 列出所有项目
 *
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  return invoke<ProjectInfo[]>("list_projects");
}

/**
 * 获取单个项目详情
 *
 */
export async function getProject(projectId: string): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("get_project", { projectId });
}

/**
 * 创建新项目
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
 * 手动创建单个片段（无剧本归属）
 *
 */
export async function createClip(input: { project_id: string; title: string; source_text: string }): Promise<Clip> {
  return invoke<Clip>("create_clip", { input });
}

/**
 * 列出项目下的所有片段
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
 * 列出项目所有剧本源
 *
 */
export async function listScriptSources(projectId: string): Promise<ScriptSourceListItem[]> {
  return invoke<ScriptSourceListItem[]>("list_script_sources", { projectId });
}

/**
 * 删除项目
 *
 */
export async function deleteProject(projectId: string, deleteFiles: boolean): Promise<void> {
  return invoke<void>("delete_project", { projectId, deleteFiles });
}

/** 新增片段级写操作 IPC */

/**
 * 批量软删除片段，支持单条（传长度1数组）或多条
 *
 */
export async function deleteClips(clipIds: string[]): Promise<void> {
  return invoke<void>("delete_clips", { input: { clip_ids: clipIds } });
}

/**
 * 更新片段标题/摘要/正文，返回更新后的片段
 *
 */
export async function updateClip(input: UpdateClipInput): Promise<Clip> {
  return invoke<Clip>("update_clip", { input });
}

/**
 * 在指定字符位置把一个片段拆成两个，返回两段 id
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

// ── 片段拆解 ──────────────────────────────────────────────
import type { ClipScriptInfo, GenerateClipScriptInput } from "../types/project";

/**
 * 触发片段拆解任务
 *
 */
export async function generateClipScript(input: GenerateClipScriptInput): Promise<{ task_id: string }> {
  return invoke<{ task_id: string }>("generate_clip_script", { input });
}

/**
 * 资产生图
 *
 * 根据资产拆解阶段生成的 prompt 创建 image 生成任务。
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
 * 添加资产到片段拆解结果
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
 * 更新资产的提示词与描述（按 clip_id + type + name 匹配）。
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
 * 获取资产图片信息
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
 * 批量获取片段下所有资产的选定图片路径
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
 * 查询片段下正在生成图片的资产（实时展示「生成中」角标用）。
 */
export async function batchGetAssetGenerating(input: {
  clip_id: string;
}): Promise<{ asset_type: string; name: string }[]> {
  return invoke("batch_get_asset_generating", { input });
}

/**
 * 导入本地图片到指定资产（复制到项目目录 + 注册 + 自动绑定）
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
 * 查询项目下指定类型的所有资产及其选中图片（资产选择器用）
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
 * 从项目内另一个资产复制选中图片到当前资产
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
 * 获取资产所有生成图片列表
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
 * 获取资产图片+任务混合列表（含 pending / running / failed 任务）
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
 * 选中资产的指定图片作为最终使用图片
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
 * 删除单张资产图片（可选同时删除文件）
 *
 */
export async function deleteAssetImage(input: {
  clip_id: string;
  asset_type: string;
  name: string;
  image_id: string;
  delete_file: boolean;
}): Promise<void> {
  return invoke("delete_asset_image", { input });
}

/**
 * 从片段拆解结果中删除资产
 *
 */
export async function deleteAssetFromClip(input: {
  clip_id: string;
  asset_type: string;
  name: string;
}): Promise<void> {
  return invoke<void>("delete_asset_from_clip", { input });
}

/**
 * 删除资产（批量）
 *
 */
export async function deleteAssets(assetIds: string[]): Promise<void> {
  return invoke<void>("delete_assets", { input: { asset_ids: assetIds } });
}


/**
 * 查询项目所有拆解记录（按 clip_id 去重，最新一条为准）
 *
 */
export async function getClipScripts(projectId: string): Promise<ClipScriptInfo[]> {
  return invoke<ClipScriptInfo[]>("get_clip_scripts", { projectId });
}

/**
 * 取消片段拆解任务
 *
 */
export async function cancelClipScript(clipId: string): Promise<void> {
  return invoke<void>("cancel_clip_script", { input: { clip_id: clipId } });
}

// ── 分镜 ─────────────────────────────────────────────────────────

/**
 * 查询指定片段的分镜列表
 *
 */
export async function listStoryboards(clipId: string): Promise<Storyboard[]> {
  return invoke<Storyboard[]>("list_storyboards", { clipId });
}

/**
 * 查询指定片段的所有资产（含绑定图片路径）
 *
 */
export async function listClipAssets(
  clipId: string,
  storyboardId?: string,
): Promise<StoryboardAssetInfo[]> {
  return invoke<StoryboardAssetInfo[]>("list_clip_assets", { clipId, storyboardId });
}

/**
 * 更新分镜关联资产
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
 * 在当前片段末尾新增一个空白分镜
 *
 */
export async function createStoryboard(input: {
  clip_id: string;
  project_id: string;
}): Promise<Storyboard> {
  return invoke<Storyboard>("create_storyboard", { input });
}

/**
 * 在指定分镜后插入新分镜，自动重排序号
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
 * 删除一个分镜，同时清理关联记录
 *
 */
export async function deleteStoryboard(input: {
  storyboard_id: string;
}): Promise<void> {
  return invoke<void>("delete_storyboard", { input });
}

/**
 * 更新分镜的视频生成参数与提示词（失焦保存）
 *
 */
export async function updateStoryboardParams(input: {
  storyboard_id: string;
  video_param_json: string | null;
  video_prompt: string | null;
}): Promise<void> {
  return invoke<void>("update_storyboard_params", { input });
}

/** 提交一个分镜视频生成任务。Worker 会读取已持久化的 promptDoc 序列化文本和 mention_map。 */
export async function generateStoryboardVideo(input: {
  storyboard_id: string;
}): Promise<{ task_id: string }> {
  return invoke<{ task_id: string }>("generate_storyboard_video", { input });
}

/**
 * 实时更新分镜时长（秒），写回分镜记录本身。
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
  duration: number | null;
}

export async function listStoryboardVideos(storyboardId: string): Promise<StoryboardVideoInfo[]> {
  return invoke<StoryboardVideoInfo[]>("list_storyboard_videos", { storyboardId });
}

export async function addStoryboardVideo(input: {
  storyboard_id: string;
  video_path: string;
  file_name?: string;
}): Promise<StoryboardVideoInfo> {
  return invoke<StoryboardVideoInfo>("add_storyboard_video", { input });
}

export async function deleteStoryboardVideo(input: {
  storyboard_id: string;
  video_id: string;
  delete_file?: boolean;
}): Promise<void> {
  return invoke("delete_storyboard_video", { input });
}

// ── 视频拼接 ─────────────────────────────────────────────

/** 可拼接的分镜视频片段（含选中视频路径、时长） */
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
}

/** 拼接进度事件载荷（后端通过 Tauri event 推送） */
export interface ConcatProgressEvent {
  percent: number;
  stage: string;
}

/** 查询片段下「已选中分镜视频」的有序列表 */
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
}
export async function saveConcatOutput(input: SaveConcatOutputInput): Promise<string> {
  return invoke<string>("save_concat_output", { input });
}

/** 删除一条拼接成片（数据库记录，可选同时删除文件） */
export async function deleteConcatOutput(id: string, deleteFile = true): Promise<void> {
  return invoke<void>("delete_concat_output", { input: { id, delete_file: deleteFile } });
}

/** 成片列表行 */
export interface ConcatOutputRow {
  id: string;
  output_path: string;
  file_name: string;
  duration: number;
  segment_count: number;
  audio_included: boolean;
  created_at: string;
}

/** 查询指定片段的所有拼接成片 */
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
