/**
 * Tauri IPC 调用封装
 *
 * 所有 invoke 调用集中在这里，组件不直接引入 @tauri-apps/api
 *
 * @author yt @date 20260702
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
 * @author yt @date 20260702
 */
export async function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

/**
 * 列出所有项目
 *
 * @author yt @date 20260702
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  return invoke<ProjectInfo[]>("list_projects");
}

/**
 * 获取单个项目详情
 *
 * @author yt @date 20260702
 */
export async function getProject(projectId: string): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("get_project", { projectId });
}

/**
 * 创建新项目
 *
 * @author yt @date 20260702
 */
export async function createProject(input: CreateProjectInput): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("create_project", { input });
}

/**
 * 启动工作进程
 *
 * @author yt @date 20260702
 */
export async function startWorker(projectId?: string): Promise<string> {
  return invoke<string>("start_worker", { projectId });
}

/**
 * 导入剧本
 *
 * @author yt @date 20260702
 */
export async function importScript(input: ImportScriptInput): Promise<ImportScriptResult> {
  return invoke<ImportScriptResult>("import_script", { input });
}

/**
 * 手动创建单个片段（无剧本归属）
 *
 * @author yt @date 20260703
 */
export async function createClip(input: { project_id: string; title: string; source_text: string }): Promise<Clip> {
  return invoke<Clip>("create_clip", { input });
}

/**
 * 列出项目下的所有片段
 *
 * @author yt @date 20260702
 */
export async function listClips(projectId: string): Promise<Clip[]> {
  return invoke<Clip[]>("list_clips", { projectId });
}

/**
 * 获取剧本源内容
 *
 * @author yt @date 20260702
 */
export async function getScriptSource(projectId: string): Promise<ScriptSource | null> {
  return invoke<ScriptSource | null>("get_script_source", { projectId });
}

/**
 * 列出项目所有剧本源
 *
 * @author yt @date 20260703
 */
export async function listScriptSources(projectId: string): Promise<ScriptSourceListItem[]> {
  return invoke<ScriptSourceListItem[]>("list_script_sources", { projectId });
}

/**
 * 删除项目
 *
 * @author yt @date 20260702
 */
export async function deleteProject(projectId: string, deleteFiles: boolean): Promise<void> {
  return invoke<void>("delete_project", { projectId, deleteFiles });
}

/** @author yt @date 20260702 新增片段级写操作 IPC */

/**
 * 批量软删除片段，支持单条（传长度1数组）或多条
 *
 * @author yt @date 20260702
 */
export async function deleteClips(clipIds: string[]): Promise<void> {
  return invoke<void>("delete_clips", { input: { clip_ids: clipIds } });
}

/**
 * 更新片段标题/摘要/正文，返回更新后的片段
 *
 * @author yt @date 20260702
 */
export async function updateClip(input: UpdateClipInput): Promise<Clip> {
  return invoke<Clip>("update_clip", { input });
}

/**
 * 在指定字符位置把一个片段拆成两个，返回两段 id
 *
 * @author yt @date 20260702
 */
export async function splitClip(input: SplitClipInput): Promise<SplitClipResult> {
  return invoke<SplitClipResult>("split_clip", { input });
}

/**
 * 确保工作进程已启动后导入剧本
 *
 * @author yt @date 20260702
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
 * @author yt @date 20260702
 */
export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

/**
 * 保存应用设置
 *
 * @author yt @date 20260702
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

// ── 片段拆解 ──────────────────────────────────────────────
import type { ClipScriptInfo, GenerateClipScriptInput } from "../types/project";

/**
 * 触发片段拆解任务
 *
 * @author yt @date 20260702
 */
export async function generateClipScript(input: GenerateClipScriptInput): Promise<{ task_id: string }> {
  return invoke<{ task_id: string }>("generate_clip_script", { input });
}

/**
 * 资产生图
 *
 * 根据资产拆解阶段生成的 prompt 创建 image 生成任务。
 *
 * @author yt @date 20260704
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
 * @author yt @date 20260704
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
}): Promise<void> {
  return invoke<void>("update_asset_in_clip", { input });
}

/**
 * 获取资产图片信息
 *
 * @author yt @date 20260705
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
 * @author yt @date 20260705
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
 * @author yt @date 20260705
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
 * 重试上传失败的资产图片
 *
 * @author yt @date 20260707
 */
export async function retryUploadAssetImage(imageId: string): Promise<void> {
  return invoke("retry_upload_asset_image", { imageId });
}

/**
 * 查询项目下指定类型的所有资产及其选中图片（资产选择器用）
 *
 * @author yt @date 20260707
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
 * @author yt @date 20260707
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
 * @author yt @date 20260705
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
 * @author yt @date 20260705
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
  ark_upload_status: string | null;  // "pending" | "uploaded" | "failed" | null
  ark_upload_error: string | null;
  created_at: string;
}[]> {
  return invoke("list_asset_image_tasks", { input });
}

/**
 * 选中资产的指定图片作为最终使用图片
 *
 * @author yt @date 20260705
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
 * @author yt @date 20260705
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
 * @author yt @date 20260704
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
 * @author yt @date 20260704
 */
export async function deleteAssets(assetIds: string[]): Promise<void> {
  return invoke<void>("delete_assets", { input: { asset_ids: assetIds } });
}


/**
 * 查询项目所有拆解记录（按 clip_id 去重，最新一条为准）
 *
 * @author yt @date 20260702
 */
export async function getClipScripts(projectId: string): Promise<ClipScriptInfo[]> {
  return invoke<ClipScriptInfo[]>("get_clip_scripts", { projectId });
}

/**
 * 取消片段拆解任务
 *
 * @author yt @date 20260702
 */
export async function cancelClipScript(clipId: string): Promise<void> {
  return invoke<void>("cancel_clip_script", { input: { clip_id: clipId } });
}

// ── 分镜 ─────────────────────────────────────────────────────────

/**
 * 查询指定片段的分镜列表
 *
 * @author yt @date 20260707
 */
export async function listStoryboards(clipId: string): Promise<Storyboard[]> {
  return invoke<Storyboard[]>("list_storyboards", { clipId });
}

/**
 * 查询指定片段的所有资产（含绑定图片路径）
 *
 * @author yt @date 20260707
 */
export async function listClipAssets(clipId: string): Promise<StoryboardAssetInfo[]> {
  return invoke<StoryboardAssetInfo[]>("list_clip_assets", { clipId });
}

/**
 * 更新分镜关联资产
 *
 * @author yt @date 20260707
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
 * @author yt @date 20260708
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
 * after_storyboard_id 为 null 则插入到最前面。
 *
 * @author yt @date 20260708
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
 * @author yt @date 20260708
 */
export async function deleteStoryboard(input: {
  storyboard_id: string;
}): Promise<void> {
  return invoke<void>("delete_storyboard", { input });
}

/**
 * 更新分镜的视频生成参数与提示词（失焦保存）
 *
 * @author yt @date 20260708
 */
export async function updateStoryboardParams(input: {
  storyboard_id: string;
  video_param_json: string | null;
  video_prompt: string | null;
}): Promise<void> {
  return invoke<void>("update_storyboard_params", { input });
}

/**
 * 实时更新分镜时长（秒），写回分镜记录本身。
 * 该时长即「模型拆解出来的分镜秒数」，可编辑并实时回写。
 */
export async function updateStoryboardDuration(input: {
  storyboard_id: string;
  duration: number | null;
}): Promise<void> {
  return invoke<void>("update_storyboard_duration", { input });
}

/**
 * 检测 FFmpeg/FFprobe 是否可用
 *
 * @author yt @date 20260708
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
 * 测试渠道连通性（OpenAI 兼容端点）
 *
 * 对 `${baseUrl}/models` 发起带 Bearer 鉴权的 GET，校验 key+url 是否可用。
 *
 * @author yt @date 20260710
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
