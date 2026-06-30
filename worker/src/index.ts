/**
 * Worker 入口文件 - Node sidecar
 * 基于模块 08 第 12.2 节 "worker 通信协议"
 *
 * 职责：
 * 1. 通过 stdio 与 Tauri 主进程通信（JSON line 协议）
 * 2. 启动时发送 ready 消息（包含 workerId + protocolVersion）
 * 3. 定期发送心跳（10s 间隔）
 * 4. 接收命令：enqueue / cancel / shutdown / ping
 * 5. 推送事件：task_event / batch_progress / quota_exhausted / log / error
 */

import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { initDatabase, getRunningTaskCount } from "./db.js";
import { TaskRunner } from "./task-runner.js";
import { RateLimiterImpl } from "./rate-limiter.js";
import { PROTOCOL_VERSION } from "./types.js";
import type { WorkerCommand, WorkerMessage, TaskEvent } from "./types.js";
import { splitScriptHandler } from "./handlers/split-script.js";

const workerId = randomUUID();
let dbPath = process.env.WORKER_DB_PATH || "";
let workspacePath = process.env.WORKER_WORKSPACE_PATH || "";
let running = true;

// 初始化数据库连接
let db: ReturnType<typeof initDatabase>;
let taskRunner: TaskRunner;
let rateLimiter: RateLimiterImpl;

// 发送消息到 Tauri 主进程（stdout）
function sendMessage(msg: WorkerMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// 发送日志
function sendLog(level: "info" | "warn" | "error", message: string): void {
  sendMessage({ version: PROTOCOL_VERSION, msg: "log", level, message });
}

// 发送任务事件
function emitEvent(event: TaskEvent): void {
  sendMessage({ version: PROTOCOL_VERSION, msg: "task_event", event });
}

// 发送心跳
function sendHeartbeat(): void {
  if (!running) return;
  const activeTasks = db ? getRunningTaskCount(db) : 0;
  sendMessage({ version: PROTOCOL_VERSION, msg: "heartbeat", workerId, activeTasks });
}

// 处理接收到的命令
async function handleCommand(cmd: WorkerCommand): Promise<void> {
  // 验证协议版本
  if (cmd.version !== PROTOCOL_VERSION) {
    sendLog("error", `Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${cmd.version}`);
    return;
  }

  switch (cmd.cmd) {
    case "enqueue":
      sendLog("info", `Enqueue task: ${cmd.taskId}`);
      break;

    case "cancel":
      sendLog("info", `Cancel task: ${cmd.taskId}`);
      // TODO: 标记任务为 cancelled
      break;

    case "shutdown":
      await handleShutdown(cmd.timeoutMs);
      break;

    case "ping":
      sendHeartbeat();
      break;

    default:
      sendLog("warn", `Unknown command: ${(cmd as any).cmd}`);
  }
}

// 处理优雅关闭
async function handleShutdown(timeoutMs: number): Promise<void> {
  sendLog("info", `Shutdown received, timeout: ${timeoutMs}ms`);
  running = false;

  // 停止任务循环
  if (taskRunner) {
    taskRunner.stop();
  }

  // 停止限流器
  if (rateLimiter) {
    rateLimiter.stopAll();
  }

  // 等待进行中的任务完成
  let pendingTasks = db ? getRunningTaskCount(db) : 0;
  sendMessage({ version: PROTOCOL_VERSION, msg: "shutting_down", pendingTasks });

  // 给任务一些时间完成
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  while (Date.now() < deadline) {
    if (db) {
      pendingTasks = getRunningTaskCount(db);
      if (pendingTasks === 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // 将仍在 running 的任务回退为 pending
  if (db) {
    db.prepare("UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'running' AND remote_task_id IS NULL").run();
    db.prepare("UPDATE tasks SET status = 'waiting_remote', updated_at = datetime('now') WHERE status = 'running' AND remote_task_id IS NOT NULL").run();
    db.close();
  }

  sendLog("info", "Worker shutdown complete");
  process.exit(0);
}

// 主函数
async function main(): Promise<void> {
  // 从命令行参数或环境变量获取数据库路径
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) {
      dbPath = args[i + 1];
    } else if (args[i] === "--workspace" && args[i + 1]) {
      workspacePath = args[i + 1];
    }
  }

  // 初始化数据库
  if (dbPath) {
    db = initDatabase(dbPath);
    rateLimiter = new RateLimiterImpl();
    // TaskRunner 内置心跳定时器，通过 onHeartbeat 回调将心跳发送出去
    taskRunner = new TaskRunner(db, workerId, rateLimiter, emitEvent, sendHeartbeat);

    // 注册任务处理器
    taskRunner.registerHandler("split_script", splitScriptHandler);
    // TODO: 后续模块注册
    // taskRunner.registerHandler("generate_script", generateScriptHandler);

    sendLog("info", `Database initialized: ${dbPath}`);
  } else {
    sendLog("warn", "No database path provided, worker running in idle mode");
  }

  // 发送 ready 消息
  sendMessage({
    version: PROTOCOL_VERSION,
    msg: "ready",
    workerId,
    protocolVersion: PROTOCOL_VERSION,
  });

  // 当没有 taskRunner 时（空闲模式），单独启动心跳定时器
  let idleHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (!taskRunner) {
    idleHeartbeatTimer = setInterval(sendHeartbeat, 10000);
  }

  // 启动任务循环
  if (taskRunner) {
    taskRunner.start().catch((err) => {
      sendLog("error", `Task runner error: ${err.message}`);
    });
  }

  // 监听 stdin 命令
  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    try {
      const cmd = JSON.parse(line) as WorkerCommand;
      handleCommand(cmd).catch((err) => {
        sendLog("error", `Command handler error: ${err.message}`);
      });
    } catch (err) {
      sendLog("error", `Failed to parse command: ${line}`);
    }
  });

  rl.on("close", async () => {
    sendLog("info", "stdin closed, shutting down");
    await handleShutdown(30000);
  });

  // 处理未捕获异常
  process.on("uncaughtException", (err) => {
    sendMessage({
      version: PROTOCOL_VERSION,
      msg: "error",
      message: err.message,
      stack: err.stack,
    });
  });

  // 清理
  process.on("exit", () => {
    clearInterval(idleHeartbeatTimer);
    if (db?.open) {
      db.close();
    }
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
