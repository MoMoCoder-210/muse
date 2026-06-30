/**
 * split_script 任务 handler
 * 基于模块 02 第 4 节 "规则拆分"
 *
 * 本期只实现规则拆分，模型智能拆分留 TODO。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { TaskContext } from "../types.js";

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
    const markers = findEpisodeMarkers(workText);
    if (markers.length > 0) {
      workText = workText.slice(markers[0]);
    }
  }

  const markers = findEpisodeMarkers(workText);
  if (markers.length === 0) return null;

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
  if (clips.length === 0) return null;
  if (clips.some((c) => c.wordCount < 50)) return null;
  const totalClipWords = clips.reduce((s, c) => s + c.wordCount, 0);
  const totalWords = countWords(workText);
  if (totalWords > 0 && totalClipWords / totalWords < 0.8) return null;

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

  const { randomUUID } = require("crypto") as typeof import("crypto");

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

  // 读取剧本内容
  const source = db
    .prepare("SELECT normalized_content FROM script_sources WHERE id = ?")
    .get(input.sourceId) as { normalized_content: string } | undefined;

  if (!source) {
    throw new Error(`ScriptSource not found: ${input.sourceId}`);
  }

  const text = source.normalized_content;

  // 标记 running
  db.prepare(
    "UPDATE script_sources SET split_status = 'running', updated_at = datetime('now') WHERE id = ?"
  ).run(input.sourceId);

  // 规则拆分
  const clips = ruleSplit(text);

  if (clips) {
    insertClips(db, input.projectId, input.sourceId, clips);
    emit({ type: "task_success", taskId: "" });
    return JSON.stringify({
      splitMode: "rule",
      clipCount: clips.length,
      totalWordCount: clips.reduce((s, c) => s + c.wordCount, 0),
    });
  }

  // TODO: 规则拆分失败 → 走模型智能拆分
  // 当前先标记失败，等待模型接入后替换
  db.prepare(
    "UPDATE script_sources SET split_status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
  ).run("规则拆分失败，模型拆分暂未实现", input.sourceId);

  throw new Error("规则拆分失败，该剧本没有明确的集数标志，模型拆分功能即将上线");
}
