/**
 * RateLimiter - 基于 Token Bucket 的 API 限流器
 * 基于模块 08 第 7.5 节 "API 限流与重试策略"
 *
 * 文本、生图和视频的最大并发由 default-settings.json 的 concurrency
 * 统一配置；语音与本地任务保持各自既有的独立限制。
 */

import type { ApiType } from "./types.js";
import type { ConcurrencySettings } from "./config/defaults.js";
import { logLine } from "./logger.js";

interface TokenBucket {
  capacity: number;
  tokens: number;
  refillRate: number;
  lastRefillTime: number;
  maxConcurrency: number;
  activeCount: number;
  paused: boolean;
  backoffUntil: number;
}

type ApiConcurrencySettings = Pick<ConcurrencySettings, "text" | "image" | "video">;
type BucketRateConfig = Pick<TokenBucket, "capacity" | "refillRate">;

const BUCKET_RATE_CONFIG: Record<ApiType, BucketRateConfig> = {
  text: { capacity: 5, refillRate: 5 },
  image: { capacity: 3, refillRate: 1 },
  voice: { capacity: 3, refillRate: 1 },
  video: { capacity: 1, refillRate: 0.2 },
  local: { capacity: 100, refillRate: 100 },
};

const STATIC_CONCURRENCY: Pick<Record<ApiType, number>, "voice" | "local"> = {
  voice: 2,
  local: 2,
};

function toConcurrencyLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function createBucketConfig(
  apiType: ApiType,
  maxConcurrency: number,
): Omit<TokenBucket, "tokens" | "lastRefillTime" | "activeCount" | "paused" | "backoffUntil"> {
  const rate = BUCKET_RATE_CONFIG[apiType];
  return {
    ...rate,
    // 初始令牌至少覆盖并发上限，避免第二个视频任务还要等待一次补充。
    capacity: Math.max(rate.capacity, maxConcurrency),
    maxConcurrency,
  };
}

export class RateLimiterImpl {
  private buckets: Map<ApiType, TokenBucket> = new Map();
  private backoffAttempts: Map<ApiType, number> = new Map();

  constructor(concurrency: ApiConcurrencySettings) {
    const configuredConcurrency: Record<ApiType, number> = {
      text: toConcurrencyLimit(concurrency.text),
      image: toConcurrencyLimit(concurrency.image),
      video: toConcurrencyLimit(concurrency.video),
      ...STATIC_CONCURRENCY,
    };

    for (const apiType of Object.keys(BUCKET_RATE_CONFIG) as ApiType[]) {
      const config = createBucketConfig(apiType, configuredConcurrency[apiType]);
      this.buckets.set(apiType, {
        ...config,
        tokens: config.capacity,
        lastRefillTime: Date.now(),
        activeCount: 0,
        paused: false,
        backoffUntil: 0,
      });
    }
  }

  /** 热更新模型任务并发，不重建 bucket，保留运行计数与退避状态。 */
  configure(concurrency: ApiConcurrencySettings): void {
    for (const apiType of ["text", "image", "video"] as const) {
      const bucket = this.buckets.get(apiType);
      if (!bucket) continue;

      const maxConcurrency = toConcurrencyLimit(concurrency[apiType]);
      const rate = BUCKET_RATE_CONFIG[apiType];
      bucket.maxConcurrency = maxConcurrency;
      bucket.capacity = Math.max(rate.capacity, maxConcurrency);
      bucket.tokens = Math.min(bucket.tokens, bucket.capacity);
    }
  }

  /** 补充 token（懒补充方式）。 */
  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefillTime) / 1000;
    const refilled = elapsed * bucket.refillRate;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refilled);
    bucket.lastRefillTime = now;
  }

  /** 检查是否可以获取令牌（不实际获取）。 */
  canAcquire(apiType: ApiType): boolean {
    const bucket = this.buckets.get(apiType);
    if (!bucket || bucket.paused || Date.now() < bucket.backoffUntil) return false;
    if (bucket.activeCount >= bucket.maxConcurrency) return false;
    this.refill(bucket);
    return bucket.tokens >= 1;
  }

  /** 获取令牌。 */
  acquire(apiType: ApiType): boolean {
    const bucket = this.buckets.get(apiType);
    if (!bucket || bucket.paused || Date.now() < bucket.backoffUntil) return false;
    if (bucket.activeCount >= bucket.maxConcurrency) return false;
    this.refill(bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    bucket.activeCount += 1;
    return true;
  }

  /** 释放令牌。 */
  release(apiType: ApiType): void {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return;
    bucket.activeCount = Math.max(0, bucket.activeCount - 1);
  }

  /** 获取当前活跃数。 */
  getActiveCount(apiType: ApiType): number {
    return this.buckets.get(apiType)?.activeCount ?? 0;
  }

  /** 报告 429 限流，触发指数退避。 */
  reportRateLimit(apiType: ApiType): void {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return;
    const attempts = (this.backoffAttempts.get(apiType) ?? 0) + 1;
    this.backoffAttempts.set(apiType, attempts);
    const baseBackoff = [5000, 15000, 30000][Math.min(attempts - 1, 2)];
    const jitter = (Math.random() - 0.5) * 2 * [2000, 5000, 10000][Math.min(attempts - 1, 2)];
    const backoffMs = Math.round(baseBackoff + jitter);
    bucket.backoffUntil = Date.now() + backoffMs;
    logLine("限流", "WARN", `${apiType} 触发限流退避 ${backoffMs}ms（第 ${attempts} 次）`);
  }

  /** 报告配额耗尽，暂停该 API 类型。 */
  reportQuotaExhausted(apiType: ApiType): void {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return;
    bucket.paused = true;
    logLine("限流", "ERROR", `${apiType} 配额耗尽，已暂停`);
  }

  /** 恢复被暂停的 API 类型。 */
  resume(apiType: ApiType): void {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return;
    bucket.paused = false;
    bucket.backoffUntil = 0;
    this.backoffAttempts.set(apiType, 0);
    logLine("限流", "INFO", `${apiType} 已恢复`);
  }

  /** 停止所有 bucket（优雅退出时调用）。 */
  stopAll(): void {
    for (const bucket of this.buckets.values()) {
      bucket.paused = true;
      bucket.activeCount = 0;
    }
  }
}
