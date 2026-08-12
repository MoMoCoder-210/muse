/**
 * Agent API 服务层：Agent 配置持久化
 *
 * 通过 Tauri 的 getSettings / saveSettings 持久化 Agent 配置。
 */
import { getSettings, saveSettings } from "./tauri";
import type { AgentConfig } from "../types/agent";
import type { AppSettings } from "../types/settings";

const AGENT_CONFIG_KEY = "agent";
type PersistedSettings = AppSettings & { agent?: unknown };

function isAgentConfig(value: unknown): value is AgentConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.provider === "openai" || candidate.provider === "anthropic") &&
    typeof candidate.model === "string" &&
    typeof candidate.apiKey === "string" &&
    (candidate.baseUrl === undefined || typeof candidate.baseUrl === "string")
  );
}

/** 从应用设置中读取 Agent 配置 */
export async function loadAgentConfig(): Promise<AgentConfig | null> {
  try {
    const settings = await getSettings();
    const raw = (settings as PersistedSettings)[AGENT_CONFIG_KEY];
    return isAgentConfig(raw) ? raw : null;
  } catch {
    // 读取失败，返回 null
    return null;
  }
}

/** 将 Agent 配置存入应用设置 */
export async function saveAgentConfig(config: AgentConfig): Promise<void> {
  const settings = await getSettings();
  const updated: PersistedSettings = { ...settings, [AGENT_CONFIG_KEY]: config };
  await saveSettings(updated);
}
