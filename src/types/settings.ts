/**
 * 应用设置类型定义
 *
 * 渠道 = OpenAI 兼容端点 (key + url)，内含多个模型 ID。
 * 调优参数（超时/maxTokens/温度/语速）统一按类型管理，所有渠道共享。
 *
 * @author yt @date 20260702
 */

import defaultSettingsJson from "../config/default-settings.json";

// ── 模型条目（极简） ──────────────────────────────────────

export interface ModelEntry {
  id: string;
  /** API 模型 ID，如 gpt-4o */
  modelId: string;
  /** 视频模型支持的分辨率（如 420/720/1080/2k/4k）；非视频模型可省略 */
  resolutions?: string[];
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

export interface VideoChannel extends ChannelBase {
  models: ModelEntry[];
  activeModelId: string;
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

export interface VideoParams {
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
  video: ChannelList<VideoChannel>;
  videoParams: VideoParams;
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
