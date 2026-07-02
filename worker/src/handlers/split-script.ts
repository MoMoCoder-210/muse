/**
 * 智能拆片段
 *
 * 两段式拆分：
 *   1. 规则拆分（正则匹配集数标志），失败时回退模型拆分
 *   2. 模型拆分按文本长度选择策略：
 *      - ≤1500 字且无集数关键字 → 整体返回，不拆分
 *      - ≤6000 字 → 单次调用 LLM
 *      - >6000 字 → 按段落边界分块，逐批调用，尾集回收（carry-over）
 *
 * @author yt
 * @date 20260702
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { TaskContext } from "../types.js";
import type { ChatMessage } from "../clients/text.js";
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

// ─── 模型拆分阈值（可配置） ────────────────────────────────────────
/** 模型拆分总字数上限（超过则拒绝，要求用户精简） */
const MODEL_SPLIT_MAX_WORDS = 100000;
/** 短文本阈值：≤此字数且无集数关键字 → 整体返回不拆分 */
const SHORT_TEXT_THRESHOLD = 1500;
/** 单次调用阈值：≤此字数 → 单次调用 LLM */
const SINGLE_CALL_THRESHOLD = 6000;
/** 分块字符上限：每个文本块不超过此字符数 */
const CHUNK_MAX_CHARS = 6000;
/** 尾集回收阈值：非末批尾集字数 < 此值则回收，拼到下一批开头 */
const CARRY_OVER_THRESHOLD = 800;

// ─── 分块追加提示 ────────────────────────────────────────────────
/** 非末批追加提示：要求尾集字数与前一致，便于衔接下一批 */
const MID_BATCH_HINT =
  "注意：这是一段较长剧本的中间部分，最后一集的字数应与前面各集保持一致，" +
  "如果剩余内容不足以凑成完整一集，就把剩余内容整体作为最后一集输出，不要强行凑数。";

/** 末批追加提示：要求各集字数均衡，避免最后一集过短 */
const LAST_BATCH_HINT =
  "注意：这是剧本的最后一段，请确保各集字数尽量均衡，避免出现某一集字数过少的情况。";

/** JSON 修复重试提示词 */
const JSON_REPAIR_HINT =
  "请将以上内容转为标准的 JSON 数组，不要包含任何 Markdown 符号或解释性文字，直接输出 JSON 数组本身。";

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
 * 检查文本是否包含任意集数标志（用于短文本不拆分判定）。
 */
function hasEpisodeMarkers(text: string): boolean {
  return EPISODE_PATTERNS.some((pattern) => pattern.test(text));
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
    logLine("剧本拆分", "DEBUG", "检测到设定关键词，剔除前言部分");
    const markers = findEpisodeMarkers(workText);
    if (markers.length > 0) {
      workText = workText.slice(markers[0]);
    }
  }

  const markers = findEpisodeMarkers(workText);
  if (markers.length === 0) {
    logLine("剧本拆分", "DEBUG", "规则拆分：未发现集数标志");
    return null;
  }

  logLine("剧本拆分", "DEBUG", `规则拆分：发现 ${markers.length} 个集数标志`);

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
    logLine("剧本拆分", "DEBUG", "规则拆分：解析后无有效片段");
    return null;
  }

  const shortClips = clips.filter((c) => c.wordCount < 50);
  if (shortClips.length > 0) {
    logLine("剧本拆分", "DEBUG", `规则拆分：${shortClips.length} 个片段字数不足50，放弃`);
    return null;
  }

  const totalClipWords = clips.reduce((s, c) => s + c.wordCount, 0);
  const totalWords = countWords(workText);
  const coverage = totalWords > 0 ? totalClipWords / totalWords : 0;
  if (totalWords > 0 && coverage < 0.8) {
    logLine("剧本拆分", "DEBUG", `规则拆分：覆盖率 ${(coverage * 100).toFixed(1)}% 低于80%，放弃`);
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

// ─── 提示词加载 ────────────────────────────────────────────────────

/**
 * 加载分集系统提示词（build 时复制 prompts 到 dist）
 * @author yt @date 20260702
 */
function loadSplitPrompt(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(moduleDir, "../prompts/split.md"), "utf-8");
}

/** 系统提示词缓存工具 */
let splitPromptCache: string | null = null;
function getSplitPrompt(): string {
  if (splitPromptCache === null) {
    splitPromptCache = loadSplitPrompt();
    logLine("剧本拆分", "DEBUG", "分集系统提示词已加载（prompts/split.md）");
  }
  return splitPromptCache;
}

// ─── 分块工具 ─────────────────────────────────────────────────────

/**
 * 按段落换行符边界将文本切分为多个块
 * @author yt @date 20260702 长文本分块处理
 */
function chunkText(text: string, maxChars: number): string[] {
  const paragraphs = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? current + "\n" + para : para;

    if (candidate.length > maxChars && current) {
      // 当前块已满，封口并新开
      chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }

    // 单段超长硬切兜底
    while (current.length > maxChars) {
      logLine(
        "剧本拆分",
        "WARN",
        `段落超长（${current.length} > ${maxChars} 字符），硬切兜底`,
      );
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
    if (current.length === 0) {
      // 硬切后剩余为空，重置以便下一段累加
      current = "";
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

// ─── 模型输出解析 ──────────────────────────────────────────────────

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

/**
 * 解析模型返回的 JSON 数组为 ClipDraft[]
 * @author yt @date 20260702
 */
function parseModelClips(raw: string): ClipDraft[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFences(raw));
  } catch {
    throw new Error("模型拆分返回内容不是有效的 JSON");
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("模型拆分返回格式无效：期望非空 JSON 数组");
  }

  return payload.map((item, index) => {
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
}

/**
 * 校验拆分结果对原文的覆盖率，低于 80% 视为模型漏内容抛错
 */
function validateCoverage(clips: ClipDraft[], originalText: string): void {
  const totalClipWords = clips.reduce((sum, clip) => sum + clip.wordCount, 0);
  const originalWords = countWords(originalText);
  if (originalWords > 0) {
    const coverage = totalClipWords / originalWords;
    if (coverage < 0.8) {
      throw new Error(
        `模型拆分结果覆盖率不足：${totalClipWords}/${originalWords} = ${(coverage * 100).toFixed(1)}%`,
      );
    }
  }
}

/**
 * 全局重排 sortIndex
 */
function reindexClips(clips: ClipDraft[]): ClipDraft[] {
  return clips.map((clip, index) => ({ ...clip, sortIndex: index + 1 }));
}

// ─── 模型拆分 ─────────────────────────────────────────────────────

/**
 * 单次调用文本模型拆分当前批次文本。
 *
 * 流程：
 *   1. 用系统提示词（split.md）+ 批次追加提示拼接 system 消息
 *   2. 解析 JSON；解析失败时执行一次 JSON 修复重试
 * @param batchHint 批次追加提示（非末批 / 末批 / 单次）
 * @author yt @date 20260702
 */
async function callModelOnce(
  ctx: TaskContext,
  text: string,
  batchHint: string,
): Promise<ClipDraft[]> {
  const textClient = ctx.clients?.text;
  if (!textClient) {
    throw new Error("模型拆分不可用：文本模型客户端未初始化");
  }

  const systemContent = `${getSplitPrompt()}\n\n${batchHint}`;
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: text },
  ];

  logLine(
    "剧本拆分",
    "INFO",
    `调用模型拆分(流式) 输入=${text.length}字符`,
  );

  // 流式调用：长输出场景下 token 持续返回，连接保持活跃，避免整体 HTTP 超时
  // 调用参数不传，TextClient 内部使用 this.config（即 settings.json 配置）
  // onChunk 每 1000 字打一次进度日志，便于诊断卡顿
  const result = await textClient.chatStream(
    messages,
    buildStreamProgressLogger("模型拆分"),
    { signal: ctx.signal },
  );

  logLine(
    "剧本拆分",
    "INFO",
    `模型拆分返回完成 输出=${result.content.length}字符 inputTokens=${result.inputTokens} outputTokens=${result.outputTokens} model=${result.model}`,
  );

  try {
    return parseModelClips(result.content);
  } catch (parseError) {
    // 一次 JSON 修复重试
    const reason = parseError instanceof Error ? parseError.message : String(parseError);
    logLine("剧本拆分", "WARN", `模型输出 JSON 解析失败（${reason}），执行一次修复重试`);

    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      { role: "user", content: JSON_REPAIR_HINT },
    ];

    logLine("剧本拆分", "INFO", `调用模型修复重试(流式)`);
    const repairResult = await textClient.chatStream(
      repairMessages,
      buildStreamProgressLogger("模型拆分修复"),
      { signal: ctx.signal },
    );
    logLine(
      "剧本拆分",
      "INFO",
      `模型修复重试返回完成 输出=${repairResult.content.length}字符`,
    );

    return parseModelClips(repairResult.content);
  }
}

/**
 * 构造流式进度日志回调：每累计 100 字符打一次日志
 * @author yt @date 20260702
 */
function buildStreamProgressLogger(label: string): (delta: string) => void {
  let received = 0;
  let lastLogged = 0;
  return (delta: string) => {
    received += delta.length;
    if (received - lastLogged >= 100) {
      logLine("剧本拆分", "DEBUG", `${label}流式进度：已接收 ${received} 字符`);
      lastLogged = received;
    }
  };
}

/**
 * 模型智能拆分：按文本长度选择策略。
 * @author yt @date 20260702
 */
async function modelSplit(ctx: TaskContext, text: string): Promise<ClipDraft[]> {
  const textClient = ctx.clients?.text;
  if (!textClient) {
    throw new Error("模型拆分不可用：文本模型客户端未初始化");
  }

  const wordCount = countWords(text);

  // 策略 1：短文本且无集数关键字 → 整体返回，不拆分
  if (wordCount <= SHORT_TEXT_THRESHOLD && !hasEpisodeMarkers(text)) {
    logLine("剧本拆分", "DEBUG", `模型拆分：短文本且无集数标志（${wordCount} 字），整体返回不拆分`);
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

  // 策略 2：≤6000 字 → 单次调用
  if (wordCount <= SINGLE_CALL_THRESHOLD) {
    logLine("剧本拆分", "INFO", `模型拆分：单次调用（${wordCount} 字）`);
    const clips = await callModelOnce(ctx, text, LAST_BATCH_HINT);
    validateCoverage(clips, text);
    return reindexClips(clips);
  }

  // 策略 3：>6000 字 → 分块处理 + carry-over
  logLine("剧本拆分", "INFO", `模型拆分：分块处理（${wordCount} 字），分块上限 ${CHUNK_MAX_CHARS} 字符`);
  const chunks = chunkText(text, CHUNK_MAX_CHARS);
  logLine("剧本拆分", "DEBUG", `文本切分为 ${chunks.length} 块`);

  const allClips: ClipDraft[] = [];
  let carryOver = "";

  for (let i = 0; i < chunks.length; i++) {
    const isLastBatch = i === chunks.length - 1;
    const batchInput = carryOver ? carryOver + "\n" + chunks[i] : chunks[i];
    const carryChars = carryOver.length;
    carryOver = "";

    const hint = isLastBatch ? LAST_BATCH_HINT : MID_BATCH_HINT;
    logLine(
      "剧本拆分",
      "DEBUG",
      `处理第 ${i + 1}/${chunks.length} 块：输入 ${batchInput.length} 字符` +
        (carryChars > 0 ? `（含回收 ${carryChars} 字符）` : "") +
        `，${isLastBatch ? "末批" : "非末批"}`,
    );

    const batchClips = await callModelOnce(ctx, batchInput, hint);

    // 尾集回收（仅非末批，且本批有多集可回收）
    if (!isLastBatch && batchClips.length > 1) {
      const lastClip = batchClips[batchClips.length - 1];
      if (lastClip.wordCount < CARRY_OVER_THRESHOLD) {
        logLine(
          "剧本拆分",
          "DEBUG",
          `第 ${i + 1} 批尾集过短（${lastClip.wordCount} 字 < ${CARRY_OVER_THRESHOLD}），回收至下一批开头重新处理`,
        );
        carryOver = lastClip.sourceText;
        batchClips.pop();
      }
    }

    allClips.push(...batchClips);
  }

  // 兜底：末批处理后理论上无残留 carryOver，防御性处理
  if (carryOver) {
    logLine("剧本拆分", "WARN", `存在未回收的尾集内容（${carryOver.length} 字符），作为单独一集附加`);
    allClips.push({
      sortIndex: allClips.length + 1,
      title: "",
      summary: "",
      sourceText: carryOver.trim(),
      wordCount: countWords(carryOver),
    });
  }

  logLine("剧本拆分", "INFO", `分块拆分完成：共 ${allClips.length} 集`);
  validateCoverage(allClips, text);
  return reindexClips(allClips);
}

// ─── handler 入口 ─────────────────────────────────────────────────

/**
 * split_script 任务 handler
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

  logLine(
    "剧本拆分",
    "INFO",
    `开始拆分 projectId=${input.projectId} sourceId=${input.sourceId} forceAi=${input.forceAi ?? false}`,
  );

  // 读取剧本内容
  const source = db
    .prepare("SELECT normalized_content FROM script_sources WHERE id = ?")
    .get(input.sourceId) as { normalized_content: string } | undefined;

  if (!source) {
    logLine("剧本拆分", "ERROR", `剧本源不存在：${input.sourceId}`);
    throw new Error(`ScriptSource not found: ${input.sourceId}`);
  }

  const text = source.normalized_content;
  const wordCount = countWords(text);
  logLine("剧本拆分", "INFO", `剧本已加载：${wordCount} 字，${text.length} 字符`);

  // 标记 running
  db.prepare(
    "UPDATE script_sources SET split_status = 'running', updated_at = datetime('now') WHERE id = ?"
  ).run(input.sourceId);

  const ruleClips = input.forceAi ? null : ruleSplit(text);

  if (ruleClips) {
    logLine("剧本拆分", "INFO", `规则拆分成功：共 ${ruleClips.length} 个片段`);
    insertClips(db, input.projectId, input.sourceId, ruleClips);
    emit({ type: "task_success", taskId: "" });
    return JSON.stringify({
      splitMode: "rule",
      clipCount: ruleClips.length,
      totalWordCount: ruleClips.reduce((s, c) => s + c.wordCount, 0),
    });
  }

  logLine(
    "剧本拆分",
    "INFO",
    `规则拆分${input.forceAi ? "已跳过(forceAi)" : "失败"}，回退模型拆分`,
  );

  try {
    const modelClips = await modelSplit(ctx, text);
    logLine("剧本拆分", "INFO", `模型拆分成功：共 ${modelClips.length} 个片段`);
    insertClips(db, input.projectId, input.sourceId, modelClips);
    emit({ type: "task_success", taskId: "" });
    return JSON.stringify({
      splitMode: "model",
      clipCount: modelClips.length,
      totalWordCount: modelClips.reduce((s, c) => s + c.wordCount, 0),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logLine("剧本拆分", "ERROR", `模型拆分失败：${errorMessage}`);
    db.prepare(
      "UPDATE script_sources SET split_status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(errorMessage, input.sourceId);
    throw error;
  }
}
