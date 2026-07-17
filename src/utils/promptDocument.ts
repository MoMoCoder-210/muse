/**
 * 分镜提示词文档模型。
 *
 * `promptDoc` 是编辑器的唯一主数据：普通文本和资产 mention 都存为节点。
 * `video_prompt` 仅由 promptDoc 序列化得到，供数据库、任务和外部视频 API 使用。
 */

export type PromptDocNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PromptDocNode[];
};

export type PromptDoc = PromptDocNode;

export interface PromptMention {
  n: number;
  assetId: string;
  name: string;
  type: string;
  imagePath: string | null;
  assetTag: string;
}

export interface PromptMentionAttrs {
  /** Tiptap Mention 所需的节点标识；与 assetId 相同。 */
  id: string | null;
  index: number;
  kind: "图片";
  label: string;
  assetId: string | null;
  assetType: string | null;
  imagePath: string | null;
  assetTag: string;
}

export function createAssetTag(name: string, index: number): string {
  return `${name}(@图片${index})`;
}

/**
 * 动态标注：在原始提示词中为资产名插入 (@图片N)。
 *
 * - 台词区域（<…>）内跳过，不标注
 * - 已存在的 (@图片\d+) 不重复标注（旧数据兼容）
 * - 资产名按最长优先匹配，避免 "甲" 误匹配 "同事甲"
 */
export function annotatePrompt(rawText: string, mentions: PromptMention[]): string {
  if (!rawText || mentions.length === 0) return rawText;

  // 如果文本已含 (@图片\d+)，说明是旧数据已标注，直接返回
  if (/\(@图片\d+\)/.test(rawText)) return rawText;

  // 按名称长度降序，长名优先匹配
  const sorted = [...mentions].sort((a, b) => b.name.length - a.name.length);

  const assetTag = (m: PromptMention) => m.assetTag || createAssetTag(m.name, m.n);
  const tagRe = /^\(@图片\d+\)/;

  let result = "";
  let cursor = 0;

  while (cursor < rawText.length) {
    // 跳过台词区域 <…>
    if (rawText[cursor] === "<") {
      const end = rawText.indexOf(">", cursor + 1);
      if (end === -1) {
        result += rawText.slice(cursor);
        break;
      }
      result += rawText.slice(cursor, end + 1);
      cursor = end + 1;
      continue;
    }

    const matched = sorted.find((m) => rawText.startsWith(m.name, cursor));
    if (!matched) {
      result += rawText[cursor];
      cursor += 1;
      continue;
    }

    const after = rawText.slice(cursor + matched.name.length);
    // 已是 (@图片N) 则跳过
    if (tagRe.test(after)) {
      result += matched.name;
      cursor += matched.name.length;
      continue;
    }

    result += assetTag(matched);
    cursor += matched.name.length;
  }

  return result;
}

export function normalizeMention(raw: Partial<PromptMention>): PromptMention | null {
  const n = Number(raw.n);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const assetId = typeof raw.assetId === "string" ? raw.assetId : "";
  if (!Number.isInteger(n) || n < 1 || !name || !assetId) return null;

  return {
    n,
    assetId,
    name,
    type: typeof raw.type === "string" ? raw.type : "",
    imagePath: typeof raw.imagePath === "string" ? raw.imagePath : null,
    assetTag: typeof raw.assetTag === "string" && raw.assetTag
      ? raw.assetTag
      : createAssetTag(name, n),
  };
}

export function normalizeMentions(raw: unknown): PromptMention[] {
  if (!Array.isArray(raw)) return [];
  const byIndex = new Map<number, PromptMention>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const mention = normalizeMention(value as Partial<PromptMention>);
    if (mention) byIndex.set(mention.n, mention);
  }
  return [...byIndex.values()].sort((a, b) => a.n - b.n);
}

export function isPromptDoc(value: unknown): value is PromptDoc {
  return Boolean(value)
    && typeof value === "object"
    && (value as PromptDoc).type === "doc"
    && Array.isArray((value as PromptDoc).content);
}

export function promptDocToPlainText(doc: PromptDoc): string {
  const nodeToText = (node: PromptDocNode): string => {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "mention") {
      const label = typeof node.attrs?.label === "string" ? node.attrs.label : "";
      const index = Number(node.attrs?.index);
      return Number.isInteger(index) && index > 0 ? createAssetTag(label, index) : label;
    }
    if (node.type === "hardBreak") return "\n";
    return node.content?.map(nodeToText).join("") ?? "";
  };

  return doc.content?.map(nodeToText).join("\n") ?? "";
}

/**
 * 旧数据迁移/LLM 初始数据的精确水合。
 * 只把 `mention_map` 中完整的 `assetTag` 转为 mention；绝不按名称或图片编号局部猜测。
 *
 * tags 已按 assetTag 长度降序排列，较长的名称优先匹配，天然避免子名称误匹配
 * （如"大猫(@图片1)"不会被"猫(@图片1)"错误识别）。
 * 移除了之前的左边界字符类检查——该检查误把 CJK 上下文词（如"在"）判定为名称字符，
 * 导致"在苏暖暖(@图片2)"这类合法位置被跳过，胶囊无法水合。
 */
function findAssetTag(source: string, tag: string): number {
  return source.indexOf(tag);
}

export function plainTextToPromptDoc(text: string, mentions: PromptMention[]): PromptDoc {
  const tags = mentions
    .filter((mention) => mention.assetTag)
    .sort((a, b) => b.assetTag.length - a.assetTag.length || a.n - b.n);

  const paragraph = (source: string): PromptDocNode => {
    if (!source || tags.length === 0) {
      return { type: "paragraph", content: source ? [{ type: "text", text: source }] : [] };
    }

    const content: PromptDocNode[] = [];
    let remaining = source;
    while (remaining) {
      let earliest = -1;
      let matched: PromptMention | undefined;
      for (const mention of tags) {
        const position = findAssetTag(remaining, mention.assetTag);
        if (position === -1) continue;
        if (earliest === -1 || position < earliest) {
          earliest = position;
          matched = mention;
        }
      }

      if (!matched || earliest === -1) {
        content.push({ type: "text", text: remaining });
        break;
      }
      if (earliest > 0) content.push({ type: "text", text: remaining.slice(0, earliest) });
      content.push({
        type: "mention",
        attrs: {
          id: matched.assetId,
          index: matched.n,
          kind: "图片",
          label: matched.name,
          assetId: matched.assetId,
          assetType: matched.type,
          imagePath: matched.imagePath,
          assetTag: matched.assetTag,
        } satisfies PromptMentionAttrs,
      });
      remaining = remaining.slice(earliest + matched.assetTag.length);
    }
    return { type: "paragraph", content };
  };

  return { type: "doc", content: text.split("\n").map(paragraph) };
}

/** 为已持久化的文档补齐最新缩略图，且不改变 mention 的名称或稳定编号。 */
export function hydratePromptDoc(doc: PromptDoc, mentions: PromptMention[]): PromptDoc {
  const byIndex = new Map(mentions.map((mention) => [mention.n, mention]));
  const copyNode = (node: PromptDocNode): PromptDocNode => {
    const content = node.content?.map(copyNode);
    if (node.type !== "mention") return { ...node, ...(content ? { content } : {}) };

    const index = Number(node.attrs?.index);
    const mapped = byIndex.get(index);
    if (!mapped) return { ...node, ...(content ? { content } : {}) };
    return {
      ...node,
      attrs: {
        ...node.attrs,
        id: mapped.assetId,
        index: mapped.n,
        kind: "图片",
        label: mapped.name,
        assetId: mapped.assetId,
        assetType: mapped.type,
        imagePath: mapped.imagePath,
        assetTag: mapped.assetTag,
      } satisfies PromptMentionAttrs,
      ...(content ? { content } : {}),
    };
  };
  return copyNode(doc);
}

export function collectMentionIndexes(doc: PromptDoc): number[] {
  const indexes = new Set<number>();
  const visit = (node: PromptDocNode) => {
    if (node.type === "mention") {
      const index = Number(node.attrs?.index);
      if (Number.isInteger(index) && index > 0) indexes.add(index);
    }
    node.content?.forEach(visit);
  };
  visit(doc);
  return [...indexes].sort((a, b) => a - b);
}
