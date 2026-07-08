/**
 * FFmpegHelper - 封装 FFmpeg/FFprobe 子进程调用
 *
 * 职责：
 * 1. 检测 FFmpeg/FFprobe 是否可用（执行 -version 并解析版本）
 * 2. 执行 FFmpeg 命令（支持 AbortSignal 取消 + 超时）
 * 3. 探测媒体文件属性（时长、分辨率、编码、帧率等）
 *
 * @author yt @date 20260708
 */

import { spawn } from "child_process";
import { l, lw } from "./utils/utils.js";

// ===== 类型定义 =====

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProbeResult {
  /** 时长（秒），保留 2 位小数 */
  duration: number;
  /** 视频宽度（像素） */
  width: number;
  /** 视频高度（像素） */
  height: number;
  /** 视频编码，如 "h264" */
  codec: string;
  /** 帧率，如 30 */
  fps: number;
  /** 像素格式，如 "yuv420p" */
  pixFmt: string;
  /** 音频编码，如 "aac" */
  audioCodec?: string;
  /** 音频采样率，如 44100 */
  audioSampleRate?: number;
  /** 是否包含音频流 */
  hasAudio: boolean;
}

export interface FFmpegInfo {
  ffmpegVersion: string;
  ffprobeVersion: string;
  ffmpegPath: string;
  ffprobePath: string;
}

// ===== 常量 =====

/** FFprobe 探测超时（10 秒） */
const PROBE_TIMEOUT_MS = 10_000;
/** FFmpeg 命令默认超时（10 分钟） */
const EXEC_TIMEOUT_MS = 10 * 60_000;

// ===== FFmpegHelper 类 =====

export class FFmpegHelper {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  private ffmpegVersion: string = "";
  private ffprobeVersion: string = "";

  constructor(ffmpegPath: string, ffprobePath: string) {
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
  }

  /**
   * 检测 FFmpeg/FFprobe 是否可用。
   * 执行 -version 并解析版本号，成功返回实例，失败返回 null。
   *
   * @author yt @date 20260708
   */
  static async detect(ffmpegPath: string, ffprobePath: string): Promise<FFmpegHelper | null> {
    const helper = new FFmpegHelper(ffmpegPath, ffprobePath);
    try {
      const ffmpegResult = await helper.exec([ffmpegPath, "-version"], PROBE_TIMEOUT_MS);
      if (ffmpegResult.exitCode !== 0) {
        lw("FFmpeg", `ffmpeg -version 退出码 ${ffmpegResult.exitCode}`);
        return null;
      }
      helper.ffmpegVersion = parseVersion(ffmpegResult.stdout);

      const ffprobeResult = await helper.exec([ffprobePath, "-version"], PROBE_TIMEOUT_MS);
      if (ffprobeResult.exitCode !== 0) {
        lw("FFmpeg", `ffprobe -version 退出码 ${ffprobeResult.exitCode}`);
        return null;
      }
      helper.ffprobeVersion = parseVersion(ffprobeResult.stdout);

      l("FFmpeg", `检测到 ffmpeg=${helper.ffmpegVersion} ffprobe=${helper.ffprobeVersion}`);
      return helper;
    } catch (err) {
      lw("FFmpeg", `检测失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 获取版本信息 */
  getInfo(): FFmpegInfo {
    return {
      ffmpegVersion: this.ffmpegVersion,
      ffprobeVersion: this.ffprobeVersion,
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
    };
  }

  /**
   * 执行 ffmpeg 命令。
   *
   * @param args - ffmpeg 参数（不含可执行文件路径）
   * @param signal - 可选的取消信号
   * @param timeoutMs - 超时毫秒数（默认 10 分钟）
   *
   * @author yt @date 20260708
   */
  async execFFmpeg(
    args: string[],
    signal?: AbortSignal,
    timeoutMs: number = EXEC_TIMEOUT_MS,
  ): Promise<ExecResult> {
    return this.runProcess(this.ffmpegPath, args, signal, timeoutMs);
  }

  /**
   * 探测媒体文件属性。
   *
   * 使用 ffprobe 以 JSON 格式输出流信息，解析为 ProbeResult。
   *
   * @param filePath - 媒体文件绝对路径
   *
   * @author yt @date 20260708
   */
  async probe(filePath: string): Promise<ProbeResult> {
    const args = [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      "-i", filePath,
    ];

    const result = await this.runProcess(this.ffprobePath, args, undefined, PROBE_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new Error(`ffprobe 探测失败（exit=${result.exitCode}）：${result.stderr || filePath}`);
    }

    let json: FFprobeJSON;
    try {
      json = JSON.parse(result.stdout) as FFprobeJSON;
    } catch {
      throw new Error(`ffprobe 输出解析失败：${result.stdout.slice(0, 200)}`);
    }

    return parseProbeJSON(json);
  }

  /**
   * 获取音频/视频时长（秒），保留 2 位小数。
   *
   * 轻量版探测，只返回时长，用于语音导入等只需时长的场景。
   *
   * @author yt @date 20260708
   */
  async probeDuration(filePath: string): Promise<number> {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      "-i", filePath,
    ];

    const result = await this.runProcess(this.ffprobePath, args, undefined, PROBE_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new Error(`ffprobe 时长探测失败（exit=${result.exitCode}）：${result.stderr || filePath}`);
    }

    const duration = parseFloat(result.stdout.trim());
    if (isNaN(duration) || duration <= 0) {
      throw new Error(`ffprobe 时长解析失败：${result.stdout.trim()}`);
    }

    return Math.round(duration * 100) / 100;
  }

  // ===== 内部方法 =====

  /**
   * 执行子进程，收集 stdout/stderr，支持取消和超时。
   *
   * @author yt @date 20260708
   */
  private runProcess(
    cmd: string,
    args: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const settle = (result: ExecResult | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };

      // 超时
      const timer = timeoutMs
        ? setTimeout(() => {
            child.kill("SIGTERM");
            // Windows 上 SIGTERM 不一定生效，用 taskkill 兜底
            if (process.platform === "win32" && child.pid) {
              try {
                spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                  windowsHide: true,
                  stdio: "ignore",
                });
              } catch {
                // 忽略
              }
            }
            settle(new Error(`${cmd} 执行超时（${timeoutMs}ms）`));
          }, timeoutMs)
        : undefined;

      // 取消
      if (signal) {
        const onAbort = () => {
          child.kill("SIGTERM");
          if (process.platform === "win32" && child.pid) {
            try {
              spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                windowsHide: true,
                stdio: "ignore",
              });
            } catch {
              // 忽略
            }
          }
          settle(new Error(`${cmd} 被取消`));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (err) => settle(err));
      child.on("close", (code) => {
        settle({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }

  /**
   * 执行原始命令（内部用，检测版本时使用完整命令路径）
   */
  private exec(cmdWithArgs: string[], timeoutMs: number): Promise<ExecResult> {
    const [cmd, ...args] = cmdWithArgs;
    return this.runProcess(cmd, args, undefined, timeoutMs);
  }
}

// ===== 辅助函数 =====

/** 从 ffmpeg -version 输出解析版本号，如 "7.1" */
function parseVersion(output: string): string {
  // 格式：ffmpeg version 7.1-essentials_build-www.gyan.dev
  // 或：ffmpeg version n7.1-...
  const match = output.match(/version\s+n?(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : "unknown";
}

// ===== ffprobe JSON 输出类型 =====

interface FFprobeJSON {
  streams?: FFprobeStream[];
  format?: {
    duration?: string;
    format_name?: string;
  };
}

interface FFprobeStream {
  codec_type: "video" | "audio" | "subtitle" | "data";
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;    // 如 "30/1"
  avg_frame_rate?: string;  // 如 "30000/1001"
  sample_rate?: string;
  duration?: string;
}

/**
 * 解析 ffprobe JSON 输出为 ProbeResult
 *
 * @author yt @date 20260708
 */
function parseProbeJSON(json: FFprobeJSON): ProbeResult {
  const videoStream = json.streams?.find((s) => s.codec_type === "video");
  const audioStream = json.streams?.find((s) => s.codec_type === "audio");

  // 时长：优先 stream 级别，回退 format 级别
  let duration = 0;
  if (videoStream?.duration) {
    duration = parseFloat(videoStream.duration);
  } else if (json.format?.duration) {
    duration = parseFloat(json.format.duration);
  }
  if (isNaN(duration)) duration = 0;

  // 帧率：解析 "num/den" 格式
  let fps = 0;
  const frameRate = videoStream?.avg_frame_rate || videoStream?.r_frame_rate || "0/1";
  if (frameRate.includes("/")) {
    const [num, den] = frameRate.split("/").map(Number);
    fps = den ? Math.round((num / den) * 100) / 100 : 0;
  } else {
    fps = parseFloat(frameRate) || 0;
  }

  return {
    duration: Math.round(duration * 100) / 100,
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    codec: videoStream?.codec_name ?? "unknown",
    fps,
    pixFmt: videoStream?.pix_fmt ?? "unknown",
    audioCodec: audioStream?.codec_name,
    audioSampleRate: audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : undefined,
    hasAudio: !!audioStream,
  };
}
