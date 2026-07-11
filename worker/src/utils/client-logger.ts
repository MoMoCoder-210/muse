/**
 * 统一 API 客户端日志工具
 *
 * 所有 client（text/image/voice/asset）的 HTTP 请求与响应通过此模块统一写入磁盘日志，
 * 包含：请求 URL、脱敏 API Key、请求体（截断 2000 字符）、响应体/流式内容、耗时。
 *
 * 仅写磁盘（logLine），不通过 stdout 转发前端 UI，避免与 handler 的 l() 双打。
 *
 * @author yt @date 20260710
 */

import { logLine } from "../logger.js";

// ─── 脱敏工具 ──────────────────────────────────────────────

/**
 * 脱敏 API Key，仅展示首 6 位 + 末 4 位，中间替换为 `****`。
 * key 短于 10 位则全部显示（非标准 key，无需脱敏）。
 */
export function maskKey(key: string): string {
  if (key.length <= 10) return key;
  return key.slice(0, 6) + "****" + key.slice(-4);
}

/**
 * 截断文本，超过 maxLen 追加 "…" 后缀。
 * 0 或负数表示不截断。
 */
function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0 || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
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
  const bodyStr = body !== null ? truncate(JSON.stringify(body), 2000) : "(无请求体)";
  logLine(source, "INFO", `${method} ${url} | key=${masked} | ${bodyStr}`);
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
  const bodyStr = truncate(JSON.stringify(body), 2000);
  logLine(source, "INFO", `${url} | 200 ${elapsed}ms | ${bodyStr}`);
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
  const contentStr = truncate(content, 4000);
  logLine(
    source,
    "INFO",
    `${url} | 200 ${elapsed}ms${metaStr} | 流式输出(${content.length}字符)\n  ▶ ${contentStr}`,
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
