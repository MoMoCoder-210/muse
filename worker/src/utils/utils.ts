/**
 * Handler 公共工具模块
 *
 * 提供日志、JSON 清洗、提示词加载等 handler 之间共用的功能。
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { PROTOCOL_VERSION } from "../types.js";

// ─── 日志：仅 stdout 转发到 Rust（由 Rust 端统一落盘，避免双写） ────

/** 信息级日志：经 stdout 转发到 Rust 统一落盘 */
export function l(source: string, message: string): void {
  process.stdout.write(JSON.stringify({ version: PROTOCOL_VERSION, msg: "log", level: "info", message: `[${source}] ${message}` }) + "\n");
}

export function lw(source: string, message: string): void {
  process.stdout.write(JSON.stringify({ version: PROTOCOL_VERSION, msg: "log", level: "warn", message: `[${source}] ${message}` }) + "\n");
}

export function le(source: string, message: string): void {
  process.stdout.write(JSON.stringify({ version: PROTOCOL_VERSION, msg: "log", level: "error", message: `[${source}] ${message}` }) + "\n");
}

// ─── JSON 清洗 ─────────────────────────────────────────────────────

/**
 * 移除 Markdown 代码围栏（```json ... ``` 或 ``` ... ```）
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

// ─── 提示词加载 ────────────────────────────────────────────────────

/**
 * 从 dist/prompts/ 加载指定文件名，并缓存结果。
 */
export function loadPrompt(filename: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(moduleDir, "../prompts", filename), "utf-8");
}

/**
 * 创建带内存缓存的提示词加载器。
 */
export function createPromptLoader(filename: string): () => string {
  let cache: string | null = null;
  return () => {
    if (cache === null) {
      cache = loadPrompt(filename);
    }
    return cache;
  };
}
