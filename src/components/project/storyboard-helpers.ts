/**
 * 分镜模块工具函数
 */
import type { PromptDoc } from "../../types/project";
import type { AssetMention } from "./MentionDropdown";
import { createAssetTag, promptDocToPlainText } from "../../utils/promptDocument";
import {
  VIDEO_DURATION_MIN, VIDEO_DURATION_MAX, VIDEO_ASPECT_OPTIONS,
  VIDEO_DEFAULT_MODEL, VIDEO_DEFAULT_DURATION, VIDEO_DEFAULT_RESOLUTION, VIDEO_DEFAULT_ASPECT,
  VIDEO_RESOLUTION_OPTIONS,
} from "../../config/muse";
import type { VideoParams } from "./storyboard-types";

// ── 通用工具 ──────────────────────────────────────────

export const parseIds = (j: string): Set<string> => {
  try { return new Set(JSON.parse(j) as string[]); } catch { return new Set(); }
};

export const formatStoryboardVideoFailure = () =>
  `视频生成失败，请检查模型配置`;

// ── 提示词引用规范化 ──────────────────────────────────

/**
 * Derive the reference map from the mention atoms that remain in the prompt.
 * Reindexing keeps Seedance's positional reference array aligned after a chip is removed.
 */
export function normalizePromptReferences(
  doc: PromptDoc,
  mentionMap: Map<number, AssetMention>,
): { promptDoc: PromptDoc; prompt: string; mentions: AssetMention[] } {
  const activeIndexes = new Set<number>();
  const collectIndexes = (node: PromptDoc) => {
    if (node.type === "mention") {
      const index = Number(node.attrs?.index);
      if (Number.isInteger(index) && index > 0) activeIndexes.add(index);
    }
    node.content?.forEach(collectIndexes);
  };
  collectIndexes(doc);

  const activeMentions = [...activeIndexes]
    .sort((a, b) => a - b)
    .map((index) => {
      const mention = mentionMap.get(index);
      if (!mention) {
        throw new Error(`@图片${index} 没有对应资产，请删除该引用后重新插入`);
      }
      return mention;
    });
  const newIndexByOldIndex = new Map(activeMentions.map((mention, position) => [mention.index, position + 1]));
  const mentions = activeMentions.map((mention, position) => ({
    ...mention,
    index: position + 1,
    assetTag: createAssetTag(mention.name, position + 1),
  }));
  const mentionByIndex = new Map(mentions.map((mention) => [mention.index, mention]));

  const rewriteIndexes = (node: PromptDoc): PromptDoc => {
    const content = node.content?.map(rewriteIndexes);
    if (node.type !== "mention") return { ...node, ...(content ? { content } : {}) };

    const oldIndex = Number(node.attrs?.index);
    const index = newIndexByOldIndex.get(oldIndex);
    const mention = index ? mentionByIndex.get(index) : undefined;
    if (!mention) throw new Error("提示词中存在无效图片引用，请删除后重新插入");

    return {
      ...node,
      attrs: {
        ...node.attrs,
        id: mention.assetId,
        index,
        kind: "图片",
        label: mention.name,
        assetId: mention.assetId,
        assetType: mention.type,
        imagePath: mention.imagePath,
        assetTag: mention.assetTag,
        deleted: mention.deleted,
      },
      ...(content ? { content } : {}),
    };
  };

  const promptDoc = rewriteIndexes(doc);
  const prompt = promptDocToPlainText(promptDoc);
  const tagIndexes = [...new Set(
    [...prompt.matchAll(/\(@图片(\d+)\)/g)].map((match) => Number(match[1])),
  )].sort((a, b) => a - b);
  const mentionIndexes = mentions.map((mention) => mention.index);
  const tagsMatchMentions = tagIndexes.length === mentionIndexes.length
    && tagIndexes.every((index, position) => index === mentionIndexes[position]);
  if (!tagsMatchMentions) {
    throw new Error("提示词中的图片引用必须与资产胶囊一一对应，请删除手工输入的无效 @图片N 后重试");
  }

  return { promptDoc, prompt, mentions };
}

// ── 视频参数 ──────────────────────────────────────────

export const DEFAULT_VIDEO_PARAMS: VideoParams = {
  model: VIDEO_DEFAULT_MODEL,
  duration: VIDEO_DEFAULT_DURATION,
  resolution: VIDEO_DEFAULT_RESOLUTION,
  aspect_ratio: VIDEO_DEFAULT_ASPECT,
};

/** 根据模型 ID 获取支持的分辨率列表 */
export function getResolutions(modelId: string, modelResMap: Record<string, string[]>): string[] {
  return (modelResMap[modelId] && modelResMap[modelId].length)
    ? modelResMap[modelId]
    : [...VIDEO_RESOLUTION_OPTIONS];
}

/** 将任意时长值夹取到合法范围内的整数 */
export function clampDuration(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return Math.min(VIDEO_DURATION_MAX, Math.max(VIDEO_DURATION_MIN, Math.round(v)));
}

/**
 * 解析视频参数。
 * @param json         已保存的 video_param_json
 * @param dbDuration   分镜数据库中存储的时长（video_duration ?? voice_duration），用作时长回退
 * @param videoModels  设置里配置的视频模型 → 分辨率映射
 */
export function parseVideoParams(json: string | null, dbDuration: number | null, videoModels: Record<string, string[]>): VideoParams {
  const fallbackDuration = clampDuration(dbDuration) ?? DEFAULT_VIDEO_PARAMS.duration;
  const defaultModel = Object.keys(videoModels)[0] ?? "";
  const base: VideoParams = { ...DEFAULT_VIDEO_PARAMS, model: defaultModel, duration: fallbackDuration };
  if (!json) return base;
  try {
    const obj = JSON.parse(json);
    const model = Object.prototype.hasOwnProperty.call(videoModels, obj.model) ? obj.model : defaultModel;
    const allowed = getResolutions(model, videoModels);
    const resolution = allowed.includes(obj.resolution) ? obj.resolution : allowed[0];
    return {
      model,
      duration: base.duration,
      resolution,
      aspect_ratio: VIDEO_ASPECT_OPTIONS.includes(obj.aspect_ratio) ? obj.aspect_ratio : base.aspect_ratio,
    };
  } catch {
    return base;
  }
}
