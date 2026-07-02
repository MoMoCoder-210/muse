/**
 * Tauri IPC 调用封装
 * 所有 invoke 调用集中在这里，组件不直接引入 @tauri-apps/api
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  ProjectInfo,
  CreateProjectInput,
  ImportScriptInput,
  ImportScriptResult,
  Clip,
  ScriptSource,
  UpdateClipInput,
  SplitClipInput,
  SplitClipResult,
} from "../types/project";

export async function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

export async function listProjects(): Promise<ProjectInfo[]> {
  return invoke<ProjectInfo[]>("list_projects");
}

export async function getProject(projectId: string): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("get_project", { projectId });
}

export async function createProject(input: CreateProjectInput): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("create_project", { input });
}

export async function startWorker(projectId?: string): Promise<string> {
  return invoke<string>("start_worker", { projectId });
}

export async function importScript(input: ImportScriptInput): Promise<ImportScriptResult> {
  return invoke<ImportScriptResult>("import_script", { input });
}

export async function listClips(projectId: string): Promise<Clip[]> {
  return invoke<Clip[]>("list_clips", { projectId });
}

export async function getScriptSource(projectId: string): Promise<ScriptSource | null> {
  return invoke<ScriptSource | null>("get_script_source", { projectId });
}

export async function deleteProject(projectId: string, deleteFiles: boolean): Promise<void> {
  return invoke<void>("delete_project", { projectId, deleteFiles });
}

// ── 片段操作（模块 02 第 9-10 节） ──────────────────────────
// @author yt @date 20260702 新增片段级写操作 IPC

/** 批量软删除片段，支持单条（传长度1数组）或多条 */
export async function deleteClips(clipIds: string[]): Promise<void> {
  return invoke<void>("delete_clips", { input: { clip_ids: clipIds } });
}

/** 更新片段标题/摘要/正文，返回更新后的片段 */
export async function updateClip(input: UpdateClipInput): Promise<Clip> {
  return invoke<Clip>("update_clip", { input });
}

/** 在指定字符位置把一个片段拆成两个，返回两段 id */
export async function splitClip(input: SplitClipInput): Promise<SplitClipResult> {
  return invoke<SplitClipResult>("split_clip", { input });
}

export async function ensureWorkerAndImportScript(
  projectId: string,
  input: Omit<ImportScriptInput, "project_id">,
): Promise<ImportScriptResult> {
  await startWorker(projectId);
  return importScript({ ...input, project_id: projectId });
}

// ── 设置 ──────────────────────────────────────────────────
import type { AppSettings } from "../types/settings";

export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}
