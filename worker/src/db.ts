/**
 * SQLite 数据库连接管理
 *
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";

/**
 * 初始化 SQLite 数据库连接。
 *
 */
export function initDatabase(dbPath: string): DatabaseType {
  // 确保目录存在
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // 启用 WAL 模式
  db.pragma("journal_mode = WAL");
  // 设置 busy_timeout 为 5 秒
  db.pragma("busy_timeout = 5000");
  // WAL checkpoint 策略
  db.pragma("wal_autocheckpoint = 1000");
  // 启用外键约束
  db.pragma("foreign_keys = ON");

  return db;
}

const WORKER_LEASE_KEY = "muse:worker";
const WORKER_LEASE_STALE_MS = 30_000;

type WorkerLeaseRow = {
  worker_id: string;
  pid: number;
  is_stale: number;
};

/**
 * PID 未知时宁可拒绝接管也不能假设旧 Worker 已停止；这避免旧版本升级期间
 * 或 PID 查询失败时对仍在执行的外部模型请求重复消费。
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ensureWorkerLeaseSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_leases (
      lease_key TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      pid INTEGER NOT NULL DEFAULT 0
    )
  `);

  const columns = db.prepare("PRAGMA table_info(worker_leases)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "pid")) {
    db.exec("ALTER TABLE worker_leases ADD COLUMN pid INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * 获取全局 Worker 租约。
 *
 * 接管过期租约前还会验证旧进程的 PID 已不存在。心跳超时本身不足以证明
 * handler 已停止；若旧进程仍存活，则拒绝启动新 Worker，避免重复调用模型。
 */
export function acquireWorkerLease(db: DatabaseType, workerId: string): boolean {
  ensureWorkerLeaseSchema(db);

  const acquire = db.transaction(() => {
    const existing = db.prepare(
      `SELECT worker_id, pid,
              (unixepoch(datetime('now')) - unixepoch(heartbeat_at)) * 1000 > ? AS is_stale
       FROM worker_leases WHERE lease_key = ?`
    ).get(WORKER_LEASE_STALE_MS, WORKER_LEASE_KEY) as WorkerLeaseRow | undefined;

    if (existing) {
      if (!existing.is_stale || isProcessAlive(existing.pid)) return false;
      db.prepare("DELETE FROM worker_leases WHERE lease_key = ? AND worker_id = ?")
        .run(WORKER_LEASE_KEY, existing.worker_id);
    }

    const result = db.prepare(
      "INSERT OR IGNORE INTO worker_leases (lease_key, worker_id, pid) VALUES (?, ?, ?)"
    ).run(WORKER_LEASE_KEY, workerId, process.pid);
    return result.changes === 1;
  });

  return acquire();
}

/** 刷新指定 Worker 的租约；返回 false 表示该 Worker 已不再拥有租约。 */
export function refreshWorkerLease(db: DatabaseType, workerId: string): boolean {
  const result = db.prepare(
    `UPDATE worker_leases
     SET heartbeat_at = datetime('now')
     WHERE lease_key = ? AND worker_id = ? AND pid = ?`
  ).run(WORKER_LEASE_KEY, workerId, process.pid);
  return result.changes === 1;
}

/** 释放指定 Worker 的租约，不会影响其他 Worker。 */
export function releaseWorkerLease(db: DatabaseType, workerId: string): void {
  db.prepare(
    "DELETE FROM worker_leases WHERE lease_key = ? AND worker_id = ? AND pid = ?"
  ).run(WORKER_LEASE_KEY, workerId, process.pid);
}

export type PendingTask = {
  id: string;
  project_id: string;
  clip_id: string | null;
  batch_id: string | null;
  storyboard_id: string | null;
  asset_id: string | null;
  type: string;
  status: string;
  lock_key: string;
  input_json: string;
  remote_task_id: string | null;
  retry_count: number;
  max_retry: number;
};

/**
 * 获取任务列表。
 */
export function getPendingTasks(db: DatabaseType): PendingTask[] {
  return db
    .prepare(
      `SELECT t.id, t.project_id, t.clip_id, t.batch_id, t.storyboard_id, t.asset_id,
              t.type, t.status, t.lock_key, t.input_json, t.remote_task_id,
              t.retry_count, t.max_retry
       FROM tasks t
       WHERE t.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM task_locks tl WHERE tl.lock_key = t.lock_key
         )
       ORDER BY t.created_at ASC
       LIMIT 20`
    )
    .all() as PendingTask[];
}

/**
 * 原子领取待处理任务。
 *
 * 锁记录与 pending → running 状态转换必须在同一事务中完成。即便多个
 * Worker 同时观察到同一条 pending 记录，也只有状态更新成功的一方能执行
 * handler；这不依赖 task_locks 表在旧数据库中是否已经具有唯一约束。
 */
export function claimPendingTask(
  db: DatabaseType,
  task: Pick<PendingTask, "id" | "lock_key">,
  lockedBy: string
): boolean {
  const claim = db.transaction(() => {
    const lockResult = db.prepare(
      "INSERT OR IGNORE INTO task_locks (lock_key, locked_by) VALUES (?, ?)"
    ).run(task.lock_key, lockedBy);

    if (lockResult.changes !== 1) {
      return false;
    }

    const result = db.prepare(
      `UPDATE tasks
       SET status = 'running', started_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND lock_key = ? AND status = 'pending'`
    ).run(task.id, task.lock_key);

    if (result.changes === 1) {
      return true;
    }

    // 未领取成功时仅删除本次尝试创建的锁，绝不能删除其他 Worker 的锁。
    db.prepare(
      "DELETE FROM task_locks WHERE lock_key = ? AND locked_by = ?"
    ).run(task.lock_key, lockedBy);
    return false;
  });

  return claim();
}

/**
 * 释放本 Worker 持有的逻辑锁。
 */
export function releaseLock(db: DatabaseType, lockKey: string, lockedBy: string): void {
  db.prepare(
    "DELETE FROM task_locks WHERE lock_key = ? AND locked_by = ?"
  ).run(lockKey, lockedBy);
}

/**
 * 标记任务为 waiting_remote。
 *
 */
export function markTaskWaitingRemote(
  db: DatabaseType,
  taskId: string,
  remoteTaskId: string
): void {
  db.prepare(
    "UPDATE tasks SET status = 'waiting_remote', remote_task_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(remoteTaskId, taskId);
}

/**
 * 标记任务为 success。
 *
 */
export function markTaskSuccess(
  db: DatabaseType,
  taskId: string,
  outputJson: string
): void {
  db.prepare(
    "UPDATE tasks SET status = 'success', output_json = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(outputJson, taskId);
}

/**
 * 标记任务为 failed。
 *
 */
export function markTaskFailed(
  db: DatabaseType,
  taskId: string,
  errorMessage: string
): void {
  db.prepare(
    "UPDATE tasks SET status = 'failed', error_message = ?, retry_count = retry_count + 1, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(errorMessage, taskId);
}

/**
 * 统一实体状态转换。
 */
export function transitionEntityStatus(
  db: DatabaseType,
  task: { type: string; clip_id: string | null; storyboard_id?: string | null; input_json: string },
  newStatus: "running" | "running-pending" | "success" | "failed",
  errorMessage?: string
): void {
  const now = "datetime('now')";

  if (task.type === "split_script") {
    const input = JSON.parse(task.input_json || "{}");
    if (!input.sourceId) return;

    switch (newStatus) {
      case "running":
        db.prepare(
          "UPDATE script_sources SET split_status = 'running', updated_at = datetime('now') WHERE id = ?"
        ).run(input.sourceId);
        break;
      case "running-pending":
        db.prepare(
          "UPDATE script_sources SET split_status = 'pending', updated_at = datetime('now') WHERE id = ?"
        ).run(input.sourceId);
        break;
      case "success":
        db.prepare(
          "UPDATE script_sources SET split_status = 'success', updated_at = datetime('now') WHERE id = ?"
        ).run(input.sourceId);
        break;
      case "failed":
        db.prepare(
          `UPDATE script_sources SET split_status = 'failed', error_message = ?, updated_at = ${now} WHERE id = ?`
        ).run(errorMessage ?? "任务最终失败", input.sourceId);
        break;
    }
  } else if (task.type === "generate_clip_script" && task.clip_id) {
    const cid = task.clip_id;

    switch (newStatus) {
      case "running":
        db.prepare(
          `UPDATE clips SET status = 'running', updated_at = ${now} WHERE id = ?`
        ).run(cid);
        db.prepare(
          `UPDATE clip_scripts SET status = 'running', updated_at = ${now} WHERE clip_id = ?`
        ).run(cid);
        break;
      case "running-pending":
        db.prepare(
          `UPDATE clips SET status = 'pending', updated_at = ${now} WHERE id = ?`
        ).run(cid);
        db.prepare(
          `UPDATE clip_scripts SET status = 'pending', updated_at = ${now} WHERE clip_id = ?`
        ).run(cid);
        break;
      case "success":
        db.prepare(
          `UPDATE clips SET status = 'script_ready', updated_at = ${now} WHERE id = ?`
        ).run(cid);
        db.prepare(
          `UPDATE clip_scripts SET status = 'success', updated_at = ${now} WHERE clip_id = ?`
        ).run(cid);
        break;
      case "failed":
        db.prepare(
          `UPDATE clips SET status = 'failed', updated_at = ${now} WHERE id = ?`
        ).run(cid);
        db.prepare(
          `UPDATE clip_scripts SET status = 'failed', error_message = ?, updated_at = ${now} WHERE clip_id = ?`
        ).run(errorMessage ?? "任务最终失败", cid);
        break;
    }
  } else if (task.type === "generate_video") {
    const input = JSON.parse(task.input_json || "{}") as { storyboardId?: string };
    const storyboardId = task.storyboard_id ?? input.storyboardId;
    if (!storyboardId) return;
    switch (newStatus) {
      case "running":
        db.prepare(`UPDATE storyboards SET video_state = 'running', updated_at = ${now} WHERE id = ?`).run(storyboardId);
        break;
      case "running-pending":
        db.prepare(`UPDATE storyboards SET video_state = 'pending', updated_at = ${now} WHERE id = ?`).run(storyboardId);
        break;
      case "failed":
        db.prepare(`UPDATE storyboards SET video_state = 'failed', updated_at = ${now} WHERE id = ?`).run(storyboardId);
        break;
      case "success":
        // Handler 在同一事务内写入 generated video 和 ready 状态；这里不覆盖。
        break;
    }
  }
}

/** @deprecated 使用 transitionEntityStatus 代替 */
export function recoverEntityStatusOnFinalFail(
  db: DatabaseType,
  task: { id: string; type: string; clip_id: string | null; input_json: string }
): void {
  transitionEntityStatus(db, task, "failed", "任务最终失败");
}

export type WaitingRemoteTask = {
  id: string;
  type: string;
  remote_task_id: string;
  project_id: string;
};

/**
 * 获取 waiting_remote 状态的任务（用于恢复轮询）。
 *
 */
export function getWaitingRemoteTasks(db: DatabaseType): WaitingRemoteTask[] {
  return db
    .prepare(
      `SELECT id, type, remote_task_id, project_id FROM tasks WHERE status = 'waiting_remote'`
    )
    .all() as WaitingRemoteTask[];
}

/**
 * 获取 running 状态的任务数量。
 *
 */
export function getRunningTaskCount(db: DatabaseType): number {
  const result = db
    .prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'running'")
    .get() as { count: number };
  return result?.count ?? 0;
}

/**
 * 清理指定 workerId 持有的所有逻辑锁。
 *
 */
export function cleanupWorkerLocks(
  db: DatabaseType,
  workerId: string
): number {
  const pattern = `workerId:${workerId}%`;
  const result = db
    .prepare("DELETE FROM task_locks WHERE locked_by LIKE ?")
    .run(pattern);
  return result.changes;
}

/**
 * 仅恢复指定 Worker 仍持有锁的运行任务。
 *
 */
export function recoverRunningTasks(
  db: DatabaseType,
  workerId: string
): number {
  const ownerPattern = `workerId:${workerId}:%`;
  const recover = db.transaction(() => {
    const remoteResult = db
      .prepare(
        `UPDATE tasks SET status = 'waiting_remote', updated_at = datetime('now')
         WHERE status = 'running' AND remote_task_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM task_locks tl
             WHERE tl.lock_key = tasks.lock_key AND tl.locked_by LIKE ?
           )`
      )
      .run(ownerPattern);
    const localResult = db
      .prepare(
        `UPDATE tasks SET status = 'pending', updated_at = datetime('now')
         WHERE status = 'running' AND remote_task_id IS NULL
           AND EXISTS (
             SELECT 1 FROM task_locks tl
             WHERE tl.lock_key = tasks.lock_key AND tl.locked_by LIKE ?
           )`
      )
      .run(ownerPattern);
    cleanupWorkerLocks(db, workerId);
    return remoteResult.changes + localResult.changes;
  });

  return recover();
}

export function recoverTasksFromInactiveWorkers(db: DatabaseType): number {
  // 只能在已获得全局 Worker 租约、且尚未启动 TaskRunner 时调用：此时不存在
  // 其他活跃消费者，才能安全回收上一个 Worker 遗留的锁并重新排队任务。
  const recover = db.transaction(() => {
    const remoteResult = db.prepare(
      `UPDATE tasks SET status = 'waiting_remote', updated_at = datetime('now')
       WHERE status = 'running' AND remote_task_id IS NOT NULL`
    ).run();
    const localResult = db.prepare(
      `UPDATE tasks SET status = 'pending', updated_at = datetime('now')
       WHERE status = 'running' AND remote_task_id IS NULL`
    ).run();
    db.prepare("DELETE FROM task_locks").run();
    return remoteResult.changes + localResult.changes;
  });

  return recover();
}

/**
 * 恢复超时的 running 任务。
 */
export function recoverStaleTasks(db: DatabaseType, timeoutMs: number): number {
  // 有锁代表 handler 仍由当前 Worker 持有；即使它耗时较长，也不能删锁、回退
  // 为 pending，否则会被新的并发调度再次领取并重复调用模型。
  const result = db
    .prepare(
      `UPDATE tasks SET status = 'pending', updated_at = datetime('now')
       WHERE status = 'running' AND remote_task_id IS NULL
         AND (unixepoch(datetime('now')) - unixepoch(updated_at)) * 1000 > ?
         AND NOT EXISTS (
           SELECT 1 FROM task_locks tl WHERE tl.lock_key = tasks.lock_key
         )`
    )
    .run(timeoutMs);

  return result.changes;
}
