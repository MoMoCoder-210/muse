import { getSettings, ensureWorkerAndImportScript, inspectScriptFile } from "./tauri";
import { getActiveChannel } from "../types/settings";
import type { ImportScriptResult } from "../types/project";

export const MAX_SCRIPT_CHARACTERS = 80_000;

export function countScriptCharacters(text: string): number {
  return Array.from(text.trim()).length;
}

export function assertScriptLength(text: string): void {
  const charCount = countScriptCharacters(text);
  if (charCount === 0) throw new Error("剧本内容不能为空");
  if (charCount > MAX_SCRIPT_CHARACTERS) {
    throw new Error(`剧本字符数（${charCount}）超过单次导入上限（${MAX_SCRIPT_CHARACTERS}）`);
  }
}

export async function inspectScriptImportFile(filePath: string): Promise<number> {
  const result = await inspectScriptFile(filePath);
  return result.char_count;
}

/**
 * 检查文本模型(活跃渠道)是否已配置 API Key。
 *
 * @returns true 表示已配置，false 表示未配置
 */
export async function hasTextModelApiKey(): Promise<boolean> {
  const settings = await getSettings();
  const active = getActiveChannel(settings.text);
  return !!active?.apiKey?.trim();
}

/**
 * 根据当前 Tab（粘贴或文件）构造入参并启动剧本导入/拆分。
 *
 * @param projectId 作品 ID
 * @param tab       当前导入方式
 * @param pasteText 粘贴的文本内容（file 模式下可忽略）
 * @param filePath  文件路径（paste 模式下可忽略）
 * @returns 导入结果
 */
export async function importScriptByTab(
  projectId: string,
  tab: "paste" | "file",
  pasteText: string,
  filePath: string,
): Promise<ImportScriptResult> {
  if (tab === "paste") assertScriptLength(pasteText);
  return ensureWorkerAndImportScript(projectId, {
    source_type: tab === "file" ? "txt" : "paste",
    content: tab === "paste" ? pasteText.trim() : undefined,
    file_path: tab === "file" ? filePath : undefined,
  });
}
