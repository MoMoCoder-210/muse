/**
 * 分集拆解：同一任务按顺序执行「素材提取 → 镜头生成」，最终一次性提交。
 * 两次模型调用期间不写业务数据，避免后续失败留下半成品素材或镜头。
 */

import { randomUUID } from "crypto";
import { realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import type { TaskContext } from "../types.js";
import type { ChatMessage } from "../clients/text.js";
import { l, lw, le, createPromptLoader, stripCodeFences } from "../utils/utils.js";

const getExtractAssetsPrompt = createPromptLoader("extract-assets.md");
const getGenerateStoryboardsPrompt = createPromptLoader("generate-storyboards.md");

const ASSET_TYPES = ["character", "scene", "item"] as const;
export type AssetType = typeof ASSET_TYPES[number];

export interface AvailableAsset {
  id: string;
  type: AssetType;
  name: string;
  description: string;
  prompt: string;
}

/** 传给模型的素材引用只保留复用所需的稳定 ID、类型和名称。 */
export interface ModelAssetReference {
  id: string;
  type: AssetType;
  name: string;
}

export function toModelAssetReferences(assets: readonly AvailableAsset[]): ModelAssetReference[] {
  return assets.map(({ id, type, name }) => ({ id, type, name }));
}

export interface ExtractedAsset {
  type: AssetType;
  name: string;
  description: string;
  prompt: string;
  /** 复用作品已有素材时返回 assets.id；新增素材不得携带此字段。 */
  id?: string;
}

export interface StoryboardItem {
  sbid: string;
  duration: number;
  description: string;
  originalText: string;
  animationPrompt: string;
  characterAssetIds: string[];
  sceneAssetIds: string[];
  itemAssetIds: string[];
}

interface PreparedAssets {
  assets: AvailableAsset[];
  newAssetIds: Set<string>;
}

interface GenerateClipScriptInput {
  projectId: string;
  clipId: string;
  clipScriptId: string;
  sourceText: string;
  sourceRevision: number;
  styleMode?: string;
}

const VIDEO_STYLE_PROMPT_MAP: Record<string, { prefix: string; suffix: string }> = {
  国漫: { prefix: "国漫动画风格，流畅手绘线条，鲜艳色彩，电影感光影。", suffix: "画面风格：国漫动画，流畅线条，鲜艳色彩，电影感光影，2K高清，视频无任何字幕。" },
  动漫: { prefix: "动漫风格，精致手绘，细腻色彩，电影感光影。", suffix: "画面风格：动漫，精致手绘，细腻色彩，电影感光影，2K高清，视频无任何字幕。" },
  日漫: { prefix: "日本动漫风格短剧分集，赛璐璞上色，电影感光影。", suffix: "画面风格：日本动漫，赛璐璞上色，精致线条，电影感光影，2K高清，视频无任何字幕。" },
  韩漫: { prefix: "韩国动漫风格，简洁线条，柔和色调，电影感光影。", suffix: "画面风格：韩国动漫，简洁线条，柔和色调，电影感光影，2K高清，视频无任何字幕。" },
  二次元: { prefix: "二次元日系动漫风格短剧分集，赛璐璞上色，电影感光影。", suffix: "画面风格：二次元日系动漫，赛璐璞上色，精致线条，电影感光影，2K高清，视频无任何字幕。" },
  真人: { prefix: "真人电影风格，背景虚化，浅景深，电影感光影。", suffix: "画面风格：真人电影，背景虚化，浅景深，电影感光影，2K高清，视频无任何字幕。" },
};

function isAssetType(value: unknown): value is AssetType {
  return typeof value === "string" && (ASSET_TYPES as readonly string[]).includes(value);
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error(`镜头字段 ${field} 必须是非空字符串 ID 数组`);
  }
  return value.map((id) => id.trim());
}

/**
 * 阶段 A 的素材协议是闭环的：有 id 仅复用当前作品素材；无 id 一律视为新增。
 */
export function resolveReusableAssetId(
  asset: Pick<ExtractedAsset, "type" | "name" | "id">,
  projectAssets: readonly AvailableAsset[],
): string | undefined {
  if (asset.id) {
    const referenced = projectAssets.find((candidate) => candidate.id === asset.id);
    if (!referenced) throw new Error(`素材 id 不属于当前作品：${asset.id}`);
    if (referenced.type !== asset.type) {
      throw new Error(`素材 id 类型不匹配：${asset.id} 应为 ${asset.type}，实际为 ${referenced.type}`);
    }
    if (referenced.name !== asset.name) {
      throw new Error(`素材 id 名称不匹配：${asset.id} 应为「${referenced.name}」，实际返回「${asset.name}」`);
    }
    return referenced.id;
  }
  return undefined;
}

/**
 * 镜头只能引用本次阶段 A 返回的精确素材集合；每个 ID 必须类型匹配。
 */
export function validateStoryboardAssetIds(
  storyboards: readonly StoryboardItem[],
  availableAssets: readonly AvailableAsset[],
): void {
  const byId = new Map(availableAssets.map((asset) => [asset.id, asset]));
  for (const storyboard of storyboards) {
    const referencedIds = new Set<string>();
    const totalAssets = storyboard.characterAssetIds.length
      + storyboard.sceneAssetIds.length
      + storyboard.itemAssetIds.length;
    if (totalAssets > 9) throw new Error(`镜头 ${storyboard.sbid} 引用素材总数不能超过 9 个`);
    for (const [expectedType, ids] of [
      ["character", storyboard.characterAssetIds],
      ["scene", storyboard.sceneAssetIds],
      ["item", storyboard.itemAssetIds],
    ] as const) {
      for (const id of ids) {
        if (referencedIds.has(id)) throw new Error(`镜头 ${storyboard.sbid} 重复引用素材 ID：${id}`);
        referencedIds.add(id);
        const asset = byId.get(id);
        if (!asset) throw new Error(`镜头 ${storyboard.sbid} 引用了不属于本次拆解的素材 ID：${id}`);
        if (asset.type !== expectedType) {
          throw new Error(`镜头 ${storyboard.sbid} 素材类型不匹配：${id} 应为 ${expectedType}，实际为 ${asset.type}`);
        }
      }
    }
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(stripCodeFences(raw));
  } catch {
    throw new Error("模型返回内容不是有效的 JSON");
  }
}

export function parseAssetsOutput(raw: string): ExtractedAsset[] {
  const payload = parseJson(raw) as Record<string, unknown>;
  if (!payload || !Array.isArray(payload.assets)) throw new Error("素材返回格式无效：期望 { assets: [] }");
  const seen = new Set<string>();
  return payload.assets.map((item, index) => {
    const value = item as Record<string, unknown>;
    const type = value?.type;
    const name = safeString(value?.name);
    if (!isAssetType(type) || !name) throw new Error(`素材 #${index + 1} 缺少有效 type 或 name`);
    const key = `${type}\u0000${name}`;
    if (seen.has(key)) throw new Error(`素材结果包含重复的 type/name：${type}/${name}`);
    seen.add(key);
    if ("assetId" in value) {
      throw new Error(`素材 #${index + 1} 使用了废弃字段 assetId，应使用 id`);
    }
    const id = safeString(value.id);
    if (id) {
      if (value.description !== undefined || value.prompt !== undefined) {
        throw new Error(`复用素材 #${index + 1} 只能原样返回 id/type/name`);
      }
      return { type, name, description: "", prompt: "", id };
    }
    const description = safeString(value.description);
    const prompt = safeString(value.prompt);
    if (!description || !prompt) {
      throw new Error(`新增素材 #${index + 1} 必须提供 description 和 prompt，且不得提供 id`);
    }
    return { type, name, description, prompt };
  });
}

/** 解析阶段 B JSON；originalText 必须原样保留，不能 trim。 */
export function parseStoryboardsOutput(raw: string): StoryboardItem[] {
  const payload = parseJson(raw) as Record<string, unknown>;
  if (!payload || !Array.isArray(payload.storyboards) || payload.storyboards.length === 0) {
    throw new Error("镜头返回格式无效：期望非空 { storyboards: [] }");
  }
  return payload.storyboards.map((item) => {
    const value = item as Record<string, unknown>;
    return {
      sbid: safeString(value?.sbid),
      duration: typeof value?.duration === "number" ? value.duration : Number.NaN,
      description: safeString(value?.description),
      originalText: typeof value?.originalText === "string" ? value.originalText : "",
      animationPrompt: safeString(value?.animationPrompt),
      characterAssetIds: safeIdArray(value?.characterAssetIds, "characterAssetIds"),
      sceneAssetIds: safeIdArray(value?.sceneAssetIds, "sceneAssetIds"),
      itemAssetIds: safeIdArray(value?.itemAssetIds, "itemAssetIds"),
    };
  });
}

function isIgnorableSourceGap(value: string): boolean {
  return value.split(/\r?\n/).every((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    return /^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(trimmed);
  });
}

/**
 * 阶段 B 代码硬校验：时长、切镜语法、素材上限及原文覆盖全部在此验证。
 */
export function validateStoryboardOutput(
  storyboards: readonly StoryboardItem[],
  sourceText: string,
): void {
  if (storyboards.length === 0) throw new Error("镜头列表不能为空");

  let sourceCursor = 0;
  for (let index = 0; index < storyboards.length; index += 1) {
    const storyboard = storyboards[index];
    const expectedSbid = String(index + 1);
    if (storyboard.sbid !== expectedSbid) {
      throw new Error(`镜头 sbid 必须从 1 连续递增：期望 ${expectedSbid}，实际 ${storyboard.sbid || "空"}`);
    }
    if (!Number.isInteger(storyboard.duration) || storyboard.duration < 5 || storyboard.duration > 15) {
      throw new Error(`镜头 ${storyboard.sbid} duration 必须是 5~15 的整数`);
    }
    if (!storyboard.description) throw new Error(`镜头 ${storyboard.sbid} description 不能为空`);
    if (!storyboard.originalText.trim()) throw new Error(`镜头 ${storyboard.sbid} originalText 不能为空`);
    if (!storyboard.animationPrompt) throw new Error(`镜头 ${storyboard.sbid} animationPrompt 不能为空`);
    if (storyboard.animationPrompt.length > 600) {
      throw new Error(`镜头 ${storyboard.sbid} animationPrompt 不能超过 600 字符`);
    }

    const lines = storyboard.animationPrompt.split("\n");
    if (lines.length < 1 || lines.length > 5) {
      throw new Error(`镜头 ${storyboard.sbid} animationPrompt 必须包含 1~5 行`);
    }
    let durationSum = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const match = /^c(\d{2}),([1-9]\d*)s,\[空间:([^\]\r\n]+)\]\[姿态:([^\]\r\n]+)\][ \t]+(\S.*)$/.exec(lines[lineIndex]);
      if (!match) {
        throw new Error(`镜头 ${storyboard.sbid} 第 ${lineIndex + 1} 行格式无效`);
      }
      if (!match[3].trim() || !match[4].trim()) {
        throw new Error(`镜头 ${storyboard.sbid} 第 ${lineIndex + 1} 行空间和姿态不能为空`);
      }
      const expectedCut = String(lineIndex + 1).padStart(2, "0");
      if (match[1] !== expectedCut) {
        throw new Error(`镜头 ${storyboard.sbid} 切镜编号必须从 c01 连续递增`);
      }
      durationSum += Number(match[2]);
    }
    if (durationSum !== storyboard.duration) {
      throw new Error(`镜头 ${storyboard.sbid} 切镜秒数之和必须等于 duration`);
    }

    const sourceIndex = sourceText.indexOf(storyboard.originalText, sourceCursor);
    if (sourceIndex < 0) {
      throw new Error(`镜头 ${storyboard.sbid} originalText 不是 sourceText 中按序连续的原文片段`);
    }
    const gap = sourceText.slice(sourceCursor, sourceIndex);
    if (!isIgnorableSourceGap(gap)) {
      throw new Error(`镜头 ${storyboard.sbid} 前遗漏了非空白或非 Markdown 分隔线的原文`);
    }
    sourceCursor = sourceIndex + storyboard.originalText.length;
  }

  if (!isIgnorableSourceGap(sourceText.slice(sourceCursor))) {
    throw new Error("最后一个镜头之后遗漏了有效原文");
  }
}

async function callModel<T>(
  ctx: TaskContext,
  prompt: string,
  userPayload: unknown,
  parse: (raw: string) => T,
  phase: string,
): Promise<{ value: T; rawOutput: string }> {
  const textClient = ctx.clients?.text;
  if (!textClient) throw new Error(`${phase}不可用：文本模型客户端未初始化`);
  const messages: ChatMessage[] = [
    { role: "system", content: prompt },
    { role: "user", content: JSON.stringify(userPayload) },
  ];
  let result: Awaited<ReturnType<typeof textClient.chat>>;
  const startedAt = Date.now();
  try {
    result = await textClient.chat(messages, () => {}, { signal: ctx.signal, reasoning_effort: "high" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    le("拆解", `${phase}模型调用失败 耗时=${Date.now() - startedAt}ms 错误=${message}`);
    throw error;
  }
  try {
    return { value: parse(result.content), rawOutput: result.content };
  } catch (parseError) {
    const reason = parseError instanceof Error ? parseError.message : String(parseError);
    lw("拆解", `${phase}输出解析失败（${reason}），执行 JSON 修复重试`);
    const repair = await textClient.chat([
      ...messages,
      { role: "assistant", content: result.content },
      { role: "user", content: "只输出符合系统提示词定义的 JSON 对象；不要 Markdown、解释或额外字段。" },
    ], () => {}, { signal: ctx.signal, reasoning_effort: "high" });
    return { value: parse(repair.content), rawOutput: repair.content };
  }
}

function loadProjectAssets(db: DatabaseType, projectId: string): AvailableAsset[] {
  return db.prepare(`
    SELECT id, type, name, description, prompt FROM assets
    WHERE project_id = ?
    ORDER BY type, name, id
  `).all(projectId) as AvailableAsset[];
}

function assertActiveOwner(
  db: DatabaseType,
  taskId: string,
  projectId: string,
  clipId: string,
  clipScriptId: string,
  sourceRevision: number,
): void {
  const owner = db.prepare(`
    SELECT t.id
    FROM tasks t
    JOIN clips c ON c.id = t.clip_id
    JOIN clip_scripts cs ON cs.id = ? AND cs.clip_id = c.id
    WHERE t.id = ? AND t.project_id = ? AND t.clip_id = ?
      AND t.status = 'running' AND t.cancel_requested_at IS NULL
      AND c.project_id = ? AND c.deleted_at IS NULL AND c.source_revision = ?
      AND cs.project_id = ? AND cs.task_id = t.id
      AND cs.source_revision = ? AND cs.status = 'running'
  `).get(
    clipScriptId,
    taskId,
    projectId,
    clipId,
    projectId,
    sourceRevision,
    projectId,
    sourceRevision,
  );
  if (!owner) throw new Error("拆解任务已取消、被替换、版本过期、跨项目或分集已删除");
}

/** 阶段 A：只查询复用素材；新增素材仅分配本地 UUID，不写数据库。 */
function prepareExtractedAssets(
  db: DatabaseType,
  projectId: string,
  extractedAssets: readonly ExtractedAsset[],
): PreparedAssets {
  const findProjectAssetById = db.prepare(`
    SELECT id, type, name, description, prompt
    FROM assets
    WHERE id = ? AND project_id = ?
  `);
  const assets: AvailableAsset[] = [];
  const newAssetIds = new Set<string>();

  for (const asset of extractedAssets) {
    if (asset.id) {
      const referenced = findProjectAssetById.get(asset.id, projectId) as AvailableAsset | undefined;
      resolveReusableAssetId(asset, referenced ? [referenced] : []);
      assets.push(referenced!);
    } else {
      const prepared: AvailableAsset = {
        id: randomUUID(),
        type: asset.type,
        name: asset.name,
        description: asset.description,
        prompt: asset.prompt,
      };
      assets.push(prepared);
      newAssetIds.add(prepared.id);
    }
  }

  return { assets, newAssetIds };
}

function buildVideoPrompt(
  rawPrompt: string,
  characters: AvailableAsset[],
  scenes: AvailableAsset[],
  items: AvailableAsset[],
  styleMode?: string,
): string {
  const parts: string[] = [];
  const style = styleMode ? VIDEO_STYLE_PROMPT_MAP[styleMode] : undefined;
  if (style) parts.push(style.prefix, "");
  if (characters.length) parts.push(`人物： ${characters.map((asset) => asset.name).join("， ")}。`);
  if (scenes.length) parts.push(`场景： ${scenes.map((asset) => asset.name).join("， ")}。`);
  if (items.length) parts.push(`道具： ${items.map((asset) => asset.name).join("， ")}。`);
  if (parts.length && (characters.length || scenes.length || items.length)) parts.push("");
  parts.push(rawPrompt);
  if (style) parts.push("", style.suffix);
  return parts.join("\n");
}

function advanceProjectStep(db: DatabaseType, projectId: string): void {
  db.prepare(`
    UPDATE projects
    SET current_step = 'asset', updated_at = datetime('now')
    WHERE id = ? AND current_step = 'script'
  `).run(projectId);
}

interface PersistedResult {
  filePaths: string[];
  workspacePath: string;
}

/**
 * 最终提交：owner/revision 校验、素材替换、旧镜头清理、新镜头插入和任务成功
 * 状态全部处于同一 better-sqlite3 事务。
 */
function persistGeneratedResult(
  db: DatabaseType,
  input: GenerateClipScriptInput,
  taskId: string,
  preparedAssets: PreparedAssets,
  storyboards: readonly StoryboardItem[],
  assetsRawOutput: string,
  storyboardsRawOutput: string,
  outputJson: string,
): PersistedResult {
  return db.transaction(() => {
    assertActiveOwner(
      db,
      taskId,
      input.projectId,
      input.clipId,
      input.clipScriptId,
      input.sourceRevision,
    );

    const project = db.prepare(
      "SELECT workspace_path FROM projects WHERE id = ?"
    ).get(input.projectId) as { workspace_path: string } | undefined;
    if (!project?.workspace_path) throw new Error("作品工作区不存在，无法安全清理旧镜头文件");

    const activeStoryboardTask = db.prepare(`
      SELECT t.id, t.type, t.status
      FROM tasks t
      JOIN storyboards s ON s.id = t.storyboard_id
      WHERE s.clip_id = ?
        AND t.status IN ('pending', 'running', 'waiting_remote', 'downloading')
      ORDER BY t.created_at ASC
      LIMIT 1
    `).get(input.clipId) as { id: string; type: string; status: string } | undefined;
    if (activeStoryboardTask) {
      throw new Error(
        `旧镜头仍有活跃任务，暂不能提交重拆结果：${activeStoryboardTask.type}/${activeStoryboardTask.status}`,
      );
    }

    const filePaths = new Set<string>();
    const videos = db.prepare(`
      SELECT sv.file_path, sv.cover_path
      FROM storyboard_videos sv
      JOIN storyboards s ON s.id = sv.storyboard_id
      WHERE s.clip_id = ?
    `).all(input.clipId) as Array<{ file_path: string; cover_path: string | null }>;
    for (const video of videos) {
      if (video.file_path?.trim()) filePaths.add(video.file_path);
      if (video.cover_path?.trim()) filePaths.add(video.cover_path);
    }
    const upscalePaths = db.prepare(`
      SELECT uj.output_path
      FROM upscale_jobs uj
      JOIN storyboards s ON s.id = uj.storyboard_id
      WHERE s.clip_id = ? AND TRIM(uj.output_path) <> ''
    `).all(input.clipId) as Array<{ output_path: string }>;
    for (const upscale of upscalePaths) filePaths.add(upscale.output_path);

    const insertAsset = db.prepare(`
      INSERT INTO assets (id, project_id, type, name, description, prompt, source, status)
      VALUES (?, ?, ?, ?, ?, ?, 'model', 'draft')
    `);
    for (const asset of preparedAssets.assets) {
      if (preparedAssets.newAssetIds.has(asset.id)) {
        try {
          insertAsset.run(
            asset.id,
            input.projectId,
            asset.type,
            asset.name,
            asset.description,
            asset.prompt,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("UNIQUE constraint failed")) {
            throw new Error(`新增素材已存在但模型未返回 id：${asset.type}/${asset.name}`);
          }
          throw error;
        }
      } else {
        const current = db.prepare(`
          SELECT id, type, name, description, prompt
          FROM assets WHERE id = ? AND project_id = ?
        `).get(asset.id, input.projectId) as AvailableAsset | undefined;
        resolveReusableAssetId(asset, current ? [current] : []);
      }
    }

    db.prepare(`
      DELETE FROM clip_assets
      WHERE clip_id = ? AND source IN ('model', 'generated', 'reused')
    `).run(input.clipId);
    const linkAsset = db.prepare(`
      INSERT OR IGNORE INTO clip_assets (id, clip_id, asset_id, source)
      VALUES (?, ?, ?, ?)
    `);
    for (const asset of preparedAssets.assets) {
      linkAsset.run(
        randomUUID(),
        input.clipId,
        asset.id,
        preparedAssets.newAssetIds.has(asset.id) ? "generated" : "reused",
      );
    }

    validateStoryboardAssetIds(storyboards, preparedAssets.assets);

    // 与 delete_storyboard 保持相同依赖顺序，先解除循环引用。
    db.prepare(`
      UPDATE storyboards SET selected_video_id = NULL, updated_at = datetime('now')
      WHERE clip_id = ?
    `).run(input.clipId);
    db.prepare(`
      DELETE FROM task_locks
      WHERE lock_key IN (
        SELECT lock_key FROM tasks
        WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?)
      ) OR locked_by IN (
        SELECT id FROM tasks
        WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?)
      )
    `).run(input.clipId, input.clipId);
    db.prepare(`
      DELETE FROM upscale_jobs
      WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?)
    `).run(input.clipId);
    db.prepare(`
      DELETE FROM storyboard_videos
      WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?)
    `).run(input.clipId);
    db.prepare(`
      DELETE FROM tasks
      WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?)
    `).run(input.clipId);
    db.prepare(`
      DELETE FROM storyboard_assets
      WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?)
    `).run(input.clipId);
    db.prepare("DELETE FROM storyboards WHERE clip_id = ?").run(input.clipId);

    const assetById = new Map(preparedAssets.assets.map((asset) => [asset.id, asset]));
    const insertStoryboard = db.prepare(`
      INSERT INTO storyboards (id, project_id, clip_id, seq_num, sbid, source_text,
        visual_description, video_prompt, video_duration, video_param_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertStoryboardAsset = db.prepare(`
      INSERT INTO storyboard_assets (id, storyboard_id, asset_id, asset_type)
      VALUES (?, ?, ?, ?)
    `);
    for (let index = 0; index < storyboards.length; index += 1) {
      const storyboard = storyboards[index];
      const groups: Array<[AssetType, string[]]> = [
        ["character", storyboard.characterAssetIds],
        ["scene", storyboard.sceneAssetIds],
        ["item", storyboard.itemAssetIds],
      ];
      const mentionAssets = groups.flatMap(([type, ids]) => ids.map((id) => {
        const asset = assetById.get(id);
        if (!asset) throw new Error(`校验后的素材不存在：${id}`);
        return { id, type, name: asset.name };
      }));
      const mentionMap = mentionAssets.map((asset, mentionIndex) => ({
        n: mentionIndex + 1,
        assetId: asset.id,
        name: asset.name,
        type: asset.type,
        assetTag: `${asset.name}(@图片${mentionIndex + 1})`,
      }));
      const storyboardId = randomUUID();
      insertStoryboard.run(
        storyboardId,
        input.projectId,
        input.clipId,
        index + 1,
        storyboard.sbid,
        storyboard.originalText,
        storyboard.description,
        buildVideoPrompt(
          storyboard.animationPrompt,
          storyboard.characterAssetIds.map((id) => assetById.get(id)!),
          storyboard.sceneAssetIds.map((id) => assetById.get(id)!),
          storyboard.itemAssetIds.map((id) => assetById.get(id)!),
          input.styleMode,
        ),
        storyboard.duration,
        JSON.stringify({ mention_map: mentionMap }),
      );
      for (const [type, ids] of groups) {
        for (const assetId of ids) {
          insertStoryboardAsset.run(randomUUID(), storyboardId, assetId, type);
        }
      }
    }

    const summary = storyboards.map((storyboard) => storyboard.description).join("；").slice(0, 200);
    const scriptUpdated = db.prepare(`
      UPDATE clip_scripts
      SET script_summary = ?, raw_model_output = ?, assets_raw_model_output = ?,
          mode = ?, status = 'success', error_message = NULL, updated_at = datetime('now')
      WHERE id = ? AND task_id = ? AND status = 'running'
    `).run(
      summary,
      storyboardsRawOutput,
      assetsRawOutput,
      input.styleMode || "RS",
      input.clipScriptId,
      taskId,
    );
    if (scriptUpdated.changes !== 1) throw new Error("拆解记录已取消、被替换或版本过期");

    const clipUpdated = db.prepare(`
      UPDATE clips
      SET status = 'script_ready', updated_at = datetime('now')
      WHERE id = ? AND project_id = ? AND source_revision = ? AND deleted_at IS NULL
    `).run(input.clipId, input.projectId, input.sourceRevision);
    if (clipUpdated.changes !== 1) throw new Error("分集版本已变化，拒绝提交拆解结果");

    const taskUpdated = db.prepare(`
      UPDATE tasks
      SET status = 'success', output_json = ?, error_message = NULL,
          finished_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
    `).run(outputJson, taskId);
    if (taskUpdated.changes !== 1) throw new Error("拆解任务已取消或被替换");

    advanceProjectStep(db, input.projectId);
    return { filePaths: [...filePaths], workspacePath: project.workspace_path };
  })();
}

function isWithinDirectory(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function cleanupStaleFiles(result: PersistedResult): Promise<void> {
  const lexicalWorkspace = resolve(result.workspacePath);
  let realWorkspace: string;
  try {
    realWorkspace = await realpath(lexicalWorkspace);
  } catch (error) {
    lw("拆解", `作品工作区无法解析，跳过旧镜头文件清理 path=${result.workspacePath} 错误=${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  await Promise.all(result.filePaths.map(async (filePath) => {
    const candidate = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(lexicalWorkspace, filePath);
    if (!isWithinDirectory(lexicalWorkspace, candidate)) {
      lw("拆解", `旧镜头文件超出作品工作区，跳过清理 path=${filePath}`);
      return;
    }

    let realCandidate: string;
    try {
      realCandidate = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      lw("拆解", `旧镜头文件无法解析，跳过清理 path=${filePath} 错误=${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!isWithinDirectory(realWorkspace, realCandidate)) {
      lw("拆解", `旧镜头文件解析后超出作品工作区，跳过清理 path=${filePath}`);
      return;
    }

    try {
      await rm(candidate, { force: true });
    } catch (error) {
      lw("拆解", `旧镜头文件清理失败 path=${filePath} 错误=${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

export async function generateClipScriptHandler(ctx: TaskContext): Promise<string> {
  const input = ctx.taskInput as GenerateClipScriptInput;
  if (
    !input
    || typeof input.projectId !== "string" || !input.projectId
    || typeof input.clipId !== "string" || !input.clipId
    || typeof input.clipScriptId !== "string" || !input.clipScriptId
    || typeof input.sourceText !== "string" || !input.sourceText
    || !Number.isInteger(input.sourceRevision)
  ) {
    throw new Error("generate_clip_script: 缺少 projectId / clipId / clipScriptId / sourceText / sourceRevision");
  }

  // sourceText 是入队快照；禁止在 handler 中重新读取 active optimization。
  const sourceText = input.sourceText;
  assertActiveOwner(
    ctx.db,
    ctx.taskId,
    input.projectId,
    input.clipId,
    input.clipScriptId,
    input.sourceRevision,
  );

  // A. 查询整个作品用于复用校验；新增素材只在内存中分配 UUID。
  const projectAssets = loadProjectAssets(ctx.db, input.projectId);
  const assetsResult = await callModel(ctx, getExtractAssetsPrompt(), {
    sourceText,
    availableAssets: toModelAssetReferences(projectAssets),
  }, parseAssetsOutput, "素材提取");
  const preparedAssets = prepareExtractedAssets(ctx.db, input.projectId, assetsResult.value);

  assertActiveOwner(
    ctx.db,
    ctx.taskId,
    input.projectId,
    input.clipId,
    input.clipScriptId,
    input.sourceRevision,
  );

  // B. 只使用本次阶段 A 返回的精确集合，绝不混入旧 clip_assets。
  const parseAndValidateStoryboards = (raw: string): StoryboardItem[] => {
    const storyboards = parseStoryboardsOutput(raw);
    validateStoryboardOutput(storyboards, sourceText);
    validateStoryboardAssetIds(storyboards, preparedAssets.assets);
    return storyboards;
  };
  const storyboardsResult = await callModel(ctx, getGenerateStoryboardsPrompt(), {
    sourceText,
    availableAssets: toModelAssetReferences(preparedAssets.assets),
  }, parseAndValidateStoryboards, "镜头生成");

  const outputJson = JSON.stringify({
    sbidCount: storyboardsResult.value.length,
    characterCount: preparedAssets.assets.filter((asset) => asset.type === "character").length,
    sceneCount: preparedAssets.assets.filter((asset) => asset.type === "scene").length,
    itemCount: preparedAssets.assets.filter((asset) => asset.type === "item").length,
  });
  const persistedResult = persistGeneratedResult(
    ctx.db,
    input,
    ctx.taskId,
    preparedAssets,
    storyboardsResult.value,
    assetsResult.rawOutput,
    storyboardsResult.rawOutput,
    outputJson,
  );

  // 清理是提交后的告警级副作用，不阻塞 handler 返回和成功事件。
  void cleanupStaleFiles(persistedResult).catch((error) => {
    lw("拆解", `旧镜头文件清理异常：${error instanceof Error ? error.message : String(error)}`);
  });

  l("拆解", `拆解成功 clipId=${input.clipId} 素材=${preparedAssets.assets.length} 镜头=${storyboardsResult.value.length}`);
  return outputJson;
}
