/**
 * 语音模型客户端
 */

import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import type { VoiceModelConfig } from "../config/defaults.js";
import { logRequest, logBinaryDone, logFailure } from "../utils/client-logger.js";

// 默认音色（官方 2.0 大模型音色）
const DEFAULT_VOICE = "zh_female_yingtaowanzi_uranus_bigtts";


export interface VoiceGenerateOptions {
  /** 覆盖配置中的 voice */
  voice?: string;
  /** 覆盖配置中的 speed（0.5 ~ 2.0） */
  speed?: number;
  /** 输出格式，默认 mp3 */
  format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  /** AbortSignal */
  signal?: AbortSignal;
}

export interface VoiceGenerateResult {
  /** 本地文件路径 */
  filePath: string;
  /** 文件大小（bytes） */
  sizeBytes: number;
}

/**
 * 从字符串中提取所有「首尾拼接」的顶层 JSON 对象。
 */
function extractJsonObjects(s: string): any[] {
  const out: any[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            out.push(JSON.parse(s.slice(start, i + 1)));
          } catch {
            // 跳过无法解析的片段
          }
          start = -1;
        }
      }
    }
  }
  return out;
}

export class VoiceClient {
  private config: VoiceModelConfig;

  constructor(config: VoiceModelConfig) {
    this.config = config;
  }

  updateConfig(config: VoiceModelConfig): void {
    this.config = config;
  }

  /**
   * 合成语音并保存到本地文件。
   *
   * @param text      需要合成的文本
   * @param savePath  保存路径（含文件名，如 audio/clip_01.mp3）
   */
  async synthesize(
    text: string,
    savePath: string,
    options: VoiceGenerateOptions = {}
  ): Promise<VoiceGenerateResult> {
    const cfg = this.config;
    if (!cfg.apiKey) {
      throw new Error("VoiceClient: apiKey 未配置");
    }

    const format = options.format ?? "mp3";
    const voice = options.voice ?? DEFAULT_VOICE;
    const resourceId = cfg.resourceId.trim();
    const sampleRate = cfg.sampleRate ?? 24000;
    const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, "");

    const reqBody = {
      req_params: {
        text,
        speaker: voice,
        audio_params: { format, sample_rate: sampleRate },
      },
    };
    logRequest("VoiceClient", "POST", baseUrl, cfg.apiKey, reqBody);
    const startedAt = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 300000);
      const signal = options.signal ?? controller.signal;

      const resp = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": cfg.apiKey,
          "X-Api-Resource-Id": resourceId,
          "Connection": "keep-alive",
        },
        body: JSON.stringify(reqBody),
        signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`VoiceClient HTTP ${resp.status}: ${txt}`);
      }

      // OpenSpeech V3 为单向流式：响应是「多个 JSON 对象首尾拼接」
      // （每个对象是一段音频块，含 data 字段的 base64 音频）。
      // 成功对象 -> {"code":0,"message":"OK","data":"<base64 片段>",...}
      // 失败对象 -> {"code":<非零>,"message":"<错误描述>",...}
      // 个别情况下也可能直接返回裸二进制流（首字节非 '{'），一并兼容。
      const buf = Buffer.from(await resp.arrayBuffer());
      let audioBuf: Buffer | null = null;
      if (buf.length > 0 && buf[0] === 0x7b) {
        const objs = extractJsonObjects(buf.toString("utf-8"));
        const parts: string[] = [];
        for (const obj of objs) {
          // V3 成功码为 0 或 20000000，其余均视为错误
          if (obj && obj.code !== undefined && obj.code !== 0 && obj.code !== 20000000) {
            const msg =
              (obj.message as string) ||
              (obj.error && (obj.error as any).message) ||
              "未知错误";
            throw new Error(`VoiceClient: ${msg}`);
          }
          if (obj && typeof obj.data === "string") {
            parts.push(obj.data);
          }
        }
        if (parts.length > 0) {
          audioBuf = Buffer.from(parts.join(""), "base64");
        }
      }
      if (!audioBuf) {
        // 非 JSON（裸二进制流）或无可解析片段：按原 buffer 处理
        audioBuf = buf;
      }

      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, audioBuf);

      const elapsed = Date.now() - startedAt;
      logBinaryDone("VoiceClient", baseUrl, elapsed, audioBuf.byteLength);

      return { filePath: savePath, sizeBytes: audioBuf.byteLength };
    } catch (err) {
      logFailure("VoiceClient", baseUrl, Date.now() - startedAt, err);
      throw err;
    }
  }
}
