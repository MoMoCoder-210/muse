/**
 * split_script 任务 handler
 * 基于模块 02 第 4 节 "规则拆分"
 *
 * 本期只实现规则拆分，模型智能拆分留 TODO。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "crypto";
import type { TaskContext } from "../types.js";
import { logLine } from "../logger.js";

// ─── 集数标志正则 ────────────────────────────────────────────────
const EPISODE_PATTERNS = [
  // 第X集/章/幕/场/回/节（中文数字或阿拉伯数字）
  /(?:^|\n)\s*【*\[*第\s*[一二三四五六七八九十百零\d]+\s*[集章幕场回节]/,
  // (X) 括号编号（全角/半角）
  /(?:^|\n)\s*[（(]\s*[一二三四五六七八九十\d]+\s*[)）]/,
  // EP.X / Ep.X
  /(?:^|\n)\s*[Ee][Pp]\.?\s*\d+/,
  // Chapter X
  /(?:^|\n)\s*[Cc]hapter\s*\d+/,
  // Episode X
  /(?:^|\n)\s*[Ee]pisode\s*\d+/,
  // 场景X（行首）
  /(?:^|\n)\s*场景\s*\d+/,
];

// 设定部分关键词
const SETTING_KEYWORDS = [
  "人物介绍", "角色介绍", "背景设定", "故事梗概", "故事背景",
  "主要人物", "人物设定", "角色设定", "剧情简介", "内容简介",
];

type ClipDraft = {
  sortIndex: number;
  title: string;
  summary: string;
  sourceText: string;
  wordCount: number;
};

// ─── 规则拆分 ─────────────────────────────────────────────────────

/**
 * 查找文本中所有集数标志的位置。
 */
function findEpisodeMarkers(text: string): number[] {
  const positions: number[] = [];
  for (const pattern of EPISODE_PATTERNS) {
    const global = new RegExp(pattern.source, "gm");
    let match: RegExpExecArray | null;
    while ((match = global.exec(text)) !== null) {
      // 标志从换行符之后开始，跳过前导 \n
      const pos = match[0].startsWith("\n") ? match.index + 1 : match.index;
      if (!positions.includes(pos)) positions.push(pos);
    }
  }
  return positions.sort((a, b) => a - b);
}

/**
 * 检查文本开头是否包含设定关键词。
 */
function hasSettingKeywords(text: string): boolean {
  const sample = text.slice(0, 500);
  return SETTING_KEYWORDS.some((kw) => sample.includes(kw));
}

/**
 * 统计语义字数（中文字、英文单词、标点各算1）。
 */
function countWords(text: string): number {
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (text.match(/\b[a-zA-Z]+\b/g) || []).length;
  const punct = (text.match(/[，。！？；：、""''（）【】《》]/g) || []).length;
  return cn + en + punct;
}

/**
 * 尝试规则拆分。
 * 返回 ClipDraft[] 或 null（失败时）。
 */
export function ruleSplit(text: string): ClipDraft[] | null {
  let workText = text;

  // 剔除设定部分
  if (hasSettingKeywords(workText)) {
    logLine("split-script", "INFO", "Setting keywords detected, trimming preamble");
    const markers = findEpisodeMarkers(workText);
    if (markers.length > 0) {
      workText = workText.slice(markers[0]);
    }
  }

  const markers = findEpisodeMarkers(workText);
  if (markers.length === 0) {
    logLine("split-script", "INFO", "Rule split: no episode markers found in text");
    return null;
  }

  logLine("split-script", "INFO", `Rule split: found ${markers.length} episode markers`);

  const clips: ClipDraft[] = [];

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i];
    const end = i + 1 < markers.length ? markers[i + 1] : workText.length;
    let segment = workText.slice(start, end);

    // 移除集数标志行本身（第一行）
    const firstNewline = segment.indexOf("\n");
    if (firstNewline !== -1) {
      segment = segment.slice(firstNewline + 1);
    }

    // 清理首尾
    segment = segment.trim();
    if (segment.startsWith("：") || segment.startsWith(":")) {
      segment = segment.slice(1).trim();
    }

    const wc = countWords(segment);
    clips.push({
      sortIndex: i + 1,
      title: "",
      summary: "",
      sourceText: segment,
      wordCount: wc,
    });
  }

  // 成功判定
  if (clips.length === 0) {
    logLine("split-script", "INFO", "Rule split: no clips produced after parsing");
    return null;
  }

  const shortClips = clips.filter((c) => c.wordCount < 50);
  if (shortClips.length > 0) {
    logLine("split-script", "INFO", `Rule split: ${shortClips.length} clip(s) have fewer than 50 words, rejecting`);
    return null;
  }

  const totalClipWords = clips.reduce((s, c) => s + c.wordCount, 0);
  const totalWords = countWords(workText);
  const coverage = totalWords > 0 ? totalClipWords / totalWords : 0;
  if (totalWords > 0 && coverage < 0.8) {
    logLine("split-script", "INFO", `Rule split: coverage ${(coverage * 100).toFixed(1)}% < 80%, rejecting`);
    return null;
  }

  return clips;
}

// ─── 写入数据库 ────────────────────────────────────────────────────

function insertClips(
  db: DatabaseType,
  projectId: string,
  sourceId: string,
  clips: ClipDraft[]
): void {
  const insert = db.prepare(
    `INSERT INTO clips (id, project_id, source_id, sort_index, title, summary, source_text, status, current_step)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'split')`
  );
  const updateSource = db.prepare(
    `UPDATE script_sources SET split_status = 'success', updated_at = datetime('now') WHERE id = ?`
  );
  const updateProject = db.prepare(
    `UPDATE projects SET current_step = 'script', updated_at = datetime('now') WHERE id = ?`
  );

  db.transaction(() => {
    for (const clip of clips) {
      insert.run(
        randomUUID(),
        projectId,
        sourceId,
        clip.sortIndex,
        clip.title,
        clip.summary,
        clip.sourceText,
      );
    }
    updateSource.run(sourceId);
    updateProject.run(projectId);
  })();
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseModelClips(raw: string, originalText: string): ClipDraft[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFences(raw));
  } catch {
    throw new Error("模型拆分返回内容不是有效的 JSON");
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("模型拆分返回格式无效：期望非空 JSON 数组");
  }

  const clips = payload.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`模型拆分第 ${index + 1} 条不是有效对象`);
    }

    const obj = item as Record<string, unknown>;
    const sourceText = typeof obj.content === "string" ? obj.content.trim() : "";
    if (!sourceText) {
      throw new Error(`模型拆分第 ${index + 1} 条内容为空或缺少 content 字段`);
    }

    return {
      sortIndex: index + 1,
      title: typeof obj.title === "string" ? obj.title.trim() : "",
      summary: typeof obj.summary === "string" ? obj.summary.trim() : "",
      sourceText,
      wordCount: typeof obj.wordCount === "number" && obj.wordCount > 0
        ? obj.wordCount
        : countWords(sourceText),
    };
  });

  const totalClipWords = clips.reduce((sum, clip) => sum + clip.wordCount, 0);
  const originalWords = countWords(originalText);
  if (originalWords > 0 && totalClipWords / originalWords < 0.8) {
    throw new Error("模型拆分结果覆盖率不足");
  }

  return clips;
}

const MODEL_SPLIT_MAX_WORDS = 100000;

async function modelSplit(ctx: TaskContext, text: string): Promise<ClipDraft[]> {
  const textClient = ctx.clients?.text;
  if (!textClient) {
    throw new Error("模型拆分不可用：文本模型客户端未初始化");
  }

  const wordCount = countWords(text);

  if (wordCount < 1500) {
    return [{
      sortIndex: 1,
      title: "",
      summary: "",
      sourceText: text.trim(),
      wordCount,
    }];
  }

  if (wordCount > MODEL_SPLIT_MAX_WORDS) {
    throw new Error(
      `剧本文字数（${wordCount}）超过模型拆分上限（${MODEL_SPLIT_MAX_WORDS}），请先手动精简或使用规则拆分`,
    );
  }

  const prompt = [
    "你是一个影视剧本拆分助手。",
    "请把输入剧本拆成有序片段，输出必须是 JSON 数组。",
    "每个元素只能包含 title、summary、wordCount、content 这四个字段。",
    "content 必须保留原文，不要改写，不要补写。",
    "如果原文存在集数边界，按自然集数切分；如果没有，按语义完整性切分成多个片段。",
    "不要输出 Markdown，不要输出解释文字。",
  ].join("\n");

  const result = await textClient.chat(
    [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
    {
      temperature: 0.2,
      maxTokens: 4096,
      signal: ctx.signal,
    }
  );

  return parseModelClips(result.content, text);
}

// ─── handler 入口 ─────────────────────────────────────────────────

/**
 * split_script 任务 handler，由 task-runner 调用。
 * input_json 结构：{ projectId, sourceId, forceAi? }
 */
export async function splitScriptHandler(ctx: TaskContext): Promise<string> {
  const input = ctx.taskInput as { projectId: string; sourceId: string; forceAi?: boolean };
  if (!input?.projectId || !input?.sourceId) {
    throw new Error("split_script: missing projectId or sourceId in input_json");
  }
  return splitScriptWithInput(ctx, input);
}

/**
 * 实际的拆分入口，由 task-runner 在分发时调用。
 */
export async function splitScriptWithInput(
  ctx: TaskContext,
  input: { projectId: string; sourceId: string; forceAi?: boolean }
): Promise<string> {
  const { db, emit } = ctx;

  logLine("split-script", "INFO", `Starting split: projectId=${input.projectId} sourceId=${input.sourceId} forceAi=${input.forceAi ?? false}`);

  // 读取剧本内容
  const source = db
    .prepare("SELECT normalized_content FROM script_sources WHERE id = ?")
    .get(input.sourceId) as { normalized_content: string } | undefined;

  if (!source) {
    logLine("split-script", "ERROR", `ScriptSource not found: ${input.sourceId}`);
    throw new Error(`ScriptSource not found: ${input.sourceId}`);
  }

  const text = source.normalized_content;
  const wordCount = countWords(text);
  logLine("split-script", "INFO", `Script loaded: ${wordCount} words, ${text.length} chars`);

  // 标记 running
  db.prepare(
    "UPDATE script_sources SET split_status = 'running', updated_at = datetime('now') WHERE id = ?"
  ).run(input.sourceId);

  const ruleClips = input.forceAi ? null : ruleSplit(text);

  if (ruleClips) {
    logLine("split-script", "INFO", `Rule split succeeded: ${ruleClips.length} clips`);
    insertClips(db, input.projectId, input.sourceId, ruleClips);
    emit({ type: "task_success", taskId: "" });
    return JSON.stringify({
      splitMode: "rule",
      clipCount: ruleClips.length,
      totalWordCount: ruleClips.reduce((s, c) => s + c.wordCount, 0),
    });
  }

  logLine("split-script", "INFO", `Rule split ${input.forceAi ? "skipped (forceAi)" : "failed"}, falling back to model split`);

  try {
    const modelClips = await modelSplit(ctx, text);
    logLine("split-script", "INFO", `Model split succeeded: ${modelClips.length} clips`);
    insertClips(db, input.projectId, input.sourceId, modelClips);
    emit({ type: "task_success", taskId: "" });
    return JSON.stringify({
      splitMode: "model",
      clipCount: modelClips.length,
      totalWordCount: modelClips.reduce((s, c) => s + c.wordCount, 0),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logLine("split-script", "ERROR", `Model split failed: ${errorMessage}`);
    db.prepare(
      "UPDATE script_sources SET split_status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(errorMessage, input.sourceId);
    throw error;
  }
}
