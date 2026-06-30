/**
 * RateLimiter - 基于 Token Bucket 的 API 限流器
 * 基于模块 08 第 7.5 节 "API 限流与重试策略"
 *
 * 每个 apiType 独立维护一个 token bucket：
 * - text:    5 QPS,  2 并发上限
 * - image:   1 QPS,  3 并发上限
 * - voice:   1 QPS,  2 并发上限
 * - video:   0.2 QPS (每 5s 一个 token), 1 并发上限
 * - local:   无 QPS 限制, 2 并发上限
 */

import type { ApiType } from "./types.js";

interface TokenBucket {
  capacity: number;       // 桶容量（QPS * 1s 的 token 数）
  tokens: number;         // 当前 token 数
  refillRate: number;     // 每秒补充 token 数
  lastRefillTime: number; // 上次补充时间戳 (ms)
  maxConcurrency: number; // 最大并发数
  activeCount: number;    // 当前活跃数
  paused: boolean;        // 是否被暂停（配额耗尽）
  backoffUntil: number;   // 429 退避截止时间戳 (ms)
}

const BUCKET_CONFIG: Record<ApiType, Omit<TokenBucket, "tokens" | "lastRefillTime" | "activeCount" | "paused" | "backoffUntil">> = {
  text:  { capacity: 5,   refillRate: 5,   maxConcurrency: 2 },
  image: { capacity: 3,   refillRate: 1,   maxConcurrency: 3 },
  voice: { capacity: 3,   refillRate: 1,   maxConcurrency: 2 },
  video: { capacity: 1,   refillRate: 0.2, maxConcurrency: 1 },
  local: { capacity: 100, refillRate: 100, maxConcurrency: 2 },
};

export class RateLimiterImpl {
  private buckets: Map<ApiType, TokenBucket> = new Map();
  private backoffAttempts: Map<ApiType, number> = new Map();

  constructor() {
    for (const [apiType, config] of Object.entries(BUCKET_CONFIG)) {
      this.buckets.set(apiType as ApiType, {
        ...config,
        tokens: config.capacity,
        lastRefillTime: Date.now(),
        activeCount: 0,
        paused: false,
        backoffUntil: 0,
      });
    }
  }

  /**
   * 补充 token（懒补充方式）
   */
  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefillTime) / 1000;
    const refilled = elapsed * bucket.refillRate;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refilled);
    bucket.lastRefillTime = now;
  }

  /**
   * 检查是否可以获取令牌（不实际获取）
   */
  canAcquire(apiType: ApiType): boolean {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return false;
    if (bucket.paused) return false;
    if (Date.now() < bucket.backoffUntil) return false;
    if (bucket.activeCount >= bucket.maxConcurrency) return false;
    this.refill(bucket);
    return bucket.tokens >= 1;
  }

  /**
   * 获取令牌
   */
  acquire(apiType: ApiType): boolean {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return false;
    if (bucket.paused) return false;
    if (Date.now() < bucket.backoffUntil) return false;
    if (bucket.activeCount >= bucket.maxConcurrency) return false;
    this.refill(bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    bucket.activeCount += 1;
    return true;
  }

  /**
   * 释放令牌
   */
  release(apiType: ApiType): void {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return;
    bucket.activeCount = Math.max(0, bucket.activeCount - 1);
  }

  /**
   * 获取当前活跃数
   */
  getActiveCount(apiType: ApiType): number {
    return this.buckets.get(apiType)?.activeCount ?? 0;
  }

  /**
   * 报告 429 限流，触发指数退避
   * 退避策略：5±2s → 15±5s → 30±10s
   */
  reportRateLimit(apiType: ApiType): void {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return;
    const attempts = (this.backoffAttempts.get(apiType) ?? 0) + 1;
    this.backoffAttempts.set(apiType, attempts);

    const baseBackoff = [5000, 15000, 30000][Math.min(attempts - 1, 2)];
    const jitter = (Math.random() - 0.5) * 2 * [2000, 5000, 10000][Math.min(attempts - 1, 2)];
    const backoffMs = Math.round(baseBackoff + jitter);

    bucket.backoffUntil = Date.now() + backoffMs;
    console.warn(`[RateLimiter] ${apiType} rate limited, backoff ${backoffMs}ms (attempt ${attempts})`);
  }

  /**
   * 报告配额耗尽，暂停该 API 类型
   */
  reportQuotaExhausted(apiType: ApiType): void {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return;
    bucket.paused = true;
    console.error(`[RateLimiter] ${apiType} quota exhausted, paused`);
  }

  /**
   * 恢复被暂停的 API 类型
   */
  resume(apiType: ApiType): void {
    const bucket = this.buckets.get(apiType);
    if (!bucket) return;
    bucket.paused = false;
    bucket.backoffUntil = 0;
    this.backoffAttempts.set(apiType, 0);
    console.info(`[RateLimiter] ${apiType} resumed`);
  }

  /**
   * 停止所有 bucket（优雅退出时调用）
   */
  stopAll(): void {
    for (const bucket of this.buckets.values()) {
      bucket.paused = true;
      bucket.activeCount = 0;
    }
  }
}
