/**
 * Agent Store：项目级 Agent 会话状态
 *
 * 按 projectId 隔离会话、消息、待确认操作和画布状态。
 */
import { create } from "zustand";
import type { ChatMessage, AgentConfig } from "../types/agent";

export interface AgentState {
  /** 当前 projectId */
  projectId: string | null;
  /** 对话历史 */
  messages: ChatMessage[];
  /** 是否正在等待 LLM 响应 */
  isStreaming: boolean;
  /** 当前流式文本缓冲区 */
  streamText: string;
  /** 待用户确认的 tool call */
  pendingConfirmation: {
    toolName: string;
    params: Record<string, unknown>;
  } | null;
  /** Agent 配置 */
  config: AgentConfig | null;
}

export interface AgentActions {
  setProjectId: (id: string | null) => void;
  addMessage: (message: ChatMessage) => void;
  setStreaming: (streaming: boolean) => void;
  appendStreamText: (delta: string) => void;
  resetStreamText: () => void;
  setPendingConfirmation: (tc: AgentState["pendingConfirmation"]) => void;
  setConfig: (config: AgentConfig | null) => void;
  clearMessages: () => void;
}

export type AgentStore = AgentState & AgentActions;

export const useAgentStore = create<AgentStore>((set) => ({
  projectId: null,
  messages: [],
  isStreaming: false,
  streamText: "",
  pendingConfirmation: null,
  config: null,

  setProjectId: (id) => {
    if (id !== useAgentStore.getState().projectId) {
      set({ projectId: id, messages: [], streamText: "", pendingConfirmation: null });
    }
  },
  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  appendStreamText: (delta) =>
    set((s) => ({ streamText: s.streamText + delta })),
  resetStreamText: () => set({ streamText: "" }),
  setPendingConfirmation: (tc) => set({ pendingConfirmation: tc }),
  setConfig: (config) => set({ config }),
  clearMessages: () => set({ messages: [], streamText: "" }),
}));
