/**
 * Worker 日志模块。
 *
 * Worker 只通过 stdout 的协议消息输出日志，由 Rust 统一落盘，避免 Worker
 * 与 Rust 同时追加同一个文件造成竞态、乱序和重复日志。
 */

import { PROTOCOL_VERSION } from "./types.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let minLevel: LogLevel = (() => {
  const envLevel = (process.env.LOG_LEVEL ?? "").toUpperCase();
  if (["DEBUG", "INFO", "WARN", "ERROR"].includes(envLevel)) return envLevel as LogLevel;
  return "INFO";
})();

/** 保留原有初始化接口；日志文件路径由 Rust 侧管理。 */
export function configureLogger(_logPath: string, level?: LogLevel): void {
  if (level) minLevel = level;
}

/** 经 Worker/Rust 协议统一转发，消息内容不直接写入本地文件。 */
export function logLine(source: string, level: LogLevel, message: string): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  try {
    process.stdout.write(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        msg: "log",
        level: level.toLowerCase(),
        message: `[${source}] ${message}`,
      }) + "\n",
    );
  } catch {
    // stdout 关闭时忽略日志，不能影响任务本身。
  }
}
