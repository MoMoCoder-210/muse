import { stripCodeFences } from "../utils/utils.js";

export type MaterializedClip = {
  sortIndex: number;
  title: string;
  summary: string;
  sourceText: string;
};

/** 将原文标为稳定的 1 起始行号，模型只可引用这些行边界。 */
export function formatNumberedScript(text: string): string {
  return text
    .split("\n")
    .map((line, index) => `[L${String(index + 1).padStart(6, "0")}] ${line}`)
    .join("\n");
}

/** 解析并校验模型返回的连续、完整行边界。 */
export function parseModelBoundaries(raw: string, lineCount: number): number[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFences(raw));
  } catch {
    throw new Error("模型拆分边界不是有效 JSON");
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("模型拆分边界格式无效：期望对象");
  }
  const boundaries = (payload as Record<string, unknown>).boundaries;
  if (!Array.isArray(boundaries) || boundaries.length === 0) {
    throw new Error("模型拆分边界格式无效：boundaries 必须是非空数组");
  }
  if (boundaries.length > lineCount) {
    throw new Error("模型拆分边界数量超过原文行数");
  }

  let previousEnd = 0;
  const ends = boundaries.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`模型拆分第 ${index + 1} 个边界不是有效对象`);
    }
    const endLine = (item as Record<string, unknown>).endLine;
    if (typeof endLine !== "number" || !Number.isSafeInteger(endLine)) {
      throw new Error(`模型拆分第 ${index + 1} 个 endLine 必须是整数`);
    }
    if (endLine <= previousEnd || endLine > lineCount) {
      throw new Error(`模型拆分第 ${index + 1} 个 endLine 越界或不递增`);
    }
    previousEnd = endLine;
    return endLine;
  });

  if (ends.at(-1) !== lineCount) {
    throw new Error(`模型拆分边界未覆盖完整原文：最后一行应为 ${lineCount}`);
  }
  return ends;
}

/** 基于经过验证的 endLine（包含该行）从原文切片，且验证拼回后逐字符一致。 */
export function materializeBoundaryClips(text: string, endLines: readonly number[]): MaterializedClip[] {
  const lines = text.split("\n").map((line, index, all) => index < all.length - 1 ? `${line}\n` : line);
  let start = 0;
  const clips = endLines.map((endLine, index) => {
    const sourceText = lines.slice(start, endLine).join("");
    start = endLine;
    if (!sourceText.trim()) {
      throw new Error(`模型拆分第 ${index + 1} 段为空`);
    }
    return {
      sortIndex: index + 1,
      title: `第${index + 1}集`,
      summary: "",
      sourceText,
    };
  });

  if (clips.map((clip) => clip.sourceText).join("") !== text) {
    throw new Error("模型拆分边界无法完整还原原文");
  }
  return clips;
}
