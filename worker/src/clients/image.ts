/**
 * 生图模型客户端（豆包 Images Generate）
 *
 * 火山方舟的生图接口兼容 OpenAI Images API（client.images.generate）。
 * 返回图片 URL，调用方负责下载并存储到本地工作区。
 *
 * 注意：
 *   - 方舟生图为异步任务，SDK 会轮询直到完成，timeout 需设置较大值（默认 120s）
 *   - URL 有效期通常为 1 小时，必须及时下载
 */

import OpenAI from "openai";
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import type { ImageModelConfig } from "../config/defaults.js";

export interface ImageGenerateOptions {
  /** 覆盖配置中的 size */
  size?: string;
  /** 是否添加水印（方舟扩展参数） */
  watermark?: boolean;
  /** AbortSignal */
  signal?: AbortSignal;
}

export interface ImageGenerateResult {
  /** 图片临时 URL（1小时有效） */
  url: string;
  model: string;
}

export class ImageClient {
  private client: OpenAI;
  private config: ImageModelConfig;

  constructor(config: ImageModelConfig) {
    this.config = config;
    this.client = this.buildClient(config);
  }

  private buildClient(config: ImageModelConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }

  updateConfig(config: ImageModelConfig): void {
    this.config = config;
    this.client = this.buildClient(config);
  }

  /**
   * 生成图片，返回临时 URL。
   */
  async generate(
    prompt: string,
    options: ImageGenerateOptions = {}
  ): Promise<ImageGenerateResult> {
    if (!this.config.apiKey) {
      throw new Error("ImageClient: apiKey is not configured");
    }

    const size = (options.size ?? this.config.size) as
      | "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792"
      | (string & {});

    const response = await this.client.images.generate(
      {
        model: this.config.model,
        prompt,
        n: 1,
        size,
        response_format: "url",
        // 方舟扩展参数：水印
        ...(options.watermark !== undefined
          ? { extra_body: { watermark: options.watermark } }
          : {}),
      } as Parameters<OpenAI["images"]["generate"]>[0],
      { signal: options.signal }
    );

    const url = response.data[0]?.url;
    if (!url) {
      throw new Error("ImageClient: no URL in response");
    }

    return { url, model: this.config.model };
  }

  /**
   * 生成图片并直接下载到本地路径。
   * 返回本地文件路径。
   */
  async generateAndSave(
    prompt: string,
    savePath: string,
    options: ImageGenerateOptions = {}
  ): Promise<string> {
    const { url } = await this.generate(prompt, options);
    await downloadFile(url, savePath, options.signal);
    return savePath;
  }
}

// ── 文件下载工具 ───────────────────────────────────────────
async function downloadFile(
  url: string,
  destPath: string,
  signal?: AbortSignal
): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("Download failed: empty response body");
  }

  await new Promise<void>((resolve, reject) => {
    const writer = createWriteStream(destPath);
    const reader = response.body!.getReader();

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
        writer.end();
        writer.on("finish", resolve);
        writer.on("error", reject);
      } catch (err) {
        writer.destroy();
        reject(err);
      }
    };
    pump();
  });
}
