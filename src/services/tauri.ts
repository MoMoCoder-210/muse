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
