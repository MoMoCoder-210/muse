/**
 * Worker 侧配置类型与默认值。
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const defaultSettingsJson = require("./default-settings.json");

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

/** 语音渠道（OpenSpeech V3 协议，非方舟 Ark） */
export interface VoiceChannel {
  id: string;
  name: string;
  /** 火山控制台「语音合成」分配的 API Key（X-Api-Key 头） */
  apiKey: string;
  /** 资源 ID：官方 2.0 为 seed-tts-2.0，克隆 2.0 为 seed-icl-2.0；留空按音色自动推断 */
  resourceId: string;
  /** V3 单向流式接口地址 */
  baseUrl: string;
  /** 采样率，默认 24000 */
  sampleRate?: number;
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
  resourceId: string;
  baseUrl: string;
  sampleRate: number;
  speed: number;
  timeoutMs: number;
}

export interface AssetModelConfig {
  apiKey: string;
  timeoutMs: number;
}

export interface VideoModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

// ── 默认值（单一真相源：src/config/default-settings.json） ──

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
  return {
    apiKey: channel.apiKey,
    resourceId: channel.resourceId ?? "seed-tts-2.0",
    baseUrl: channel.baseUrl ?? "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    sampleRate: channel.sampleRate ?? 24000,
    speed: params.speed,
    timeoutMs: params.timeoutMs,
  };
}

export function resolveVideoConfig(channel: VideoChannel, params: VideoParams): VideoModelConfig {
  const m = channel.models.find((x) => x.id === channel.activeModelId) ?? channel.models[0] ?? DEFAULT_MODEL_ENTRY;
  return {
    apiKey: channel.apiKey, baseUrl: channel.baseUrl,
    timeoutMs: params.timeoutMs, model: m.modelId,
  };
}
