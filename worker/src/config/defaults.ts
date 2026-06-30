/**
 * API 配置默认值
 *
 * 所有模型接入均走火山方舟（OpenAI 兼容格式）。
 * apiKey 默认为空，必须通过设置页面填入后才能调用。
 */

// ── 基础连接 ──────────────────────────────────────────────
export const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

// ── 文本模型（豆包 / DeepSeek 等） ───────────────────────
export const DEFAULT_TEXT_CONFIG: TextModelConfig = {
  apiKey: "",
  baseUrl: ARK_BASE_URL,
  model: "doubao-pro-32k-241215",
  maxTokens: 4096,
  temperature: 0.7,
  timeoutMs: 60_000,
};

// ── 生图模型 ──────────────────────────────────────────────
export const DEFAULT_IMAGE_CONFIG: ImageModelConfig = {
  apiKey: "",
  baseUrl: ARK_BASE_URL,
  model: "doubao-seedream-4-5-251128",
  size: "1024x1024",
  timeoutMs: 120_000,
};

// ── 语音模型（TTS） ───────────────────────────────────────
export const DEFAULT_VOICE_CONFIG: VoiceModelConfig = {
  apiKey: "",
  baseUrl: ARK_BASE_URL,
  model: "doubao-tts",
  voice: "zh_female_shuangkuaisisi_moon_bigtts",
  speed: 1.0,
  timeoutMs: 60_000,
};

// ── 配置类型定义 ─────────────────────────────────────────

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
  /** 格式：宽x高，如 "1024x1024" | "2K" | "4K" */
  size: string;
  timeoutMs: number;
}

export interface VoiceModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 音色 ID，见火山方舟 TTS 文档 */
  voice: string;
  /** 语速倍率，0.5 ~ 2.0 */
  speed: number;
  timeoutMs: number;
}

/** 完整应用配置结构 */
export interface AppSettings {
  text: TextModelConfig;
  image: ImageModelConfig;
  voice: VoiceModelConfig;
}

export const DEFAULT_SETTINGS: AppSettings = {
  text:  DEFAULT_TEXT_CONFIG,
  image: DEFAULT_IMAGE_CONFIG,
  voice: DEFAULT_VOICE_CONFIG,
};
