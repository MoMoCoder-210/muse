/**
 * buildVideoContent.ts
 *
 * 从提示词文本中解析 @mention 引用标记，生成豆包 Seedance 2.0 API 所需的 content 数组格式。
 *
 * ── 官方 Volcengine API 格式 ──────────────────────────────────────────────
 * POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
 *
 * content 数组结构（多模态参考模式）：
 *   [
 *     { type: "text", text: "提示词，用「图片1」「图片2」在文字中自然引用" },
 *     { type: "image_url", image_url: { url: "..." }, role: "reference_image" },
 *     { type: "image_url", image_url: { url: "..." }, role: "reference_image" },
 *     { type: "audio_url", audio_url: { url: "..." }, role: "reference_audio" },
 *   ]
 *
 * 注意：
 * - 官方格式 **无 index 字段**，模型按数组顺序自动编号（第1个 reference_image = 图片1）
 * - 本项目在提示词中使用 (@图片N) 语法标注引用，buildContentArray 解析后
 *   按序号顺序输出 reference_image/reference_audio 条目，确保顺序与文本一致
 * - 上传图片需先通过 asset:// 协议或公网 URL，本地路径须在调用侧转换
 *
 * 使用方式：
 *   const { content, ratio, duration } = buildVideoContent(prompt, mentionMap, videoParams);
 */

/* ------------------------------------------------------------------ */
/*  类型                                                               */
/* ------------------------------------------------------------------ */

/** 单个 @mention 所在的资产信息 */
export interface MentionAsset {
  /** 资产 ID（数据库 UUID） */
  assetId: string;
  /** 资产名称（用于 reference_image.text 字段） */
  name: string;
  /** 资产类型 */
  type: string;
  /** 选中图片的本地路径（待上传/转 URL 后填入） */
  imagePath: string | null;
  /** 从 prompt 解析得到的序号 N */
  index: number;
}

/** 视频生成参数 */
export interface VideoGenParams {
  model: string;
  duration: number;
  resolution: string;
  aspect_ratio: string;
}

/** content 数组中的文本元素 */
export interface ContentTextItem {
  type: "text";
  text: string;
}

/** content 数组中的参考图元素（官方格式：无 index/text 字段，顺序即编号） */
export interface ContentImageItem {
  type: "image_url";
  image_url: { url: string };
  role: "reference_image";
}

/** content 数组中的参考音频元素（官方格式：无 index/text 字段，顺序即编号） */
export interface ContentAudioItem {
  type: "audio_url";
  audio_url: { url: string };
  role: "reference_audio";
}

export type ContentItem = ContentTextItem | ContentImageItem | ContentAudioItem;

/** 构建结果 */
export interface BuildResult {
  /** API 请求用的 content 数组 */
  content: ContentItem[];
  /** 每项 @mention 的资产详情（供调用方做文件上传 / URL 改写） */
  mentions: MentionAsset[];
  /** 宽高比 */
  ratio: string;
  /** 时长 */
  duration: number;
  /** 分辨率 */
  resolution: string;
}

/* ------------------------------------------------------------------ */
/*  核心函数                                                           */
/* ------------------------------------------------------------------ */

/** regex: 匹配 (@图片N) 或 (@音频N) */
const RE_TAG = /\(@图片(\d+)\)|\(@音频(\d+)\)/g;

/**
 * 从 prompt 文本中提取所有 @mention 序号
 * @returns 有序的 { index: number, type: "image"|"audio" }[]（按出现顺序）
 */
export function parseMentionIndexes(prompt: string): Array<{ index: number; type: "image" | "audio" }> {
  const results: Array<{ index: number; type: "image" | "audio" }> = [];
  let m: RegExpExecArray | null;
  RE_TAG.lastIndex = 0;
  while ((m = RE_TAG.exec(prompt)) !== null) {
    if (m[1]) {
      // (@图片N) 捕获组1
      results.push({ index: Number(m[1]), type: "image" });
    } else if (m[2]) {
      // (@音频N) 捕获组2
      results.push({ index: Number(m[2]), type: "audio" });
    }
  }
  return results;
}

/**
 * 将稳定的 mention_map 编译为参考图数组。
 *
 * Seedance 根据 content 内 reference_image 的位置编号，因此数组必须按 N 升序且 1..N
 * 连续。我们保留已删除胶囊的映射项以填补编号，避免保存的 `(@图片N)` 与 API 图片序号漂移。
 */
function orderedReferenceAssets(
  mentionMap: Map<number, { assetId: string; name: string; imagePath: string | null }>,
): Array<{ index: number; assetId: string; name: string; imagePath: string | null }> {
  const entries = [...mentionMap.entries()]
    .filter(([index]) => Number.isInteger(index) && index > 0)
    .map(([index, asset]) => ({ index, ...asset }))
    .sort((a, b) => a.index - b.index);

  for (let position = 0; position < entries.length; position++) {
    const expected = position + 1;
    if (entries[position].index !== expected) {
      throw new Error(`图片引用编号不连续：缺少 @图片${expected}，无法保证视频请求引用正确`);
    }
  }
  return entries;
}

/** 内部方法：按稳定 N 构建内容，而非按提示词首次出现顺序构建。 */
function buildContentArrayFromMap(
  prompt: string,
  mentionMap: Map<number, { assetId: string; name: string; imagePath: string | null }>,
  urlResolver: (info: { assetId: string; imagePath: string | null }) => string,
): ContentItem[] {
  const refs: ContentImageItem[] = orderedReferenceAssets(mentionMap).map((asset) => ({
    type: "image_url",
    image_url: { url: urlResolver({ assetId: asset.assetId, imagePath: asset.imagePath }) },
    role: "reference_image",
  }));
  return [{ type: "text", text: prompt }, ...refs];
}

/**
 * 根据稳定编号映射将 prompt 编译为 API content。
 * 即使同一资产在正文出现多次，也只提交一次参考图；编号由 mention_map 的 N 决定。
 */
export function buildContentArray(
  prompt: string,
  mentionMap: Map<number, { assetId: string; name: string; imagePath: string | null }>,
  urlResolver: (info: { assetId: string; imagePath: string | null }) => string = ({ imagePath }) => imagePath ?? "",
): ContentItem[] {
  return buildContentArrayFromMap(prompt, mentionMap, urlResolver);
}

/**
 * 一站式构建：解析 prompt + 组装完整 API 参数。
 *
 * @param prompt      包含 (@图片N) 标记的提示词
 * @param mentionMap  序号 → { assetId, name, imagePath } 映射
 * @param videoParams 视频生成参数
 * @param urlResolver 可选：将本地路径转为 API URL
 */
export function buildVideoContent(
  prompt: string,
  mentionMap: Map<number, { assetId: string; name: string; imagePath: string | null }>,
  videoParams: VideoGenParams,
  urlResolver?: (info: { assetId: string; imagePath: string | null }) => string,
): BuildResult {
  const content = buildContentArrayFromMap(
    prompt,
    mentionMap,
    urlResolver ?? (({ imagePath }) => imagePath ?? ""),
  );
  const mentions = orderedReferenceAssets(mentionMap).map((asset) => ({
    assetId: asset.assetId,
    name: asset.name,
    type: "image",
    imagePath: asset.imagePath,
    index: asset.index,
  }));

  return {
    content,
    mentions,
    ratio: videoParams.aspect_ratio,
    duration: videoParams.duration,
    resolution: videoParams.resolution,
  };
}
