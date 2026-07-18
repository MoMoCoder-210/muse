/**
 * Worker 侧配置类型与默认值。
 *
 * 类型定义 → src/config/settings-types.ts（构建时从 src/types/settings-types.ts 复制）
 * 默认值 → ../src/config/default-settings.json（单一真相源）
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const defaultSettingsJson = require("../../src/config/default-settings.json");

// 类型从共享模块重导出
export type {
  ModelEntry,
  TextChannel,
  ImageChannel,
  VoiceChannel,
  AssetChannel,
  VideoChannel,
  TextParams,
  ImageParams,
  VoiceParams,
  AssetParams,
  VideoParams,
  ChannelList,
  AppSettings,
} from "./settings-types.js";

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

import type {
  AppSettings,
  ChannelList,
  TextChannel,
  ImageChannel,
  VoiceChannel,
  VideoChannel,
  TextParams,
  ImageParams,
  VoiceParams,
  VideoParams,
} from "./settings-types.js";

const DEFAULTS = defaultSettingsJson as unknown as AppSettings;

export const DEFAULT_MODEL_ENTRY = { id: "m1", modelId: "" } as const;
export const DEFAULT_TEXT_CHANNEL = DEFAULTS.text.channels[0];
export const DEFAULT_IMAGE_CHANNEL = DEFAULTS.image.channels[0];
export const DEFAULT_VOICE_CHANNEL = DEFAULTS.voice.channels[0];
export const DEFAULT_ASSET_CHANNEL = DEFAULTS.asset.channels[0];
export const DEFAULT_VIDEO_CHANNEL = DEFAULTS.video.channels[0];

export const DEFAULT_TEXT_PARAMS = DEFAULTS.textParams;
export const DEFAULT_IMAGE_PARAMS = DEFAULTS.imageParams;
export const DEFAULT_VOICE_PARAMS = DEFAULTS.voiceParams;
export const DEFAULT_ASSET_PARAMS = DEFAULTS.assetParams;
export const DEFAULT_VIDEO_PARAMS = DEFAULTS.videoParams;

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
