/**
 * Worker 日志模块
 *
 * 支持按级别过滤（LOG_LEVEL 环境变量）、日志轮转（保留最近 2MB）。
 *
 * @author yt @date 20260702
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { appendFile } from "fs/promises";
import { dirname } from "path";

// 与 src-tauri/src/project_log.rs 中的 LOG_MAX_BYTES / LOG_KEEP_BYTES 保持一致
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_BYTES = 2 * 1024 * 1024;

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** 当前生效的最低日志级别，低于此级别的日志不会写入文件 */
let minLevel: LogLevel = (() => {
  const envLevel = (process.env.LOG_LEVEL ?? "").toUpperCase();
  if (["DEBUG", "INFO", "WARN", "ERROR"].includes(envLevel)) return envLevel as LogLevel;
  return "INFO";
})();

const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let logPath = "";

export function configureLogger(nextLogPath: string, level?: LogLevel): void {
  logPath = nextLogPath.trim();
  if (level) minLevel = level;
  if (!logPath) return;
  mkdirSync(dirname(logPath), { recursive: true });
}

export function logLine(source: string, level: LogLevel, message: string): void {
  if (!logPath) return;
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  rotateIfNeeded();
  const line = `[${formatTime(new Date())}] [${level}] [${source}] ${message}\n`;
  void appendFile(logPath, line, "utf-8");
}

function formatTime(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  const h = d.getHours().toString().padStart(2, "0");
  const min = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${y}/${m}/${day} ${h}:${min}:${s}`;
}

function rotateIfNeeded(): void {
  if (!logPath || !existsSync(logPath)) return;
  const size = statSync(logPath).size;
  if (size <= LOG_MAX_BYTES) return;
  const content = readFileSync(logPath);
  writeFileSync(logPath, content.subarray(Math.max(0, content.length - LOG_KEEP_BYTES)));
}
