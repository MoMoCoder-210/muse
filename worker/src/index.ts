/**
 * Worker 入口文件 - Node sidecar
 *
 * 职责：
 * 1. 通过 stdio 与 Tauri 主进程通信（JSON line 协议）
 * 2. 启动时发送 ready 消息（包含 workerId + protocolVersion）
 * 3. 定期发送心跳（10s 间隔）
 * 4. 接收命令：enqueue / cancel / shutdown / ping
 * 5. 推送事件：task_event / batch_progress / quota_exhausted / log / error
 *
 * @author yt @date 20260702
 */

import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { initDatabase, getRunningTaskCount } from "./db.js";
import { TaskRunner } from "./task-runner.js";
import { RateLimiterImpl } from "./rate-limiter.js";
import { PROTOCOL_VERSION } from "./types.js";
import type { WorkerCommand, WorkerMessage, TaskEvent } from "./types.js";
import { splitScriptHandler } from "./handlers/split-script.js";
import { generateClipScriptHandler } from "./handlers/generate-clip-script.js";
import { generateAssetImageHandler } from "./handlers/generate-asset-image.js";
import { SettingsManager } from "./config/settings.js";
import { createClients } from "./clients/index.js";
import type { ApiClients } from "./clients/index.js";
import { configureLogger, logLine } from "./logger.js";

const workerId = randomUUID();
let dbPath = process.env.WORKER_DB_PATH || "";
let workspacePath = process.env.WORKER_WORKSPACE_PATH || "";
let configPath = process.env.WORKER_CONFIG_PATH || "";
let logPath = process.env.WORKER_LOG_PATH || "";
let running = true;

// 初始化数据库连接
let db: ReturnType<typeof initDatabase>;
let taskRunner: TaskRunner;
let rateLimiter: RateLimiterImpl;
let settings: SettingsManager;
let clients: ApiClients;

interface UnknownWorkerCommand {
  cmd: string;
  version: number;
  [key: string]: unknown;
}

/**
 * 发送消息到 Tauri 主进程（stdout）
 *
 * @author yt @date 20260702
 */
function sendMessage(msg: WorkerMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * 发送日志（统一通过 stdout 转发到 Rust 项目日志，避免双写）
 *
 * @author yt @date 20260702
 */
function sendLog(level: "info" | "warn" | "error", message: string): void {
  sendMessage({ version: PROTOCOL_VERSION, msg: "log", level, message });
}

/**
 * 发送任务事件
 *
 * @author yt @date 20260702
 */
function emitEvent(event: TaskEvent): void {
  sendMessage({ version: PROTOCOL_VERSION, msg: "task_event", event });
}

/**
 * 发送心跳
 *
 * @author yt @date 20260702
 */
function sendHeartbeat(): void {
  if (!running) return;
  const activeTasks = db ? getRunningTaskCount(db) : 0;
  sendMessage({ version: PROTOCOL_VERSION, msg: "heartbeat", workerId, activeTasks });
}

// 处理接收到的命令
async function handleCommand(cmd: WorkerCommand): Promise<void> {
  // 验证协议版本
  if (cmd.version !== PROTOCOL_VERSION) {
    sendLog("error", `协议版本不匹配：期望 ${PROTOCOL_VERSION}，实际 ${cmd.version}`);
    return;
  }

  switch (cmd.cmd) {
    case "enqueue":
      sendLog("info", `任务入队：${cmd.taskId} type=${cmd.taskType ?? "?"}`);
      // 唤醒 TaskRunner 立即调度，不必等下一轮轮询
      if (taskRunner) {
        taskRunner.wakeup();
      }
      break;

    case "cancel":
      sendLog("info", `取消任务：${cmd.taskId}`);
      if (taskRunner) {
        taskRunner.cancelTask(cmd.taskId);
      }
      break;

    case "shutdown":
      await handleShutdown(cmd.timeoutMs);
      break;

    case "ping":
      sendHeartbeat();
      break;

    case "reload_config":
      if (clients) {
        clients.reload();
        sendLog("info", "配置已重新加载");
      } else {
        sendLog("warn", "重载配置失败：客户端未初始化");
      }
      break;

    default:
      sendLog("warn", `未知命令：${(cmd as UnknownWorkerCommand).cmd}`);
  }
}

/**
 * 处理优雅关闭
 *
 * @author yt @date 20260702
 */
async function handleShutdown(timeoutMs: number): Promise<void> {
  sendLog("info", `收到关闭指令，超时：${timeoutMs}ms`);
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

  sendLog("info", "Worker 已关闭");
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
    } else if (args[i] === "--config" && args[i + 1]) {
      configPath = args[i + 1];
    } else if (args[i] === "--log" && args[i + 1]) {
      logPath = args[i + 1];
    }
  }

  configureLogger(logPath);
  const shortDb = dbPath ? dbPath.split(/[\\/]/).slice(-2).join("/") : "无";
  const shortWs = workspacePath ? workspacePath.split(/[\\/]/).slice(-2).join("/") : "无";
  logLine("主进程", "DEBUG", `Worker 启动 db=${shortDb} workspace=${shortWs}`);

  // 初始化配置和 API 客户端（无论是否有数据库都先初始化）
  if (configPath) {
    const { existsSync } = await import("fs");
    const configExists = existsSync(configPath);
    settings = new SettingsManager(configPath);
    clients = createClients(settings);
    if (configExists) {
      sendLog("info", `配置已加载：${configPath}`);
    } else {
      sendLog("warn", `配置文件不存在，使用默认配置（API Key 为空）：${configPath}`);
    }
  } else {
    sendLog("warn", "未提供配置路径，API 客户端未初始化");
  }

  // 初始化数据库
  if (dbPath) {
    // 启动诊断：检查 DB 文件是否可访问
    const { existsSync } = await import("fs");
    if (!existsSync(dbPath)) {
      logLine("主进程", "WARN", "数据库文件不存在，初始化时将创建");
    }

    db = initDatabase(dbPath);
    logLine("主进程", "DEBUG", `数据库已连接：${shortDb}`);

    // 检查启动时是否有遗留的 running 任务（上次崩溃未回退）
    const staleRunning = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'running'").get() as { cnt: number };
    if (staleRunning.cnt > 0) {
      logLine("主进程", "WARN", `发现 ${staleRunning.cnt} 个残留运行任务，已重置为待处理`);
      db.prepare("UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'running'").run();
    }

    // 清理已删除片段的孤儿任务
    const orphanTasks = db.prepare(`
      DELETE FROM tasks WHERE type = 'generate_clip_script'
      AND status IN ('pending', 'running')
      AND lock_key NOT IN (
        SELECT 'generate_clip_script:' || c.id FROM clips c WHERE c.deleted_at IS NULL
      )
    `).run();
    if (orphanTasks.changes > 0) {
      logLine("主进程", "INFO", `已清理 ${orphanTasks.changes} 个孤儿拆解任务（片段已删除）`);
    }

    const pendingCount = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'").get() as { cnt: number };
    logLine("主进程", "DEBUG", `启动时待处理任务：${pendingCount.cnt}`);

    rateLimiter = new RateLimiterImpl();
    // TaskRunner 内置心跳定时器，通过 onHeartbeat 回调将心跳发送出去
    taskRunner = new TaskRunner(db, workerId, rateLimiter, emitEvent, sendHeartbeat, clients);

    // 注册任务处理器
    taskRunner.registerHandler("split_script", splitScriptHandler);
    taskRunner.registerHandler("generate_clip_script", generateClipScriptHandler);
    taskRunner.registerHandler("generate_asset_image", generateAssetImageHandler);
    logLine("主进程", "DEBUG", "已注册处理器：split_script, generate_clip_script, generate_asset_image");

    sendLog("info", `数据库初始化完成：${shortDb}`);
  } else {
    sendLog("warn", "未提供数据库路径，Worker 以空闲模式运行");
  }

  // 发送 ready 消息
  sendMessage({
    version: PROTOCOL_VERSION,
    msg: "ready",
    workerId,
    protocolVersion: PROTOCOL_VERSION,
  });
  sendLog("info", `Worker 就绪，等待任务（待处理：${db ? (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'").get() as { cnt: number }).cnt : 0}）`);

  // 当没有 taskRunner 时（空闲模式），单独启动心跳定时器
  let idleHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (!taskRunner) {
    idleHeartbeatTimer = setInterval(sendHeartbeat, 10000);
  }

  // 启动任务循环
  if (taskRunner) {
    taskRunner.start().catch((err) => {
      sendLog("error", `任务执行器错误：${err.message}`);
    });
  }

  // 监听 stdin 命令
  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    try {
      const cmd = JSON.parse(line) as WorkerCommand;
      handleCommand(cmd).catch((err) => {
        sendLog("error", `命令处理错误：${err.message}`);
      });
    } catch (err) {
      sendLog("error", `命令解析失败：${line}`);
    }
  });

  rl.on("close", async () => {
    sendLog("info", "stdin 已关闭，正在退出");
    await handleShutdown(30000);
  });

  // 处理未捕获异常
  process.on("uncaughtException", (err) => {
    logLine("主进程", "ERROR", `未捕获异常：${err.message}\n${err.stack || ""}`);
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
  logLine("主进程", "ERROR", `致命错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
