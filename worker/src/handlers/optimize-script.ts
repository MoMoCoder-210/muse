/**
 * 剧本优化 — 对分集原文做 AI 润色 / 扩写 / 精简
 * 支持流式输出（逐字推送到前端）与多版本落库。
 */

import type { TaskContext } from "../types.js";
import type { ChatMessage } from "../clients/text.js";
import { l, lw, createPromptLoader } from "../utils/utils.js";

// ─── 提示词加载 ────────────────────────────────────────────────────

const getPrompt = createPromptLoader("optimize-script.md");

// ─── 类型 ──────────────────────────────────────────────────────────

type OptimizeMode = "polish" | "expand" | "condense";

interface OptimizeInput {
  clipId: string;
  projectId: string;
  text: string;
  mode: OptimizeMode;
  instruction?: string;
  optimizationId: string;
}

interface OptimizeOutput {
  optimization_id: string;
  charCountBefore: number;
  charCountAfter: number;
}

const MODE_LABELS: Record<OptimizeMode, string> = {
  polish: "润色",
  expand: "扩写",
  condense: "精简",
};

// ─── 常量 ──────────────────────────────────────────────────────────

const MODE_BLOCK_KEYS: Record<OptimizeMode, string> = {
  polish: "MODE_POLISH",
  expand: "MODE_EXPAND",
  condense: "MODE_CONDENSE",
};

const OTHER_MODES: Record<OptimizeMode, OptimizeMode[]> = {
  polish: ["expand", "condense"],
  expand: ["polish", "condense"],
  condense: ["polish", "expand"],
};

// ─── 模板渲染 ──────────────────────────────────────────────────────

/**
 * 内联模板渲染：替换占位符、条件块 + 剔除无关模式段落。
 */
function renderPrompt(mode: OptimizeMode, instruction?: string): string {
  let tpl = getPrompt();

  // 1. 替换模式名称
  tpl = tpl.replace(/\{\{MODE\}\}/g, MODE_LABELS[mode]);

  // 2. 处理用户自定义指令（有则保留，无则整段删除）
  tpl = tpl.replace(/\{\{#INSTRUCTION\}\}([\s\S]*?)\{\{\/INSTRUCTION\}\}/g, (_m, body) => {
    if (instruction && instruction.trim()) {
      return body.replace(/\{\{INSTRUCTION\}\}/g, instruction.trim());
    }
    return "";
  });

  // 3. 保留当前模式段落，删除其余模式段落
  const keepKey = MODE_BLOCK_KEYS[mode];
  for (const other of OTHER_MODES[mode]) {
    const otherKey = MODE_BLOCK_KEYS[other];
    tpl = tpl.replace(new RegExp(`\\{\\{#${otherKey}\\}\\}[\\s\\S]*?\\{\\{/${otherKey}\\}\\}`, "g"), "");
  }
  // 清除保留模式的标记标签
  tpl = tpl.replace(new RegExp(`\\{\\{#${keepKey}\\}\\}`, "g"), "");
  tpl = tpl.replace(new RegExp(`\\{\\{/${keepKey}\\}\\}`, "g"), "");

  // 4. 移除 {{TEXT}} 占位符（剧本原文由 user 消息传入，不在 system prompt 中）
  tpl = tpl.replace(/\{\{TEXT\}\}/g, "");

  // 5. 清理残留的空白行（3 个以上连续空行缩减为 2 个）
  tpl = tpl.replace(/\n{3,}/g, "\n\n");

  return tpl.trimEnd();
}

// ─── Handler ───────────────────────────────────────────────────────

export async function optimizeScriptHandler(
  ctx: TaskContext,
): Promise<string> {
  const input = ctx.taskInput as OptimizeInput;
  if (!input?.clipId || !input?.projectId || !input?.text || !input?.mode || !input?.optimizationId) {
    throw new Error("optimize_script: 缺少必填字段");
  }

  if (!["polish", "expand", "condense"].includes(input.mode)) {
    throw new Error(`optimize_script: 未知模式 ${input.mode}`);
  }

  const textClient = ctx.clients?.text;
  if (!textClient) {
    throw new Error("剧本优化不可用：文本模型客户端未初始化");
  }

  const modeLabel = MODE_LABELS[input.mode];
  l("剧本优化", `开始优化分集 ${input.clipId}，模式=${modeLabel}，字数=${input.text.length}${input.instruction ? `，自定义指令: ${input.instruction}` : ""}`);

  // 渲染提示词
  const systemPrompt = renderPrompt(input.mode, input.instruction);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input.text },
  ];

  try {
    let result = "";
    let streamIndex = 0;

    await textClient.chat(
      messages,
      (delta) => {
        if (!delta) return;
        result += delta;
        // 流式推送：逐块发送到前端实时渲染
        ctx.emit({
          type: "task_stream",
          taskId: ctx.taskId,
          chunk: delta,
          index: streamIndex++,
        });
      },
      { maxTokens: Math.max(1024, Math.ceil(input.text.length * 2)), reasoning_effort: "high" },
    );

    const cleaned = result.trim();
    if (!cleaned) {
      throw new Error("模型返回了空内容");
    }

    // 更新已存在的优化记录（Rust 端已创建 status=running 的空记录）
    ctx.db
      .prepare(
        `UPDATE script_optimizations
            SET optimized_text  = ?,
                char_count_after = ?,
                status           = 'completed'
          WHERE id = ?`,
      )
      .run(cleaned, cleaned.length, input.optimizationId);

    l("剧本优化", `优化完成，分集=${input.clipId}，原字数=${input.text.length}，结果字数=${cleaned.length}，版本=${input.optimizationId}`);
    const output: OptimizeOutput = {
      optimization_id: input.optimizationId,
      charCountBefore: input.text.length,
      charCountAfter: cleaned.length,
    };
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lw("剧本优化", `优化失败，分集=${input.clipId}，错误=${msg}`);

    // 将运行中的记录标记为 failed，避免前端永久显示"生成中"
    if (input?.optimizationId) {
      try {
        ctx.db
          .prepare("UPDATE script_optimizations SET status = 'failed' WHERE id = ?")
          .run(input.optimizationId);
      } catch { /* 静默：DB 操作不应遮盖原始错误 */ }
    }

    throw err;
  }
}
