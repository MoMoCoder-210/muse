import { randomUUID } from "crypto";
import { mkdir } from "fs/promises";
import { join } from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import type { TaskContext } from "../types.js";
import type { VideoReference } from "../clients/video.js";
import { l, lw } from "../utils/utils.js";

const ARK_UPLOAD_MAX_ATTEMPTS = 3;
const ARK_UPLOAD_RETRY_DELAY_MS = 1_000;
const MAX_SEEDANCE_REFERENCE_IMAGES = 9;

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
  for (const { imageId, fileId } of arkFiles) {
    const imageIds = imageIdsByFileId.get(fileId) ?? [];
    imageIds.push(imageId);
    imageIdsByFileId.set(fileId, imageIds);
  }

  for (const [fileId, imageIds] of imageIdsByFileId) {
    try {
      await assetClient.deleteFile(fileId);
      const clearCache = ctx.db.prepare(`
        UPDATE asset_images
        SET ark_file_id = NULL, ark_upload_status = 'pending', ark_upload_error = NULL
        WHERE id = ? AND ark_file_id = ?
      `);
      const tx = ctx.db.transaction(() => {
        for (const imageId of imageIds) clearCache.run(imageId, fileId);
      });
      tx();
      l("视频生成", `已删除方舟参考文件 fileId=${fileId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 视频已成功落盘；保留 file_id 以便下次视频任务复用并再次尝试清理。
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
  const { references, arkFiles } = await resolveReferences(ctx.db, ctx, mentions);

  const project = ctx.db.prepare("SELECT workspace_path FROM projects WHERE id = ?").get(input.projectId) as {
    workspace_path: string;
  } | undefined;
  if (!project) throw new Error("项目不存在");

  const outputDir = join(project.workspace_path, "videos", "storyboards");
  await mkdir(outputDir, { recursive: true });
  const fileName = `sb_${String(storyboard.seq_num).padStart(3, "0")}_${Date.now()}.mp4`;
  const filePath = join(outputDir, fileName);

  l("视频生成", `提交 storyboardId=${input.storyboardId} refs=${references.length} prompt=${prompt.length}字符`);
  const result = await videoClient.generate(prompt, references, filePath, {
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
