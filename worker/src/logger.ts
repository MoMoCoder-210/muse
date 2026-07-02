import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";

// 与 src-tauri/src/project_log.rs 中的 LOG_MAX_BYTES / LOG_KEEP_BYTES 保持一致
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_BYTES = 2 * 1024 * 1024;

let logPath = "";

export function configureLogger(nextLogPath: string): void {
  logPath = nextLogPath.trim();
  if (!logPath) return;
  mkdirSync(dirname(logPath), { recursive: true });
}

export function logLine(source: string, level: "INFO" | "WARN" | "ERROR", message: string): void {
  if (!logPath) return;
  rotateIfNeeded();
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] [${level}] [${source}] ${message}\n`;
  appendFileSync(logPath, line, "utf-8");
}

function rotateIfNeeded(): void {
  if (!logPath || !existsSync(logPath)) return;
  const size = statSync(logPath).size;
  if (size <= LOG_MAX_BYTES) return;
  const content = readFileSync(logPath);
  writeFileSync(logPath, content.subarray(Math.max(0, content.length - LOG_KEEP_BYTES)));
}
