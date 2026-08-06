/**
 * useAgentSession：项目级 Agent 会话生命周期管理
 *
 * 管理消息发送、流式响应、工具确认和会话持久化。
 */
import { useCallback } from "react";
import { useAgentStore } from "../store/agent-store";
import type { ChatMessage, AgentConfig, ToolSchema } from "../types/agent";
import { runAgent } from "../agent/engine";
import { visibleTools as searchVisibleTools } from "../agent/tools/search";
import { getTool } from "../agent/tools/registry";
import type { AgentRunResult } from "../agent/engine";

export function useAgentSession() {
  const store = useAgentStore();

  const sendMessage = useCallback(
    async (userInput: string): Promise<AgentRunResult | null> => {
      const { config, projectId, messages } = useAgentStore.getState();
      if (!config) return null;

      const userMsg: ChatMessage = { role: "user", content: userInput };
      store.addMessage(userMsg);

      const schemas: ToolSchema[] = searchVisibleTools({ text: userInput });

      store.setStreaming(true);
      store.resetStreamText();

      try {
        const result = await runAgent({
          config,
          context: {
            projectId,
            projectName: null,
            canvas: { nodes: [], edges: [] },
            activeDomain: null,
            memories: [],
          },
          messages: [...useAgentStore.getState().messages, userMsg],
          schemas,
        });

        store.addMessage({ role: "assistant", content: result.text });
        return result;
      } finally {
        store.setStreaming(false);
      }
    },
    [store]
  );

  // Phase 2: 接入 confirm 流程时启用
  const confirmTool = useCallback(
    async (approved: boolean) => {
      const { pendingConfirmation } = useAgentStore.getState();
      if (!pendingConfirmation) return;
      store.setPendingConfirmation(null);
      if (approved) {
        const def = getTool(pendingConfirmation.toolName);
        if (def) return def.execute(pendingConfirmation.params);
      }
      return { success: false, error: "用户取消" };
    },
    [store]
  );

  const updateConfig = useCallback(
    (config: AgentConfig) => store.setConfig(config),
    [store]
  );

  return {
    messages: store.messages,
    isStreaming: store.isStreaming,
    streamText: store.streamText,
    pendingConfirmation: store.pendingConfirmation,
    config: store.config,
    sendMessage,
    confirmTool,
    updateConfig,
    clearMessages: store.clearMessages,
  };
}
