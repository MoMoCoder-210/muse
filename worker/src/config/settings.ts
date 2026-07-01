/**
 * 配置文件读写
 *
 * 配置以 JSON 文件形式存储在应用数据目录中（settings.json）。
 * 路径由 Rust 层启动 worker 时通过 --config <path> 参数传入。
 *
 * 读取策略：启动时加载一次，调用方可按需重新加载（热更新）。
 * 写入策略：由设置页面通过 Tauri command 写文件，worker 重载配置。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { DEFAULT_SETTINGS, type AppSettings } from "./defaults.js";

export class SettingsManager {
  private configPath: string;
  private cache: AppSettings;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.cache = this.load();
  }

  /**
   * 从磁盘加载配置，缺失字段用默认值填充（深合并）。
   */
  private load(): AppSettings {
    if (!existsSync(this.configPath)) {
      return structuredClone(DEFAULT_SETTINGS);
    }

    try {
      const raw = readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return deepMerge(DEFAULT_SETTINGS, parsed);
    } catch (err) {
      console.error(`[Settings] Failed to load ${this.configPath}:`, err);
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  /** 获取当前完整配置（内存缓存） */
  get(): AppSettings {
    return this.cache;
  }

  /** 重新从磁盘加载（设置页保存后调用） */
  reload(): AppSettings {
    this.cache = this.load();
    return this.cache;
  }

  /**
   * 将配置写入磁盘（通常由设置页 Tauri command 调用，worker 侧一般不需要写）。
   * worker 侧暴露此方法仅作为兜底。
   */
  save(settings: AppSettings): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(settings, null, 2), "utf-8");
    this.cache = settings;
  }

  /** 检查文本模型是否已配置 apiKey */
  isTextConfigured(): boolean {
    return this.cache.text.apiKey.trim().length > 0;
  }

  /** 检查生图模型是否已配置 apiKey */
  isImageConfigured(): boolean {
    return this.cache.image.apiKey.trim().length > 0;
  }

  /** 检查语音模型是否已配置 apiKey */
  isVoiceConfigured(): boolean {
    return this.cache.voice.apiKey.trim().length > 0;
  }
}

// ── 工具：深合并（target 为默认值，source 为用户配置） ──────────────
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = structuredClone(target) as any;
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      srcVal !== undefined &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      ) as any;
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result;
}
