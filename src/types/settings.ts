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

export interface AppSettings {
  text: TextModelConfig;
  image: ImageModelConfig;
  voice: VoiceModelConfig;
  asset: AssetModelConfig;
}

export const DEFAULT_SETTINGS: AppSettings = {
  text: {
    apiKey: "",
    baseUrl: "",
    model: "",
    maxTokens: 131072,
    temperature: 0.7,
    timeoutMs: 300000,
  },
  image: {
    apiKey: "",
    baseUrl: "",
    model: "",
    timeoutMs: 300000,
  },
  voice: {
    apiKey: "",
    baseUrl: "",
    model: "",
    speed: 1.0,
    timeoutMs: 300000,
  },
  asset: {
    apiKey: "",
    baseUrl: "",
    timeoutMs: 300000,
  },
};
