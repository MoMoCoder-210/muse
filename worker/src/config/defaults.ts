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
  // 分集等场景需原样输出长文本，输出 token 量大，60s 一次性返回易超时
  // @author yt @date 20260702 由 60s 调至 120s，与 image 对齐
  timeoutMs: 120_000,
};

// ── 生图模型 ──────────────────────────────────────────────
export const DEFAULT_IMAGE_CONFIG: ImageModelConfig = {
  apiKey: "",
  baseUrl: ARK_BASE_URL,
  model: "doubao-seedream-4-5-251128",
  timeoutMs: 120_000,
};

// ── 语音模型（TTS） ───────────────────────────────────────
export const DEFAULT_VOICE_CONFIG: VoiceModelConfig = {
  apiKey: "",
  baseUrl: ARK_BASE_URL,
  model: "doubao-tts",
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
  timeoutMs: number;
}

export interface VoiceModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
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
