/**
 * 分集拆解 — 模型分析分集生成镜头、人物、场景、道具及生图/生视频提示词
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "crypto";
import type { TaskContext } from "../types.js";
import type { ChatMessage } from "../clients/text.js";
import { l, lw, le, stripCodeFences, createPromptLoader } from "../utils/utils.js";

// ─── 提示词加载 ────────────────────────────────────────────────────

const getPrompt = createPromptLoader("disassemble.md");

// ─── 视频风格提示词映射 ────────────────────────────────────────────
// 与前端 src/config/muse.ts VIDEO_STYLE_PROMPT_MAP 保持同步

const VIDEO_STYLE_PROMPT_MAP: Record<string, { prefix: string; suffix: string }> = {
  国漫: {
    prefix: "国漫动画风格，流畅手绘线条，鲜艳色彩，电影感光影。",
    suffix: "画面风格：国漫动画，流畅线条，鲜艳色彩，电影感光影，2K高清，视频无任何字幕。",
  },
  动漫: {
    prefix: "动漫风格，精致手绘，细腻色彩，电影感光影。",
    suffix: "画面风格：动漫，精致手绘，细腻色彩，电影感光影，2K高清，视频无任何字幕。",
  },
  日漫: {
    prefix: "日本动漫风格短剧分集，赛璐璞上色，电影感光影。",
    suffix: "画面风格：日本动漫，赛璐璞上色，精致线条，电影感光影，2K高清，视频无任何字幕。",
  },
  韩漫: {
    prefix: "韩国动漫风格，简洁线条，柔和色调，电影感光影。",
    suffix: "画面风格：韩国动漫，简洁线条，柔和色调，电影感光影，2K高清，视频无任何字幕。",
  },
  二次元: {
    prefix: "二次元日系动漫风格短剧分集，赛璐璞上色，电影感光影。",
    suffix: "画面风格：二次元日系动漫，赛璐璞上色，精致线条，电影感光影，2K高清，视频无任何字幕。",
  },
  真人: {
    prefix: "真人电影风格，背景虚化，浅景深，电影感光影。",
    suffix: "画面风格：真人电影，背景虚化，浅景深，电影感光影，2K高清，视频无任何字幕。",
  },
};

// ─── @mention 自动标注 ─────────────────────────────────────────────

interface AnnotatedAsset {
  name: string;
  assetId: string;
  type: "character" | "scene" | "item";
}

/**
 * 对 animationPrompt 做自动 @mention 标注：
 * - 按素材名长度降序扫描，避免短名先于长名命中
 * - 首次出现：`名(@图片N)`；后续出现：复用同一 index
 * - 跳过已在 `(@图片N)` 内的匹配（lookbehind 保护）
 * - 返回：标注后的文本 + index→assetId 映射（供 video_param_json 持久化）
 */
function autoMentionPrompt(
  prompt: string,
  assets: AnnotatedAsset[],
): { annotated: string; mentionMap: { n: number; assetId: string; name: string; type: string; assetTag: string }[] } {
  if (!prompt.trim() || assets.length === 0) {
    return { annotated: prompt, mentionMap: [] };
  }

  // 同名跨类型在纯文本中无法可靠消歧，保留镜头结构中第一个素材；其余按 assetId 分配。
  const assetByName = new Map<string, AnnotatedAsset>();
  for (const asset of assets) {
    if (asset.name && !assetByName.has(asset.name)) assetByName.set(asset.name, asset);
  }
  const candidates = [...assetByName.values()].sort((a, b) => b.name.length - a.name.length);

  const existingNums: number[] = [];
  const existRe = /\(@图片(\d+)\)/g;
  let existing: RegExpExecArray | null;
  while ((existing = existRe.exec(prompt)) !== null) existingNums.push(Number(existing[1]));
  let nextIndex = existingNums.length ? Math.max(...existingNums) + 1 : 1;

  const indexByAssetId = new Map<string, number>();
  const assetByIndex = new Map<number, AnnotatedAsset>();
  let cursor = 0;
  let annotated = "";

  // 单次从左到右扫描原始文本。绝不在已经插入的 tag 上再次扫描，
  // 所以"老兵"不会把"老兵A(@图片1)"再拆坏。
  // 台词区域（<…>）内不匹配素材名：台词是对白本身，不是提示词描述。
  while (cursor < prompt.length) {
    const ch = prompt[cursor];
    // 跳过台词区域：进入 < 时不匹配任何素材，直到遇到 >
    if (ch === "<") {
      let end = prompt.indexOf(">", cursor + 1);
      if (end === -1) end = prompt.length;
      annotated += prompt.slice(cursor, end + 1);
      cursor = end + 1;
      continue;
    }

    const matched = candidates.find((asset) => prompt.startsWith(asset.name, cursor));
    if (!matched) {
      annotated += prompt[cursor];
      cursor += 1;
      continue;
    }

    const afterName = prompt.slice(cursor + matched.name.length);
    const existingTag = afterName.match(/^\(@图片(\d+)\)/);
    let index: number;
    if (existingTag) {
      index = Number(existingTag[1]);
      indexByAssetId.set(matched.assetId, index);
      if (!assetByIndex.has(index)) assetByIndex.set(index, matched);
      annotated += `${matched.name}(@图片${index})`;
      cursor += matched.name.length + existingTag[0].length;
      continue;
    }

    index = indexByAssetId.get(matched.assetId) ?? nextIndex++;
    indexByAssetId.set(matched.assetId, index);
    if (!assetByIndex.has(index)) assetByIndex.set(index, matched);
    annotated += `${matched.name}(@图片${index})`;
    cursor += matched.name.length;
  }

  const mentionMap = [...assetByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, asset]) => ({
      n,
      assetId: asset.assetId,
      name: asset.name,
      type: asset.type,
      assetTag: `${asset.name}(@图片${n})`,
    }));

  return { annotated, mentionMap };
}

/**
 * 构建完整的 video_prompt：
 * 1. 风格前缀（如有 styleMode）
 * 2. 人物/场景/道具 声明行（参考示例格式）
 * 3. animationPrompt（已 @mention 标注）
 * 4. 风格后缀（如有 styleMode）
 */
/**
 * 将完整 assetTag 精确转为可持久化的 Tiptap 文档。
 * 这是 LLM 初始结果的唯一水合入口；前端随后直接恢复该 AST，不再重复猜测文本。
 */
function buildPromptDoc(
  text: string,
  mentionMap: Array<{ n: number; assetId: string; name: string; type: string; assetTag: string }>,
): Record<string, unknown> {
  const tags = [...mentionMap].sort((a, b) => b.assetTag.length - a.assetTag.length || a.n - b.n);
  const buildParagraph = (source: string) => {
    const content: Array<Record<string, unknown>> = [];
    let remaining = source;
    while (remaining) {
      let earliest = -1;
      let matched: typeof tags[number] | undefined;
      for (const mention of tags) {
        const position = remaining.indexOf(mention.assetTag);
        if (position !== -1 && (earliest === -1 || position < earliest)) {
          earliest = position;
          matched = mention;
        }
      }
      if (!matched || earliest === -1) {
        content.push({ type: "text", text: remaining });
        break;
      }
      if (earliest > 0) content.push({ type: "text", text: remaining.slice(0, earliest) });
      content.push({
        type: "mention",
        attrs: {
          id: matched.assetId,
          index: matched.n,
          kind: "图片",
          label: matched.name,
          assetId: matched.assetId,
          assetType: matched.type,
          imagePath: null,
          assetTag: matched.assetTag,
        },
      });
      remaining = remaining.slice(earliest + matched.assetTag.length);
    }
    return { type: "paragraph", content };
  };

  return { type: "doc", content: text.split("\n").map(buildParagraph) };
}

function buildVideoPrompt(
  rawPrompt: string,
  sbCharacters: AnnotatedAsset[],
  sbScenes: AnnotatedAsset[],
  sbItems: AnnotatedAsset[],
  styleMode?: string,
): string {
  const parts: string[] = [];

  // 1. 风格前缀
  const styleEntry = styleMode ? VIDEO_STYLE_PROMPT_MAP[styleMode] : undefined;
  if (styleEntry) {
    parts.push(styleEntry.prefix);
    parts.push("");
  }

  // 2. 素材声明行（仅列名称，不标注 @图片N——前端动态注解）
  if (sbCharacters.length > 0) {
    const charDecl = sbCharacters.map((c) => c.name).join("， ");
    parts.push(`人物： ${charDecl}。`);
  }
  if (sbScenes.length > 0) {
    const sceneDecl = sbScenes.map((s) => s.name).join("， ");
    parts.push(`场景： ${sceneDecl}。`);
  }
  if (sbItems.length > 0) {
    const itemDecl = sbItems.map((it) => it.name).join("， ");
    parts.push(`道具： ${itemDecl}。`);
  }

  // 3. 正文
  if (parts.length > 0 && (sbCharacters.length > 0 || sbScenes.length > 0 || sbItems.length > 0)) {
    parts.push("");
  }
  parts.push(rawPrompt);

  // 4. 风格后缀
  if (styleEntry) {
    parts.push("");
    parts.push(styleEntry.suffix);
  }

  return parts.join("\n");
}

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
    lw("拆解", `输出 JSON 解析失败（${reason}），原始内容: ${result.content}`);
    lw("拆解", `执行修复重试`);

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

// ─── 台词时长校验 ───────────────────────────────────────────────────

/** 中文正常语速约 3 字/秒 */
const CHARS_PER_SECOND = 3;

/**
 * 从 animationPrompt 中提取所有对话框台词的总字符数，推算最低所需时长（秒）。
 * 台词格式：人物名说：<台词原文>
 */
function calcDialogueDuration(animationPrompt: string): number {
  const dialogueRegex = /说：<([^>]*)>/g;
  let totalChars = 0;
  let match: RegExpExecArray | null;
  while ((match = dialogueRegex.exec(animationPrompt)) !== null) {
    totalChars += match[1].length;
  }
  return Math.ceil(totalChars / CHARS_PER_SECOND);
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
  // 检查分集是否已被删除
  const clip = db.prepare(
    "SELECT id FROM clips WHERE id = ? AND deleted_at IS NULL"
  ).get(clipId);
  if (!clip) {
    lw("拆解", `分集已被删除，丢弃拆解结果 clipId=${clipId}`);
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

  // ── 将拆解出的素材写入 assets 表，并建立 name → assetId 映射 ──
  // 同分集内去重
  const findAsset = db.prepare(`
    SELECT id FROM assets
    WHERE clip_id = ? AND type = ? AND name = ?
  `);
  // 作品级同名素材复用：查找其他分集中已有的同名素材，继承其图片绑定
  const findProjectAsset = db.prepare(`
    SELECT id, selected_image_id, generated_image_path, reference_image_path, status, voice_binding_json
    FROM assets
    WHERE project_id = ? AND type = ? AND name = ? AND clip_id != ?
    ORDER BY CASE WHEN selected_image_id IS NOT NULL THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `);
  const insertAsset = db.prepare(`
    INSERT INTO assets (id, project_id, clip_id, type, name, description, prompt, source, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'model', 'draft')
  `);
  // 复用作品素材时继承图片绑定数据
  const insertAssetWithImage = db.prepare(`
    INSERT INTO assets (id, project_id, clip_id, type, name, description, prompt, source, status,
      selected_image_id, generated_image_path, reference_image_path, voice_binding_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'model', ?, ?, ?, ?, ?)
  `);

  // type → name → assetId
  const idMap = new Map<string, Map<string, string>>();
  idMap.set("character", new Map());
  idMap.set("scene", new Map());
  idMap.set("item", new Map());

  for (const type of ["character", "scene", "item"] as const) {
    const list = type === "character" ? resources.characters
      : type === "scene" ? resources.scenes : resources.items;
    const map = idMap.get(type)!;
    for (const r of list) {
      // 1. 同分集内已有 → 直接复用
      const existing = findAsset.get(clipId, type, r.name) as { id: string } | undefined;
      if (existing) {
        map.set(r.name, existing.id);
        continue;
      }
      // 2. 作品内其他分集已有同名素材 → 新建当前分集记录并继承图片绑定
      const projectAsset = findProjectAsset.get(projectId, type, r.name, clipId) as {
        id: string;
        selected_image_id: string | null;
        generated_image_path: string | null;
        reference_image_path: string | null;
        status: string;
        voice_binding_json: string | null;
      } | undefined;
      if (projectAsset) {
        const id = randomUUID();
        const inheritStatus = projectAsset.selected_image_id ? "image_ready" : "draft";
        insertAssetWithImage.run(
          id, projectId, clipId, type, r.name, r.description, r.prompt,
          inheritStatus,
          projectAsset.selected_image_id, projectAsset.generated_image_path,
          projectAsset.reference_image_path, projectAsset.voice_binding_json
        );
        map.set(r.name, id);
        l("拆解", `  复用素材: ${type} "${r.name}" id=${id.slice(0, 8)} (源自 ${projectAsset.id.slice(0, 8)})`);
        continue;
      }
      // 3. 全新素材
      const id = randomUUID();
      insertAsset.run(id, projectId, clipId, type, r.name, r.description, r.prompt);
      map.set(r.name, id);
      l("拆解", `  新增素材: ${type} "${r.name}" id=${id.slice(0, 8)}`);
    }
  }

  // ── 写入故事板，携带镜头→素材的绑定 ──
  const insertSb = db.prepare(`
    INSERT INTO storyboards (id, project_id, clip_id, seq_num, sbid, source_text,
      visual_description, video_prompt, video_duration,
      character_ids_json, scene_ids_json, item_ids_json, video_param_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const charById = idMap.get("character")!;
  const sceneById = idMap.get("scene")!;
  const itemById = idMap.get("item")!;

  for (let i = 0; i < storyboards.length; i++) {
    const sb = storyboards[i];
    // 按名称从 idMap 中查找素材 ID
    const charIds = sb.characters
      .map((c) => charById.get(c.name))
      .filter(Boolean) as string[];
    const sceneIds = sb.scenes
      .map((s) => sceneById.get(s.name))
      .filter(Boolean) as string[];
    const itemIds = sb.items
      .map((it) => itemById.get(it.name))
      .filter(Boolean) as string[];

    // ── 构建 mention_map（按镜头绑定素材顺序分配序号）──────────────
    // 不再调用 autoMentionPrompt 污染原始提示词；前端加载时动态标注。
    const sbAssets: AnnotatedAsset[] = [
      ...sb.characters.map((c) => ({
        name: c.name,
        assetId: charById.get(c.name) ?? "",
        type: "character" as const,
      })),
      ...sb.scenes.map((s) => ({
        name: s.name,
        assetId: sceneById.get(s.name) ?? "",
        type: "scene" as const,
      })),
      ...sb.items.map((it) => ({
        name: it.name,
        assetId: itemById.get(it.name) ?? "",
        type: "item" as const,
      })),
    ].filter((a) => a.assetId !== "");

    const mentionMap = sbAssets.map((a, idx) => ({
      n: idx + 1,
      assetId: a.assetId,
      name: a.name,
      type: a.type,
      assetTag: `${a.name}(@图片${idx + 1})`,
    }));

    const sbCharAssets = sb.characters
      .map((c) => ({ name: c.name, assetId: charById.get(c.name) ?? "", type: "character" as const }))
      .filter((a) => a.assetId !== "");
    const sbSceneAssets = sb.scenes
      .map((s) => ({ name: s.name, assetId: sceneById.get(s.name) ?? "", type: "scene" as const }))
      .filter((a) => a.assetId !== "");
    const sbItemAssets = sb.items
      .map((it) => ({ name: it.name, assetId: itemById.get(it.name) ?? "", type: "item" as const }))
      .filter((a) => a.assetId !== "");

    // 存原始提示词（不标注 @图片N），前端动态标注
    const videoPrompt = buildVideoPrompt(
      sb.animationPrompt,
      sbCharAssets,
      sbSceneAssets,
      sbItemAssets,
      mode,
    );

    const videoParamJson = JSON.stringify({
      mention_map: mentionMap,
    });

    // ── 台词时长校验：防止台词过长但视频秒数过短导致语速异常 ──
    const dialogueMinDur = calcDialogueDuration(sb.animationPrompt);
    const llmDuration = sb.duration ?? 15;
    const finalDuration = Math.min(Math.max(llmDuration, dialogueMinDur), 15);
    if (finalDuration > llmDuration) {
      l("拆解", `镜头 ${sb.sbid} 台词需至少 ${dialogueMinDur}s，LLM 预估 ${llmDuration}s → 修正为 ${finalDuration}s`);
    }
    if (dialogueMinDur > 15) {
      lw("拆解", `⚠ 镜头 ${sb.sbid} 台词 ${dialogueMinDur * CHARS_PER_SECOND} 字 / 需 ${dialogueMinDur}s 已超过 15s 上限，建议重新拆分`);
    }

    insertSb.run(
      randomUUID(), projectId, clipId,
      i + 1, sb.sbid, sb.originalText || "",
      sb.description, videoPrompt,
      finalDuration,
      JSON.stringify(charIds),
      JSON.stringify(sceneIds),
      JSON.stringify(itemIds),
      videoParamJson,
    );
  }
}

// ─── 作品步骤推进 ───────────────────────────────────────────────────
/**
 * 若该作品首次完成拆解（current_step 为 "script"），推进至 "asset"
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
 * 分集拆解任务 handler
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

  // 前置检查：分集是否已被删除
  const clip = db.prepare(
    "SELECT id FROM clips WHERE id = ? AND deleted_at IS NULL"
  ).get(input.clipId);
  if (!clip) {
    lw("拆解", `分集已删除，跳过拆解 clipId=${input.clipId}`);
    db.prepare("UPDATE clip_scripts SET status = 'failed', error_message = '分集已删除', updated_at = datetime('now') WHERE clip_id = ?")
      .run(input.clipId);
    return JSON.stringify({ skipped: true, reason: "clip_deleted" });
  }

  // 若分集已选定生效的优化版本，则拆解使用优化后的剧本
  const activeOpt = db
    .prepare(
      "SELECT so.optimized_text AS optimized_text FROM script_optimizations so JOIN clips c ON c.active_optimization_id = so.id WHERE c.id = ?1 AND so.status = 'completed'",
    )
    .get(input.clipId) as { optimized_text: string } | undefined;
  const sourceText = activeOpt ? activeOpt.optimized_text : input.sourceText;

  l("拆解", `开始拆解 clipId=${input.clipId} 原文=${sourceText.length}字符${activeOpt ? "（使用优化版本）" : ""}`);

  // 标记 running
  db.prepare("UPDATE clip_scripts SET status = 'running', updated_at = datetime('now') WHERE clip_id = ? AND status = 'pending'")
    .run(input.clipId);

  // 调用模型并解析（含修复重试）
  const { storyboards, resources, rawOutput } = await callModelAndParse(ctx, { ...input, sourceText });

  // 写入数据库
  saveResults(db, input.clipId, storyboards, resources, rawOutput, input.styleMode);

  // 推进作品步骤
  advanceProjectStep(db, input.clipId);

  l("拆解", `拆解成功 clipId=${input.clipId} 镜头数=${storyboards.length}`);
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
