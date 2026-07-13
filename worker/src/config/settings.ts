/**
 * 配置文件读写
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import {
  DEFAULT_SETTINGS, getActiveChannel,
  resolveTextConfig, resolveImageConfig, resolveVoiceConfig, resolveVideoConfig,
  type AppSettings, type TextModelConfig, type ImageModelConfig,
  type VoiceModelConfig, type AssetModelConfig, type VideoModelConfig,
} from "./defaults.js";
import { logLine } from "../logger.js";

export class SettingsManager {
  private configPath: string;
  private cache: AppSettings;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.cache = this.load();
  }

  private load(): AppSettings {
    if (!existsSync(this.configPath)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = readFileSync(this.configPath, "utf-8");
      return deepMerge(DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (err) {
      logLine("配置", "WARN", `加载失败: ${err instanceof Error ? err.message : String(err)}`);
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  get(): AppSettings { return this.cache; }
  reload(): AppSettings { this.cache = this.load(); return this.cache; }

  save(settings: AppSettings): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(settings, null, 2), "utf-8");
    this.cache = settings;
  }

  getTextConfig(): TextModelConfig {
    const ch = getActiveChannel(this.cache.text);
    if (!ch) throw new Error("文本渠道缺失");
    return resolveTextConfig(ch, this.cache.textParams);
  }

  getImageConfig(): ImageModelConfig {
    const ch = getActiveChannel(this.cache.image);
    if (!ch) throw new Error("生图渠道缺失");
    return resolveImageConfig(ch, this.cache.imageParams);
  }

  getVoiceConfig(): VoiceModelConfig {
    const ch = getActiveChannel(this.cache.voice);
    if (!ch) throw new Error("语音渠道缺失");
    return resolveVoiceConfig(ch, this.cache.voiceParams);
  }

  getAssetConfig(): AssetModelConfig {
    const ch = getActiveChannel(this.cache.asset);
    // 素材复用视频模型密钥与地址（直接解析 video 渠道，避免与 getVideoConfig 互相递归）
    const videoCh = getActiveChannel(this.cache.video);
    const video = videoCh ? resolveVideoConfig(videoCh, this.cache.videoParams) : null;
    return {
      apiKey: (video?.apiKey && video.apiKey.trim() ? video.apiKey : (ch?.apiKey ?? "")),
      baseUrl: (video?.baseUrl || ch?.baseUrl || "").replace(/\/+$/, ""),
      timeoutMs: this.cache.assetParams.timeoutMs,
    };
  }

  getVideoConfig(): VideoModelConfig {
    const ch = getActiveChannel(this.cache.video);
    if (!ch) throw new Error("视频渠道缺失");
    const cfg = resolveVideoConfig(ch, this.cache.videoParams);
    // 视频与素材共用火山方舟密钥，未配置时复用 asset 渠道（直接读 asset 渠道，避免与 getAssetConfig 互相递归）
    if (!cfg.apiKey.trim()) {
      const assetCh = getActiveChannel(this.cache.asset);
      cfg.apiKey = assetCh?.apiKey ?? "";
      cfg.baseUrl = ((assetCh?.baseUrl || cfg.baseUrl).replace(/\/+$/, "") + "/v3");
    } else {
      // 确保视频 baseUrl 以 /v3 结尾
      cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
      if (!cfg.baseUrl.endsWith("/v3")) cfg.baseUrl += "/v3";
    }
    return cfg;
  }

  isTextConfigured(): boolean  { return this.getTextConfig().apiKey.trim().length > 0; }
  isImageConfigured(): boolean { return this.getImageConfig().apiKey.trim().length > 0; }
  isVoiceConfigured(): boolean { const c = this.getVoiceConfig(); return c.apiKey.trim().length > 0; }
  isAssetConfigured(): boolean { return this.getAssetConfig().apiKey.trim().length > 0; }
  isVideoConfigured(): boolean { return this.getVideoConfig().apiKey.trim().length > 0; }
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = structuredClone(target) as any;
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sv = source[key], tv = result[key];
    if (sv !== null && sv !== undefined && typeof sv === "object" && !Array.isArray(sv) && typeof tv === "object" && tv !== null) {
      result[key] = deepMerge(tv, sv as any);
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result;
}
