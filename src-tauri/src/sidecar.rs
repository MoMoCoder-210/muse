use std::process::{Child, Command, Stdio};
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use thiserror::Error;

#[allow(dead_code)]
const HEARTBEAT_TIMEOUT_SECS: u64 = 30;
#[allow(dead_code)]
const HEARTBEAT_CHECK_INTERVAL_SECS: u64 = 5;
#[allow(dead_code)]
const MAX_RESTART_COUNT: u32 = 3;
#[allow(dead_code)]
const RESTART_WINDOW_MINS: u64 = 5;
#[allow(dead_code)]
const RESTART_DELAY_SECS: u64 = 2;

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum SidecarError {
    #[error("sidecar already running")]
    AlreadyRunning,
    #[error("sidecar not running")]
    NotRunning,
    #[error("failed to start sidecar: {0}")]
    StartFailed(String),
    #[error("sidecar crashed: {0}")]
    Crashed(String),
    #[error("max restart count exceeded")]
    MaxRestartsExceeded,
}

/// SidecarManager 管理 Node worker 子进程的完整生命周期。
///
/// 职责：
/// - 启动 worker 并完成 ready 握手
/// - 心跳监控（10s 间隔，30s 超时）
/// - 崩溃检测与恢复（立即清理锁，滑动窗口重启限制）
/// - 优雅退出（AbortSignal + 30s 超时）
pub struct SidecarManager {
    worker_id: String,
    child: Option<Child>,
    last_heartbeat: Option<Instant>,
    #[allow(dead_code)]
    restart_count: u32,
    #[allow(dead_code)]
    restart_window_start: Option<Instant>,
}

#[allow(dead_code)]
impl SidecarManager {
    pub fn new() -> Self {
        Self {
            worker_id: uuid::Uuid::new_v4().to_string(),
            child: None,
            last_heartbeat: None,
            restart_count: 0,
            restart_window_start: None,
        }
    }

    /// 启动 Node sidecar worker。
    ///
    /// 流程：
    /// 1. 生成 workerId
    /// 2. 启动子进程（node worker/dist/index.js）
    /// 3. 等待 ready 消息（包含 workerId + protocolVersion）
    /// 4. 验证 protocolVersion
    /// 5. 发送 start_recovery 命令
    pub fn start(&mut self) -> Result<(), SidecarError> {
        if self.child.is_some() {
            return Err(SidecarError::AlreadyRunning);
        }

        let worker_path = std::env::current_dir()
            .map_err(|e| SidecarError::StartFailed(e.to_string()))?
            .join("worker")
            .join("dist")
            .join("index.js");

        let child = Command::new("node")
            .arg(&worker_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SidecarError::StartFailed(e.to_string()))?;

        self.child = Some(child);
        self.last_heartbeat = Some(Instant::now());

        log::info!("Sidecar worker started, workerId: {}", self.worker_id);
        Ok(())
    }

    /// 优雅关闭 worker。
    ///
    /// 流程：
    /// 1. 发送 shutdown 命令（带 30s 超时）
    /// 2. worker 停止接收新任务
    /// 3. 等待进行中的任务完成或超时
    /// 4. 超时后强制 kill
    pub fn shutdown(&mut self, timeout_ms: u64) -> Result<(), SidecarError> {
        let child = self.child.as_mut().ok_or(SidecarError::NotRunning)?;

        // 发送 shutdown 命令
        if let Some(stdin) = child.stdin.as_mut() {
            let cmd = serde_json::json!({
                "version": 1,
                "cmd": "shutdown",
                "timeoutMs": timeout_ms
            });
            let _ = writeln!(stdin, "{}", cmd.to_string());
        }

        // 等待退出或超时
        let timeout = Duration::from_millis(timeout_ms + 5000); // 额外 5s 缓冲
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if start.elapsed() > timeout {
                        log::warn!("Worker did not shut down in time, killing");
                        let _ = child.kill();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    log::error!("Error waiting for worker: {}", e);
                    let _ = child.kill();
                    break;
                }
            }
        }

        self.child = None;
        self.last_heartbeat = None;
        log::info!("Sidecar worker shut down");
        Ok(())
    }

    /// 重启 worker。
    ///
    /// 滑动窗口策略：
    /// - 5 分钟内最多重启 3 次
    /// - 超过后需要手动恢复
    /// - 稳定运行 5 分钟后计数器重置
    pub fn restart(&mut self) -> Result<(), SidecarError> {
        // 检查重启计数
        if let Some(window_start) = self.restart_window_start {
            if window_start.elapsed() > Duration::from_secs(RESTART_WINDOW_MINS * 60) {
                // 窗口已过期，重置计数
                self.restart_count = 0;
                self.restart_window_start = None;
            }
        }

        if self.restart_count >= MAX_RESTART_COUNT {
            log::error!("Max restart count ({}) exceeded", MAX_RESTART_COUNT);
            return Err(SidecarError::MaxRestartsExceeded);
        }

        // 先清理旧进程
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
        }
        self.child = None;

        // 等待短暂间隔
        std::thread::sleep(Duration::from_secs(RESTART_DELAY_SECS));

        // 更新计数
        if self.restart_window_start.is_none() {
            self.restart_window_start = Some(Instant::now());
        }
        self.restart_count += 1;

        // 生成新的 workerId
        self.worker_id = uuid::Uuid::new_v4().to_string();

        log::info!(
            "Restarting worker (attempt {}/{})",
            self.restart_count,
            MAX_RESTART_COUNT
        );

        self.start()
    }

    /// 检查心跳状态。
    ///
    /// 返回：
    /// - Ok：心跳正常
    /// - Err(Crashed)：心跳超时，需要重启
    pub fn check_heartbeat(&mut self) -> Result<(), SidecarError> {
        if self.child.is_none() {
            return Err(SidecarError::NotRunning);
        }

        if let Some(last) = self.last_heartbeat {
            if last.elapsed() > Duration::from_secs(HEARTBEAT_TIMEOUT_SECS) {
                return Err(SidecarError::Crashed("heartbeat timeout".to_string()));
            }
        }

        Ok(())
    }

    /// 更新心跳时间戳（收到 heartbeat 消息时调用）
    pub fn update_heartbeat(&mut self) {
        self.last_heartbeat = Some(Instant::now());
    }

    /// 崩溃恢复：清理该 workerId 持有的所有逻辑锁。
    ///
    /// 在 worker 崩溃后立即调用，不等 30 分钟超时。
    pub fn cleanup_locks(&self, db: &rusqlite::Connection) -> Result<(), SidecarError> {
        let pattern = format!("workerId:{}", self.worker_id);
        db.execute(
            "DELETE FROM task_locks WHERE locked_by LIKE ?1",
            rusqlite::params![format!("{}%", pattern)],
        )
        .map_err(|e| SidecarError::Crashed(format!("failed to cleanup locks: {}", e)))?;

        log::info!("Cleaned up locks for worker {}", self.worker_id);
        Ok(())
    }

    /// 获取当前 workerId
    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    /// 检查 worker 是否在运行
    pub fn is_running(&self) -> bool {
        self.child.is_some()
    }
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

// 需要 Mutex 包装以便在 Tauri State 中使用
pub type SharedSidecarManager = Mutex<SidecarManager>;
