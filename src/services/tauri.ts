/**
 * Tauri IPC 调用封装
 * 所有 invoke 调用集中在这里，组件不直接引入 @tauri-apps/api
 */
import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo, CreateProjectInput } from "../types/project";

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
