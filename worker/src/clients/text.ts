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
import { logLine } from "../logger.js";

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
   * 发送对话请求，返回完整响应文本（一次性返回，非流式）。
   *
   * 适用于短输出场景。长输出（如分集原样回传）请用 chatStream，避免整体超时。
   *
   * @throws 网络错误、超时、限流（429）、配额耗尽均直接抛出，由调用方处理。
   *
   * @author yt @date 20260702 新增调用前/后/异常中文日志
   */
  async chat(
    messages: ChatMessage[],
    options: TextCallOptions = {}
  ): Promise<TextCallResult> {
    if (!this.config.apiKey) {
      throw new Error("TextClient: apiKey is not configured");
    }

    const model = this.config.model;
    const maxTokens = options.maxTokens ?? this.config.maxTokens;
    const temperature = options.temperature ?? this.config.temperature;
    const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
    const startedAt = Date.now();

    logLine(
      "text-client",
      "INFO",
      `开始调用(非流式) model=${model} 消息数=${messages.length} 输入=${inputChars}字符 maxTokens=${maxTokens} temperature=${temperature}`,
    );

    try {
      const response = await this.client.chat.completions.create(
        {
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          ...(options.jsonMode
            ? { response_format: { type: "json_object" } }
            : {}),
        },
        { signal: options.signal }
      );

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        throw new Error("模型返回空内容");
      }

      const elapsedMs = Date.now() - startedAt;
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;
      logLine(
        "text-client",
        "INFO",
        `调用完成(非流式) 耗时=${elapsedMs}ms 输出=${choice.message.content.length}字符 inputTokens=${inputTokens} outputTokens=${outputTokens} model=${response.model}`,
      );

      return {
        content: choice.message.content,
        inputTokens,
        outputTokens,
        model: response.model,
      };
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      const msg = err instanceof Error ? err.message : String(err);
      logLine(
        "text-client",
        "ERROR",
        `调用失败(非流式) 耗时=${elapsedMs}ms 错误=${msg}`,
      );
      throw err;
    }
  }

  /**
   * 流式对话，逐 chunk 回调。
   *
   * 适用于长输出场景（如分集原样回传）：流式持续返回 token，连接保持活跃，
   * 比一次性返回更不容易触发整体 HTTP 超时。
   *
   * @param onChunk 每收到一段 delta 文本时回调；不需要实时展示时传空函数即可
   * @throws 网络错误、超时、限流（429）、配额耗尽均直接抛出，由调用方处理
   *
   * @author yt @date 20260702 新增调用前/后/异常中文日志
   */
  async chatStream(
    messages: ChatMessage[],
    onChunk: (delta: string) => void,
    options: TextCallOptions = {}
  ): Promise<TextCallResult> {
    if (!this.config.apiKey) {
      throw new Error("TextClient: apiKey is not configured");
    }

    const model = this.config.model;
    const maxTokens = options.maxTokens ?? this.config.maxTokens;
    const temperature = options.temperature ?? this.config.temperature;
    const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
    const startedAt = Date.now();

    logLine(
      "text-client",
      "INFO",
      `开始调用(流式) model=${model} 消息数=${messages.length} 输入=${inputChars}字符 maxTokens=${maxTokens} temperature=${temperature}`,
    );

    // 声明提到 try 外，便于 catch 记录流式中断时已接收的字符数
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let respModel = model;

    try {
      const stream = await this.client.chat.completions.create(
        {
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options.signal }
      );

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
        if (chunk.model) respModel = chunk.model;
      }

      if (!fullContent) {
        throw new Error("模型流式返回空内容");
      }

      const elapsedMs = Date.now() - startedAt;
      logLine(
        "text-client",
        "INFO",
        `调用完成(流式) 耗时=${elapsedMs}ms 输出=${fullContent.length}字符 inputTokens=${inputTokens} outputTokens=${outputTokens} model=${respModel}`,
      );

      return { content: fullContent, inputTokens, outputTokens, model: respModel };
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      const msg = err instanceof Error ? err.message : String(err);
      logLine(
        "text-client",
        "ERROR",
        `调用失败(流式) 耗时=${elapsedMs}ms 已接收=${fullContent.length}字符 错误=${msg}`,
      );
      throw err;
    }
  }
}
