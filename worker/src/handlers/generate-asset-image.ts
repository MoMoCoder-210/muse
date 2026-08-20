import { randomUUID } from "crypto";
import { unlink, mkdir } from "fs/promises";
import { join } from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import type { TaskContext } from "../types.js";
import { generateImageThumbnail, imageThumbnailPath } from "../media.js";
import { l, le } from "../utils/utils.js";

/**
 * 素材生图任务 handler。
 */
export async function generateAssetImageHandler(ctx: TaskContext): Promise<string> {
  const input = ctx.taskInput as {
    projectId: string;
    clipId: string;
    assetType: "character" | "scene" | "item";
    name: string;
    prompt: string;
    size?: string;
    n?: number;
    style?: string;
    /** 素材唯一 ID，用于精确定位；旧任务缺失时回退按 name 定位 */
    assetId?: string;
  };

  if (!input?.projectId || !input?.clipId || !input?.assetType || !input?.name || !input?.prompt) {
    throw new Error("generate_asset_image: 缺少 projectId / clipId / assetType / name / prompt");
  }

  const imageClient = ctx.clients?.image;
  if (!imageClient) {
    throw new Error("素材生图不可用：图片模型客户端未初始化");
  }

  const { db, emit } = ctx;
  const assertActiveOwner = () => {
    const owner = db.prepare(`
      SELECT t.id
      FROM tasks t
      JOIN clips c ON c.id = t.clip_id
      WHERE t.id = ? AND t.project_id = ? AND t.clip_id = ?
        AND t.status = 'running' AND t.cancel_requested_at IS NULL AND c.deleted_at IS NULL
    `).get(ctx.taskId, input.projectId, input.clipId);
    if (!owner) throw new Error("素材生图任务已取消、被替换或分集已删除");
  };
  assertActiveOwner();

  // 查询工作区路径
  const projectRow = db.prepare(
    "SELECT workspace_path FROM projects WHERE id = ?"
  ).get(input.projectId) as { workspace_path: string } | undefined;
  if (!projectRow) {
    throw new Error(`作品不存在：${input.projectId}`);
  }

  const workspacePath = projectRow.workspace_path;
  const safeName = sanitizeFileName(input.name);
  // 使用作品预创建的 assets/{assetType}s 扁平目录
  const typeDir = `${input.assetType}s`; // characters / scenes / items
  const saveDir = join(workspacePath, "assets", typeDir);
  await mkdir(saveDir, { recursive: true });

  const assetId = ensureAssetRow(db, input);
  ensureClipAssetLink(db, input.clipId, assetId, "generated");
  const count = Math.max(input.n ?? 1, 1);

  // 检查素材是否已有绑定图片（已选中）
  const existingSelected = db.prepare(
    "SELECT COUNT(*) as cnt FROM asset_images WHERE asset_id = ? AND is_selected = 1"
  ).get(assetId) as { cnt: number } | undefined;
  const hasExistingBinding = (existingSelected?.cnt ?? 0) > 0;

  // 只有无绑定时才清除旧选中状态并自动绑定新批次第一张
  if (!hasExistingBinding) {
    db.prepare("UPDATE asset_images SET is_selected = 0 WHERE asset_id = ?").run(assetId);
  }

  l("素材生图", `开始生成 assetType=${input.assetType} name=${input.name} n=${count} size=${input.size ?? "默认"}`);

  const generatedPaths: { path: string; imageId: string }[] = [];
  const batchStamp = Date.now();

  for (let i = 0; i < count; i++) {
    // 文件名：素材名_uuid短码_批次时间戳[_序号].png，与 Rust 侧命名规范一致
    const imageUuid = randomUUID();
    const uuidShort = imageUuid.slice(0, 8);
    const suffix = count > 1 ? `_${batchStamp}_${i + 1}` : `_${batchStamp}`;
    const imageFileName = `${safeName}_${uuidShort}${suffix}.png`;
    const savePath = join(saveDir, imageFileName);
    let imagePersisted = false;

    try {
      // 严格校验 size：前端计算的值必须符合 API 最低 3.68MP 要求
      if (input.size) {
        const parts = input.size.split("x");
        const pixels = parts.length === 2 ? Number(parts[0]) * Number(parts[1]) : 0;
        if (pixels < 3686400) {
          throw new Error(`生成尺寸 ${input.size}（${pixels}像素）不满足最低 3686400 像素要求`);
        }
      }
      const genOptions = { signal: ctx.signal, size: input.size } as { signal: AbortSignal; size?: string };
      l("素材生图", `使用 size=${input.size ?? "默认"} prompt长度=${input.prompt.length} prompt=${input.prompt}`);

      await imageClient.generateAndSave(input.prompt, savePath, genOptions);
      const thumbnailPath = await generateImageThumbnail(ctx.ffmpeg, savePath, ctx.signal);

      // 复用上方生成的 UUID 作为图片唯一 ID
      const imageId = imageUuid;

      // 创建 asset_images 记录（无已绑定时首张自动选中）
      const shouldSelect = !hasExistingBinding && i === 0;
      db.transaction(() => {
        assertActiveOwner();
        db.prepare(
          `INSERT INTO asset_images (id, asset_id, prompt, size, style, image_path, thumbnail_path, file_name, is_selected, source, task_id, ark_upload_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'generation', ?, 'pending')`
        ).run(
          imageId, assetId, input.prompt,
          input.size ?? null, input.style ?? null,
          savePath, thumbnailPath, imageFileName, shouldSelect ? 1 : 0, ctx.taskId
        );
      })();
      imagePersisted = true;

      generatedPaths.push({ path: savePath, imageId });
      l("素材生图", `第${i + 1}/${count}张完成 assetId=${assetId} imageId=${imageId} path=${savePath} thumbnail=${thumbnailPath}`);

      // 单张图片已 ready，通知前端即时刷新画廊
      emit({
        type: "asset_image_task_update",
        clipId: input.clipId,
        assetType: input.assetType,
        name: input.name,
        assetId: input.assetId,
        imageId,
        status: "ready",
      });

      // 生图阶段仅落盘并登记为待上传；方舟文件仅在视频任务实际需要参考图时上传。
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      le("素材生图", `第${i + 1}张失败 assetType=${input.assetType} name=${input.name} 错误=${msg}`);
      if (!imagePersisted) {
        await unlink(savePath).catch(() => undefined);
        await unlink(imageThumbnailPath(savePath)).catch(() => undefined);
      }
      if (i === 0 && generatedPaths.length === 0) throw err;
      // 后续图片失败不影响已生成的结果
    }
  }

  db.transaction(() => {
    assertActiveOwner();
    if (!hasExistingBinding && generatedPaths.length > 0) {
      const firstImage = generatedPaths[0];
      db.prepare(
        `UPDATE assets
         SET selected_image_id = ?, status = 'image_ready', updated_at = datetime('now')
         WHERE id = ?`
      ).run(firstImage.imageId, assetId);
    } else {
      db.prepare(
        `UPDATE assets SET status = 'image_ready', updated_at = datetime('now') WHERE id = ?`
      ).run(assetId);
    }
  })();

  l("素材生图", `成功 assetId=${assetId} 已生成=${generatedPaths.length}/${count}张`);
  emit({ type: "task_success", taskId: ctx.taskId });

  return JSON.stringify({ assetId, imageCount: generatedPaths.length, imageIds: generatedPaths.map((p) => p.imageId) });
}

/**
 * 确保 assets 表中存在对应记录。
 *
 * 优先使用唯一 assetId 精确定位（同名素材互不干扰），
 * 旧任务缺失 assetId 时回退按 (project_id, clip_id, type, name) 定位。
 */
function ensureAssetRow(
  db: DatabaseType,
  input: { projectId: string; clipId: string; assetType: string; name: string; prompt: string; assetId?: string }
): string {
  if (input.assetId) {
    const byId = db.prepare(`
      SELECT a.id FROM assets a
      JOIN clip_assets ca ON ca.asset_id = a.id
      JOIN clips c ON c.id = ca.clip_id
      WHERE a.id = ? AND a.project_id = ? AND ca.clip_id = ? AND c.deleted_at IS NULL
    `).get(input.assetId, input.projectId, input.clipId) as { id: string } | undefined;
    if (!byId) {
      throw new Error("素材已删除、不属于当前分集或任务已失效");
    }
    return byId.id;
  }

  const existing = db.prepare(
    `SELECT a.id FROM assets a
     JOIN clip_assets ca ON ca.asset_id = a.id
     WHERE ca.clip_id = ? AND a.project_id = ? AND a.type = ? AND a.name = ?`
  ).get(input.clipId, input.projectId, input.assetType, input.name) as { id: string } | undefined;

  if (!existing) {
    throw new Error("素材不存在或已删除，拒绝创建新的素材记录");
  }
  return existing.id;
}

function ensureClipAssetLink(
  db: DatabaseType,
  clipId: string,
  assetId: string,
  source: "generated" | "reused" | "manual" | "imported",
): void {
  db.prepare(
    `INSERT OR IGNORE INTO clip_assets (id, clip_id, asset_id, source)
     VALUES (?, ?, ?, ?)`
  ).run(randomUUID(), clipId, assetId, source);
}

/** 简单文件名清洗 */
function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 64) || "asset";
}
