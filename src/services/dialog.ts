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
