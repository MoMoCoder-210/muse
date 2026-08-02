//! 镜头视频超分任务管理器。
//!
//! 设计目标：**超分任务的状态/队列/执行/进度以本模块为唯一事实来源**。
//! - 前端只负责展示与触发（订阅事件 + 调用命令），不再自行维护队列/状态机；
//! - 所有任务统一由单个 worker 串行消费，同一时刻只有一个超分在跑；
//! - 任务状态持久化到 `upscale_jobs` 表，应用重启后从 DB 恢复未完成任务入队续跑；
//! - 状态变化统一广播 `upscale-changed` 事件（携带变更后的任务），前端据此渲染。

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::util;
use crate::commands::video::{run_upscale_blocking, UpscaleVideoInput};

/// 写入超分项目日志（muse.log，source=视频超分）。
/// 日志为尽力型操作，失败不影响主流程。
fn log_upscale(app: &AppHandle, level: &str, message: &str) {
    log::info!("[超分] {} {}", level, message);
    if let Ok(app_data_dir) = crate::app_paths::resolve_app_data_dir(app) {
        let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
        crate::project_log::append_log(&log_path, "视频超分", level, message);
    }
}

/// 任务展示名（job id 前 8 位 + 源文件名）
fn job_label(job: &UpscaleJob) -> String {
    let fname = Path::new(&job.input_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("?");
    format!("{}[{}]", &job.id[..job.id.len().min(8)], fname)
}

/// 超分任务状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpscaleJobStatus {
    /// 排队等待执行
    Queued,
    /// 正在执行
    Running,
    /// 成功完成
    Done,
    /// 执行失败（可保留临时目录供下次续跑）
    Failed,
    /// 用户主动取消（已清理）
    Cancelled,
}

impl UpscaleJobStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
    fn from_str(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Queued,
        }
    }
}

/// 超分任务（对前端公开的结构；storyboard_id/video_id 仅序列化给前端定位批次）
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct UpscaleJob {
    /// 任务 id（= job_id，也是临时目录后缀）
    pub id: String,
    pub storyboard_id: String,
    pub video_id: String,
    pub input_path: String,
    pub output_path: String,
    pub model: String,
    pub scale: u32,
    pub status: UpscaleJobStatus,
    /// 进度 0-100
    pub percent: f64,
    pub stage: String,
    pub error: Option<String>,
    pub created_at: String,
}

/// 内部执行上下文（每个任务独立取消标志，避免互相干扰）
struct JobContext {
    job: UpscaleJob,
    cancel: Arc<AtomicBool>,
}

/// 任务管理器（Tauri managed state）
pub struct UpscaleManager {
    inner: Mutex<Inner>,
    app: AppHandle,
}

struct Inner {
    /// 全量任务（含终态），顺序 = 创建顺序
    jobs: Vec<UpscaleJob>,
    /// 待执行队列（job id）
    queue: VecDeque<String>,
    /// 正在执行的任务（同一时刻至多一个）
    active: Option<JobContext>,
    /// worker 是否已启动
    started: bool,
}

/// 任务创建入参
#[derive(Debug, Deserialize)]
pub struct UpscaleEnqueueInput {
    pub storyboard_id: String,
    pub video_id: String,
    /// 模型：anime / x4plus / x4plus-anime
    #[serde(default = "default_model")]
    pub model: String,
    /// 放大倍数：2/3/4（x4plus 系列固定 4x，忽略该值）
    #[serde(default = "default_scale")]
    pub scale: u32,
}

fn default_model() -> String {
    "anime".to_string()
}
fn default_scale() -> u32 {
    4
}

impl UpscaleManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Mutex::new(Inner {
                jobs: Vec::new(),
                queue: VecDeque::new(),
                active: None,
                started: false,
            }),
            app,
        }
    }

    /// 启动 worker + 从 DB 恢复未完成任务。
    ///
    /// 只应调用一次（应用 setup 中）。恢复逻辑：
    /// 1. 查询 DB 中 status in ('queued','running') 的任务；
    /// 2. 将它们的目录视为断点（续跑时跳过已完成阶段），重新入队；
    /// 3. 启动 worker 串行执行。
    pub fn start(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.started {
            return;
        }
        inner.started = true;

    // 从 DB 恢复未完成任务
    let mut recovered = 0usize;
    if let Ok(conn) = util::open_app_conn(&self.app) {
        let sql = "SELECT id, storyboard_id, video_id, input_path, output_path, model, scale, status, created_at
                   FROM upscale_jobs WHERE status IN ('queued','running') ORDER BY created_at";
        if let Ok(mut stmt) = conn.prepare(sql) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, u32>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            }) {
                for row in rows.flatten() {
                    let (id, sb_id, vid_id, input_path, output_path, model, scale, status, created_at) = row;
                    // DB 里 running 视为中断，入队续跑（keep_on_error=true 保留目录）
                    let status = if status == "running" {
                        UpscaleJobStatus::Queued
                    } else {
                        UpscaleJobStatus::from_str(&status)
                    };
                    inner.jobs.push(UpscaleJob {
                        id: id.clone(),
                        storyboard_id: sb_id,
                        video_id: vid_id,
                        input_path: input_path.clone(),
                        output_path,
                        model,
                        scale,
                        status,
                        percent: 0.0,
                        stage: "排队中…".to_string(),
                        error: None,
                        created_at,
                    });
                    inner.queue.push_back(id.clone());
                    recovered += 1;
                    log_upscale(
                        &self.app,
                        "INFO",
                        &format!(
                            "启动恢复未完成任务：job={} 输入={}（断点续跑）",
                            &id[..id.len().min(8)],
                            input_path
                        ),
                    );
                }
            }
        }
    }
    drop(inner);
    if recovered > 0 {
        log_upscale(&self.app, "INFO", &format!("共恢复 {} 个未完成超分任务", recovered));
    }

        // 启动 worker：单线程串行消费队列（长循环，用系统线程而非 async）
        let manager = self.app.clone();
        std::thread::spawn(move || {
            loop {
                let next = {
                    let mgr = manager.state::<UpscaleManager>();
                    let mut inner = mgr.inner.lock().unwrap();
                    let id = inner.queue.pop_front();
                    if let Some(id) = id {
                        let job = inner.jobs.iter().find(|j| j.id == id).cloned();
                        if let Some(job) = job {
                            let cancel = Arc::new(AtomicBool::new(false));
                            inner.active = Some(JobContext {
                                job: job.clone(),
                                cancel: cancel.clone(),
                            });
                            // 标记 running 并广播
                            if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == id) {
                                j.status = UpscaleJobStatus::Running;
                                j.stage = "准备中…".to_string();
                            }
                            let job_snapshot = inner.active.as_ref().unwrap().job.clone();
                            drop(inner);
                            log_upscale(
                                &manager,
                                "INFO",
                                &format!(
                                    "开始超分：{} model={} scale={}x",
                                    job_label(&job),
                                    job.model,
                                    job.scale
                                ),
                            );
                            broadcast_change(&manager, &job_snapshot, false);
                            Some((id, job))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some((id, job)) = next {
                    execute_one(&manager, &id, &job);
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
        });
    }
}

/// 执行单个任务（worker 内部，同步执行）
fn execute_one(app: &AppHandle, job_id: &str, job: &UpscaleJob) {
    let cancel = {
        let mgr = app.state::<UpscaleManager>();
        let inner = mgr.inner.lock().unwrap();
        match inner.active.as_ref() {
            Some(ctx) if ctx.job.id == job_id => ctx.cancel.clone(),
            _ => Arc::new(AtomicBool::new(false)),
        }
    };

    let input = UpscaleVideoInput {
        input_path: job.input_path.clone(),
        output_path: job.output_path.clone(),
        model: job.model.clone(),
    };
    let scale = job.scale;
    let job_id2 = job_id.to_string();

    // 进度回调：更新内存 + 广播事件（不落 DB 每次进度，避免高频写库）
    let app_p = app.clone();
    let job_id_p = job_id2.clone();
    let on_progress: std::sync::Arc<
        dyn Fn(f64, &str) + Send + Sync,
    > = std::sync::Arc::new(move |percent, stage| {
        let mgr = app_p.state::<UpscaleManager>();
        let mut inner = mgr.inner.lock().unwrap();
        if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id_p) {
            j.percent = percent.min(100.0);
            j.stage = stage.to_string();
        }
        let snapshot = inner.jobs.iter().find(|j| j.id == job_id_p).cloned();
        drop(inner);
        if let Some(s) = snapshot {
            broadcast_change(&app_p, &s, false);
        }
    });

    // 同步执行（worker 线程中直接阻塞运行，无需再套子线程）
    // keep_on_error=false：失败即清理临时目录，避免残留；
    // 仅当进程被强制关闭（DB 仍是 running）时目录天然保留，下次启动恢复续跑。
    let result = run_upscale_blocking(
        input,
        app.clone(),
        scale,
        job_id2,
        false,
        cancel,
        on_progress,
    );

    let mgr = app.state::<UpscaleManager>();
    let mut inner = mgr.inner.lock().unwrap();
    inner.active = None;
    match result {
        Ok((_upscale_result, _outcome)) => {
            if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
                j.status = UpscaleJobStatus::Done;
                j.percent = 100.0;
                j.stage = "完成".to_string();
            }
            // 落库为新批次 + 更新任务状态
            let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
            drop(inner);
            finalize_success(app, &job, &snapshot.unwrap_or(job.clone()));
        }
        Err(e) => {
            let status = if e.contains("已取消") {
                UpscaleJobStatus::Cancelled
            } else {
                UpscaleJobStatus::Failed
            };
            if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
                j.status = status;
                j.error = Some(e.clone());
                if j.status == UpscaleJobStatus::Cancelled {
                    j.percent = 0.0;
                    j.stage = "已取消".to_string();
                } else {
                    j.stage = format!("失败：{}", e);
                }
            }
            let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
            drop(inner);
            // 日志：取消 / 失败（含错误信息，便于排查）
            let level = if status == UpscaleJobStatus::Cancelled {
                "WARN"
            } else {
                "ERROR"
            };
            let msg = if status == UpscaleJobStatus::Cancelled {
                format!("超分已取消：{}", job_label(&job))
            } else {
                format!("超分失败：{} 错误={}", job_label(&job), e)
            };
            log_upscale(app, level, &msg);
            if let Some(s) = snapshot {
                // 更新 DB 状态 + 删除未产出的超分批次（该批次无真实文件，保留只会是空批次）
                if let Ok(conn) = util::open_app_conn(app) {
                    let _ = conn.execute(
                        "UPDATE upscale_jobs SET status=?1, error_message=?2, updated_at=datetime('now') WHERE id=?3",
                        rusqlite::params![status.as_str(), &e, job_id],
                    );
                    let _ = conn.execute(
                        "DELETE FROM storyboard_videos WHERE id=?1 AND source='upscale'",
                        rusqlite::params![&job.video_id],
                    );
                }
                broadcast_change(app, &s, true);
            }
        }
    }
}

/// 续跑成功：更新 DB 任务状态 + 落库为新批次 + 广播完成事件
fn finalize_success(app: &AppHandle, job: &UpscaleJob, snapshot: &UpscaleJob) {
    log_upscale(
        app,
        "INFO",
        &format!(
            "超分完成：{} → {} model={} scale={}x",
            job_label(job),
            job.output_path,
            job.model,
            job.scale
        ),
    );
    if let Ok(conn) = util::open_app_conn(app) {
        let _ = conn.execute(
            "UPDATE upscale_jobs SET status='done', updated_at=datetime('now') WHERE id=?1",
            rusqlite::params![&job.id],
        );
        // 批次已在 enqueue 时落库（video_id 指向它），产物文件已生成，
        // 无需重复插入；确保批次 file_path 指向最终产物即可。
        let _ = conn.execute(
            "UPDATE storyboard_videos SET file_path=?1, file_name=?2 WHERE id=?3",
            rusqlite::params![
                &job.output_path,
                Path::new(&job.output_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&job.output_path),
                &job.video_id,
            ],
        );
    }
    broadcast_change(app, snapshot, true);
}

/// 广播任务状态变化事件
fn broadcast_change(app: &AppHandle, job: &UpscaleJob, is_final: bool) {
    let _ = app.emit("upscale-changed", job.clone());
    // 完成/失败/取消时额外广播 done 事件（前端据此刷新视频列表）
    if is_final && job.status != UpscaleJobStatus::Running && job.status != UpscaleJobStatus::Queued
    {
        let _ = app.emit(
            "upscale-done",
            UpscaleDonePayload {
                storyboard_id: job.storyboard_id.clone(),
                video_id: job.video_id.clone(),
                result_id: if job.status == UpscaleJobStatus::Done {
                    job.video_id.clone() // 批次 id（enqueue 时真实落库，前端可直接定位产物）
                } else {
                    String::new()
                },
                status: job.status,
                output_path: job.output_path.clone(),
                file_name: Path::new(&job.output_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string(),
            },
        );
    }
}

/// 完成/失败/取消事件载荷
#[derive(Debug, Clone, Serialize)]
pub struct UpscaleDonePayload {
    pub storyboard_id: String,
    pub video_id: String,
    pub result_id: String,
    pub status: UpscaleJobStatus,
    pub output_path: String,
    pub file_name: String,
}

/// 入队超分任务。
///
/// 创建任务（写 DB）→ 放入队列 → 广播 queued 事件。worker 串行消费。
#[tauri::command]
pub fn enqueue_upscale(
    input: UpscaleEnqueueInput,
    app: AppHandle,
) -> Result<UpscaleJob, String> {
    // x4plus 系列固定 4x
    let scale = if input.model == "x4plus" || input.model == "x4plus-anime" {
        4
    } else {
        match input.scale {
            2 | 3 | 4 => input.scale,
            _ => 4,
        }
    };

    // 查询源视频
    let conn = util::open_app_conn(&app)?;
    let file_path: String = conn
        .query_row(
            "SELECT file_path FROM storyboard_videos
             WHERE id = ?1 AND storyboard_id = ?2",
            rusqlite::params![&input.video_id, &input.storyboard_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("查询镜头视频失败：{}", e))?;

    // 生成输出路径（随机名，避免覆盖）
    let src_path = Path::new(&file_path);
    let out_path = match (src_path.parent(), src_path.file_name()) {
        (Some(parent), Some(name)) => {
            let name = name.to_string_lossy().to_string();
            let (base, ext) = match name.rsplit_once('.') {
                Some((b, e)) if !e.is_empty() => (b.to_string(), format!(".{e}")),
                _ => (name, ".mp4".to_string()),
            };
            let rand = &uuid::Uuid::new_v4().to_string()[..8];
            parent.join(format!("{base}_up{scale}x_{rand}{ext}"))
        }
        _ => return Err("无法解析源视频路径".to_string()),
    };
    let out_path_str = out_path.to_string_lossy().to_string();

    // ── 核心架构：先真实落库一个「超分批次」到 storyboard_videos（source='upscale'），
    // 任务（upscale_jobs.video_id）指向该新批次，而非源视频。
    // 这样前端批次列表/预览区始终指向同一个稳定 id，任务状态只影响渲染
    // （排队中 → 超分中 → 完成），不会出现「假批次 id 随状态变化导致预览丢失」。
    let batch_id = uuid::Uuid::new_v4().to_string();
    let out_file_name = Path::new(&out_path_str)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&out_path_str)
        .to_string();
    conn.execute(
        "INSERT INTO storyboard_videos (id, storyboard_id, file_path, file_name, source)
         VALUES (?1, ?2, ?3, ?4, 'upscale')",
        rusqlite::params![&batch_id, &input.storyboard_id, &out_path_str, &out_file_name],
    )
    .map_err(|e| format!("创建超分批次失败：{}", e))?;

    // 写 DB（任务 video_id 指向新批次）；created_at 由 DB 生成后读回，
    // 保证内存与 DB 一致（前端用于排序/展示）。
    let job_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO upscale_jobs (id, storyboard_id, video_id, input_path, output_path, model, scale, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', datetime('now'))",
        rusqlite::params![
            &job_id,
            &input.storyboard_id,
            &batch_id,
            &file_path,
            &out_path_str,
            &input.model,
            scale,
        ],
    )
    .map_err(|e| format!("保存超分任务失败：{}", e))?;
    let created_at: String = conn
        .query_row(
            "SELECT created_at FROM upscale_jobs WHERE id = ?1",
            rusqlite::params![&job_id],
            |row| row.get(0),
        )
        .unwrap_or_default();

    let job = UpscaleJob {
        id: job_id.clone(),
        storyboard_id: input.storyboard_id.clone(),
        video_id: batch_id,
        input_path: file_path,
        output_path: out_path_str,
        model: input.model,
        scale,
        status: UpscaleJobStatus::Queued,
        percent: 0.0,
        stage: "排队中…".to_string(),
        error: None,
        created_at,
    };

    // 加入内存队列
    let mgr = app.state::<UpscaleManager>();
    let mut inner = mgr.inner.lock().unwrap();
    inner.jobs.push(job.clone());
    inner.queue.push_back(job_id);
    drop(inner);
    log_upscale(
        &app,
        "INFO",
        &format!(
            "收到超分请求：{} model={} scale={}x（排队等待执行）",
            job_label(&job),
            job.model,
            job.scale
        ),
    );
    broadcast_change(&app, &job, false);

    Ok(job)
}

/// 查询全量超分任务（前端启动时用于恢复状态）
#[tauri::command]
pub fn list_upscale_jobs(app: AppHandle) -> Result<Vec<UpscaleJob>, String> {
    let mgr = app.state::<UpscaleManager>();
    let inner = mgr.inner.lock().unwrap();
    Ok(inner.jobs.clone())
}

/// 取消超分任务。
///
/// - 排队中：直接从队列移除，标记 cancelled；
/// - 运行中：置取消标志（worker 轮询到后终止），标记 cancelled；
/// - 已完成/已失败：忽略。
#[tauri::command]
pub fn cancel_upscale_job(job_id: String, app: AppHandle) -> Result<bool, String> {
    let mgr = app.state::<UpscaleManager>();
    let mut inner = mgr.inner.lock().unwrap();
    let status = inner
        .jobs
        .iter()
        .find(|j| j.id == job_id)
        .map(|j| j.status);
    let Some(status) = status else {
        drop(inner);
        return Ok(false);
    };
    match status {
        UpscaleJobStatus::Queued => {
            // 从队列移除 + 标记 cancelled（分开借用，避免冲突）
            inner.queue.retain(|id| id != &job_id);
            if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
                j.status = UpscaleJobStatus::Cancelled;
                j.stage = "已取消".to_string();
            }
            let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
            drop(inner);
            if let Ok(conn) = util::open_app_conn(&app) {
                let _ = conn.execute(
                    "UPDATE upscale_jobs SET status='cancelled', updated_at=datetime('now') WHERE id=?1",
                    rusqlite::params![&job_id],
                );
                // 取消未开始的超分批次：产物从未生成，删除空批次
                if let Some(s) = &snapshot {
                    let _ = conn.execute(
                        "DELETE FROM storyboard_videos WHERE id=?1 AND source='upscale'",
                        rusqlite::params![&s.video_id],
                    );
                }
            }
            if let Some(s) = snapshot {
                broadcast_change(&app, &s, true);
            }
            Ok(true)
        }
        UpscaleJobStatus::Running => {
            // 外层已持有 inner 锁，直接操作 active（勿二次加锁，同一 Mutex 会死锁）
            let canceled = if let Some(ctx) = inner.active.as_mut() {
                if ctx.job.id == job_id {
                    ctx.cancel.store(true, Ordering::Relaxed);
                    if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
                        j.stage = "取消中…".to_string();
                    }
                    let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
                    drop(inner);
                    if let Some(s) = snapshot {
                        broadcast_change(&app, &s, false);
                    }
                    true
                } else {
                    drop(inner);
                    false
                }
            } else {
                drop(inner);
                false
            };
            Ok(canceled)
        }
        _ => {
            drop(inner);
            Ok(false)
        }
    }
}

/// 供 setup 调用：创建并注册 manager（Tauri state），并启动 worker（含断点续跑）。
pub fn setup_manager(app: &AppHandle) {
    app.manage(UpscaleManager::new(app.clone()));
    let mgr = app.state::<UpscaleManager>();
    mgr.start();
}

/// 当前活跃任务 id 集合（queued/running，含恢复中的任务）。
///
/// 供启动时清理孤儿临时目录使用：只有 job_id 不在该集合中的
/// `_upscale_{job_id}_frames/_out` 目录才视为残留可删除。
pub fn active_job_ids(app: &AppHandle) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    if let Some(mgr) = app.try_state::<UpscaleManager>() {
        let inner = mgr.inner.lock().unwrap();
        for j in &inner.jobs {
            if j.status == UpscaleJobStatus::Queued || j.status == UpscaleJobStatus::Running {
                ids.insert(j.id.clone());
            }
        }
    }
    ids
}
