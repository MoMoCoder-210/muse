import { randomUUID } from "crypto";
import { mkdir } from "fs/promises";
import { join } from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import type { TaskContext } from "../types.js";
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
  };

  if (!input?.projectId || !input?.clipId || !input?.assetType || !input?.name || !input?.prompt) {
    throw new Error("generate_asset_image: 缺少 projectId / clipId / assetType / name / prompt");
  }

  const imageClient = ctx.clients?.image;
  if (!imageClient) {
    throw new Error("素材生图不可用：图片模型客户端未初始化");
  }

  const { db, emit } = ctx;

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

      // 复用上方生成的 UUID 作为图片唯一 ID
      const imageId = imageUuid;

      // 创建 asset_images 记录（无已绑定时首张自动选中）
      const shouldSelect = !hasExistingBinding && i === 0;
      db.prepare(
        `INSERT INTO asset_images (id, asset_id, prompt, size, style, image_path, file_name, is_selected, source, task_id, ark_upload_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generation', ?, 'pending')`
      ).run(
        imageId, assetId, input.prompt,
        input.size ?? null, input.style ?? null,
        savePath, imageFileName, shouldSelect ? 1 : 0, ctx.taskId
      );

      generatedPaths.push({ path: savePath, imageId });
      l("素材生图", `第${i + 1}/${count}张完成 assetId=${assetId} imageId=${imageId} path=${savePath}`);

      // 单张图片已 ready，通知前端即时刷新画廊
      emit({
        type: "asset_image_task_update",
        clipId: input.clipId,
        assetType: input.assetType,
        name: input.name,
        imageId,
        status: "ready",
      });

      // 生图阶段仅落盘并登记为待上传；方舟文件仅在视频任务实际需要参考图时上传。
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      le("素材生图", `第${i + 1}张失败 assetType=${input.assetType} name=${input.name} 错误=${msg}`);
      if (i === 0 && generatedPaths.length === 0) throw err;
      // 后续图片失败不影响已生成的结果
    }
  }

  // 更新 assets 表（仅无已绑定时回写第一张）
  if (!hasExistingBinding && generatedPaths.length > 0) {
    const firstImage = generatedPaths[0];
    db.prepare(
      `UPDATE assets
       SET generated_image_path = ?,
           selected_image_id = ?,
           status = 'image_ready',
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(firstImage.path, firstImage.imageId, assetId);
  } else {
    // 有已绑定图片时只更新状态
    db.prepare(
      `UPDATE assets SET status = 'image_ready', updated_at = datetime('now') WHERE id = ?`
    ).run(assetId);
  }

  l("素材生图", `成功 assetId=${assetId} 已生成=${generatedPaths.length}/${count}张`);
  emit({ type: "task_success", taskId: ctx.taskId });

  return JSON.stringify({ assetId, imageCount: generatedPaths.length, imageIds: generatedPaths.map((p) => p.imageId) });
}

/**
 * 确保 assets 表中存在对应记录。
 */
function ensureAssetRow(
  db: DatabaseType,
  input: { projectId: string; clipId: string; assetType: string; name: string; prompt: string }
): string {
  const existing = db.prepare(
    "SELECT id FROM assets WHERE project_id = ? AND clip_id = ? AND type = ? AND name = ?"
  ).get(input.projectId, input.clipId, input.assetType, input.name) as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO assets (id, project_id, clip_id, type, name, description, prompt, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'image_pending', 'model')`
  ).run(id, input.projectId, input.clipId, input.assetType, input.name, "", input.prompt);
  return id;
}

/** 简单文件名清洗 */
function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 64) || "asset";
}
