/**
 * 统一 API 客户端日志工具
 */

import { logLine } from "../logger.js";

// ─── 脱敏工具 ──────────────────────────────────────────────

/**
 * 脱敏 API Key，仅展示首 6 位 + 末 4 位，中间替换为 `****`。
 */
export function maskKey(key: string): string {
  if (key.length <= 10) return key;
  return key.slice(0, 6) + "****" + key.slice(-4);
}

function summarizePayload(value: unknown): string {
  if (value == null) return "(无内容)";
  if (typeof value === "string") return `字符串(${value.length}字符)`;
  if (Array.isArray(value)) return `数组(${value.length}项)`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `对象(keys=${keys.join(",") || "无"})`;
  }
  return typeof value;
}

// ─── 对外 API ──────────────────────────────────────────────

/**
 * 打印请求日志（仅写磁盘）。
 *
 * @param source  客户端标识（如 "ImageClient"）
 * @param method  HTTP 方法
 * @param url     完整请求 URL
 * @param apiKey  原始 API Key（会自动脱敏）
 * @param body    请求体 JSON（null 表示无请求体）
 */
export function logRequest(
  source: string,
  method: string,
  url: string,
  apiKey: string,
  body: unknown,
): void {
  const masked = maskKey(apiKey);
  const bodyStr = summarizePayload(body);
  logLine(source, "INFO", `${method} ${url} | key=${masked} | body=${bodyStr}`);
}

/**
 * 打印非流式响应日志（JSON 响应体，仅写磁盘）。
 *
 * @param source  客户端标识
 * @param url     请求 URL
 * @param elapsed 耗时（ms）
 * @param body    响应体 JSON
 */
export function logResponse(
  source: string,
  url: string,
  elapsed: number,
  body: unknown,
): void {
  logLine(source, "INFO", `${url} | 200 ${elapsed}ms | body=${summarizePayload(body)}`);
}

/**
 * 打印流式完成日志（仅写磁盘，含完整流式内容）。
 *
 * @param source    客户端标识
 * @param url       请求 URL
 * @param elapsed   耗时（ms）
 * @param content   流式输出的完整文本
 * @param meta      附加统计信息（如 tokens、chunks），可选
 */
export function logStreamDone(
  source: string,
  url: string,
  elapsed: number,
  content: string,
  meta?: Record<string, string | number>,
): void {
  const metaStr = meta ? " " + Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  logLine(
    source,
    "INFO",
    `${url} | 200 ${elapsed}ms | 流式输出(${content.length}字符)${metaStr}`,
  );
}

/**
 * 打印二进制响应日志（仅写磁盘，如语音合成）。
 *
 * @param source   客户端标识
 * @param url      请求 URL
 * @param elapsed  耗时（ms）
 * @param sizeBytes 响应体大小
 */
export function logBinaryDone(
  source: string,
  url: string,
  elapsed: number,
  sizeBytes: number,
): void {
  logLine(source, "INFO", `${url} | 200 ${elapsed}ms | 二进制 ${sizeBytes}bytes`);
}

/**
 * 打印错误日志（仅写磁盘）。
 *
 * @param source  客户端标识
 * @param url     请求 URL
 * @param elapsed 耗时（ms）
 * @param error   错误对象
 */
export function logFailure(
  source: string,
  url: string,
  elapsed: number,
  error: unknown,
): void {
  const errMsg = error instanceof Error ? error.message : String(error);
  logLine(source, "ERROR", `${url} | FAIL ${elapsed}ms | ${errMsg}`);
}
