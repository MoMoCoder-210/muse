import { open } from "@tauri-apps/plugin-dialog";

/**
 * 弹出文件选择器，仅允许选择单个 .txt 文件。
 *
 * @returns 选中的绝对路径；用户取消或选择无效时返回 null
 * @author yt @date 20260703
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
