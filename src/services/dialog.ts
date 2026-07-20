import { open } from "@tauri-apps/plugin-dialog";

/**
 * 弹出文件选择器，仅允许选择单个 .txt 文件。
 */
export async function pickTxtFile(options?: { title?: string }): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "文本文件", extensions: ["txt"] }],
    title: options?.title ?? "选择文本文件",
  });

  if (typeof selected === "string" && selected.trim()) {
    return selected;
  }
  return null;
}

/**
 * 弹出文件选择器，选择单个视频文件。
 */
export async function pickVideoFile(options?: { title?: string }): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "视频文件", extensions: ["mp4", "mov", "avi", "mkv", "webm"] }],
    title: options?.title ?? "选择本地视频",
  });

  if (typeof selected === "string" && selected.trim()) {
    return selected;
  }
  return null;
}
