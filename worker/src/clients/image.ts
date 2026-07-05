/**
 * 生图模型客户端
 *
 * 兼容 OpenAI Images API
 *
 * @author yt @date 20260702
 */

import OpenAI from "openai";
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import type { ImageModelConfig } from "../config/defaults.js";
import { FALLBACK_API_KEY } from "./constants.js";

export interface ImageGenerateOptions {
  /** 生图尺寸 */
  size?: string;
  /** 是否添加水印 */
  watermark?: boolean;
  /** AbortSignal */
  signal?: AbortSignal;
}

export interface ImageGenerateResult {
  /** 图片临时 URL*/
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
      apiKey: config.apiKey || FALLBACK_API_KEY,
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
   * 生成图片，返回临时 URL
   *
   * @author yt @date 20260702
   */
  async generate(
    prompt: string,
    options: ImageGenerateOptions = {}
  ): Promise<ImageGenerateResult> {
    if (!this.config.apiKey) {
      throw new Error("ImageClient: apiKey is not configured");
    }

    const size = (options.size ?? "1024x1024") as
      | "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792"
      | (string & {});

    const requestParams = {
      model: this.config.model,
      prompt: prompt.slice(0, 60) + (prompt.length > 60 ? "…" : ""),
      n: 1,
      size,
      response_format: "url",
    };
    console.log("[ImageClient]", JSON.stringify(requestParams));

    const response = await this.client.images.generate(
      {
        model: this.config.model,
        prompt,
        n: 1,
        size,
        response_format: "url",
        // OpenAI 兼容端点扩展参数：水印
        ...(options.watermark !== undefined
          ? { extra_body: { watermark: options.watermark } }
          : {}),
      } as Parameters<OpenAI["images"]["generate"]>[0],
      { signal: options.signal }
    );

    if (!("data" in response) || !response.data) {
      throw new Error("ImageClient: unexpected streaming response");
    }

    const resultData = response.data[0];
    console.log("[ImageClient] 响应:", JSON.stringify({ url: resultData?.url?.slice(0, 80) + "…", revised_prompt: (resultData as any)?.revised_prompt?.slice(0, 80) }));

    const url = resultData?.url;
    if (!url) {
      throw new Error("ImageClient: no URL in response");
    }

    return { url, model: this.config.model };
  }

  /**
   * 生成图片并直接下载到本地路径
   * 返回本地文件路径
   *
   * @author yt @date 20260702
   */
  async generateAndSave(
    prompt: string,
    savePath: string,
    options: ImageGenerateOptions = {}
  ): Promise<string> {
    const { url } = await this.generate(prompt, options);
    console.log("[ImageClient] 保存路径:", savePath);
    await downloadFile(url, savePath, options.signal);
    console.log("[ImageClient] 下载完成:", savePath);
    return savePath;
  }
}

// ── 文件下载工具 ───────────────────────────────────────────
// @author yt @date 20260702 下载文件到本地
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
