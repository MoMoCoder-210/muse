/**
 * 语音模型客户端
 *
 * 兼容 OpenAI Audio Speech API（client.audio.speech.create）。
 * 输出格式默认 mp3，返回二进制流，直接写入本地文件。
 *
 * @author yt @date 20260702
 */

import OpenAI from "openai";
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import type { VoiceModelConfig } from "../config/defaults.js";
import { FALLBACK_API_KEY } from "./constants.js";
import { logRequest, logBinaryDone, logFailure } from "../utils/client-logger.js";

const DEFAULT_VOICE = "zh_female_shuangkuaisisi_moon_bigtts";

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

export class VoiceClient {
  private client: OpenAI;
  private config: VoiceModelConfig;

  constructor(config: VoiceModelConfig) {
    this.config = config;
    this.client = this.buildClient(config);
  }

  private buildClient(config: VoiceModelConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey || FALLBACK_API_KEY,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }

  updateConfig(config: VoiceModelConfig): void {
    this.config = config;
    this.client = this.buildClient(config);
  }

  /**
   * 合成语音并保存到本地文件。
   *
   * @param text      需要合成的文本
   * @param savePath  保存路径（含文件名，如 audio/clip_01.mp3）
   *
   * @author yt @date 20260702
   */
  async synthesize(
    text: string,
    savePath: string,
    options: VoiceGenerateOptions = {}
  ): Promise<VoiceGenerateResult> {
    if (!this.config.apiKey) {
      throw new Error("VoiceClient: apiKey is not configured");
    }

    const format = options.format ?? "mp3";
    const voice = options.voice ?? DEFAULT_VOICE;
    const speed = options.speed ?? this.config.speed;

    const apiUrl = `${(this.config.baseUrl || "").replace(/\/+$/, "")}/audio/speech`;
    const reqBody = { model: this.config.model, input: text, voice, speed, response_format: format };
    logRequest("VoiceClient", "POST", apiUrl, this.config.apiKey, reqBody);
    const startedAt = Date.now();

    try {
      const response = await this.client.audio.speech.create(
        {
          model: this.config.model,
          input: text,
          voice: voice as Parameters<
            OpenAI["audio"]["speech"]["create"]
          >[0]["voice"],
          speed,
          response_format: format,
        },
        { signal: options.signal }
      );

      await mkdir(dirname(savePath), { recursive: true });

      const buffer = Buffer.from(await response.arrayBuffer());
      await writeBuffer(buffer, savePath);

      const elapsed = Date.now() - startedAt;
      logBinaryDone("VoiceClient", apiUrl, elapsed, buffer.byteLength);

      return { filePath: savePath, sizeBytes: buffer.byteLength };
    } catch (err) {
      logFailure("VoiceClient", apiUrl, Date.now() - startedAt, err);
      throw err;
    }
  }
}

// ── 写 Buffer 到文件 ─────────────────────────────────────
// @author yt @date 20260702 写 Buffer 到文件
function writeBuffer(buffer: Buffer, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const writer = createWriteStream(filePath);
    writer.write(buffer, (err) => {
      if (err) { writer.destroy(); return reject(err); }
      writer.end();
    });
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}
