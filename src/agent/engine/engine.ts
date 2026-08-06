/**
 * Agent Engine：封装 Vercel AI SDK v7 generateText + maxSteps 实现 Agent Loop。
 *
 * Tool 执行通过 Registry → invoke() 桥接到现有 Tauri 命令。
 */
import { generateText, tool as aiTool, type Tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ChatMessage, AgentConfig, ToolSchema, ToolResult } from "../../types/agent";
import { getTool } from "../tools/registry";
import { buildSystemPrompt } from "../domain/context";
import type { AgentContext } from "../../types/agent";

const MAX_AGENT_STEPS = 10;

// ── AI SDK Tool 桥接 ─────────────────────────────────

/** 执行 Tool（通过 Registry → invoke） */
async function executeTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const def = getTool(name);
  if (!def) return { success: false, error: `未知工具: ${name}` };
  try {
    return await def.execute(params);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 将 ToolSchema + execute 构建为 AI SDK Tool */
function toAiSdkTool(name: string, schema: ToolSchema): Tool {
  return aiTool({
    description: schema.description,
    parameters: schema.parameters as Record<string, unknown>,
    execute: (args: unknown) => executeTool(name, args as Record<string, unknown>),
  });
}

/** 构建 AI SDK 使用的完整 tools 映射 */
function buildTools(schemas: ToolSchema[]): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const s of schemas) {
    tools[s.name] = toAiSdkTool(s.name, s);
  }
  return tools;
}

// ── 核心：Agent Run ──────────────────────────────────

export interface AgentRunConfig {
  config: AgentConfig;
  context: AgentContext;
  messages: ChatMessage[];
  schemas: ToolSchema[];
  signal?: AbortSignal;
}

export interface AgentRunResult {
  text: string;
  toolCalls: Array<{ name: string; params: Record<string, unknown>; result: unknown }>;
}

export async function runAgent(config: AgentRunConfig): Promise<AgentRunResult> {
  const { providerConfig, tools, systemPrompt, messages } = prepareAgentInput(config);
  const toolCalls: AgentRunResult["toolCalls"] = [];

  const result = await generateText({
    model: providerConfig,
    system: systemPrompt,
    messages,
    tools,
    maxSteps: MAX_AGENT_STEPS,
    onStepFinish: (step) => {
      if (step.toolCalls) {
        for (const tc of step.toolCalls) {
          toolCalls.push({
            name: tc.toolName,
            params: tc.args as Record<string, unknown>,
            result: step.toolResults, // AI SDK 按 step 聚合所有结果
          });
        }
      }
    },
  });

  return { text: result.text, toolCalls };
}

function prepareAgentInput(config: AgentRunConfig) {
  const { config: agentConfig } = config;

  // 创建 provider
  let providerConfig: ReturnType<typeof createOpenAI> | ReturnType<typeof createAnthropic>;
  if (agentConfig.provider === "anthropic") {
    providerConfig = createAnthropic({ apiKey: agentConfig.apiKey })(agentConfig.model);
  } else {
    const openaiClient = createOpenAI({
      apiKey: agentConfig.apiKey,
      baseURL: agentConfig.baseUrl || undefined,
    });
    providerConfig = openaiClient(agentConfig.model);
  }

  const tools = buildTools(config.schemas);
  const systemPrompt = buildSystemPrompt(config.context);
  const messages = config.messages.map((m) => ({
    role: m.role as "system" | "user" | "assistant",
    content: m.content,
  }));

  return { providerConfig, tools, systemPrompt, messages };
}
