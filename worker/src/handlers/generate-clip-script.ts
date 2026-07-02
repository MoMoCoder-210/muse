/**
 * 片段拆解 — 模型分析片段生成分镜、角色、场景、物品及生图/生视频提示词
 *
 * 基于模块 03，拆解结果写入 clip_scripts 表：
 *   - script_summary：片段摘要
 *   - extracted_resources_json：角色 / 场景 / 物品候选列表（JSON）
 *   - raw_model_output：模型原始响应（诊断用）
 *   - 同时将 JSON 中的 storyboards/characters/scenes/items 分离存储
 *
 * @author yt @date 20260702
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { TaskContext } from "../types.js";
import type { ChatMessage } from "../clients/text.js";
import { logLine } from "../logger.js";

// ─── 提示词加载 ────────────────────────────────────────────────────
// @author yt @date 20260702 加载拆解系统提示词

function loadDisassemblePrompt(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(moduleDir, "../prompts/disassemble.md"), "utf-8");
}

let promptCache: string | null = null;
// @author yt @date 20260702 获取拆解系统提示词
function getPrompt(): string {
  if (promptCache === null) {
    promptCache = loadDisassemblePrompt();
    logLine("拆解", "DEBUG", "拆解系统提示词已加载（prompts/disassemble.md）");
  }
  return promptCache;
}

// ─── JSON 清洗 ─────────────────────────────────────────────────────

// @author yt @date 20260702 移除 Markdown 代码围栏
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

// ─── 输出解析 ──────────────────────────────────────────────────────

interface StoryboardItem {
  sbid: string;
  description: string;
  originalText?: string;
  characters: { name: string; description: string; prompt: string }[];
  scenes: { name: string; description: string; time?: string; weather?: string; direction?: string; prompt: string }[];
  items: { name: string; description: string; prompt: string }[];
  animationPrompt: string;
  fusionPrompt?: string;
}

// @author yt @date 20260702 解析模型返回的 JSON 为分镜数组
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
      sbid: safeStr(obj.sbid) || `${i + 1}-1`,
      description: safeStr(obj.description),
      originalText: safeStr(obj.originalText),
      characters: Array.isArray(obj.characters) ? obj.characters.map((c: any) => ({
        name: safeStr(c.name),
        description: safeStr(c.description),
        prompt: safeStr(c.prompt),
      })) : [],
      scenes: Array.isArray(obj.scenes) ? obj.scenes.map((s: any) => ({
        name: safeStr(s.name),
        description: safeStr(s.description),
        time: safeStr(s.time),
        weather: safeStr(s.weather),
        direction: safeStr(s.direction),
        prompt: safeStr(s.prompt),
      })) : [],
      items: Array.isArray(obj.items) ? obj.items.map((it: any) => ({
        name: safeStr(it.name),
        description: safeStr(it.description),
        prompt: safeStr(it.prompt),
      })) : [],
      animationPrompt: safeStr(obj.animationPrompt),
      fusionPrompt: safeStr(obj.fusionPrompt),
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

// @author yt @date 20260702 构建提取的资源对象
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

// @author yt @date 20260702 写入拆解结果到数据库
function writeResults(
  db: DatabaseType,
  projectId: string,
  clipId: string,
  rawOutput: string,
  sbs: StoryboardItem[],
  mode: string,
): void {
  const resources = buildResources(sbs);
  const summary = sbs.map((s) => s.description).join("；").slice(0, 200);
  const resourcesJson = JSON.stringify(resources);

  // 写入 clip_scripts
  db.prepare(`
    INSERT INTO clip_scripts (id, project_id, clip_id, source_text, script_summary,
      raw_model_output, extracted_resources_json, mode, status)
    VALUES (?, ?, ?, '', ?, ?, ?, ?, 'success')
  `).run(randomUUID(), projectId, clipId, summary, rawOutput, resourcesJson, mode);

  // 写入故事板（每个 sbid 一行）
  const insertSb = db.prepare(`
    INSERT INTO storyboards (id, project_id, clip_id, sbid, description, original_text,
      animation_prompt, fusion_prompt, sort_order, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `);
  for (let i = 0; i < sbs.length; i++) {
    const sb = sbs[i];
    insertSb.run(
      randomUUID(), projectId, clipId,
      sb.sbid, sb.description, sb.originalText || "",
      sb.animationPrompt, sb.fusionPrompt || "", i + 1,
    );
  }

  // 更新 clips 状态
  db.prepare("UPDATE clips SET status = 'script_ready', updated_at = datetime('now') WHERE id = ?")
    .run(clipId);

  // 如果该片段是项目中第一个拆解完成的，推进项目 current_step
  const projectRow = db.prepare(
    "SELECT current_step FROM projects WHERE id = ?"
  ).get(projectId) as { current_step: string } | undefined;
  if (projectRow && projectRow.current_step === "script") {
    db.prepare("UPDATE projects SET current_step = 'asset', updated_at = datetime('now') WHERE id = ?")
      .run(projectId);
  }
}

// ─── handler ───────────────────────────────────────────────────────
/**
 * 片段拆解任务 handler
 *
 * @author yt @date 20260702
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
  const textClient = ctx.clients?.text;
  if (!textClient) {
    throw new Error("拆解不可用：文本模型客户端未初始化");
  }

  logLine("拆解", "INFO", `开始拆解 clipId=${input.clipId} 原文=${input.sourceText.length}字符`);

  // 标记 running
  db.prepare("UPDATE clip_scripts SET status = 'running', updated_at = datetime('now') WHERE clip_id = ? AND status = 'pending'")
    .run(input.clipId);

  const systemContent = getPrompt();
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: input.sourceText },
  ];

  logLine("拆解", "INFO", `调用模型拆解(流式) 输入=${input.sourceText.length}字符`);

  const result = await textClient.chatStream(messages, () => {}, { signal: ctx.signal });

  logLine("拆解", "INFO", `模型拆解返回完成 输出=${result.content.length}字符`);

  try {
    const sbs = parseModelOutput(result.content);
    if (sbs.length === 0) {
      throw new Error("拆解结果为空");
    }

    const mode = input.styleMode || "RS";
    writeResults(db, input.projectId, input.clipId, result.content, sbs, mode);

    logLine("拆解", "INFO", `拆解成功 clipId=${input.clipId} 分镜数=${sbs.length}`);
    emit({ type: "task_success", taskId: "" });

    return JSON.stringify({
      sbidCount: sbs.length,
      characterCount: buildResources(sbs).characters.length,
      sceneCount: buildResources(sbs).scenes.length,
      itemCount: buildResources(sbs).items.length,
    });
  } catch (parseError) {
    const reason = parseError instanceof Error ? parseError.message : String(parseError);
    logLine("拆解", "WARN", `输出 JSON 解析失败（${reason}），执行修复重试`);

    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      { role: "user", content: "请将以上内容转为标准的 JSON 数组，不要包含任何 Markdown 符号或解释性文字，直接输出 JSON 数组本身。" },
    ];

    const repairResult = await textClient.chatStream(repairMessages, () => {}, { signal: ctx.signal });

    const sbs = parseModelOutput(repairResult.content);
    const mode = input.styleMode || "RS";
    writeResults(db, input.projectId, input.clipId, repairResult.content, sbs, mode);

    logLine("拆解", "INFO", `拆解修复成功 clipId=${input.clipId} 分镜数=${sbs.length}`);
    emit({ type: "task_success", taskId: "" });

    return JSON.stringify({ sbidCount: sbs.length });
  }
}
