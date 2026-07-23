import { randomUUID } from "crypto";
import { mkdir, readFile } from "fs/promises";
import { join, extname } from "path";
import { tmpdir } from "os";
import type { Database as DatabaseType } from "better-sqlite3";
import type { TaskContext } from "../types.js";
import type { VideoReference } from "../clients/video.js";
import { l, lw } from "../utils/utils.js";

const TTS_SAMPLE_TEXT = "你好，很高兴认识你。";
const MAX_SEEDANCE_REFERENCE_IMAGES = 9;
const MAX_SEEDANCE_REFERENCE_AUDIOS = 3;

/** 将本地文件转为 Base64 data URL，用于 Seedance API 的 image_url/audio_url.url 字段。 */
const DATA_URL_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
  mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4",
};

async function fileToDataUrl(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const ext = extname(filePath).toLowerCase().replace(".", "");
  const mime = DATA_URL_MIME[ext] || "application/octet-stream";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

type StoredMention = {
  n: number;
  assetId: string;
  name: string;
  type: string;
  assetTag: string;
};

type StoredVideoParams = {
  model?: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  mention_map?: StoredMention[];
};

type VoiceBinding = {
  source: "public" | "local";
  filePath?: string;
  voiceId?: string;
  label?: string;
};

type VoiceEntry = { n: number; characterName: string; label?: string; filePath?: string };

/**
 * 解析 prompt 中的台词段，为有音色的人物注入 [@音频N] 并构建音频引用。
 * 返回 { annotatedPrompt, voiceEntries }
 */
async function injectVoiceReferences(
  db: DatabaseType,
  ctx: TaskContext,
  prompt: string,
  mentions: StoredMention[],
): Promise<{ annotatedPrompt: string; voiceEntries: VoiceEntry[] }> {
  // 查每个 mention 的 voice_binding_json
  const getVoiceBinding = db.prepare("SELECT voice_binding_json FROM assets WHERE id = ?");
  const voicedChars = new Map<string, { voiceBinding: VoiceBinding; n: number }>();

  for (const mention of mentions) {
    const row = getVoiceBinding.get(mention.assetId) as { voice_binding_json: string | null } | undefined;
    if (!row?.voice_binding_json) continue;
    try {
      const binding: VoiceBinding = JSON.parse(row.voice_binding_json);
      if (binding.source === "local" || binding.source === "public") {
        voicedChars.set(mention.name, { voiceBinding: binding, n: mention.n });
      }
    } catch { /* 忽略格式错误 */ }
  }

  // 上限校验
  if (voicedChars.size > MAX_SEEDANCE_REFERENCE_AUDIOS) {
    throw new Error(
      `人物绑定音色最高仅支持${MAX_SEEDANCE_REFERENCE_AUDIOS}个，当前已绑定${voicedChars.size}个，请移除多余人物音色后重试`,
    );
  }

  if (voicedChars.size === 0) return { annotatedPrompt: prompt, voiceEntries: [] };

  // 构建 VoiceEntry：直接使用本地文件路径（无 Ark 上传）
  const voiceEntries: VoiceEntry[] = [];

  for (const [name, { voiceBinding, n }] of voicedChars) {
    let voiceFilePath: string | undefined;

    if (voiceBinding.source === "local" && voiceBinding.filePath) {
      voiceFilePath = voiceBinding.filePath;
    } else if (voiceBinding.source === "public" && voiceBinding.voiceId) {
      // 公共音色：TTS 合成到临时文件
      const voiceClient = ctx.clients?.voice;
      if (voiceClient) {
        const tmpPath = join(tmpdir(), `tts_${randomUUID()}.mp3`);
        await voiceClient.synthesize(TTS_SAMPLE_TEXT, tmpPath, { voice: voiceBinding.voiceId });
        voiceFilePath = tmpPath;
        l("视频生成", `TTS 合成成功 name=${name} voiceId=${voiceBinding.voiceId}`);
      } else {
        lw("视频生成", `语音客户端未初始化，跳过公共音色 name=${name}`);
      }
    }

    voiceEntries.push({ n, characterName: name, label: voiceBinding.label, filePath: voiceFilePath });
  }

  // 为 prompt 中的台词段注入 [@音频N]
  let annotatedPrompt = prompt;
  for (const entry of voiceEntries) {
    const speakRe = new RegExp(`\\(@图片${entry.n}\\)说：<`, "g");
    annotatedPrompt = annotatedPrompt.replace(speakRe, `(@图片${entry.n})说：<[@音频${entry.n}]`);
  }

  return { annotatedPrompt, voiceEntries };
}

type ResolvedReferences = {
  references: VideoReference[];
};

async function resolveReferences(
  db: DatabaseType,
  mentions: StoredMention[],
): Promise<ResolvedReferences> {
  const selectedImage = db.prepare(`
    SELECT ai.id AS image_id, ai.image_path
    FROM assets a
    LEFT JOIN asset_images ai ON ai.id = a.selected_image_id
    WHERE a.id = ?
  `);

  const references: VideoReference[] = [];

  for (const mention of mentions) {
    const row = selectedImage.get(mention.assetId) as {
      image_id: string | null;
      image_path: string | null;
    } | undefined;
    if (!row?.image_id || !row.image_path) {
      throw new Error(`素材"${mention.name}"（@图片${mention.n}）尚未选择参考图片`);
    }

    const imageDataUrl = await fileToDataUrl(row.image_path);
    references.push({ type: "image_url", url: imageDataUrl });
  }

  return { references };
}

function parseParams(raw: string | null): StoredVideoParams {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? value as StoredVideoParams : {};
  } catch {
    return {};
  }
}

function normalizeResolution(value: string | undefined): "480p" | "720p" | "1080p" | "2k" | "4k" | undefined {
  switch (value) {
    case "420": case "480p": return "480p";
    case "720": case "720p": return "720p";
    case "1080": case "1080p": return "1080p";
    case "2k": case "4k": return value;
    default: return undefined;
  }
}

function stableMentions(raw: StoredMention[] | undefined, prompt: string): StoredMention[] {
  const byIndex = new Map<number, StoredMention>();
  for (const mention of raw ?? []) {
    if (!Number.isInteger(mention.n) || mention.n < 1 || !mention.assetId || !mention.name) continue;
    byIndex.set(mention.n, mention);
  }
  const mentions = [...byIndex.values()].sort((a, b) => a.n - b.n);
  for (let position = 0; position < mentions.length; position++) {
    const expected = position + 1;
    if (mentions[position].n !== expected) {
      throw new Error(`图片引用编号不连续：缺少 @图片${expected}，请在提示词中重新插入该素材后再生成`);
    }
  }
  if (mentions.length > MAX_SEEDANCE_REFERENCE_IMAGES) {
    throw new Error(`Seedance 2.0 最多支持 ${MAX_SEEDANCE_REFERENCE_IMAGES} 张参考图片，当前为 ${mentions.length} 张，请移除多余图片后重试`);
  }

  const promptIndexes = [...new Set(
    [...prompt.matchAll(/(?:\(@图片|@图片)(\d+)\)?/g)].map((match) => Number(match[1])),
  )].sort((a, b) => a - b);
  const mentionIndexes = mentions.map((mention) => mention.n);
  const promptMatchesMentions = promptIndexes.length === mentionIndexes.length
    && promptIndexes.every((index, position) => index === mentionIndexes[position]);
  if (!promptMatchesMentions) {
    throw new Error("提示词中的 @图片N 必须与已插入的参考图胶囊一一对应，请删除无效标签或重新插入图片后再生成");
  }

  return mentions;
}

/** 使用入队时冻结的 prompt/mention_map 生成一个视频批次。 */
export async function generateVideoHandler(ctx: TaskContext): Promise<string> {
  const input = ctx.taskInput as {
    projectId: string;
    clipId: string;
    storyboardId: string;
    videoPrompt?: string;
    videoParamJson?: string | null;
  };
  if (!input?.projectId || !input?.clipId || !input?.storyboardId) {
    throw new Error("generate_video: 缺少 projectId / clipId / storyboardId");
  }
  const videoClient = ctx.clients?.video;
  if (!videoClient) throw new Error("视频生成不可用：视频模型客户端未初始化");

  // 新任务的输入在 Tauri 入队时已冻结。仅兼容升级前遗留任务时才读取镜头当前值，
  // 避免用户后续编辑覆盖已经排队的批次。
  const storyboard = ctx.db.prepare(`
    SELECT seq_num, video_prompt, video_param_json
    FROM storyboards
    WHERE id = ? AND project_id = ? AND clip_id = ?
  `).get(input.storyboardId, input.projectId, input.clipId) as {
    seq_num: number;
    video_prompt: string | null;
    video_param_json: string | null;
  } | undefined;
  if (!storyboard) throw new Error("镜头不存在或不属于当前作品");
  const hasPromptSnapshot = typeof input.videoPrompt === "string";
  const hasParamsSnapshot = Object.prototype.hasOwnProperty.call(input, "videoParamJson");
  const prompt = (hasPromptSnapshot ? input.videoPrompt : storyboard.video_prompt)?.trim() ?? "";
  if (!prompt) throw new Error("提示词为空，无法生成视频");

  const params = parseParams(hasParamsSnapshot ? input.videoParamJson ?? null : storyboard.video_param_json);
  const mentions = stableMentions(params.mention_map, prompt);
  const { annotatedPrompt, voiceEntries } = await injectVoiceReferences(ctx.db, ctx, prompt, mentions);
  const { references: imageRefs } = await resolveReferences(ctx.db, mentions);

  // 音频引用拼入 content 数组（按 n 排序，保证 @音频N 编号一致）
  const voiceRefs: VideoReference[] = await Promise.all(
    voiceEntries
      .filter((e) => e.filePath)
      .sort((a, b) => a.n - b.n)
      .map(async (e) => ({ type: "audio_url", url: await fileToDataUrl(e.filePath!) })),
  );
  const references = [...imageRefs, ...voiceRefs];

  const project = ctx.db.prepare("SELECT workspace_path FROM projects WHERE id = ?").get(input.projectId) as {
    workspace_path: string;
  } | undefined;
  if (!project) throw new Error("作品不存在");

  const outputDir = join(project.workspace_path, "videos", "storyboards");
  await mkdir(outputDir, { recursive: true });
  // taskId 在每次点击时唯一，避免并发任务在同一毫秒生成同名输出文件。
  const fileName = `sb_${String(storyboard.seq_num).padStart(3, "0")}_${ctx.taskId}.mp4`;
  const filePath = join(outputDir, fileName);

  l("视频生成", `提交 storyboardId=${input.storyboardId} refs=${references.length} voices=${voiceEntries.length} prompt=${annotatedPrompt.length}字符`);
  const result = await videoClient.generate(annotatedPrompt, references, filePath, {
    model: params.model,
    ratio: params.aspect_ratio as "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | undefined,
    duration: params.duration,
    resolution: normalizeResolution(params.resolution),
    signal: ctx.signal,
  });

  const videoId = randomUUID();
  const tx = ctx.db.transaction(() => {
    ctx.db.prepare(`
      INSERT INTO storyboard_videos (id, storyboard_id, file_path, file_name, source, task_id, duration)
      VALUES (?, ?, ?, ?, 'generated', ?, ?)
    `).run(videoId, input.storyboardId, result.filePath, fileName, ctx.taskId, params.duration ?? null);
    ctx.db.prepare(`
      UPDATE storyboards
      SET video_state = 'ready',
          selected_video_id = COALESCE(selected_video_id, ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(videoId, input.storyboardId);
  });
  tx();

  return JSON.stringify({ storyboardId: input.storyboardId, videoId, filePath: result.filePath, model: result.model });
}
