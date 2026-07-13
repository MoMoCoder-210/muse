/**
 * 片段拆解 — 模型分析片段生成分镜、角色、场景、物品及生图/生视频提示词
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "crypto";
import type { TaskContext } from "../types.js";
import type { ChatMessage } from "../clients/text.js";
import { l, lw, le, stripCodeFences, createPromptLoader } from "../utils/utils.js";

// ─── 提示词加载 ────────────────────────────────────────────────────

const getPrompt = createPromptLoader("disassemble.md");

// ─── JSON 清洗 ─────────────────────────────────────────────────────

// ─── 模型调用与解析 ─────────────────────────────────────────────────
/**
 * 调用 LLM 模型并解析 JSON 结果（含修复重试）
 *
 * @returns 解析后的 storyboards、resources 及原始模型输出
 * @throws 模型调用失败或解析失败时抛出错误
 */
async function callModelAndParse(
  ctx: TaskContext,
  input: { sourceText: string },
): Promise<{
  storyboards: StoryboardItem[];
  resources: ReturnType<typeof buildResources>;
  rawOutput: string;
}> {
  const textClient = ctx.clients?.text;
  if (!textClient) {
    throw new Error("拆解不可用：文本模型客户端未初始化");
  }

  const systemContent = getPrompt();
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: input.sourceText },
  ];

  // ── 模型调用 ──
  let result: Awaited<ReturnType<typeof textClient.chat>>;
  const startedAt = Date.now();
  try {
    result = await textClient.chat(messages, () => {}, { signal: ctx.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - startedAt;
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("abort")) {
      le("拆解", `模型调用超时 耗时=${elapsed}ms 错误=${msg}`);
    } else {
      le("拆解", `模型调用失败 耗时=${elapsed}ms 错误=${msg}（将由任务调度器决定重试）`);
    }
    throw err;
  }

  // ── 首次解析 ──
  try {
    const storyboards = parseModelOutput(result.content);
    if (storyboards.length === 0) {
      throw new Error("拆解结果为空");
    }
    const resources = buildResources(storyboards);
    return { storyboards, resources, rawOutput: result.content };
  } catch (parseError) {
    const reason = parseError instanceof Error ? parseError.message : String(parseError);
    lw("拆解", `输出 JSON 解析失败（${reason}），执行修复重试`);

    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      { role: "user", content: "请将以上内容转为标准的 JSON 数组，不要包含任何 Markdown 符号或解释性文字，直接输出 JSON 数组本身。" },
    ];

    const repairResult = await textClient.chat(repairMessages, () => {}, { signal: ctx.signal });

    l("拆解", `修复返回完成 输出=${repairResult.content.length}字符`);

    const storyboards = parseModelOutput(repairResult.content);
    const resources = buildResources(storyboards);
    return { storyboards, resources, rawOutput: repairResult.content };
  }
}

// ─── 结果保存 ───────────────────────────────────────────────────────
/**
 * 将拆解结果（storyboards、resource 汇总）写入数据库
 */
function saveResults(
  db: DatabaseType,
  clipId: string,
  storyboards: StoryboardItem[],
  resources: ReturnType<typeof buildResources>,
  rawOutput: string,
  mode?: string,
): void {
  // 检查片段是否已被删除
  const clip = db.prepare(
    "SELECT id FROM clips WHERE id = ? AND deleted_at IS NULL"
  ).get(clipId);
  if (!clip) {
    lw("拆解", `片段已被删除，丢弃拆解结果 clipId=${clipId}`);
    return;
  }

  // 从 clips 表获取 projectId
  const clipRow = db.prepare(
    "SELECT project_id FROM clips WHERE id = ?"
  ).get(clipId) as { project_id: string } | undefined;
  if (!clipRow) return;

  const projectId = clipRow.project_id;
  const actualMode = mode || "RS";
  const summary = storyboards.map((s) => s.description).join("；").slice(0, 200);
  const resourcesJson = JSON.stringify(resources);

  // 写入 clip_scripts — UPDATE 已有的 pending 记录，而非 INSERT 新行
  const updated = db.prepare(`
    UPDATE clip_scripts
    SET script_summary = ?, raw_model_output = ?, extracted_resources_json = ?,
        mode = ?, status = 'success', updated_at = datetime('now')
    WHERE clip_id = ? AND status = 'pending'
  `).run(summary, rawOutput, resourcesJson, actualMode, clipId);

  // 兜底：如果没有 pending 记录（直接调用 handler 场景），则 INSERT
  if (updated.changes === 0) {
    db.prepare(`
      INSERT INTO clip_scripts (id, project_id, clip_id, source_text, script_summary,
        raw_model_output, extracted_resources_json, mode, status)
      VALUES (?, ?, ?, '', ?, ?, ?, ?, 'success')
    `).run(randomUUID(), projectId, clipId, summary, rawOutput, resourcesJson, actualMode);
  }

  // 写入故事板
  const insertSb = db.prepare(`
    INSERT INTO storyboards (id, project_id, clip_id, seq_num, sbid, source_text,
      visual_description, video_prompt, video_duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < storyboards.length; i++) {
    const sb = storyboards[i];
    insertSb.run(
      randomUUID(), projectId, clipId,
      i + 1, sb.sbid, sb.originalText || "",
      sb.description, sb.animationPrompt,
      sb.duration ?? 15,
    );
  }
}

// ─── 项目步骤推进 ───────────────────────────────────────────────────
/**
 * 若该项目首次完成拆解（current_step 为 "script"），推进至 "asset"
 */
function advanceProjectStep(db: DatabaseType, clipId: string): void {
  const clipRow = db.prepare(
    "SELECT project_id FROM clips WHERE id = ? AND deleted_at IS NULL"
  ).get(clipId) as { project_id: string } | undefined;
  if (!clipRow) return;

  const projectRow = db.prepare(
    "SELECT current_step FROM projects WHERE id = ?"
  ).get(clipRow.project_id) as { current_step: string } | undefined;
  if (projectRow && projectRow.current_step === "script") {
    db.prepare("UPDATE projects SET current_step = 'asset', updated_at = datetime('now') WHERE id = ?")
      .run(clipRow.project_id);
  }
}

// ─── handler ───────────────────────────────────────────────────────
/**
 * 片段拆解任务 handler
 */
export async function generateClipScriptHandler(ctx: TaskContext): Promise<string> {
  const input = ctx.taskInput as {
    projectId: string;
    clipId: string;
    sourceText: string;
    styleMode?: string;
  };
  if (!input?.projectId || !input?.clipId || !input?.sourceText) {
    throw new Error("generate_clip_script: 缺少 projectId / clipId / sourceText");
  }

  const { db, emit } = ctx;

  // 前置检查：片段是否已被删除
  const clip = db.prepare(
    "SELECT id FROM clips WHERE id = ? AND deleted_at IS NULL"
  ).get(input.clipId);
  if (!clip) {
    lw("拆解", `片段已删除，跳过拆解 clipId=${input.clipId}`);
    db.prepare("UPDATE clip_scripts SET status = 'failed', error_message = '片段已删除', updated_at = datetime('now') WHERE clip_id = ?")
      .run(input.clipId);
    return JSON.stringify({ skipped: true, reason: "clip_deleted" });
  }

  l("拆解", `开始拆解 clipId=${input.clipId} 原文=${input.sourceText.length}字符`);

  // 标记 running
  db.prepare("UPDATE clip_scripts SET status = 'running', updated_at = datetime('now') WHERE clip_id = ? AND status = 'pending'")
    .run(input.clipId);

  // 调用模型并解析（含修复重试）
  const { storyboards, resources, rawOutput } = await callModelAndParse(ctx, input);

  // 写入数据库
  saveResults(db, input.clipId, storyboards, resources, rawOutput, input.styleMode);

  // 推进项目步骤
  advanceProjectStep(db, input.clipId);

  l("拆解", `拆解成功 clipId=${input.clipId} 分镜数=${storyboards.length}`);
  emit({ type: "task_success", taskId: ctx.taskId });

  return JSON.stringify({
    sbidCount: storyboards.length,
    characterCount: resources.characters.length,
    sceneCount: resources.scenes.length,
    itemCount: resources.items.length,
  });
}

// ─── 输出解析 ──────────────────────────────────────────────────────

interface ParsedResourceItem {
  name: string;
  description: string;
  prompt: string;
}

interface ParsedSceneItem extends ParsedResourceItem {
  time?: string;
  weather?: string;
  direction?: string;
}

interface StoryboardItem {
  sbid: string;
  duration?: number;
  description: string;
  originalText?: string;
  characters: ParsedResourceItem[];
  scenes: ParsedSceneItem[];
  items: ParsedResourceItem[];
  animationPrompt: string;
}

function parseModelOutput(raw: string): StoryboardItem[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFences(raw));
  } catch {
    throw new Error("拆解返回内容不是有效的 JSON");
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("拆解返回格式无效：期望非空 JSON 数组");
  }
  return payload.map((item, i) => {
    const obj = item as Record<string, unknown>;
    const safeStr = (v: unknown) => (typeof v === "string" ? v : "");

    return {
      sbid: safeStr(obj.sbid) || `${i + 1}`,
      duration: typeof obj.duration === "number" ? obj.duration : undefined,
      description: safeStr(obj.description),
      originalText: safeStr(obj.originalText),
      characters: Array.isArray(obj.characters) ? obj.characters.map((c: ParsedResourceItem) => ({
        name: safeStr(c.name),
        description: safeStr(c.description),
        prompt: safeStr(c.prompt),
      })) : [],
      scenes: Array.isArray(obj.scenes) ? obj.scenes.map((s: ParsedSceneItem) => ({
        name: safeStr(s.name),
        description: safeStr(s.description),
        time: safeStr(s.time),
        weather: safeStr(s.weather),
        direction: safeStr(s.direction),
        prompt: safeStr(s.prompt),
      })) : [],
      items: Array.isArray(obj.items) ? obj.items.map((it: ParsedResourceItem) => ({
        name: safeStr(it.name),
        description: safeStr(it.description),
        prompt: safeStr(it.prompt),
      })) : [],
      animationPrompt: safeStr(obj.animationPrompt),
    };
  });
}

// ─── 数据库写入 ────────────────────────────────────────────────────

interface ExtractedResource {
  type: "character" | "scene" | "item";
  name: string;
  description: string;
  prompt: string;
  tags?: string[];
}

function buildResources(sbs: StoryboardItem[]): {
  characters: ExtractedResource[];
  scenes: ExtractedResource[];
  items: ExtractedResource[];
} {
  const charMap = new Map<string, ExtractedResource>();
  const sceneMap = new Map<string, ExtractedResource>();
  const itemMap = new Map<string, ExtractedResource>();

  for (const sb of sbs) {
    for (const c of sb.characters) {
      if (c.name && !charMap.has(c.name)) {
        charMap.set(c.name, { type: "character", name: c.name, description: c.description, prompt: c.prompt });
      }
    }
    for (const s of sb.scenes) {
      if (s.name && !sceneMap.has(s.name)) {
        sceneMap.set(s.name, { type: "scene", name: s.name, description: s.description, prompt: s.prompt });
      }
    }
    for (const it of sb.items) {
      if (it.name && !itemMap.has(it.name)) {
        itemMap.set(it.name, { type: "item", name: it.name, description: it.description, prompt: it.prompt });
      }
    }
  }

  return {
    characters: [...charMap.values()],
    scenes: [...sceneMap.values()],
    items: [...itemMap.values()],
  };
}
