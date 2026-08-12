import { mkdir, rename, rm } from "fs/promises";
import { basename, dirname, join } from "path";
import { randomUUID } from "crypto";
import type { FFmpegHelper } from "./ffmpeg.js";

/** 返回图片对应的缩略图路径，与 Tauri 侧保持一致。 */
export function imageThumbnailPath(imagePath: string): string {
  return join(dirname(imagePath), "thumbnails", `${basename(imagePath)}.jpg`);
}

/** 使用内置 FFmpeg 生成图片缩略图。 */
export async function generateImageThumbnail(
  ffmpeg: FFmpegHelper,
  imagePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const outputPath = imageThumbnailPath(imagePath);
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });

  const temporaryPath = join(
    outputDir,
    `.${basename(outputPath)}.tmp-${randomUUID()}.jpg`,
  );

  try {
    await ffmpeg.createImageThumbnail(imagePath, temporaryPath, signal);
    await rm(outputPath, { force: true });
    await rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
