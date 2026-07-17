import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Database as DatabaseType } from "better-sqlite3";
import type { TaskContext } from "../types.js";
import type { VideoReference } from "../clients/video.js";
import { l, lw } from "../utils/utils.js";

const TTS_SAMPLE_TEXT = "你好，很高兴认识你。";
const ARK_UPLOAD_MAX_ATTEMPTS = 3;
const ARK_UPLOAD_RETRY_DELAY_MS = 1_000;
const MAX_SEEDANCE_REFERENCE_IMAGES = 9;
const MAX_SEEDANCE_REFERENCE_AUDIOS = 3;

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

type ArkReferenceFile = {
  imageId: string;
  fileId: string;
};

type VoiceBinding = {
  source: "public" | "local";
  filePath?: string;
  voiceId?: string;
  label?: string;
  arkFileId?: string;
};

type VoiceEntry = { n: number; characterName: string; arkFileId?: string; label?: string };

/**
 * 解析 prompt 中的台词段，为有音色的角色注入 [@音频N] 并构建音频引用。
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
      `角色绑定音色最高仅支持${MAX_SEEDANCE_REFERENCE_AUDIOS}个，当前已绑定${voicedChars.size}个，请移除多余角色音色后重试`,
    );
  }

  if (voicedChars.size === 0) return { annotatedPrompt: prompt, voiceEntries: [] };

  // 上传音频到 Ark + 构建 VoiceEntry（缓存复用逻辑与 resolveReferences 一致）
  const assetClient = ctx.clients?.asset;
  const writeVoiceBinding = db.prepare("UPDATE assets SET voice_binding_json = ? WHERE id = ?");
  const voiceEntries: VoiceEntry[] = [];
  const uploadedFiles: ArkReferenceFile[] = [];

  const getMentionAssetId = (name: string) => mentions.find((m) => m.name === name)?.assetId ?? "";

  try {
    for (const [name, { voiceBinding, n }] of voicedChars) {
      let arkFileId: string | undefined;

      if (voiceBinding.arkFileId) {
        // 缓存命中（本地或已合成的公共音色）
        arkFileId = voiceBinding.arkFileId;
        l("视频生成", `角色音频复用缓存 name=${name} @音频${n} arkFileId=${arkFileId}`);
      } else if (voiceBinding.source === "local" && voiceBinding.filePath) {
        if (!assetClient) throw new Error("方舟文件上传客户端未初始化");
        const uploaded = await assetClient.uploadImage(voiceBinding.filePath);
        arkFileId = uploaded.id;
        l("视频生成", `角色音频上传成功 name=${name} @音频${n} arkFileId=${arkFileId}`);
      } else if (voiceBinding.source === "public" && voiceBinding.voiceId) {
        // 公共音色：TTS 合成 → 上传 Ark
        const voiceClient = ctx.clients?.voice;
        if (!voiceClient) { lw("视频生成", `语音客户端未初始化，跳过公共音色 name=${name}`); }
        else {
          if (!assetClient) throw new Error("方舟文件上传客户端未初始化");
          const tmpPath = join(tmpdir(), `tts_${randomUUID()}.mp3`);
          const ttsResult = await voiceClient.synthesize(TTS_SAMPLE_TEXT, tmpPath, { voice: voiceBinding.voiceId });
          l("视频生成", `TTS 合成成功 name=${name} voiceId=${voiceBinding.voiceId} size=${ttsResult.sizeBytes}`);
          const uploaded = await assetClient.uploadImage(ttsResult.filePath);
          arkFileId = uploaded.id;
          l("视频生成", `TTS 音频上传成功 name=${name} @音频${n} arkFileId=${arkFileId}`);
        }
      }

      if (arkFileId) {
        const assetId = getMentionAssetId(name);
        if (assetId) {
          const updatedBinding = { ...voiceBinding, arkFileId };
          writeVoiceBinding.run(JSON.stringify(updatedBinding), assetId);
        }
        uploadedFiles.push({ imageId: getMentionAssetId(name), fileId: arkFileId });
      }

      voiceEntries.push({ n, characterName: name, arkFileId, label: voiceBinding.label });
    }

    // 为 prompt 中的台词段注入 [@音频N]
    // 用 mention_map 序号匹配 `(@图片N)说：<`，比人名正则更可靠
    let annotatedPrompt = prompt;
    for (const entry of voiceEntries) {
      const speakRe = new RegExp(`\\(@图片${entry.n}\\)说：<`, "g");
      annotatedPrompt = annotatedPrompt.replace(speakRe, `(@图片${entry.n})说：<[@音频${entry.n}]`);
    }

    return { annotatedPrompt, voiceEntries };
  } catch (error) {
    await cleanupArkFiles(ctx, uploadedFiles);
    throw error;
  }
}

type ResolvedReferences = {
  references: VideoReference[];
  arkFiles: ArkReferenceFile[];
};

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
    // 兼容旧版 UI/数据库保存的无单位数值。
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
      throw new Error(`图片引用编号不连续：缺少 @图片${expected}，请在提示词中重新插入该资产后再生成`);
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

async function waitForUploadRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) throw new Error("视频任务已取消");

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("视频任务已取消"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function uploadReferenceImage(
  db: DatabaseType,
  ctx: TaskContext,
  mention: StoredMention,
  imageId: string,
  imagePath: string,
): Promise<string> {
  const assetClient = ctx.clients?.asset;
  if (!assetClient) {
    const errorMessage = "方舟文件上传客户端未初始化，请检查视频渠道配置";
    db.prepare(`
      UPDATE asset_images
      SET ark_upload_status = 'failed', ark_upload_error = ?
      WHERE id = ?
    `).run(errorMessage, imageId);
    throw new Error(`参考图“${mention.name}”（@图片${mention.n}）上传失败：${errorMessage}`);
  }

  db.prepare(`
    UPDATE asset_images
    SET ark_upload_status = 'pending', ark_upload_error = NULL
    WHERE id = ?
  `).run(imageId);

  let lastError = "";
  for (let attempt = 1; attempt <= ARK_UPLOAD_MAX_ATTEMPTS; attempt++) {
    if (ctx.signal.aborted) throw new Error("视频任务已取消");

    try {
      l("视频生成", `上传参考图 @图片${mention.n}（${attempt}/${ARK_UPLOAD_MAX_ATTEMPTS}）`);
      const uploaded = await assetClient.uploadImage(imagePath);
      db.prepare(`
        UPDATE asset_images
        SET ark_file_id = ?, ark_upload_status = 'uploaded', ark_upload_error = NULL
        WHERE id = ?
      `).run(uploaded.id, imageId);
      l("视频生成", `参考图上传成功 @图片${mention.n} arkFileId=${uploaded.id}`);
      return uploaded.id;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      lw("视频生成", `参考图上传失败 @图片${mention.n}（${attempt}/${ARK_UPLOAD_MAX_ATTEMPTS}）：${lastError}`);
      if (attempt < ARK_UPLOAD_MAX_ATTEMPTS) {
        await waitForUploadRetry(ctx.signal, ARK_UPLOAD_RETRY_DELAY_MS * attempt);
      }
    }
  }

  db.prepare(`
    UPDATE asset_images
    SET ark_upload_status = 'failed', ark_upload_error = ?
    WHERE id = ?
  `).run(lastError, imageId);

  // 不携带底层网络错误文本，避免 TaskRunner 将本地重试耗尽误判为可继续重试的网络错误。
  throw new Error(`参考图“${mention.name}”（@图片${mention.n}）上传已重试${ARK_UPLOAD_MAX_ATTEMPTS}次仍失败，请检查图片上传错误详情`);
}

async function resolveReferences(
  db: DatabaseType,
  ctx: TaskContext,
  mentions: StoredMention[],
): Promise<ResolvedReferences> {
  const references: VideoReference[] = [];
  const arkFiles: ArkReferenceFile[] = [];
  const uploadedArkFiles: ArkReferenceFile[] = [];
  const selectedImage = db.prepare(`
    SELECT ai.id AS image_id, ai.image_path, ai.ark_file_id
    FROM assets a
    LEFT JOIN asset_images ai ON ai.id = a.selected_image_id
    WHERE a.id = ?
  `);

  try {
    for (const mention of mentions) {
      const row = selectedImage.get(mention.assetId) as {
        image_id: string | null;
        image_path: string | null;
        ark_file_id: string | null;
      } | undefined;
      if (!row?.image_id || !row.image_path) {
        throw new Error(`资产“${mention.name}”（@图片${mention.n}）尚未选择参考图片`);
      }

      const cachedArkFileId = row.ark_file_id;
      const arkFileId = cachedArkFileId
        ?? await uploadReferenceImage(db, ctx, mention, row.image_id, row.image_path);
      const arkFile = { imageId: row.image_id, fileId: arkFileId };

      // 方舟 file_id 是 Seedance reference_image 的合法 url 值；数组顺序就是图片编号。
      references.push({ type: "image_url", url: arkFileId });
      arkFiles.push(arkFile);
      if (!cachedArkFileId) uploadedArkFiles.push(arkFile);
    }
  } catch (error) {
    // 此时还未提交视频模型请求，安全删除本次已上传的临时参考文件。
    await cleanupArkFiles(ctx, uploadedArkFiles);
    throw error;
  }

  return { references, arkFiles };
}

async function cleanupArkFiles(ctx: TaskContext, arkFiles: ArkReferenceFile[]): Promise<void> {
  const assetClient = ctx.clients?.asset;
  if (!assetClient || arkFiles.length === 0) return;

  const imageIdsByFileId = new Map<string, string[]>();
  const assetIdsByFileId = new Map<string, string[]>(); // 音色文件：assetId
  for (const { imageId, fileId } of arkFiles) {
    if (imageId) {
      // imageId 非空时是 asset_images.id（图片）或 assets.id（音色）
      // 优先按 asset_images 匹配；不匹配则视为音色 asset
      const list = imageIdsByFileId.get(fileId) ?? [];
      list.push(imageId);
      imageIdsByFileId.set(fileId, list);
    }
  }

  for (const [fileId, imageIds] of imageIdsByFileId) {
    try {
      await assetClient.deleteFile(fileId);
      const clearCache = ctx.db.prepare(`
        UPDATE asset_images
        SET ark_file_id = NULL, ark_upload_status = 'pending', ark_upload_error = NULL
        WHERE id = ? AND ark_file_id = ?
      `);
      const clearVoiceCache = ctx.db.prepare(`
        UPDATE assets
        SET voice_binding_json = json_remove(voice_binding_json, '$.arkFileId')
        WHERE id = ? AND voice_binding_json LIKE ?
      `);
      const tx = ctx.db.transaction(() => {
        for (const id of imageIds) {
          clearCache.run(id, fileId);
          clearVoiceCache.run(id, `%${fileId}%`);
        }
      });
      tx();
      l("视频生成", `已删除方舟参考文件 fileId=${fileId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lw("视频生成", `方舟参考文件删除失败 fileId=${fileId}：${message}`);
    }
  }
}

/** 使用分镜已保存的 prompt/mention_map 生成一个视频批次。 */
export async function generateVideoHandler(ctx: TaskContext): Promise<string> {
  const input = ctx.taskInput as { projectId: string; clipId: string; storyboardId: string };
  if (!input?.projectId || !input?.clipId || !input?.storyboardId) {
    throw new Error("generate_video: 缺少 projectId / clipId / storyboardId");
  }
  const videoClient = ctx.clients?.video;
  if (!videoClient) throw new Error("视频生成不可用：视频模型客户端未初始化");

  const storyboard = ctx.db.prepare(`
    SELECT seq_num, video_prompt, video_param_json
    FROM storyboards
    WHERE id = ? AND project_id = ? AND clip_id = ?
  `).get(input.storyboardId, input.projectId, input.clipId) as {
    seq_num: number;
    video_prompt: string | null;
    video_param_json: string | null;
  } | undefined;
  if (!storyboard) throw new Error("分镜不存在或不属于当前项目");
  const prompt = storyboard.video_prompt?.trim() ?? "";
  if (!prompt) throw new Error("提示词为空，无法生成视频");

  const params = parseParams(storyboard.video_param_json);
  const mentions = stableMentions(params.mention_map, prompt);
  const { annotatedPrompt, voiceEntries } = await injectVoiceReferences(ctx.db, ctx, prompt, mentions);
  const { references: imageRefs, arkFiles } = await resolveReferences(ctx.db, ctx, mentions);

  // 音频引用拼入 content 数组（按 n 排序，保证 @音频N 编号一致）
  const voiceRefs: VideoReference[] = voiceEntries
    .filter((e) => e.arkFileId)
    .sort((a, b) => a.n - b.n)
    .map((e) => ({ type: "audio_url", url: e.arkFileId! }));
  const references = [...imageRefs, ...voiceRefs];

  const project = ctx.db.prepare("SELECT workspace_path FROM projects WHERE id = ?").get(input.projectId) as {
    workspace_path: string;
  } | undefined;
  if (!project) throw new Error("项目不存在");

  const outputDir = join(project.workspace_path, "videos", "storyboards");
  await mkdir(outputDir, { recursive: true });
  const fileName = `sb_${String(storyboard.seq_num).padStart(3, "0")}_${Date.now()}.mp4`;
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

  await cleanupArkFiles(ctx, arkFiles);

  return JSON.stringify({ storyboardId: input.storyboardId, videoId, filePath: result.filePath, model: result.model });
}
