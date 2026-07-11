/**
 * 配置文件读写
 *
 * @author yt @date 20260702
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import {
  DEFAULT_SETTINGS, getActiveChannel,
  resolveTextConfig, resolveImageConfig, resolveVoiceConfig,
  type AppSettings, type TextModelConfig, type ImageModelConfig,
  type VoiceModelConfig, type AssetModelConfig,
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
    if (!ch) throw new Error("素材渠道缺失");
    return {
      apiKey: ch.apiKey, baseUrl: ch.baseUrl,
      timeoutMs: this.cache.assetParams.timeoutMs,
    };
  }

  isTextConfigured(): boolean  { return this.getTextConfig().apiKey.trim().length > 0; }
  isImageConfigured(): boolean { return this.getImageConfig().apiKey.trim().length > 0; }
  isVoiceConfigured(): boolean { return this.getVoiceConfig().apiKey.trim().length > 0; }
  isAssetConfigured(): boolean { return this.getAssetConfig().apiKey.trim().length > 0; }
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
