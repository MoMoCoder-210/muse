/**
 * 应用设置类型定义 — 共享模块
 *
 * 前端 (src/types/settings.ts) 与 Worker (worker/src/config/defaults.ts)
 * 均从此文件导入类型定义，消除双端重复维护。
 */

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

/** 语音渠道（OpenSpeech V3 协议，非方舟 Ark） */
export interface VoiceChannel {
  id: string;
  name: string;
  /** 火山控制台「语音合成」分配的 API Key（X-Api-Key 头） */
  apiKey: string;
  /** 资源 ID：官方 2.0 为 seed-tts-2.0，克隆 2.0 为 seed-icl-2.0；留空按音色自动推断 */
  resourceId: string;
  /** V3 单向流式接口地址（默认 https://openspeech.bytedance.com/api/v3/tts/unidirectional） */
  baseUrl: string;
  /** 采样率，默认 24000 */
  sampleRate?: number;
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

// ── 通用设置 ─────────────────────────────────────────────

export interface GeneralSettings {
  defaultProjectDir: string;
}

// ── 复合设置 ─────────────────────────────────────────────

export interface AppSettings {
  general: GeneralSettings;
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
