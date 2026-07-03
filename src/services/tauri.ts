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
