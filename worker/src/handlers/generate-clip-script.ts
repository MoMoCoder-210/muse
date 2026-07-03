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
import type { TaskContext } from "../types.js";
import type { ChatMessage } from "../clients/text.js";
import { l, lw, le, stripCodeFences, createPromptLoader } from "./utils.js";

// ─── 提示词加载 ────────────────────────────────────────────────────

const getPrompt = createPromptLoader("disassemble.md");

// ─── JSON 清洗 ─────────────────────────────────────────────────────

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
  // 检查片段是否已被删除
  const clip = db.prepare(
    "SELECT id FROM clips WHERE id = ? AND deleted_at IS NULL"
  ).get(clipId);
  if (!clip) {
    lw("拆解", `片段已被删除，丢弃拆解结果 clipId=${clipId}`);
    return;
  }
  const resources = buildResources(sbs);
  const summary = sbs.map((s) => s.description).join("；").slice(0, 200);
  const resourcesJson = JSON.stringify(resources);

  // 写入 clip_scripts
  db.prepare(`
    INSERT INTO clip_scripts (id, project_id, clip_id, source_text, script_summary,
      raw_model_output, extracted_resources_json, mode, status)
    VALUES (?, ?, ?, '', ?, ?, ?, ?, 'success')
  `).run(randomUUID(), projectId, clipId, summary, rawOutput, resourcesJson, mode);

  // 写入故事板（每个 item 一行）
  const insertSb = db.prepare(`
    INSERT INTO storyboards (id, project_id, clip_id, seq_num, sbid, source_text,
      visual_description, image_prompt, video_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < sbs.length; i++) {
    const sb = sbs[i];
    insertSb.run(
      randomUUID(), projectId, clipId,
      i + 1, sb.sbid, sb.originalText || "",
      sb.description, sb.fusionPrompt || "", sb.animationPrompt,
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

  const systemContent = getPrompt();
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: input.sourceText },
  ];

  // ── 模型调用（带生命周期日志） ──
  l("拆解", `发送请求 model=${textClient.config.model} 输入=${input.sourceText.length}字符 系统提示词=${systemContent.length}字符`);

  let firstChunk = true;
  let streamTotal = 0;
  let lastMilestone = 0;
  const onChunk = (delta: string) => {
    if (firstChunk) {
      l("拆解", `收到首个流式响应 首块=${delta.length}字符`);
      firstChunk = false;
    }
    streamTotal += delta.length;
    const milestone = Math.floor(streamTotal / 100) * 100;
    if (milestone >= 100 && milestone > lastMilestone) {
      l("拆解", `流式进度：已接收 ${milestone} 字符`);
      lastMilestone = milestone;
    }
  };

  let result: Awaited<ReturnType<typeof textClient.chatStream>>;
  const startedAt = Date.now();
  try {
    result = await textClient.chatStream(messages, onChunk, { signal: ctx.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - startedAt;
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("abort")) {
      le("拆解", `模型调用超时 耗时=${elapsed}ms 已接收=${streamTotal}字符 错误=${msg}`);
    } else {
      le("拆解", `模型调用失败 耗时=${elapsed}ms 已接收=${streamTotal}字符 错误=${msg}`);
    }
    // 标记 clip_scripts 失败，让调用方感知
    db.prepare("UPDATE clip_scripts SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE clip_id = ?")
      .run(msg, input.clipId);
    throw err;
  }

  l("拆解", `模型返回完成 耗时=${Date.now() - startedAt}ms 输出=${result.content.length}字符 inputTokens=${result.inputTokens} outputTokens=${result.outputTokens} model=${result.model}`);

  // 打印完整返回内容，直接打印原文以诊断 JSON 解析问题
  l("拆解", `返回内容=\n${result.content}`);

  try {
    const sbs = parseModelOutput(result.content);
    if (sbs.length === 0) {
      throw new Error("拆解结果为空");
    }

    const mode = input.styleMode || "RS";
    writeResults(db, input.projectId, input.clipId, result.content, sbs, mode);

    l("拆解", `拆解成功 clipId=${input.clipId} 分镜数=${sbs.length}`);
    emit({ type: "task_success", taskId: "" });

    const resources = buildResources(sbs);
    return JSON.stringify({
      sbidCount: sbs.length,
      characterCount: resources.characters.length,
      sceneCount: resources.scenes.length,
      itemCount: resources.items.length,
    });
  } catch (parseError) {
    const reason = parseError instanceof Error ? parseError.message : String(parseError);
    lw("拆解", `输出 JSON 解析失败（${reason}），执行修复重试`);

    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      { role: "user", content: "请将以上内容转为标准的 JSON 数组，不要包含任何 Markdown 符号或解释性文字，直接输出 JSON 数组本身。" },
    ];

    const repairResult = await textClient.chatStream(repairMessages, () => {}, { signal: ctx.signal });

    l("拆解", `修复返回完成 输出=${repairResult.content.length}字符`);
    // 打印完整修复返回内容
    l("拆解", `修复返回内容=\n${repairResult.content}`);

    const sbs = parseModelOutput(repairResult.content);
    const mode = input.styleMode || "RS";
    writeResults(db, input.projectId, input.clipId, repairResult.content, sbs, mode);

    l("拆解", `拆解修复成功 clipId=${input.clipId} 分镜数=${sbs.length}`);
    emit({ type: "task_success", taskId: "" });

    return JSON.stringify({ sbidCount: sbs.length });
  }
}
