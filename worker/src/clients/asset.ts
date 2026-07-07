/**
 * 素材管理客户端
 *
 * 对接火山方舟 File API（OpenAI 兼容），将本地图片上传至方舟平台，
 * 返回 file_id 供 Seedance 2.0 视频生成时作为参考图引用。
 *
 * @author yt @date 20260707
 */

import { readFile } from "fs/promises";
import { basename, extname } from "path";
import type { AssetModelConfig } from "../config/defaults.js";

/** 上传后方舟返回的文件对象 */
export interface ArkFileObject {
  id: string;
  object: "file";
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
}

export class AssetClient {
  private config: AssetModelConfig;

  constructor(config: AssetModelConfig) {
    this.config = config;
  }

  updateConfig(config: AssetModelConfig): void {
    this.config = config;
  }

  /**
   * 上传本地图片到方舟平台，返回 file_id。
   *
   * @param filePath 本地图片绝对路径
   * @param purpose  上传用途，默认 "user_data"（方舟平台接受 user_data 或 agent）
   */
  async uploadImage(
    filePath: string,
    purpose: string = "user_data",
  ): Promise<ArkFileObject> {
    if (!this.config.apiKey) {
      throw new Error("AssetClient: apiKey is not configured");
    }
    if (!this.config.baseUrl) {
      throw new Error("AssetClient: baseUrl is not configured");
    }

    const fileBuffer = await readFile(filePath);
    const fileName = basename(filePath);
    const ext = extname(filePath).toLowerCase().replace(".", "");
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
    };
    const mimeType = mimeMap[ext] ?? "application/octet-stream";

    // 构建 multipart/form-data
    const boundary = `----MuseUpload${Date.now()}`;
    const parts: Buffer[] = [];

    // file 字段
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
          `Content-Type: ${mimeType}\r\n\r\n`,
      ),
      fileBuffer,
      Buffer.from("\r\n"),
    );

    // purpose 字段
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
          `${purpose}\r\n`,
      ),
    );

    // 结束边界
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/v3/files`;

    console.log("[AssetClient] 上传文件:", fileName, "→", url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `AssetClient: upload failed ${response.status} ${response.statusText} — ${text}`,
      );
    }

    const result = (await response.json()) as ArkFileObject;
    console.log("[AssetClient] 上传成功:", result.id, result.filename);
    return result;
  }

  /**
   * 批量上传多张本地图片，返回 file_id 列表（保持传入顺序）。
   */
  async uploadImages(
    filePaths: string[],
    purpose: string = "user_data",
  ): Promise<ArkFileObject[]> {
    const results: ArkFileObject[] = [];
    for (const filePath of filePaths) {
      const obj = await this.uploadImage(filePath, purpose);
      results.push(obj);
    }
    return results;
  }

  /**
   * 从方舟平台删除文件。
   *
   * @param fileId 方舟平台返回的 file_id（如 "file-xxx"）
   */
  async deleteFile(fileId: string): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error("AssetClient: apiKey is not configured");
    }
    if (!this.config.baseUrl) {
      throw new Error("AssetClient: baseUrl is not configured");
    }

    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/v3/files/${encodeURIComponent(fileId)}`;

    console.log("[AssetClient] 删除文件:", fileId, "→", url);

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `AssetClient: delete failed ${response.status} ${response.statusText} — ${text}`,
      );
    }

    console.log("[AssetClient] 删除成功:", fileId);
  }
}
