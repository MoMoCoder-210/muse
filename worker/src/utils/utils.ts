/**
 * Handler 公共工具模块
 *
 * 提供日志、JSON 清洗、提示词加载等 handler 之间共用的功能。
 *
 * @author yt @date 20260703
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { logLine } from "../logger.js";
import { PROTOCOL_VERSION } from "../types.js";

// ─── 日志：双写 — 磁盘文件（logLine）+ stdout 转发到 Rust ────

/** 信息级日志：双写（写盘 + 经 stdout 转发到 Rust 实时日志）。handler 内请优先用 l/lw/le，避免裸 logLine 导致 UI 收不到实时日志。 */
export function l(source: string, message: string): void {
  logLine(source, "INFO", message);
  process.stdout.write(JSON.stringify({ version: PROTOCOL_VERSION, msg: "log", level: "info", message: `[${source}] ${message}` }) + "\n");
}

export function lw(source: string, message: string): void {
  logLine(source, "WARN", message);
  process.stdout.write(JSON.stringify({ version: PROTOCOL_VERSION, msg: "log", level: "warn", message: `[${source}] ${message}` }) + "\n");
}

export function le(source: string, message: string): void {
  logLine(source, "ERROR", message);
  process.stdout.write(JSON.stringify({ version: PROTOCOL_VERSION, msg: "log", level: "error", message: `[${source}] ${message}` }) + "\n");
}

// ─── JSON 清洗 ─────────────────────────────────────────────────────

/**
 * 移除 Markdown 代码围栏（```json ... ``` 或 ``` ... ```）
 *
 * @author yt @date 20260703
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

// ─── 提示词加载 ────────────────────────────────────────────────────

/**
 * 从 dist/prompts/ 加载指定文件名，并缓存结果。
 *
 * @author yt @date 20260703
 */
export function loadPrompt(filename: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(moduleDir, "../prompts", filename), "utf-8");
}

/**
 * 创建带内存缓存的提示词加载器。
 * 首次调用时从文件读取，后续调用返回缓存。
 *
 * @author yt @date 20260703
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
