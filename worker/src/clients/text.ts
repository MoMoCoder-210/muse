/**
 * 文本模型客户端
 *
 * 兼容 OpenAI Chat Completions API（含兼容端点），流式输出。
 *
 * @author yt @date 20260702
 */

import OpenAI from "openai";
import type { TextModelConfig } from "../config/defaults.js";
import { FALLBACK_API_KEY } from "./constants.js";
import { logRequest, logStreamDone, logFailure } from "../utils/client-logger.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TextCallOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface TextCallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class TextClient {
  private client: OpenAI;
  config: TextModelConfig;

  constructor(config: TextModelConfig) {
    this.config = config;
    this.client = this.buildClient(config);
  }

  private buildClient(config: TextModelConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey || FALLBACK_API_KEY,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }

  updateConfig(config: TextModelConfig): void {
    this.config = config;
    this.client = this.buildClient(config);
  }

  async chat(
    messages: ChatMessage[],
    onChunk: (delta: string) => void,
    options: TextCallOptions = {},
  ): Promise<TextCallResult> {
    if (!this.config.apiKey) throw new Error("TextClient: apiKey is not configured");

    const model = this.config.model;
    const maxTokens = options.maxTokens ?? this.config.maxTokens;
    const temperature = options.temperature ?? this.config.temperature;
    const startedAt = Date.now();

    const apiUrl = `${(this.config.baseUrl || "").replace(/\/+$/, "")}/chat/completions`;
    const reqBody = { model, messages, max_tokens: maxTokens, temperature, stream: true };
    logRequest("TextClient", "POST", apiUrl, this.config.apiKey, reqBody);

    let fullContent = "", inputTokens = 0, outputTokens = 0, respModel = model;

    try {
      const stream = await this.client.chat.completions.create(
        { model, messages, max_tokens: maxTokens, temperature, stream: true },
        { signal: options.signal },
      );

      let cc = 0;
      for await (const c of stream) {
        cc++;
        const d = c.choices[0]?.delta?.content ?? "";
        if (d) { fullContent += d; onChunk(d); }
        if (c.usage) { inputTokens = c.usage.prompt_tokens ?? 0; outputTokens = c.usage.completion_tokens ?? 0; }
        if (c.model) respModel = c.model;
      }

      if (!fullContent) throw new Error("模型流式返回空内容");

      const elapsed = Date.now() - startedAt;
      logStreamDone("TextClient", apiUrl, elapsed, fullContent, {
        chunks: cc,
        it: inputTokens,
        ot: outputTokens,
        model: respModel,
      });
      return { content: fullContent, inputTokens, outputTokens, model: respModel };
    } catch (err) {
      logFailure("TextClient", apiUrl, Date.now() - startedAt, err);
      throw err;
    }
  }
}
