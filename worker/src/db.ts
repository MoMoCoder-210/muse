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
 * 尝试获取逻辑锁。
 *
 */
export function acquireLock(
  db: DatabaseType,
  lockKey: string,
  lockedBy: string
): boolean {
  try {
    db.prepare(
      "INSERT INTO task_locks (lock_key, locked_by) VALUES (?, ?)"
    ).run(lockKey, lockedBy);
    return true;
  } catch {
    return false;
  }
}

/**
 * 释放逻辑锁。
 *
 */
export function releaseLock(db: DatabaseType, lockKey: string): void {
  db.prepare("DELETE FROM task_locks WHERE lock_key = ?").run(lockKey);
}

/**
 * 标记任务为 running。
 *
 */
export function markTaskRunning(db: DatabaseType, taskId: string): void {
  db.prepare(
    "UPDATE tasks SET status = 'running', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(taskId);
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
  task: { type: string; clip_id: string | null; input_json: string },
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
 * 重启恢复：将 running 状态的任务回退。
 *
 */
export function recoverRunningTasks(
  db: DatabaseType,
  workerId: string
): number {
  // 先清理该 worker 的锁
  cleanupWorkerLocks(db, workerId);

  // 远端任务（有 remoteTaskId）：running → waiting_remote
  const remoteResult = db
    .prepare(
      `UPDATE tasks SET status = 'waiting_remote', updated_at = datetime('now')
       WHERE status = 'running' AND remote_task_id IS NOT NULL`
    )
    .run();

  // 本地任务（无 remoteTaskId）：running → pending
  const localResult = db
    .prepare(
      `UPDATE tasks SET status = 'pending', updated_at = datetime('now')
       WHERE status = 'running' AND remote_task_id IS NULL`
    )
    .run();

  return remoteResult.changes + localResult.changes;
}

/**
 * 恢复超时的 running 任务。
 */
export function recoverStaleTasks(db: DatabaseType, timeoutMs: number): number {
  // 先清理超时任务的锁
  db.prepare(
    `DELETE FROM task_locks WHERE lock_key IN (
       SELECT lock_key FROM tasks
       WHERE status = 'running' AND remote_task_id IS NULL
         AND (unixepoch(datetime('now')) - unixepoch(updated_at)) * 1000 > ?
     )`
  ).run(timeoutMs);

  // 回退超时任务
  const result = db
    .prepare(
      `UPDATE tasks SET status = 'pending', updated_at = datetime('now')
       WHERE status = 'running' AND remote_task_id IS NULL
         AND (unixepoch(datetime('now')) - unixepoch(updated_at)) * 1000 > ?`
    )
    .run(timeoutMs);

  return result.changes;
}
