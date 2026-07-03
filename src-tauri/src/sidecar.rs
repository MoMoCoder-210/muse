//! @author yt @date 20260702 Sidecar 子进程管理

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
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

/// @author yt @date 20260702 Sidecar 错误类型
#[derive(Debug, Error)]
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

type LogLineProcessor = Box<dyn Fn(&str) + Send + 'static>;

/// @author yt @date 20260702 启动日志读取线程
fn spawn_log_reader<R: std::io::Read + Send + 'static>(
    stream: R,
    log_path: Arc<std::path::PathBuf>,
    default_source: &'static str,
    default_level: &'static str,
    process_line: Option<LogLineProcessor>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Some(ref processor) = process_line {
                        processor(trimmed);
                    } else {
                        crate::project_log::append_log(&log_path, default_source, default_level, trimmed);
                    }
                }
                Err(_) => break,
            }
        }
    })
}

/// @author yt @date 20260702 解析 stdout 行内容
///
/// 返回 Option<&str>：heartbeat 消息返回 Some("heartbeat")，调用方可据此更新心跳时间戳。
fn parse_stdout_line<'a>(
    log_path: &Arc<std::path::PathBuf>,
    text: &'a str,
) -> Option<&'a str> {
    if let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) {
        let msg_type = msg.get("msg").and_then(|v| v.as_str()).unwrap_or("");
        match msg_type {
            "heartbeat" => {
                // 返回标记，调用方应更新心跳时间戳
                return Some("heartbeat");
            }
            "batch_progress" | "quota_exhausted" | "shutting_down" => {}
            "ready" => {
                let wid = msg.get("workerId").and_then(|v| v.as_str()).unwrap_or("?");
                crate::project_log::append_log(log_path, "主进程", "INFO", &format!("Worker 就绪，workerId={}", wid));
            }
            "task_event" => {
                if let Some(event) = msg.get("event") {
                    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let task_id = event.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
                    match event_type {
                        "task_started" => {
                            let task_type = event.get("taskType").and_then(|v| v.as_str()).unwrap_or("");
                            crate::project_log::append_log(log_path, "任务调度", "INFO", &format!("开始执行任务 taskId={} type={}", task_id, task_type));
                        }
                        "task_success" => {
                            crate::project_log::append_log(log_path, "任务调度", "INFO", &format!("任务成功 taskId={}", task_id));
                        }
                        "task_failed" => {
                            let err = event.get("errorMessage").and_then(|v| v.as_str()).unwrap_or("");
                            crate::project_log::append_log(log_path, "任务调度", "ERROR", &format!("任务失败 taskId={} 错误={}", task_id, err));
                        }
                        _ => {}
                    }
                }
            }
            "log" => {
                let level = msg.get("level").and_then(|v| v.as_str()).unwrap_or("INFO");
                let message = msg.get("message").and_then(|v| v.as_str()).unwrap_or("");
                crate::project_log::append_log(log_path, "主进程", &level.to_uppercase(), message);
            }
            "error" => {
                let message = msg.get("message").and_then(|v| v.as_str()).unwrap_or("unknown error");
                crate::project_log::append_log(log_path, "主进程", "ERROR", message);
            }
            _ => {
                crate::project_log::append_log(log_path, "主进程(stdout)", "INFO", text);
            }
        }
    } else {
        crate::project_log::append_log(log_path, "主进程(stdout)", "INFO", text);
    }
    None
}

/// SidecarManager 管理 Node worker 子进程的完整生命周期。
///
/// 职责：
/// - 启动 worker 并完成 ready 握手
/// - 心跳监控（10s 间隔，30s 超时）
/// - 崩溃检测与恢复（立即清理锁，滑动窗口重启限制）
/// - 优雅退出（AbortSignal + 30s 超时）
/// @author yt @date 20260702
pub struct SidecarManager {
    worker_id: String,
    child: Option<Child>,
    /// 心跳时间戳，由 stdout 读取线程在收到 heartbeat 消息时更新
    last_heartbeat: Arc<Mutex<Option<Instant>>>,
    #[allow(dead_code)]
    restart_count: u32,
    #[allow(dead_code)]
    restart_window_start: Option<Instant>,
    // 启动参数，重启时复用
    db_path: String,
    workspace_path: String,
    config_path: String,
    log_path: String,
    // stderr 读取线程，shutdown 时 join
    log_handles: Vec<JoinHandle<()>>,
}

#[allow(dead_code)]
impl SidecarManager {
    pub fn new() -> Self {
        Self {
            worker_id: uuid::Uuid::new_v4().to_string(),
            child: None,
            last_heartbeat: Arc::new(Mutex::new(None)),
            restart_count: 0,
            restart_window_start: None,
            db_path: String::new(),
            workspace_path: String::new(),
            config_path: String::new(),
            log_path: String::new(),
            log_handles: Vec::new(),
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
    /// @author yt @date 20260702
    pub fn start(&mut self, db_path: &str, workspace_path: &str, config_path: &str, log_path: &str) -> Result<(), SidecarError> {
        if self.child.is_some() {
            return Err(SidecarError::AlreadyRunning);
        }

        // 保存参数供 restart() 复用
        self.db_path = db_path.to_string();
        self.workspace_path = workspace_path.to_string();
        self.config_path = config_path.to_string();
        self.log_path = log_path.to_string();

        // 解析 worker 脚本路径
        // Tauri dev 模式下 current_dir() 是 src-tauri/，需要回退到项目根目录
        let cwd = std::env::current_dir()
            .map_err(|e| SidecarError::StartFailed(e.to_string()))?;
        let worker_path = {
            let primary = cwd.join("worker").join("dist").join("index.js");
            if primary.exists() {
                primary
            } else {
                let fallback = cwd.parent()
                    .unwrap_or(&cwd)
                    .join("worker")
                    .join("dist")
                    .join("index.js");
                fallback
            }
        };

        // 启动前检查 worker 文件是否存在，避免静默失败
        if !worker_path.exists() {
            let msg = format!("Worker 脚本不存在：{}", worker_path.display());
            if !log_path.is_empty() {
                crate::project_log::append_log(Path::new(log_path), "子进程", "ERROR", &msg);
            }
            return Err(SidecarError::StartFailed(msg));
        }

        log::info!("Worker 脚本路径：{}", worker_path.display());

        let mut child = Command::new("node")
            .arg(&worker_path)
            .args(["--db", db_path])
            .args(["--workspace", workspace_path])
            .args(["--config", config_path])
            .args(["--log", log_path])
            .env("LOG_LEVEL", "debug")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SidecarError::StartFailed(format!("Failed to spawn node: {}", e)))?;

        // 启动 stderr 读取线程 → 写入项目日志文件
        if let Some(stderr) = child.stderr.take() {
            let log_path_arc: Arc<std::path::PathBuf> = Arc::new(std::path::PathBuf::from(log_path));
            let handle = spawn_log_reader(stderr, log_path_arc, "worker:stderr", "ERROR", None);
            self.log_handles.push(handle);
        }

        // 启动 stdout 读取线程 → 解析协议消息，非 JSON 行写入日志
        if let Some(stdout) = child.stdout.take() {
            let log_path_arc: Arc<std::path::PathBuf> = Arc::new(std::path::PathBuf::from(log_path));
            let log_path_clone = log_path_arc.clone();
            let hb = self.last_heartbeat.clone();
            let processor: LogLineProcessor = Box::new(move |text: &str| {
                if let Some("heartbeat") = parse_stdout_line(&log_path_clone, text).as_deref() {
                    // 收到心跳，更新时间戳
                    if let Ok(mut ts) = hb.lock() {
                        *ts = Some(Instant::now());
                    }
                }
            });
            let handle = spawn_log_reader(stdout, log_path_arc, "主进程(stdout)", "INFO", Some(processor));
            self.log_handles.push(handle);
        }

        self.child = Some(child);
        // 初始化心跳时间戳
        {
            let mut ts = self.last_heartbeat.lock().unwrap_or_else(|e| e.into_inner());
            *ts = Some(Instant::now());
        }

        if !log_path.is_empty() {
            crate::project_log::append_log(
                Path::new(log_path),
                "子进程",
                "INFO",
                &format!("Worker 已启动，workerId={}", self.worker_id),
            );
        }
        log::info!("子进程已启动，workerId: {}", self.worker_id);
        Ok(())
    }

    /// 优雅关闭 worker。
    ///
    /// 流程：
    /// 1. 发送 shutdown 命令（带 30s 超时）
    /// 2. worker 停止接收新任务
    /// 3. 等待进行中的任务完成或超时
    /// 4. 超时后强制 kill
    /// @author yt @date 20260702
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
                        log::warn!("Worker 未按时关闭，强制终止");
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
        {
            let mut ts = self.last_heartbeat.lock().unwrap_or_else(|e| e.into_inner());
            *ts = None;
        }

        // 等待日志读取线程结束（子进程退出后管道关闭，线程会自动退出）
        for handle in self.log_handles.drain(..) {
            let _ = handle.join();
        }

        if !self.log_path.is_empty() {
            crate::project_log::append_log(
                Path::new(&self.log_path),
                "子进程",
                "INFO",
                "Worker 已关闭",
            );
        }
        log::info!("子进程已关闭");
        Ok(())
    }

    /// 重启 worker。
    ///
    /// 滑动窗口策略：
    /// - 5 分钟内最多重启 3 次
    /// - 超过后需要手动恢复
    /// - 稳定运行 5 分钟后计数器重置
    /// @author yt @date 20260702
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
            log::error!("超过最大重启次数（{}）", MAX_RESTART_COUNT);
            return Err(SidecarError::MaxRestartsExceeded);
        }

        // 先清理旧进程
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
        }
        self.child = None;

        // 等待旧的日志读取线程结束
        for handle in self.log_handles.drain(..) {
            let _ = handle.join();
        }

        // 等待短暂间隔
        std::thread::sleep(Duration::from_secs(RESTART_DELAY_SECS));

        // 更新计数
        if self.restart_window_start.is_none() {
            self.restart_window_start = Some(Instant::now());
        }
        self.restart_count += 1;

        // 生成新的 workerId 和心跳时间戳
        self.worker_id = uuid::Uuid::new_v4().to_string();
        self.last_heartbeat = Arc::new(Mutex::new(None));

        log::info!(
            "重启 Worker（第 {}/{} 次）",
            self.restart_count,
            MAX_RESTART_COUNT
        );

        let db = self.db_path.clone();
        let workspace = self.workspace_path.clone();
        let config = self.config_path.clone();
        let log_path = self.log_path.clone();
        self.start(&db, &workspace, &config, &log_path)
    }
    /// 返回：
    /// - Ok：心跳正常
    /// - Err(Crashed)：心跳超时，需要重启
    /// @author yt @date 20260702
    pub fn check_heartbeat(&mut self) -> Result<(), SidecarError> {
        if self.child.is_none() {
            return Err(SidecarError::NotRunning);
        }

        let ts = self.last_heartbeat.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(last) = *ts {
            if last.elapsed() > Duration::from_secs(HEARTBEAT_TIMEOUT_SECS) {
                return Err(SidecarError::Crashed("heartbeat timeout".to_string()));
            }
        }

        Ok(())
    }

    /// 更新心跳时间戳（收到 heartbeat 消息时调用）
    /// 注意：现在由 stdout 读取线程自动更新，此方法保留用于手动场景。
    /// @author yt @date 20260702
    pub fn update_heartbeat(&mut self) {
        let mut ts = self.last_heartbeat.lock().unwrap_or_else(|e| e.into_inner());
        *ts = Some(Instant::now());
    }

    /// 崩溃恢复：清理该 workerId 持有的所有逻辑锁。
    ///
    /// 在 worker 崩溃后立即调用，不等 30 分钟超时。
    /// @author yt @date 20260702
    pub fn cleanup_locks(&self, db: &rusqlite::Connection) -> Result<(), SidecarError> {
        let pattern = format!("workerId:{}", self.worker_id);
        db.execute(
            "DELETE FROM task_locks WHERE locked_by LIKE ?1",
            rusqlite::params![format!("{}%", pattern)],
        )
        .map_err(|e| SidecarError::Crashed(format!("failed to cleanup locks: {}", e)))?;

        log::info!("已清理 Worker {} 的锁", self.worker_id);
        Ok(())
    }

    /// 发送 reload_config 命令给 worker
    /// @author yt @date 20260702
    pub fn send_reload_config(&mut self) -> Result<(), SidecarError> {
        let child = self.child.as_mut().ok_or(SidecarError::NotRunning)?;
        if let Some(stdin) = child.stdin.as_mut() {
            let cmd = serde_json::json!({ "version": 1, "cmd": "reload_config" });
            let _ = writeln!(stdin, "{}", cmd);
        }
        Ok(())
    }

    /// 发送 enqueue 命令，通知 Worker 立即调度任务。
    /// @author yt @date 20260703
    pub fn send_enqueue(&mut self, task_id: &str, task_type: &str) -> Result<(), SidecarError> {
        let child = self.child.as_mut().ok_or(SidecarError::NotRunning)?;
        if let Some(stdin) = child.stdin.as_mut() {
            let cmd = serde_json::json!({ "version": 1, "cmd": "enqueue", "taskId": task_id, "taskType": task_type });
            let _ = writeln!(stdin, "{}", cmd);
        }
        Ok(())
    }

    /// 发送 cancel 命令，通知 Worker 中止指定任务。
    /// @author yt @date 20260703
    pub fn send_cancel(&mut self, task_id: &str) -> Result<(), SidecarError> {
        let child = self.child.as_mut().ok_or(SidecarError::NotRunning)?;
        if let Some(stdin) = child.stdin.as_mut() {
            let cmd = serde_json::json!({ "version": 1, "cmd": "cancel", "taskId": task_id });
            let _ = writeln!(stdin, "{}", cmd);
        }
        Ok(())
    }

    /// 获取当前 workerId
    /// @author yt @date 20260702
    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    /// 检查 worker 是否在运行
    /// @author yt @date 20260702
    pub fn is_running(&self) -> bool {
        self.child.is_some()
    }

    pub fn matches_runtime(&self, db_path: &str, workspace_path: &str, config_path: &str, log_path: &str) -> bool {
        self.child.is_some()
            && self.db_path == db_path
            && self.workspace_path == workspace_path
            && self.config_path == config_path
            && self.log_path == log_path
    }
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

// 需要 Mutex 包装以便在 Tauri State 中使用
pub type SharedSidecarManager = Mutex<SidecarManager>;
