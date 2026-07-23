/**
 * 统计 clip_scripts.extracted_resources_json 中各类素材数量。
 *
 * @param resourcesJson 拆解输出的 JSON 字符串
 * @returns 例如 "人物3·场景2·道具1"
 */
export function countResources(resourcesJson: string | null | undefined): string {
  if (!resourcesJson) return "";
  try {
    const data = JSON.parse(resourcesJson) as {
      characters?: unknown[];
      scenes?: unknown[];
      items?: unknown[];
    };
    const parts: string[] = [];
    const c = data.characters?.length ?? 0;
    const s = data.scenes?.length ?? 0;
    const i = data.items?.length ?? 0;
    if (c) parts.push(`人物${c}`);
    if (s) parts.push(`场景${s}`);
    if (i) parts.push(`道具${i}`);
    return parts.join("·");
  } catch {
    return "";
  }
}
