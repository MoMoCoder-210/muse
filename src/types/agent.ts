/**
 * Muse AI Agent 类型定义
 *
 * 覆盖 Agent 上下文、Tool 系统、事件总线和会话管理。
 */

// ── Tool 定义 ──────────────────────────────────────────

export type ToolCategory = "查询" | "创建" | "修改" | "删除" | "管理";

export type ToolPermission = "auto" | "confirm" | "danger";

/** 模型可见的简要 Tool 摘要（两阶段 Tool Search 的第一阶段） */
export interface ToolCandidate {
  name: string;
  description: string;
  category: ToolCategory;
  permission: ToolPermission;
  /** 目标操作对象：project / clip / asset / storyboard / system */
  target: string;
}

/** 完整的 Tool Schema（第二阶段加载，包含 Zod schema 序列化） */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission: ToolPermission;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ── 画布 ─────────────────────────────────────────────

export type CanvasNodeType =
  | "ProjectNode"
  | "ClipNode"
  | "AssetNode"
  | "ImageNode"
  | "StoryboardNode"
  | "VideoNode"
  | "UpscaleNode";

export type CanvasEdgeType = "GENERATED_BY" | "UPSCALED_FROM" | "BELONGS_TO" | "DEPENDS_ON";

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  label: string;
  parentId?: string;
  data?: Record<string, unknown>;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  type: CanvasEdgeType;
}

export interface CanvasSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

// ── 上下文 ────────────────────────────────────────────

export interface AgentContext {
  projectId: string | null;
  projectName: string | null;
  canvas: CanvasSnapshot;
  activeDomain: ToolCategory | null;
  memories: string[];
}

// ── 事件 ──────────────────────────────────────────────

export type AgentEventType =
  | "stream-delta"
  | "tool-call"
  | "tool-result"
  | "done"
  | "error";

export interface AgentStreamEvent {
  type: "stream-delta";
  delta: string;
}

export interface AgentToolCallEvent {
  type: "tool-call";
  toolName: string;
  params: Record<string, unknown>;
  needConfirm: boolean;
}

export interface AgentToolResultEvent {
  type: "tool-result";
  toolName: string;
  result: ToolResult;
  canvasOps: CanvasOp[];
}

export interface AgentDoneEvent {
  type: "done";
  text: string;
}

export interface AgentErrorEvent {
  type: "error";
  message: string;
}

export type AgentEvent =
  | AgentStreamEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentDoneEvent
  | AgentErrorEvent;

// ── 画布操作 ──────────────────────────────────────────

export type CanvasOp =
  | { action: "addNode"; node: CanvasNode }
  | { action: "updateNode"; id: string; data: Partial<CanvasNode> }
  | { action: "removeNode"; id: string }
  | { action: "addEdge"; edge: CanvasEdge }
  | { action: "removeEdge"; id: string }
  | { action: "focusNode"; id: string }
  | { action: "fitView" };

// ── 会话 ──────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallRecord[];
  toolCallId?: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentSession {
  id: string;
  projectId: string;
  messages: ChatMessage[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── 配置 ──────────────────────────────────────────────

export interface AgentConfig {
  provider: "openai" | "anthropic";
  model: string;
  apiKey: string;
  baseUrl?: string;
}
