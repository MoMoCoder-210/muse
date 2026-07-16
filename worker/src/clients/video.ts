/**
 * 视频生成客户端
 *
 * 对接火山方舟 Seedance 2.0 视频生成 API。
 * 支持文本 + 参考图 + 参考音频的多模态输入。
 *
 * 模型：
 *   - doubao-seedance-2-0-260128      高品质
 *   - doubao-seedance-2-0-fast-260128  快速低延迟
 *
 * 提示词中引用素材格式：图片1、图片2、音频1、视频1（按 content 数组中出现顺序从 1 计数）
 */

import OpenAI from "openai";
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import type { VideoModelConfig } from "../config/defaults.js";
import { FALLBACK_API_KEY } from "./constants.js";
import { logRequest, logResponse, logFailure } from "../utils/client-logger.js";
import { l } from "../utils/utils.js";

// ── 类型定义 ──────────────────────────────────────────────

/** 参考素材 */
export interface VideoReference {
  type: "image_url" | "video_url" | "audio_url";
  url: string;
}

/** 视频生成选项 */
export interface VideoGenerateOptions {
  /** 覆盖设置中当前激活模型；分镜选择的模型以此为准。 */
  model?: string;
  /** 分辨率：480p / 720p */
  resolution?: "480p" | "720p" | "1080p" | "2k" | "4k";
  /** 宽高比 */
  ratio?: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  /** 时长（秒），4~15 */
  duration?: number;
  /** 是否生成有声视频 */
  generateAudio?: boolean;
  /** 是否添加水印 */
  watermark?: boolean;
  /** AbortSignal */
  signal?: AbortSignal;
}

/** 视频生成结果 */
export interface VideoGenerateResult {
  /** 下载后的本地路径 */
  filePath: string;
  /** 模型名 */
  model: string;
}

/** 任务状态 */
type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

interface TaskInfo {
  id: string;
  status: TaskStatus;
  /** 成功后返回的视频 URL */
  output_url?: string;
  /** 失败信息 */
  error?: { message?: string };
}

// ── 客户端 ────────────────────────────────────────────────

export class VideoClient {
  private client: OpenAI;
  private config: VideoModelConfig;

  constructor(config: VideoModelConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey || FALLBACK_API_KEY,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }

  updateConfig(config: VideoModelConfig): void {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey || FALLBACK_API_KEY,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }

  // ── 创建任务 ──────────────────────────────────────

  private async createTask(
    prompt: string,
    references: VideoReference[],
    options: VideoGenerateOptions = {},
  ): Promise<string> {
    const apiUrl = `${(this.config.baseUrl || "").replace(/\/+$/, "")}/content_generation/tasks`;

    const content: unknown[] = [
      { type: "text", text: prompt },
      ...references.map((r) => ({
        type: r.type,
        [r.type]: { url: r.url },
        role: r.type === "image_url"
          ? "reference_image"
          : r.type === "audio_url"
            ? "reference_audio"
            : "reference_video",
      })),
    ];

    const reqBody = {
      model: options.model || this.config.model,
      content,
      ratio: options.ratio ?? "16:9",
      duration: options.duration ?? 5,
      ...(options.resolution ? { resolution: options.resolution } : {}),
      generate_audio: options.generateAudio ?? false,
      watermark: options.watermark ?? false,
    };

    // 记录实际交给 SDK 的完整业务请求体，便于验证提示词、参考资源和模型参数。
    // reqBody 不包含 Authorization/API Key；通过 l 双写到 Worker 日志文件和应用实时日志。
    l("VideoClient", `最终模型请求（完整参数，无凭据）\n${JSON.stringify({ method: "POST", url: apiUrl, body: reqBody }, null, 2)}`);
    logRequest("VideoClient", "POST", apiUrl, this.config.apiKey, reqBody);
    const startedAt = Date.now();

    try {
      const response = await (this.client as any).content_generation.tasks.create(
        reqBody,
        { signal: options.signal },
      );

      const taskId = response?.id;
      if (!taskId) throw new Error("VideoClient: 未获取到任务 ID");

      logResponse("VideoClient", apiUrl, Date.now() - startedAt, { task_id: taskId, status: response?.status });
      return taskId;
    } catch (err) {
      logFailure("VideoClient", apiUrl, Date.now() - startedAt, err);
      throw err;
    }
  }

  // ── 查询任务状态 ──────────────────────────────────

  private async getTask(taskId: string): Promise<TaskInfo> {
    const apiUrl = `${(this.config.baseUrl || "").replace(/\/+$/, "")}/content_generation/tasks/${taskId}`;

    const response = await (this.client as any).content_generation.tasks.retrieve(taskId);
    return {
      id: response.id,
      status: response.status as TaskStatus,
      output_url: response.output?.video_url,
      error: response.error,
    };
  }

  // ── 轮询等待完成 ──────────────────────────────────

  private async waitForCompletion(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const maxAttempts = 120; // 最多轮询 10 分钟（5s 间隔）
    const pollInterval = 5000;

    for (let i = 0; i < maxAttempts; i++) {
      if (signal?.aborted) throw new Error("VideoClient: 任务已取消");

      const task = await this.getTask(taskId);

      if (task.status === "succeeded") {
        if (!task.output_url) throw new Error("VideoClient: 任务成功但无视频 URL");
        return task.output_url;
      }

      if (task.status === "failed" || task.status === "cancelled") {
        throw new Error(
          `VideoClient: 任务${task.status === "failed" ? "失败" : "已取消"} — ${task.error?.message ?? "未知错误"}`,
        );
      }

      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    }

    throw new Error("VideoClient: 任务超时（超过 10 分钟未完成）");
  }

  // ── 生成视频并下载到本地 ──────────────────────────

  /**
   * 生成视频并下载到本地路径。
   */
  async generate(
    prompt: string,
    references: VideoReference[],
    savePath: string,
    options: VideoGenerateOptions = {},
  ): Promise<VideoGenerateResult> {
    if (!this.config.apiKey) throw new Error("VideoClient: apiKey is not configured");

    const taskId = await this.createTask(prompt, references, options);
    const videoUrl = await this.waitForCompletion(taskId, options.signal);

    await mkdir(dirname(savePath), { recursive: true });
    await downloadFile(videoUrl, savePath, options.signal);

    return { filePath: savePath, model: options.model || this.config.model };
  }
}

// ── 文件下载工具 ───────────────────────────────────────────

async function downloadFile(
  url: string,
  destPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`VideoClient: 下载失败 ${response.status}`);
  }
  if (!response.body) {
    throw new Error("VideoClient: 下载失败，空响应");
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
