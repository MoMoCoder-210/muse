/**
 * 文本模型客户端（豆包 Chat Completions）
 *
 * 火山方舟完全兼容 OpenAI Chat Completions API，直接用 openai SDK。
 * base_url 指向方舟端点，model 填方舟的模型接入点 ID。
 *
 * 支持：
 *   - 普通对话（单轮 / 多轮）
 *   - JSON 模式输出
 *   - 流式输出（可选）
 */

import OpenAI from "openai";
import type { TextModelConfig } from "../config/defaults.js";
import { FALLBACK_API_KEY } from "./constants.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TextCallOptions {
  /** 覆盖配置中的 temperature */
  temperature?: number;
  /** 覆盖配置中的 maxTokens */
  maxTokens?: number;
  /** 强制 JSON 输出（response_format: json_object） */
  jsonMode?: boolean;
  /** AbortSignal，用于任务取消 */
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
  private config: TextModelConfig;

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

  /** 配置变更后重建客户端 */
  updateConfig(config: TextModelConfig): void {
    this.config = config;
    this.client = this.buildClient(config);
  }

  /**
   * 发送对话请求，返回完整响应文本。
   *
   * @throws 网络错误、超时、限流（429）、配额耗尽均直接抛出，由调用方处理。
   */
  async chat(
    messages: ChatMessage[],
    options: TextCallOptions = {}
  ): Promise<TextCallResult> {
    if (!this.config.apiKey) {
      throw new Error("TextClient: apiKey is not configured");
    }

    const response = await this.client.chat.completions.create(
      {
        model: this.config.model,
        messages,
        max_tokens: options.maxTokens ?? this.config.maxTokens,
        temperature: options.temperature ?? this.config.temperature,
        ...(options.jsonMode
          ? { response_format: { type: "json_object" } }
          : {}),
      },
      { signal: options.signal }
    );

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error("TextClient: empty response from model");
    }

    return {
      content: choice.message.content,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      model: response.model,
    };
  }

  /**
   * 流式对话，逐 chunk 回调。
   * 适用于需要实时展示生成进度的场景。
   */
  async chatStream(
    messages: ChatMessage[],
    onChunk: (delta: string) => void,
    options: TextCallOptions = {}
  ): Promise<TextCallResult> {
    if (!this.config.apiKey) {
      throw new Error("TextClient: apiKey is not configured");
    }

    const stream = await this.client.chat.completions.create(
      {
        model: this.config.model,
        messages,
        max_tokens: options.maxTokens ?? this.config.maxTokens,
        temperature: options.temperature ?? this.config.temperature,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: options.signal }
    );

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let modelId = this.config.model;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        fullContent += delta;
        onChunk(delta);
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
      if (chunk.model) modelId = chunk.model;
    }

    return { content: fullContent, inputTokens, outputTokens, model: modelId };
  }
}
