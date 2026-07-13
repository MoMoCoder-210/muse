/**
 * 统计 clip_scripts.extracted_resources_json 中各类资产数量。
 *
 * @param resourcesJson 拆解输出的 JSON 字符串
 * @returns 例如 "角色3·场景2·物品1"
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
    if (c) parts.push(`角色${c}`);
    if (s) parts.push(`场景${s}`);
    if (i) parts.push(`物品${i}`);
    return parts.join("·");
  } catch {
    return "";
  }
}
