/**
 * concat_video handler - 视频拼接
 *
 * 将多个视频文件按顺序拼接为一个输出文件。
 *
 * 输入 (input_json)：
 *   videoPaths: string[]     - 待拼接的视频绝对路径列表（按顺序）
 *   outputPath: string       - 输出文件绝对路径
 *   targetWidth?: number     - 目标宽度（默认 1920）
 *   targetHeight?: number    - 目标高度（默认 1080）
 *   targetFps?: number       - 目标帧率（默认 30）
 *   skipNormalize?: boolean  - 跳过归一化（默认 false，所有视频需参数一致）
 *
 * 输出 (output_json)：
 *   outputPath: string
 *   duration: number         - 成片时长（秒）
 *   normalizedCount: number  - 归一化的视频数量
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname, basename } from "path";
import type { TaskContext } from "../types.js";
import type { FFmpegHelper, ProbeResult } from "../ffmpeg.js";
import { logLine } from "../logger.js";
import { l } from "../utils/utils.js";

/** 拼接任务输入参数 */
interface ConcatVideoInput {
  videoPaths: string[];
  outputPath: string;
  targetWidth?: number;
  targetHeight?: number;
  targetFps?: number;
  skipNormalize?: boolean;
}

/** 拼接任务输出 */
interface ConcatVideoOutput {
  outputPath: string;
  duration: number;
  normalizedCount: number;
}

/**
 * 判断视频是否需要归一化。
 * 任一条件满足即需重编码。
 */
function needsNormalization(
  probe: ProbeResult,
  targetWidth: number,
  targetHeight: number,
  targetFps: number,
): boolean {
  if (probe.width !== targetWidth || probe.height !== targetHeight) return true;
  if (Math.abs(probe.fps - targetFps) > 1) return true;
  if (probe.codec !== "h264") return true;
  if (probe.pixFmt !== "yuv420p") return true;
  if (probe.audioSampleRate !== 44100) return true;
  if (!probe.hasAudio) return true;
  return false;
}

/**
 * concat_video 任务处理器
 */
export async function concatVideoHandler(ctx: TaskContext): Promise<string> {
  const input = ctx.taskInput as ConcatVideoInput;
  const ffmpeg: FFmpegHelper = ctx.ffmpeg;

  // 校验
  if (!input.videoPaths || input.videoPaths.length === 0) {
    throw new Error("视频列表为空");
  }
  if (!input.outputPath) {
    throw new Error("输出路径为空");
  }

  const targetWidth = input.targetWidth ?? 1920;
  const targetHeight = input.targetHeight ?? 1080;
  const targetFps = input.targetFps ?? 30;
  const skipNormalize = input.skipNormalize ?? false;

  l("concat_video", `开始拼接 ${input.videoPaths.length} 个视频 → ${input.outputPath}`);

  // 确保输出目录存在
  mkdirSync(dirname(input.outputPath), { recursive: true });

  // 归一化缓存目录
  const cacheDir = join(dirname(input.outputPath), "_normalized");
  mkdirSync(cacheDir, { recursive: true });

  // 第一步：逐个探测视频属性
  const probes: Array<{ path: string; info: ProbeResult }> = [];
  for (const vp of input.videoPaths) {
    if (!existsSync(vp)) {
      throw new Error(`视频文件不存在：${vp}`);
    }
    ctx.emit({
      type: "task_progress",
      taskId: ctx.taskId,
      progress: probes.length / input.videoPaths.length * 0.3,
      message: `探测中 ${probes.length + 1}/${input.videoPaths.length}`,
    });
    const info = await ffmpeg.probe(vp);
    probes.push({ path: vp, info });
    logLine("concat_video", "DEBUG", `${basename(vp)}: ${info.width}x${info.height} ${info.fps}fps ${info.codec} ${info.pixFmt} audio=${info.hasAudio}`);
  }

  // 第二步：归一化（如需要）
  const finalPaths: string[] = [];
  let normalizedCount = 0;

  if (skipNormalize) {
    // 跳过归一化，直接使用原始路径
    for (const p of probes) {
      finalPaths.push(p.path);
    }
    l("concat_video", "跳过归一化（skipNormalize=true）");
  } else {
    for (let i = 0; i < probes.length; i++) {
      ctx.signal.throwIfAborted();
      const { path, info } = probes[i];
      ctx.emit({
        type: "task_progress",
        taskId: ctx.taskId,
        progress: 0.3 + (i / probes.length) * 0.4,
        message: `处理中 ${i + 1}/${probes.length}`,
      });

      if (!needsNormalization(info, targetWidth, targetHeight, targetFps)) {
        // 参数一致，直接使用原文件
        finalPaths.push(path);
        logLine("concat_video", "DEBUG", `${basename(path)}: 参数一致，跳过归一化`);
        continue;
      }

      // 需要归一化
      const normPath = join(cacheDir, `${i}_${basename(path)}`);
      const normArgs = buildNormalizeArgs(path, normPath, targetWidth, targetHeight, targetFps, info.hasAudio);

      l("concat_video", `归一化 ${basename(path)} → ${basename(normPath)}`);
      const result = await ffmpeg.execFFmpeg(normArgs, ctx.signal);
      if (result.exitCode !== 0) {
        throw new Error(`归一化失败：${basename(path)}\n${result.stderr.slice(-500)}`);
      }

      finalPaths.push(normPath);
      normalizedCount++;
    }
    l("concat_video", `归一化完成：${normalizedCount}/${probes.length} 个视频已重编码`);
  }

  // 第三步：生成 concat 清单
  ctx.signal.throwIfAborted();
  const concatListPath = join(dirname(input.outputPath), "_concat_list.txt");
  const concatContent = finalPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  writeFileSync(concatListPath, concatContent, "utf-8");

  // 第四步：执行拼接
  ctx.signal.throwIfAborted();
  ctx.emit({
    type: "task_progress",
    taskId: ctx.taskId,
    progress: 0.8,
    message: "合成中…",
  });

  // 如果所有视频已归一化（参数统一），可以用 -c copy 加速
  // 否则需要重编码
  const allNormalized = normalizedCount === probes.length || skipNormalize;
  const concatArgs: string[] = [
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
  ];

  if (allNormalized && !skipNormalize) {
    // 所有视频已归一化到统一参数，直接 copy
    concatArgs.push("-c", "copy");
  } else if (skipNormalize) {
    // 用户选择跳过归一化，尝试 copy（可能失败）
    concatArgs.push("-c", "copy");
  } else {
    // 部分归一化，需要重编码统一
    concatArgs.push(
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
    );
  }

  concatArgs.push("-y", input.outputPath);

  l("concat_video", `执行拼接：ffmpeg ${concatArgs.join(" ")}`);
  const concatResult = await ffmpeg.execFFmpeg(concatArgs, ctx.signal);
  if (concatResult.exitCode !== 0) {
    throw new Error(`FFmpeg 拼接失败：\n${concatResult.stderr.slice(-500)}`);
  }

  // 第五步：探测输出文件时长
  ctx.signal.throwIfAborted();
  const outputProbe = await ffmpeg.probe(input.outputPath);

  // 清理临时文件
  try {
    unlinkSync(concatListPath);
  } catch {
    // 忽略
  }

  const output: ConcatVideoOutput = {
    outputPath: input.outputPath,
    duration: outputProbe.duration,
    normalizedCount,
  };

  l("concat_video", `拼接完成：${output.duration}s，归一化 ${normalizedCount} 个视频`);
  ctx.emit({
    type: "task_progress",
    taskId: ctx.taskId,
    progress: 1,
    message: "完成",
  });

  return JSON.stringify(output);
}

/**
 * 构建归一化 FFmpeg 参数
 */
function buildNormalizeArgs(
  inputPath: string,
  outputPath: string,
  width: number,
  height: number,
  fps: number,
  hasAudio: boolean,
): string[] {
  const args = [
    "-i", inputPath,
    "-s", `${width}x${height}`,
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
  ];

  if (hasAudio) {
    args.push("-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k");
  } else {
    // 补齐静音音轨
    args.push(
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest",
      "-c:a", "aac", "-b:a", "192k",
    );
  }

  args.push("-y", outputPath);
  return args;
}
