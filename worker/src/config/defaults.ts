/**
 * API 配置默认值
 *
 * OpenAI 兼容格式
 *
 * @author yt @date 20260702
 */

// ── 文本模型 ──────────────────────────────────────────────
export const DEFAULT_TEXT_CONFIG: TextModelConfig = {
  apiKey: "",
  baseUrl: "",
  model: "",
  maxTokens: 4096,
  temperature: 0.5,
  // @author yt @date 20260702 由 60s 调至 120s，与 image 对齐
  timeoutMs: 600000,
};

// ── 生图模型 ──────────────────────────────────────────────
export const DEFAULT_IMAGE_CONFIG: ImageModelConfig = {
  apiKey: "",
  baseUrl: "",
  model: "",
  timeoutMs: 600000,
};

// ── 语音模型 ─────────────────────────────────────────────
export const DEFAULT_VOICE_CONFIG: VoiceModelConfig = {
  apiKey: "",
  baseUrl:"",
  model: "",
  speed: 1.0,
  timeoutMs: 600000,
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
  timeoutMs: number;
}

export interface VoiceModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
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
