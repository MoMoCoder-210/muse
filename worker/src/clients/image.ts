/**
 * Image generation client
 * Native fetch implementation, compatible with OpenAI Images API.
 * No third-party SDK dependency (replaces openai npm package, saves ~10MB).
 */

import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import type { ImageModelConfig } from "../config/defaults.js";
import { FALLBACK_API_KEY } from "./constants.js";
import { logRequest, logResponse, logFailure } from "../utils/client-logger.js";

export interface ImageGenerateOptions {
  size?: string;
  watermark?: boolean;
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  signal?: AbortSignal;
}

export interface ImageGenerateResult {
  url: string;
  model: string;
}

export class ImageClient {
  private config: ImageModelConfig;

  constructor(config: ImageModelConfig) {
    this.config = config;
  }

  updateConfig(config: ImageModelConfig): void {
    this.config = config;
  }

  async generate(
    prompt: string,
    options: ImageGenerateOptions = {}
  ): Promise<ImageGenerateResult> {
    if (!this.config.apiKey) {
      throw new Error("ImageClient: apiKey is not configured");
    }

    const size = options.size ?? "1024x1024";
    const quality = options.quality ?? "hd";
    const style = options.style ?? "natural";
    const watermark = options.watermark ?? false;

    const apiUrl = `${(this.config.baseUrl || "").replace(/\/+$/, "")}/images/generations`;
    const reqBody = {
      model: this.config.model,
      prompt,
      n: 1,
      size,
      quality,
      style,
      response_format: "url",
      watermark,
    };
    logRequest("ImageClient", "POST", apiUrl, this.config.apiKey, reqBody);
    const startedAt = Date.now();

    try {
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey || FALLBACK_API_KEY}`,
        },
        body: JSON.stringify(reqBody),
        signal: options.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const json = await resp.json() as { data?: Array<{ url?: string; revised_prompt?: string }> };
      const resultData = json.data?.[0];
      const url = resultData?.url;

      if (!url) {
        throw new Error("ImageClient: no URL in response");
      }

      const elapsed = Date.now() - startedAt;
      logResponse("ImageClient", apiUrl, elapsed, {
        url,
        revised_prompt: resultData?.revised_prompt,
      });

      return { url, model: this.config.model };
    } catch (err) {
      logFailure("ImageClient", apiUrl, Date.now() - startedAt, err);
      throw err;
    }
  }

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
