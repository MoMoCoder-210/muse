/**
 * SQLite 数据库连接管理
 * 基于 better-sqlite3，启用 WAL 模式支持多进程并发访问
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";

/**
 * 初始化 SQLite 数据库连接。
 *
 * 必须设置 WAL 模式和 busy_timeout，以支持 Node worker 和 Tauri Rust 层的多进程并发访问。
 * 详见模块 09 第 3.11 节 "SQLite 多进程访问规范"。
 *
 * @author yt @date 20260702
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
 *
 * 查询所有 status = 'pending' 且 lockKey 未被占用的 Task，按 createdAt 排序。
 *
 * @author yt @date 20260702
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
       ORDER BY t.created_at ASC`
    )
    .all() as PendingTask[];
}

/**
 * 尝试获取逻辑锁。
 *
 * @author yt @date 20260702
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
 * @author yt @date 20260702
 */
export function releaseLock(db: DatabaseType, lockKey: string): void {
  db.prepare("DELETE FROM task_locks WHERE lock_key = ?").run(lockKey);
}

/**
 * 标记任务为 running。
 *
 * @author yt @date 20260702
 */
export function markTaskRunning(db: DatabaseType, taskId: string): void {
  db.prepare(
    "UPDATE tasks SET status = 'running', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(taskId);
}

/**
 * 标记任务为 waiting_remote。
 *
 * @author yt @date 20260702
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
 * @author yt @date 20260702
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
 * @author yt @date 20260702
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

export type WaitingRemoteTask = {
  id: string;
  type: string;
  remote_task_id: string;
  project_id: string;
};

/**
 * 获取 waiting_remote 状态的任务（用于恢复轮询）。
 *
 * @author yt @date 20260702
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
 * @author yt @date 20260702
 */
export function getRunningTaskCount(db: DatabaseType): number {
  const result = db
    .prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'running'")
    .get() as { count: number };
  return result?.count ?? 0;
}

/**
 * 清理指定 workerId 持有的所有逻辑锁。
 * 在 worker 崩溃后立即调用。
 *
 * @author yt @date 20260702
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
 * - 本地任务：running → pending
 * - 远端任务：running → waiting_remote（有 remoteTaskId）
 *
 * @author yt @date 20260702
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
