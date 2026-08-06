/**
 * Agent API 服务层：Agent 配置持久化
 *
 * 通过 Tauri 的 getSettings / saveSettings 持久化 Agent 配置。
 */
import { getSettings, saveSettings } from "./tauri";
import type { AgentConfig } from "../types/agent";

const AGENT_CONFIG_KEY = "agent";

/** 从应用设置中读取 Agent 配置 */
export async function loadAgentConfig(): Promise<AgentConfig | null> {
  try {
    const settings = await getSettings();
    const raw = (settings as Record<string, unknown>)[AGENT_CONFIG_KEY];
    if (raw && typeof raw === "object") {
      return raw as AgentConfig;
    }
  } catch {
    // 读取失败，返回 null
  }
  return null;
}

/** 将 Agent 配置存入应用设置 */
export async function saveAgentConfig(config: AgentConfig): Promise<void> {
  const settings = await getSettings();
  const updated = { ...settings, [AGENT_CONFIG_KEY]: config };
  await saveSettings(updated as never);
}
