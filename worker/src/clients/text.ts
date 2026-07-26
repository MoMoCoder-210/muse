/**
 * Text model client
 * Native fetch + SSE streaming, compatible with OpenAI Chat Completions API.
 * No third-party SDK dependency (replaces openai npm package, saves ~10MB).
 */

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
  config: TextModelConfig;

  constructor(config: TextModelConfig) {
    this.config = config;
  }

  updateConfig(config: TextModelConfig): void {
    this.config = config;
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

      if (!resp.body) throw new Error("Empty response body");

      let cc = 0;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;

          try {
            const json = JSON.parse(payload);
            cc++;
            const delta = json.choices?.[0]?.delta?.content ?? "";
            if (delta) { fullContent += delta; onChunk(delta); }
            if (json.usage) {
              inputTokens = json.usage.prompt_tokens ?? 0;
              outputTokens = json.usage.completion_tokens ?? 0;
            }
            if (json.model) respModel = json.model;
          } catch {
            // skip malformed lines
          }
        }
      }

      if (!fullContent) throw new Error("Model returned empty content");

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
