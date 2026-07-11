/**
 * Worker 侧配置类型与默认值
 *
 * 与前端 src/types/settings.ts 同步。
 * 渠道 = OpenAI 端点 (key+url)，内含模型 ID 列表。
 * 调优参数统一按类型管理。
 *
 * @author yt @date 20260702
 */

// ── 模型条目 ───────────────────────────────────────────────

export interface ModelEntry {
  id: string;
  modelId: string;
}

// ── 渠道 ──────────────────────────────────────────────────

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

export interface AssetChannel extends ChannelBase {}

// ── 全局参数 ──────────────────────────────────────────────

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

// ── 容器 ─────────────────────────────────────────────────

export interface ChannelList<T> {
  channels: T[];
  activeId: string;
}

// ── AppSettings ──────────────────────────────────────────

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

// ── 客户端平面配置 ──────────────────────────────────────

export interface TextModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export interface ImageModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface VoiceModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  speed: number;
  timeoutMs: number;
}

export interface AssetModelConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

// ── 默认值 ──────────────────────────────────────────────
// 同步点：本文件 DEFAULT_* 须与 src/types/settings.ts
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
export const DEFAULT_IMAGE_PARAMS: ImageParams = { timeoutMs: 300000 };
export const DEFAULT_VOICE_PARAMS: VoiceParams = { timeoutMs: 300000, speed: 1.0 };
export const DEFAULT_ASSET_PARAMS: AssetParams = { timeoutMs: 300000 };

export const DEFAULT_SETTINGS: AppSettings = {
  text:  { channels: [{ ...DEFAULT_TEXT_CHANNEL }],  activeId: "default" },
  textParams:  { ...DEFAULT_TEXT_PARAMS },
  image: { channels: [{ ...DEFAULT_IMAGE_CHANNEL }], activeId: "default" },
  imageParams: { ...DEFAULT_IMAGE_PARAMS },
  voice: { channels: [{ ...DEFAULT_VOICE_CHANNEL }], activeId: "default" },
  voiceParams: { ...DEFAULT_VOICE_PARAMS },
  asset: { channels: [{ ...DEFAULT_ASSET_CHANNEL }], activeId: "default" },
  assetParams: { ...DEFAULT_ASSET_PARAMS },
};

// ── 工具函数 ─────────────────────────────────────────────

// 同步点：与 src/types/settings.ts::getActiveChannel 逻辑保持一致。
export function getActiveChannel<T extends { id: string }>(
  list: ChannelList<T>,
): T | undefined {
  return list.channels.find((c) => c.id === list.activeId) ?? list.channels[0];
}

/** 解析 TextChannel + TextParams → 客户端平面配置 */
export function resolveTextConfig(channel: TextChannel, params: TextParams): TextModelConfig {
  const m = channel.models.find((x) => x.id === channel.activeModelId) ?? channel.models[0];
  return {
    apiKey: channel.apiKey, baseUrl: channel.baseUrl,
    timeoutMs: params.timeoutMs,
    model: m.modelId, maxTokens: params.maxTokens, temperature: params.temperature,
  };
}

export function resolveImageConfig(channel: ImageChannel, params: ImageParams): ImageModelConfig {
  const m = channel.models.find((x) => x.id === channel.activeModelId) ?? channel.models[0];
  return {
    apiKey: channel.apiKey, baseUrl: channel.baseUrl,
    timeoutMs: params.timeoutMs, model: m.modelId,
  };
}

export function resolveVoiceConfig(channel: VoiceChannel, params: VoiceParams): VoiceModelConfig {
  const m = channel.models.find((x) => x.id === channel.activeModelId) ?? channel.models[0];
  return {
    apiKey: channel.apiKey, baseUrl: channel.baseUrl,
    timeoutMs: params.timeoutMs, model: m.modelId, speed: params.speed,
  };
}
