/**
 * Worker 侧配置类型与默认值
 *
 * 与前端 src/types/settings.ts 同步。
 * 渠道 = OpenAI 端点 (key+url)，内含模型 ID 列表。
 * 调优参数统一按类型管理。
 *
 * @author yt @date 20260702
 */

import defaultSettingsJson from "../../../src/config/default-settings.json";

// ── 模型条目 ───────────────────────────────────────────────

export interface ModelEntry {
  id: string;
  modelId: string;
  /** 视频模型支持的分辨率（如 420/720/1080/2k/4k）；非视频模型可省略 */
  resolutions?: string[];
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

export interface VideoChannel extends ChannelBase {
  models: ModelEntry[];
  activeModelId: string;
}

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

export interface VideoParams {
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
  video: ChannelList<VideoChannel>;
  videoParams: VideoParams;
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

export interface VideoModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

// ── 默认值（单一真相源：src/config/default-settings.json） ──
// 前端 / Worker / Rust 三端均从该 JSON 派生，避免三处手写重复与漂移。

const DEFAULTS = defaultSettingsJson as unknown as AppSettings;

export const DEFAULT_MODEL_ENTRY: ModelEntry = { id: "m1", modelId: "" };
export const DEFAULT_TEXT_CHANNEL: TextChannel = DEFAULTS.text.channels[0];
export const DEFAULT_IMAGE_CHANNEL: ImageChannel = DEFAULTS.image.channels[0];
export const DEFAULT_VOICE_CHANNEL: VoiceChannel = DEFAULTS.voice.channels[0];
export const DEFAULT_ASSET_CHANNEL: AssetChannel = DEFAULTS.asset.channels[0];
export const DEFAULT_VIDEO_CHANNEL: VideoChannel = DEFAULTS.video.channels[0];

export const DEFAULT_TEXT_PARAMS: TextParams = DEFAULTS.textParams;
export const DEFAULT_IMAGE_PARAMS: ImageParams = DEFAULTS.imageParams;
export const DEFAULT_VOICE_PARAMS: VoiceParams = DEFAULTS.voiceParams;
export const DEFAULT_ASSET_PARAMS: AssetParams = DEFAULTS.assetParams;
export const DEFAULT_VIDEO_PARAMS: VideoParams = DEFAULTS.videoParams;

export const DEFAULT_SETTINGS: AppSettings = DEFAULTS;

// ── 工具函数 ─────────────────────────────────────────────

// 同步点：与 src/types/settings.ts::getActiveChannel 逻辑保持一致。
export function getActiveChannel<T extends { id: string }>(
  list: ChannelList<T>,
): T | undefined {
  return list.channels.find((c) => c.id === list.activeId) ?? list.channels[0];
}

/** 解析 TextChannel + TextParams → 客户端平面配置 */
export function resolveTextConfig(channel: TextChannel, params: TextParams): TextModelConfig {
  const m = channel.models.find((x) => x.id === channel.activeModelId) ?? channel.models[0] ?? DEFAULT_MODEL_ENTRY;
  return {
    apiKey: channel.apiKey, baseUrl: channel.baseUrl,
    timeoutMs: params.timeoutMs,
    model: m.modelId, maxTokens: params.maxTokens, temperature: params.temperature,
  };
}

export function resolveImageConfig(channel: ImageChannel, params: ImageParams): ImageModelConfig {
  const m = channel.models.find((x) => x.id === channel.activeModelId) ?? channel.models[0] ?? DEFAULT_MODEL_ENTRY;
  return {
    apiKey: channel.apiKey, baseUrl: channel.baseUrl,
    timeoutMs: params.timeoutMs, model: m.modelId,
  };
}

export function resolveVoiceConfig(channel: VoiceChannel, params: VoiceParams): VoiceModelConfig {
  const m = channel.models.find((x) => x.id === channel.activeModelId) ?? channel.models[0] ?? DEFAULT_MODEL_ENTRY;
  return {
    apiKey: channel.apiKey, baseUrl: channel.baseUrl,
    timeoutMs: params.timeoutMs, model: m.modelId, speed: params.speed,
  };
}

export function resolveVideoConfig(channel: VideoChannel, params: VideoParams): VideoModelConfig {
  const m = channel.models.find((x) => x.id === channel.activeModelId) ?? channel.models[0] ?? DEFAULT_MODEL_ENTRY;
  return {
    apiKey: channel.apiKey, baseUrl: channel.baseUrl,
    timeoutMs: params.timeoutMs, model: m.modelId,
  };
}
