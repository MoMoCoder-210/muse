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
  size: string;
  timeoutMs: number;
}

export interface VoiceModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed: number;
  timeoutMs: number;
}

export interface AppSettings {
  text: TextModelConfig;
  image: ImageModelConfig;
  voice: VoiceModelConfig;
}

export const DEFAULT_SETTINGS: AppSettings = {
  text: {
    apiKey: "",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-pro-32k-241215",
    maxTokens: 4096,
    temperature: 0.7,
    timeoutMs: 60000,
  },
  image: {
    apiKey: "",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedream-4-5-251128",
    size: "1024x1024",
    timeoutMs: 120000,
  },
  voice: {
    apiKey: "",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-tts",
    voice: "zh_female_shuangkuaisisi_moon_bigtts",
    speed: 1.0,
    timeoutMs: 60000,
  },
};
