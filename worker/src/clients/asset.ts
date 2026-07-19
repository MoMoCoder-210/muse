/**
 * 素材管理客户端：对接火山方舟 Files API。
 */
import { readFile } from "fs/promises";
import { basename, extname } from "path";
import type { AssetModelConfig } from "../config/defaults.js";
import { logRequest, logResponse, logFailure } from "../utils/client-logger.js";

const ARK_FILES_API_URL = "https://ark.cn-beijing.volces.com/api/v3/files";

/** 上传后方舟返回的文件对象。 */
export interface ArkFileObject {
  id: string;
  object: "file";
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
}

function toLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function abortedUploadError(): Error {
  return new Error("方舟文件上传已取消");
}

/** 实例级 FIFO 信号量，所有 Ark Files POST 共享同一并发预算。 */
class AsyncSemaphore {
  private active = 0;
  private maxConcurrent: number;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = toLimit(maxConcurrent);
  }

  setMaxConcurrent(maxConcurrent: number): void {
    this.maxConcurrent = toLimit(maxConcurrent);
    this.drain();
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortedUploadError();

    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortedUploadError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(waiter);
      });
    } else {
      this.active += 1;
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
    if (signal?.aborted) {
      release();
      throw abortedUploadError();
    }
    return release;
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      this.active += 1;
      this.waiters.shift()?.();
    }
  }
}

export class AssetClient {
  private config: AssetModelConfig;
  private readonly uploadSemaphore: AsyncSemaphore;
  /** 当前 Worker 中正在使用某个 Ark 文件的并发视频任务数。 */
  private readonly referenceFileUsers = new Map<string, number>();

  constructor(config: AssetModelConfig, uploadConcurrency: number) {
    this.config = config;
    this.uploadSemaphore = new AsyncSemaphore(uploadConcurrency);
  }

  updateConfig(config: AssetModelConfig, uploadConcurrency: number): void {
    this.config = config;
    this.uploadSemaphore.setMaxConcurrent(uploadConcurrency);
  }

  /** 标记当前视频任务正在引用此 Ark 文件。 */
  retainReferenceFile(fileId: string): void {
    this.referenceFileUsers.set(fileId, (this.referenceFileUsers.get(fileId) ?? 0) + 1);
  }

  /**
   * 释放当前视频任务对 Ark 文件的引用；返回 true 表示调用方是最后一个使用者，
   * 可以安全删除远端文件并清除本地缓存。
   */
  releaseReferenceFile(fileId: string): boolean {
    const remaining = (this.referenceFileUsers.get(fileId) ?? 1) - 1;
    if (remaining > 0) {
      this.referenceFileUsers.set(fileId, remaining);
      return false;
    }
    this.referenceFileUsers.delete(fileId);
    return true;
  }

  /** 上传本地图片到方舟平台，返回 file_id。 */
  async uploadImage(
    filePath: string,
    purpose: string = "user_data",
    signal?: AbortSignal,
  ): Promise<ArkFileObject> {
    if (!this.config.apiKey) {
      throw new Error("AssetClient: apiKey is not configured");
    }

    const release = await this.uploadSemaphore.acquire(signal);
    try {
      if (signal?.aborted) throw abortedUploadError();
      const fileBuffer = await readFile(filePath);
      if (signal?.aborted) throw abortedUploadError();

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
      const boundary = `----MuseUpload${Date.now()}`;
      const parts: Buffer[] = [
        Buffer.from(
          `--${boundary}\r\n`
            + `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
            + `Content-Type: ${mimeType}\r\n\r\n`,
        ),
        fileBuffer,
        Buffer.from("\r\n"),
        Buffer.from(
          `--${boundary}\r\n`
            + `Content-Disposition: form-data; name="purpose"\r\n\r\n`
            + `${purpose}\r\n`,
        ),
        Buffer.from(`--${boundary}--\r\n`),
      ];
      const body = Buffer.concat(parts);
      const url = ARK_FILES_API_URL;
      logRequest("AssetClient", "POST", url, this.config.apiKey, {
        purpose,
        fileName,
        mimeType,
        size: fileBuffer.byteLength,
      });
      const startedAt = Date.now();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
            : AbortSignal.timeout(this.config.timeoutMs),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`AssetClient: upload failed ${response.status} ${response.statusText} — ${text}`);
        }
        const result = (await response.json()) as ArkFileObject;
        logResponse("AssetClient", url, Date.now() - startedAt, {
          id: result.id,
          filename: result.filename,
          bytes: result.bytes,
        });
        return result;
      } catch (err) {
        logFailure("AssetClient", url, Date.now() - startedAt, err);
        throw err;
      }
    } finally {
      release();
    }
  }

  /** 批量上传并保持输入顺序；实际并发由共享上传信号量限制。 */
  uploadImages(
    filePaths: string[],
    purpose: string = "user_data",
    signal?: AbortSignal,
  ): Promise<ArkFileObject[]> {
    return Promise.all(filePaths.map((filePath) => this.uploadImage(filePath, purpose, signal)));
  }

  /** 从方舟平台删除文件。 */
  async deleteFile(fileId: string): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error("AssetClient: apiKey is not configured");
    }
    const url = `${ARK_FILES_API_URL}/${encodeURIComponent(fileId)}`;
    logRequest("AssetClient", "DELETE", url, this.config.apiKey, { fileId });
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`AssetClient: delete failed ${response.status} ${response.statusText} — ${text}`);
      }
      logResponse("AssetClient", url, Date.now() - startedAt, { deleted: fileId });
    } catch (err) {
      logFailure("AssetClient", url, Date.now() - startedAt, err);
      throw err;
    }
  }
}
