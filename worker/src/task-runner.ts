/**
 * TaskRunner - 任务执行核心循环
 * 基于模块 08 第 3.2 节 "worker 设计"
 *
 * 核心循环：
 * 1. 每 STALE_CHECK_INTERVAL 轮恢复超时 running 任务（防丢失）
 * 2. 查询 pending 任务（LIMIT 20）+ lockKey 未被占用
 * 3. 对每条 Task：尝试获锁 → 获令牌 → 标记 running → 分发 handler
 * 4. handler 完成/超时/失败 → 回写结果 + 释放资源
 * 5. 失败且可重试 + retry_count < max_retry → 回退 pending
 * 6. 收到 wakeup 信号时跳过休眠，立即进入下一轮
 *
 * @author yt @date 20260702
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { TaskEvent, TaskType, ApiType, TaskContext, RateLimiter } from "./types.js";
import { TASK_TYPE_TO_API } from "./types.js";
import type { ApiClients } from "./clients/index.js";
import {
  getPendingTasks,
  acquireLock,
  releaseLock,
  markTaskRunning,
  markTaskSuccess,
  markTaskFailed,
  getWaitingRemoteTasks,
  getRunningTaskCount,
  recoverStaleTasks,
  recoverEntityStatusOnFinalFail,
  transitionEntityStatus,
  type PendingTask,
} from "./db.js";
import { logLine } from "./logger.js";
import { PROTOCOL_VERSION } from "./types.js";

// 调度日志双写：磁盘文件 + stdout 转发到 Rust
function log(source: string, level: "INFO" | "WARN" | "ERROR", message: string): void {
  logLine(source, level, message);
  const lv = level.toLowerCase();
  process.stdout.write(JSON.stringify({ version: PROTOCOL_VERSION, msg: "log", level: lv, message: `[${source}] ${message}` }) + "\n");
}

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 10000;
/** 每隔多少轮轮询执行一次超时任务恢复检查 */
const STALE_CHECK_INTERVAL = 30;
/** running 任务超时阈值（5 分钟） */
const STALE_TASK_TIMEOUT_MS = 5 * 60 * 1000;
/** 单个任务 handler 执行超时（10 分钟，LLM 长输出场景兜底） */
const TASK_HANDLER_TIMEOUT_MS = 10 * 60 * 1000;

/** 可重试的错误关键词 */
const RETRYABLE_KEYWORDS = ["timeout", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "socket hang up", "fetch failed"];

interface RetryableError extends Error {
  status?: number;
  code?: string;
  message: string;
}

export class TaskRunner {
  private db: DatabaseType;
  private workerId: string;
  private rateLimiter: RateLimiter;
  private emit: (event: TaskEvent) => void;
  private clients?: ApiClients;
  private ffmpeg: import("./ffmpeg.js").FFmpegHelper;
  private running = false;
  private abortController: AbortController;
  private handlers: Map<TaskType, (ctx: TaskContext) => Promise<string>> = new Map();
  private onHeartbeat: ((activeCount: number) => void) | null = null;
  /** wakeup 标志：收到 enqueue 通知时置 true，sleep 中提前返回 */
  private wakeupRequested = false;
  /** 轮询计数器，用于定期执行超时恢复 */
  private pollCount = 0;
  /** 运行中任务的 AbortController 映射，用于取消 */
  private runningTasks: Map<string, AbortController> = new Map();

  constructor(
    db: DatabaseType,
    workerId: string,
    rateLimiter: RateLimiter,
    emit: (event: TaskEvent) => void,
    ffmpeg: import("./ffmpeg.js").FFmpegHelper,
    onHeartbeat?: (activeCount: number) => void,
    clients?: ApiClients
  ) {
    this.db = db;
    this.workerId = workerId;
    this.rateLimiter = rateLimiter;
    this.emit = emit;
    this.ffmpeg = ffmpeg;
    this.clients = clients;
    this.abortController = new AbortController();
    this.onHeartbeat = onHeartbeat ?? null;
  }

  /**
   * 注册任务处理器
   *
   * @author yt @date 20260702
   */
  registerHandler(taskType: TaskType, handler: (ctx: TaskContext) => Promise<string>): void {
    this.handlers.set(taskType, handler);
  }

  /**
   * 唤醒：跳过当前休眠，立即进入下一轮调度。
   * 由 index.ts 收到 enqueue 命令时调用。
   *
   * @author yt @date 20260703
   */
  wakeup(): void {
    this.wakeupRequested = true;
  }

  /**
   * 取消指定任务：abort 对应的 AbortController，中断正在执行的 handler。
   * 由 index.ts 收到 cancel 命令时调用。
   *
   * @author yt @date 20260703
   */
  cancelTask(taskId: string): void {
    const ctrl = this.runningTasks.get(taskId);
    if (ctrl) {
      log("任务调度", "WARN", `取消运行中任务：${taskId}`);
      ctrl.abort();
      this.runningTasks.delete(taskId);
    }
  }

  /**
   * 启动任务循环
   *
   * @author yt @date 20260702
   */
  async start(): Promise<void> {
    this.running = true;
    log("任务调度", "INFO", `已启动，workerId=${this.workerId}`);

    // 启动心跳定时器
    const heartbeatTimer = setInterval(() => {
      const activeCount = this.getActiveTaskCount();
      this.onHeartbeat?.(activeCount);
    }, HEARTBEAT_INTERVAL_MS);

    // 主循环
    while (this.running) {
      try {
        // 定期恢复超时 running 任务
        this.pollCount++;
        if (this.pollCount >= STALE_CHECK_INTERVAL) {
          this.pollCount = 0;
          try {
            this.checkStaleTasks();
          } catch (e) {
            log("任务调度", "ERROR", `恢复超时任务出错：${e instanceof Error ? e.message : String(e)}`);
          }
        }

        await this.processPendingTasks();
        await this.processWaitingRemoteTasks();
      } catch (err) {
        log("任务调度", "ERROR", `主循环错误：${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof Error && err.stack) {
          log("任务调度", "ERROR", `调用栈：${err.stack}`);
        }
      }

      if (this.running) {
        await this.sleep(POLL_INTERVAL_MS);
      }
    }

    clearInterval(heartbeatTimer);
    log("任务调度", "INFO", "已停止");
  }

  /**
   * 停止任务循环
   *
   * @author yt @date 20260702
   */
  stop(): void {
    this.running = false;
    this.abortController.abort();
  }

  /**
   * 恢复超时的 running 任务。
   * 场景：Worker 崩溃重启后、handler 卡死未返回、进程被 kill。
   *
   * @author yt @date 20260703
   */
  private checkStaleTasks(): void {
    const recovered = recoverStaleTasks(this.db, STALE_TASK_TIMEOUT_MS);
    if (recovered > 0) {
      log("任务调度", "WARN", `恢复 ${recovered} 个超时运行任务`);
    }
  }

  /**
   * 处理 pending 任务
   *
   * @author yt @date 20260702
   */
  private async processPendingTasks(): Promise<void> {
    const tasks = getPendingTasks(this.db);
    if (tasks.length > 0) {
      const summary = tasks.map((t) => `${t.type}(${t.id.slice(0, 8)})`).join(", ");
      log("任务调度", "INFO", `轮询发现 ${tasks.length} 个待处理任务：[${summary}]`);
    }
    if (tasks.length === 0) return;

    for (const task of tasks) {
      if (!this.running) break;

      const taskType = task.type as TaskType;
      const apiType: ApiType = TASK_TYPE_TO_API[taskType] ?? "local";

      // 尝试获取逻辑锁（防止同一 clipId 重复调度）
      const lockedBy = `workerId:${this.workerId}:taskId:${task.id}`;
      if (!acquireLock(this.db, task.lock_key, lockedBy)) {
        continue;
      }

      // 尝试获取令牌（并发 + 限流 + 暂停 统一由 rateLimiter 判断）
      if (!this.rateLimiter.acquire(apiType)) {
        releaseLock(this.db, task.lock_key);
        continue;
      }

      // 锁 + 令牌都拿到，执行任务
      await this.executeTask(task, apiType, taskType);
    }
  }

  /**
   * 执行单个任务
   *
   * @author yt @date 20260702
   */
  private async executeTask(
    task: PendingTask,
    apiType: ApiType,
    taskType: TaskType
  ): Promise<void> {
    // 标记为 running
    markTaskRunning(this.db, task.id);
    transitionEntityStatus(this.db, task, "running");
    this.emit({ type: "task_started", taskId: task.id, taskType });

    // 获取 handler
    const handler = this.handlers.get(taskType);
    if (!handler) {
      const errMsg = `未注册任务处理器：${taskType}`;
      log("任务调度", "ERROR", errMsg);
      markTaskFailed(this.db, task.id, errMsg);
      releaseLock(this.db, task.lock_key);
      this.rateLimiter.release(apiType);
      this.emit({ type: "task_failed", taskId: task.id, errorMessage: errMsg });
      return;
    }

    // 构建 TaskContext（每任务独立 AbortSignal）
    const taskAbort = new AbortController();
    this.runningTasks.set(task.id, taskAbort);
    const ctx: TaskContext = {
      workspacePath: "",
      taskId: task.id,
      taskInput: (() => {
        try { return JSON.parse(task.input_json); } catch { return {}; }
      })(),
      db: this.db,
      emit: this.emit,
      rateLimiter: this.rateLimiter,
      signal: taskAbort.signal,
      clients: this.clients,
      ffmpeg: this.ffmpeg,
    };

    // 资产生图任务：向前端推送实时进度，避免前端仅依赖轮询
    const assetInput = taskType === "generate_asset_image"
      ? (ctx.taskInput as { clipId?: string; assetType?: string; name?: string } | undefined)
      : undefined;
    const emitAssetProgress = (status: "running" | "success" | "failed") => {
      if (assetInput?.clipId && assetInput?.assetType && assetInput?.name) {
        this.emit({
          type: "asset_image_progress",
          clipId: assetInput.clipId,
          assetType: assetInput.assetType,
          name: assetInput.name,
          status,
        });
      }
    };
    emitAssetProgress("running");

    // 片段拆解任务：完成/失败时通知前端即时刷新片段列表
    const emitClipScriptReady = (status: "success" | "failed", errorMessage?: string) => {
      if (taskType === "generate_clip_script") {
        const input = ctx.taskInput as { projectId?: string; clipId?: string } | undefined;
        if (input?.projectId && input?.clipId) {
          this.emit({
            type: "clip_script_ready",
            projectId: input.projectId,
            clipId: input.clipId,
            status,
            errorMessage,
          });
        }
      }
    };

    log("任务调度", "INFO", `执行任务：id=${task.id} type=${taskType} apiType=${apiType} retry=${task.retry_count}/${task.max_retry}`);

    try {
      // per-task 超时保护
      const outputJson = await this.withTimeout(
        handler(ctx),
        TASK_HANDLER_TIMEOUT_MS,
        taskAbort,
      );
      log("任务调度", "INFO", `任务成功：id=${task.id} type=${taskType}`);
      markTaskSuccess(this.db, task.id, outputJson);
      transitionEntityStatus(this.db, task, "success");
      this.emit({ type: "task_success", taskId: task.id, outputJson });
      emitAssetProgress("success");
      emitClipScriptReady("success");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log("任务调度", "ERROR", `任务失败：id=${task.id} type=${taskType} 错误=${errorMessage}`);

      // 429 限流 → 报告 rateLimiter
      if (this.isRateLimitError(err)) {
        this.rateLimiter.reportRateLimit(apiType);
      }

      // 配额耗尽 → 暂停该 API
      if (this.isQuotaExhaustedError(err)) {
        this.rateLimiter.reportQuotaExhausted(apiType);
        this.emit({ type: "quota_exhausted", apiType, message: errorMessage });
      }

      // 可重试错误 + 还有重试次数 → 回退 pending
      if (this.isRetryable(err) && task.retry_count < task.max_retry) {
        log("任务调度", "WARN", `任务回退待重试：id=${task.id} retry=${task.retry_count + 1}/${task.max_retry}`);
        try {
          this.db.prepare(
            "UPDATE tasks SET status = 'pending', retry_count = retry_count + 1, error_message = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(errorMessage, task.id);
          transitionEntityStatus(this.db, task, "running-pending");
          this.emit({ type: "task_failed", taskId: task.id, errorMessage: `${errorMessage}（将重试）` });
        } catch (e) {
          log("任务调度", "ERROR", `回退任务写库失败：${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        try {
          markTaskFailed(this.db, task.id, errorMessage);
          recoverEntityStatusOnFinalFail(this.db, task);
          this.emit({ type: "task_failed", taskId: task.id, errorMessage });
          emitAssetProgress("failed");
          emitClipScriptReady("failed", errorMessage);
        } catch (e) {
          log("任务调度", "ERROR", `标记任务失败写库失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      this.runningTasks.delete(task.id);
      try {
        releaseLock(this.db, task.lock_key);
      } catch {
        // 锁可能已被外部删除，忽略
      }
      this.rateLimiter.release(apiType);
    }
  }

  /**
   * 包装 Promise，超时后 abort 并抛错。
   *
   * @author yt @date 20260703
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, abort: AbortController): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`任务执行超时（${timeoutMs / 1000}s）`));
      }, timeoutMs);

      promise
        .then((result) => { clearTimeout(timer); resolve(result); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  /**
   * 判断错误是否可重试
   *
   * @author yt @date 20260703
   */
  private isRetryable(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return RETRYABLE_KEYWORDS.some((kw) => msg.toLowerCase().includes(kw.toLowerCase()));
  }

  /**
   * 处理 waiting_remote 任务（恢复轮询远端任务状态）。
   *
   * 流程：
   * 1. 查询所有 waiting_remote 状态的任务
   * 2. 对每条任务，根据 task_type 查询对应 API 客户端
   * 3. 调用客户端的 poll 方法查询远端任务状态
   * 4. 完成 → markTaskSuccess；失败 → markTaskFailed；仍在处理 → 跳过
   *
   * 注意：当前仅有 text/image/voice 三种 API，它们的操作是同步的，
   * 不会产生 waiting_remote 状态。此方法预留给未来的异步 API（如视频生成服务）。
   *
   * @author yt @date 20260702
   */
  private async processWaitingRemoteTasks(): Promise<void> {
    const tasks = getWaitingRemoteTasks(this.db);
    if (tasks.length === 0) return;

    log("任务调度", "INFO", `检查 ${tasks.length} 个远端任务状态`);

    for (const task of tasks) {
      if (!this.running) break;

      const taskType = task.type as TaskType;
      const apiType: ApiType = TASK_TYPE_TO_API[taskType] ?? "local";

      // 只处理有对应客户端的 API 类型
      if (apiType === "local" || !this.clients) {
        log("任务调度", "WARN", `远端任务 ${task.id} 类型 ${taskType} 无对应客户端，跳过`);
        continue;
      }

      try {
        const handler = this.handlers.get(taskType);
        if (handler) {
          // 有 handler → 说明是本地任务误标为 waiting_remote，回退为 pending
          log("任务调度", "WARN", `远端任务 ${task.id} 类型 ${taskType} 有本地 handler，回退为 pending`);
          this.db.prepare(
            "UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
          ).run(task.id);
        } else {
          // 无 handler → 真正的远端任务，保持 waiting_remote，等待外部恢复
          log("任务调度", "INFO", `远端任务 ${task.id} 类型 ${taskType} 仍在等待远端结果`);
        }
      } catch (err) {
        log("任务调度", "ERROR", `查询远端任务 ${task.id} 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * 获取当前活跃任务数（running 状态）
   *
   * @author yt @date 20260702
   */
  private getActiveTaskCount(): number {
    return getRunningTaskCount(this.db);
  }

  /**
   * 判断是否是 429 限流错误
   *
   * @author yt @date 20260702
   */
  private isRateLimitError(err: unknown): boolean {
    if (err && typeof err === "object" && "status" in err) {
      return (err as RetryableError).status === 429;
    }
    return false;
  }

  /**
   * 判断是否是配额耗尽错误
   *
   * @author yt @date 20260702
   */
  private isQuotaExhaustedError(err: unknown): boolean {
    if (err && typeof err === "object" && "code" in err) {
      return (err as RetryableError).code === "QUOTA_EXHAUSTED";
    }
    return false;
  }

  /**
   * 可中断休眠：收到 wakeup 信号时立即返回
   *
   * @author yt @date 20260703
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const interval = 50;
      let elapsed = 0;
      const timer = setInterval(() => {
        if (this.wakeupRequested) {
          this.wakeupRequested = false;
          clearInterval(timer);
          resolve();
          return;
        }
        elapsed += interval;
        if (elapsed >= ms) {
          clearInterval(timer);
          resolve();
        }
      }, interval);
    });
  }
}
