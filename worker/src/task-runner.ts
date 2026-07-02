/**
 * TaskRunner - 任务执行核心循环
 * 基于模块 08 第 3.2 节 "worker 设计"
 *
 * 核心循环：
 * 1. 查询所有 status = 'pending' 且 lockKey 未被占用的 Task
 * 2. 对每条 Task：
 *    a. 根据 task.type 映射到 apiType
 *    b. 检查该 apiType 并发数是否达上限
 *    c. 检查该 apiType 是否被暂停（配额耗尽）
 *    d. 尝试获取逻辑锁
 * 3. 三项都通过：获取令牌 → 标记 running → 分发到 handler → 回写结果
 * 4. 恢复 waiting_remote 的任务轮询
 * 5. 本轮无可执行任务时休眠 1 秒
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
  type PendingTask,
} from "./db.js";
import { logLine } from "./logger.js";

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 10000;

export class TaskRunner {
  private db: DatabaseType;
  private workerId: string;
  private rateLimiter: RateLimiter;
  private emit: (event: TaskEvent) => void;
  private clients?: ApiClients;
  private running = false;
  private abortController: AbortController;
  private handlers: Map<TaskType, (ctx: TaskContext) => Promise<string>> = new Map();

  private onHeartbeat: ((activeCount: number) => void) | null = null;

  constructor(
    db: DatabaseType,
    workerId: string,
    rateLimiter: RateLimiter,
    emit: (event: TaskEvent) => void,
    onHeartbeat?: (activeCount: number) => void,
    clients?: ApiClients
  ) {
    this.db = db;
    this.workerId = workerId;
    this.rateLimiter = rateLimiter;
    this.emit = emit;
    this.clients = clients;
    this.abortController = new AbortController();
    this.onHeartbeat = onHeartbeat ?? null;
  }

  /**
   * 注册任务处理器
   */
  registerHandler(taskType: TaskType, handler: (ctx: TaskContext) => Promise<string>): void {
    this.handlers.set(taskType, handler);
  }

  /**
   * 启动任务循环
   */
  async start(): Promise<void> {
    this.running = true;
    logLine("task-runner", "INFO", `Started workerId=${this.workerId}`);
    console.log(`[TaskRunner] started, workerId: ${this.workerId}`);

    // 启动心跳定时器
    const heartbeatTimer = setInterval(() => {
      const activeCount = this.getActiveTaskCount();
      this.onHeartbeat?.(activeCount);
    }, HEARTBEAT_INTERVAL_MS);

    // 主循环
    while (this.running) {
      try {
        await this.processPendingTasks();
        await this.processWaitingRemoteTasks();
      } catch (err) {
        logLine("task-runner", "ERROR", `Main loop error: ${err instanceof Error ? err.message : String(err)}`);
        console.error("[TaskRunner] error in main loop:", err);
      }

      if (this.running) {
        await this.sleep(POLL_INTERVAL_MS);
      }
    }

    clearInterval(heartbeatTimer);
    logLine("task-runner", "INFO", "Stopped");
    console.log("[TaskRunner] stopped");
  }

  /**
   * 停止任务循环
   */
  stop(): void {
    this.running = false;
    this.abortController.abort();
  }

  /**
   * 处理 pending 任务
   */
  private async processPendingTasks(): Promise<void> {
    const tasks = getPendingTasks(this.db);
    if (tasks.length === 0) return;

    logLine("task-runner", "INFO", `Found ${tasks.length} pending task(s)`);

    for (const task of tasks) {
      if (!this.running) break;

      const taskType = task.type as TaskType;
      const apiType: ApiType = TASK_TYPE_TO_API[taskType] ?? "local";

      // 检查三项条件
      // a. 并发数是否达上限
      if (this.rateLimiter.getActiveCount(apiType) >= this.getMaxConcurrency(apiType)) {
        continue;
      }
      // b. 是否被暂停
      if (!this.rateLimiter.canAcquire(apiType)) {
        continue;
      }
      // c. 尝试获取逻辑锁
      const lockedBy = `workerId:${this.workerId}:taskId:${task.id}`;
      if (!acquireLock(this.db, task.lock_key, lockedBy)) {
        continue;
      }

      // 三项都通过：执行任务
      await this.executeTask(task, apiType, taskType);
    }
  }

  /**
   * 执行单个任务
   */
  private async executeTask(
    task: PendingTask,
    apiType: ApiType,
    taskType: TaskType
  ): Promise<void> {
    // 获取令牌
    if (!this.rateLimiter.acquire(apiType)) {
      releaseLock(this.db, task.lock_key);
      return;
    }

    // 标记为 running
    markTaskRunning(this.db, task.id);
    this.emit({ type: "task_started", taskId: task.id, taskType });

    // 获取 handler
    const handler = this.handlers.get(taskType);
    if (!handler) {
      const errMsg = `No handler registered for task type: ${taskType}`;
      logLine("task-runner", "ERROR", errMsg);
      markTaskFailed(this.db, task.id, errMsg);
      releaseLock(this.db, task.lock_key);
      this.rateLimiter.release(apiType);
      this.emit({ type: "task_failed", taskId: task.id, errorMessage: errMsg });
      return;
    }

    // 构建 TaskContext
    const ctx: TaskContext = {
      workspacePath: "", // TODO: 从项目配置获取
      taskId: task.id,
      taskInput: (() => {
        try { return JSON.parse(task.input_json); } catch { return {}; }
      })(),
      db: this.db,
      emit: this.emit,
      rateLimiter: this.rateLimiter,
      signal: this.abortController.signal,
      clients: this.clients,
    };

    logLine("task-runner", "INFO", `Executing task: id=${task.id} type=${taskType} apiType=${apiType}`);

    try {
      const outputJson = await handler(ctx);
      logLine("task-runner", "INFO", `Task succeeded: id=${task.id} type=${taskType}`);
      markTaskSuccess(this.db, task.id, outputJson);
      this.emit({ type: "task_success", taskId: task.id, outputJson });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logLine("task-runner", "ERROR", `Task failed: id=${task.id} type=${taskType} error=${errorMessage}`);

      // 检查是否是 429 错误
      if (this.isRateLimitError(err)) {
        this.rateLimiter.reportRateLimit(apiType);
      }

      // 检查是否是配额耗尽
      if (this.isQuotaExhaustedError(err)) {
        this.rateLimiter.reportQuotaExhausted(apiType);
        this.emit({ type: "quota_exhausted", apiType, message: errorMessage });
      }

      markTaskFailed(this.db, task.id, errorMessage);
      this.emit({ type: "task_failed", taskId: task.id, errorMessage });
    } finally {
      releaseLock(this.db, task.lock_key);
      this.rateLimiter.release(apiType);
    }
  }

  /**
   * 处理 waiting_remote 任务（恢复轮询）
   */
  private async processWaitingRemoteTasks(): Promise<void> {
    const tasks = getWaitingRemoteTasks(this.db);
    if (tasks.length === 0) return;

    // TODO: 实现远端任务轮询逻辑
    // 对每个 waiting_remote 的任务，调用对应的轮询接口
    // 成功 → 下载结果 → markTaskSuccess
    // 失败 → markTaskFailed
  }

  /**
   * 获取当前活跃任务数（running 状态）
   */
  private getActiveTaskCount(): number {
    return getRunningTaskCount(this.db);
  }

  /**
   * 获取 API 类型最大并发数
   */
  private getMaxConcurrency(apiType: ApiType): number {
    const max: Record<ApiType, number> = {
      text: 2,
      image: 3,
      voice: 2,
      video: 1,
      local: 2,
    };
    return max[apiType] ?? 1;
  }

  /**
   * 判断是否是 429 限流错误
   */
  private isRateLimitError(err: unknown): boolean {
    if (err && typeof err === "object" && "status" in err) {
      return (err as any).status === 429;
    }
    return false;
  }

  /**
   * 判断是否是配额耗尽错误
   */
  private isQuotaExhaustedError(err: unknown): boolean {
    if (err && typeof err === "object" && "code" in err) {
      return (err as any).code === "QUOTA_EXHAUSTED";
    }
    return false;
  }

  /**
   * 休眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
