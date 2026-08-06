/**
 * Agent 领域纯类型与常量（无 React / Tauri 依赖）
 */
export type {
  ToolCandidate,
  ToolSchema,
  ToolResult,
  ToolCategory,
  CanvasOp,
  CanvasSnapshot,
  AgentContext,
  AgentEvent,
  ChatMessage,
  AgentConfig,
} from "../../types/agent";

/** Tool Search 参数上限常量 */
export const TOOL_CANDIDATE_LIMIT = 8;
export const TOOL_SCHEMA_LIMIT = 2;
export const TOOL_CONTEXT_BUDGET = 4000; // Token 预算
