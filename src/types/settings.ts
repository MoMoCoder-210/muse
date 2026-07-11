/**
 * 应用设置类型定义
 *
 * 渠道 = OpenAI 兼容端点 (key + url)，内含多个模型 ID。
 * 调优参数（超时/maxTokens/温度/语速）统一按类型管理，所有渠道共享。
 *
 * @author yt @date 20260702
 */

// ── 模型条目（极简） ──────────────────────────────────────

export interface ModelEntry {
  id: string;
  /** API 模型 ID，如 gpt-4o */
  modelId: string;
}

// ── 渠道配置 ─────────────────────────────────────────────

export interface ChannelBase {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
}

export interface TextChannel extends ChannelBase {
  models: ModelEntry[];
  activeModelId: string;
}

export interface ImageChannel extends ChannelBase {
  models: ModelEntry[];
  activeModelId: string;
}

export interface VoiceChannel extends ChannelBase {
  models: ModelEntry[];
  activeModelId: string;
}

export interface AssetChannel extends ChannelBase {
  /** 素材渠道无模型概念 */
}

// ── 类型级全局参数 ──────────────────────────────────────

export interface TextParams {
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

export interface ImageParams {
  timeoutMs: number;
}

export interface VoiceParams {
  timeoutMs: number;
  speed: number;
}

export interface AssetParams {
  timeoutMs: number;
}

// ── 容器 ────────────────────────────────────────────────

export interface ChannelList<T> {
  channels: T[];
  activeId: string;
}

// ── 复合设置 ─────────────────────────────────────────────

export interface AppSettings {
  text: ChannelList<TextChannel>;
  textParams: TextParams;
  image: ChannelList<ImageChannel>;
  imageParams: ImageParams;
  voice: ChannelList<VoiceChannel>;
  voiceParams: VoiceParams;
  asset: ChannelList<AssetChannel>;
  assetParams: AssetParams;
}

// ── 默认值 ──────────────────────────────────────────────
// 同步点：本文件 DEFAULT_* 须与 worker/src/config/defaults.ts
// 及 src-tauri/src/commands/util.rs::default_settings_json 三处保持一致。

export const DEFAULT_MODEL_ENTRY: ModelEntry = { id: "m1", modelId: "" };

export const DEFAULT_TEXT_CHANNEL: TextChannel = {
  id: "default", name: "默认", apiKey: "", baseUrl: "",
  models: [{ ...DEFAULT_MODEL_ENTRY }], activeModelId: "m1",
};

export const DEFAULT_IMAGE_CHANNEL: ImageChannel = {
  id: "default", name: "默认", apiKey: "", baseUrl: "",
  models: [{ ...DEFAULT_MODEL_ENTRY }], activeModelId: "m1",
};

export const DEFAULT_VOICE_CHANNEL: VoiceChannel = {
  id: "default", name: "默认", apiKey: "", baseUrl: "",
  models: [{ ...DEFAULT_MODEL_ENTRY }], activeModelId: "m1",
};

export const DEFAULT_ASSET_CHANNEL: AssetChannel = {
  id: "default", name: "默认", apiKey: "", baseUrl: "",
};

export const DEFAULT_TEXT_PARAMS: TextParams = {
  timeoutMs: 300000, maxTokens: 131072, temperature: 0.7,
};

export const DEFAULT_IMAGE_PARAMS: ImageParams = {
  timeoutMs: 300000,
};

export const DEFAULT_VOICE_PARAMS: VoiceParams = {
  timeoutMs: 300000, speed: 1.0,
};

export const DEFAULT_ASSET_PARAMS: AssetParams = {
  timeoutMs: 300000,
};

export const DEFAULT_SETTINGS: AppSettings = {
  text:   { channels: [{ ...DEFAULT_TEXT_CHANNEL }],   activeId: "default" },
  textParams:   { ...DEFAULT_TEXT_PARAMS },
  image:  { channels: [{ ...DEFAULT_IMAGE_CHANNEL }],  activeId: "default" },
  imageParams:  { ...DEFAULT_IMAGE_PARAMS },
  voice:  { channels: [{ ...DEFAULT_VOICE_CHANNEL }],  activeId: "default" },
  voiceParams:  { ...DEFAULT_VOICE_PARAMS },
  asset:  { channels: [{ ...DEFAULT_ASSET_CHANNEL }],  activeId: "default" },
  assetParams:  { ...DEFAULT_ASSET_PARAMS },
};

// ── 工具 ────────────────────────────────────────────────

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 同步点：与 worker/src/config/defaults.ts::getActiveChannel 逻辑保持一致。
export function getActiveChannel<T extends { id: string }>(
  list: ChannelList<T>,
): T | undefined {
  return list.channels.find((c) => c.id === list.activeId) ?? list.channels[0];
}
