/**
 * buildVideoContent.ts
 *
 * 从提示词文本中解析 @mention 引用标记，生成豆包 Seedance 2.0 API 所需的 content 数组格式。
 *
 * 提示词中使用语法：
 *   (@图片N)  — 引用第 N 张参考图片，如 "老兵A(@图片1)站在门前"
 *   (@音频N)  — 引用第 N 个参考音频（预留，当前仅支持图片）
 *
 * 输出的 content 数组结构与 API 完全对齐：
 *   [{ type:"text", text: string }, ...{ role:"reference_image", image_url:{url}, index:N, text:string, type:"image_url" }]
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

/** content 数组中的参考图元素 */
export interface ContentImageItem {
  role: "reference_image";
  image_url: { url: string };
  index: number;
  text: string;
  type: "image_url";
}

/** content 数组中的参考音频元素（预留） */
export interface ContentAudioItem {
  role: "reference_audio";
  audio_url: { url: string };
  index: number;
  text: string;
  type: "audio_url";
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
 * 根据已知的序号映射（N → 资产详情），将 prompt 编译为 API 所需的 content 数组。
 *
 * @param prompt      包含 (@图片N) 标记的提示词文本
 * @param mentionMap  序号 → 资产详情的映射 Map<number, { assetId, name, imagePath }>
 * @param urlResolver 将本地图片路径转为 API 可访问 URL 的函数（默认为 identity）
 * @param _videoParams 视频参数（ratio/duration/resolution 在调用侧传入 API body）
 * @returns           可序列化为 API body 的 content 数组
 */
export function buildContentArray(
  prompt: string,
  mentionMap: Map<number, { assetId: string; name: string; imagePath: string | null }>,
  urlResolver: (info: { assetId: string; imagePath: string | null }) => string = ({ imagePath }) =>
    imagePath ?? "",
): ContentItem[] {
  const indexes = parseMentionIndexes(prompt);
  return buildContentArrayFromIndexes(prompt, indexes, mentionMap, urlResolver);
}

/** 内部方法：使用预解析的索引构建 content 数组，避免重复解析 */
function buildContentArrayFromIndexes(
  prompt: string,
  indexes: ReturnType<typeof parseMentionIndexes>,
  mentionMap: Map<number, { assetId: string; name: string; imagePath: string | null }>,
  urlResolver: (info: { assetId: string; imagePath: string | null }) => string,
): ContentItem[] {
  const visited = new Set<number>();

  const refs: ContentItem[] = [];
  // 按 prompt 中出现顺序收集 reference 条目（去重）
  for (const { index, type } of indexes) {
    if (visited.has(index)) continue;
    visited.add(index);
    const asset = mentionMap.get(index);
    if (!asset) continue; // 无对应资产则跳过
    const url = urlResolver({ assetId: asset.assetId, imagePath: asset.imagePath });

    if (type === "image") {
      refs.push({
        role: "reference_image",
        image_url: { url },
        index,
        text: asset.name,
        type: "image_url",
      });
    } else {
      refs.push({
        role: "reference_audio",
        audio_url: { url },
        index,
        text: asset.name,
        type: "audio_url",
      });
    }
  }

  // content[0] = prompt 文本
  const textItem: ContentTextItem = { type: "text", text: prompt };
  return [textItem, ...refs];
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
  const indexes = parseMentionIndexes(prompt);
  const content = buildContentArrayFromIndexes(
    prompt,
    indexes,
    mentionMap,
    urlResolver ?? (({ imagePath }) => imagePath ?? ""),
  );
  const mentions = indexes.map(({ index, type }) => {
    const asset = mentionMap.get(index);
    return {
      assetId: asset?.assetId ?? "",
      name: asset?.name ?? `@${type}${index}`,
      type: type === "image" ? "image" : "audio",
      imagePath: asset?.imagePath ?? null,
      index,
    };
  });

  return {
    content,
    mentions,
    ratio: videoParams.aspect_ratio,
    duration: videoParams.duration,
    resolution: videoParams.resolution,
  };
}
