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

/// 超时自动重试上限：超过此次数则放弃自动重试，转为 Failed 等待用户手动重试。
const MAX_AUTO_RETRIES: u32 = 3;

/// 写入超分项目日志（muse.log，source=视频超分）。
/// 日志为尽力型操作，失败不影响主流程。
fn log_upscale(app: &AppHandle, level: &str, message: &str) {
    log::info!("[超分] {} {}", level, message);
    if let Ok(app_data_dir) = crate::app_paths::resolve_app_data_dir(app) {
        let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
        crate::project_log::append_log(&log_path, "视频超分", level, message);
    }
}

fn cleanup_video_batch_files(app: &AppHandle, video_id: &str) {
    let Ok(conn) = util::open_app_conn(app) else {
        return;
    };
    let row = conn.query_row(
        "SELECT sv.file_path, sv.cover_path, p.workspace_path
         FROM storyboard_videos sv
         JOIN storyboards s ON s.id = sv.storyboard_id
         JOIN projects p ON p.id = s.project_id
         WHERE sv.id = ?1",
        rusqlite::params![video_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    );
    let Ok((file_path, cover_path, workspace_path)) = row else {
        return;
    };
    let workspace_path = std::path::PathBuf::from(workspace_path);
    let mut candidates = vec![crate::commands::clip::ClipFileCandidate {
        workspace_path: workspace_path.clone(),
        file_path: Path::new(&file_path).to_path_buf(),
    }];
    if let Some(cover_path) = cover_path {
        candidates.push(crate::commands::clip::ClipFileCandidate {
            workspace_path,
            file_path: Path::new(&cover_path).to_path_buf(),
        });
    }
    let _ = crate::commands::clip::delete_managed_files(candidates);
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
    /// 执行失败（目录已清理；仅进程被强杀时目录天然保留，重启后由 DB running 恢复续跑）
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
    /// 'video' | 'image'
    #[serde(default = "default_task_type")]
    pub task_type: String,
    /// 素材图片超分定位字段（仅 task_type='image'）
    pub asset_clip_id: String,
    pub asset_type_name: String,
    pub asset_image_id: String,
}

#[allow(dead_code)]
fn default_task_type() -> String {
    "video".to_string()
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
    /// 超时自动重试计数（job id → 累计超时次数），超出上限后转 Failed
    timeout_retries: std::collections::HashMap<String, u32>,
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
                timeout_retries: std::collections::HashMap::new(),
            }),
            app,
        }
    }

    /// 启动 worker，并从 DB 加载画布与任务面板需要的任务快照。
    ///
    /// 只应调用一次（应用 setup 中）。恢复逻辑：
    /// 1. 仅将 `queued` / `running` 任务视为可恢复工作并重新入队；
    /// 2. `failed` / `done` 任务只保留为只读历史，供画布关联批次；
    /// 3. 启动 worker 串行执行。
    pub fn start(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.started {
            return;
        }
        inner.started = true;

        // queued/running 入队续跑；failed/done 只供前端展示，不会重新执行。
        let mut recovered = 0usize;
        if let Ok(conn) = util::open_app_conn(&self.app) {
            // 进程中断遗留的 running 任务在本次启动中重新排队；图片与视频都可从源文件重跑。
            if let Err(error) = conn.execute(
                "UPDATE upscale_jobs SET status='queued', updated_at=datetime('now') WHERE status='running'",
                [],
            ) {
                log_upscale(&self.app, "ERROR", &format!("恢复超分任务状态失败：{}", error));
            }
            let sql = "SELECT id, COALESCE(storyboard_id, ''), COALESCE(video_id, ''), input_path, output_path, model, scale, status, error_message, created_at, task_type, COALESCE(source_clip_id, ''), '' AS asset_type_name, COALESCE(source_asset_image_id, '')
                       FROM upscale_jobs WHERE status IN ('queued','failed','done','cancelled') ORDER BY created_at";
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
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                }) {
                    for row in rows.flatten() {
                        let (
                            id,
                            sb_id,
                            vid_id,
                            input_path,
                            output_path,
                            model,
                            scale,
                            status,
                            error_message,
                            created_at,
                            task_type,
                            asset_clip_id,
                            asset_type_name,
                            asset_image_id,
                        ) = row;
                        // running 已在查询前持久化恢复为 queued；所有可恢复类型均重新入队。
                        let should_resume = status == "queued";
                        let status_enum = UpscaleJobStatus::from_str(&status);
                        let do_enqueue = should_resume;
                        inner.jobs.push(UpscaleJob {
                            id: id.clone(),
                            storyboard_id: sb_id,
                            video_id: vid_id,
                            input_path: input_path.clone(),
                            output_path,
                            model,
                            scale,
                            status: status_enum,
                            percent: 0.0,
                            stage: if should_resume {
                                "排队中…".to_string()
                            } else if status == "done" {
                                "完成".to_string()
                            } else {
                                "失败".to_string()
                            },
                            error: error_message,
                            created_at,
                            task_type: task_type.clone(),
                            asset_clip_id,
                            asset_type_name,
                            asset_image_id,
                        });
                        if do_enqueue {
                            inner.queue.push_back(id.clone());
                        }
                        recovered += 1;
                        log_upscale(
                            &self.app,
                            if should_resume { "INFO" } else { "WARN" },
                            &format!(
                                "启动{}：job={} type={} 输入={}{}",
                                if should_resume {
                                    "恢复未完成任务"
                                } else if status == "done" {
                                    "加载已完成任务"
                                } else {
                                    "加载失败任务"
                                },
                                &id[..id.len().min(8)],
                                task_type,
                                input_path,
                                if should_resume {
                                    "（断点续跑）"
                                } else {
                                    ""
                                }
                            ),
                        );
                    }
                }
            }
        }
        drop(inner);
        if recovered > 0 {
            log_upscale(
                &self.app,
                "INFO",
                &format!("共恢复/加载 {} 个超分任务记录", recovered),
            );
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
                            let job_snapshot = inner
                                .jobs
                                .iter()
                                .find(|j| j.id == id)
                                .cloned()
                                .unwrap_or_else(|| job.clone());
                            drop(inner);
                            let claimed = util::open_app_conn(&manager)
                                .and_then(|conn| {
                                    conn.execute(
                                        "UPDATE upscale_jobs SET status='running', updated_at=datetime('now') WHERE id=?1 AND status='queued'",
                                        rusqlite::params![&id],
                                    )
                                    .map_err(|e| e.to_string())
                                })
                                .unwrap_or(0);
                            if claimed != 1 {
                                log_upscale(
                                    &manager,
                                    "WARN",
                                    &format!("超分作业未取得执行权，跳过 jobId={}", id),
                                );
                                let mgr = manager.state::<UpscaleManager>();
                                let mut inner = mgr.inner.lock().unwrap();
                                inner.active = None;
                                if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == id) {
                                    j.status = UpscaleJobStatus::Cancelled;
                                    j.stage = "已取消或失效".to_string();
                                }
                                None
                            } else {
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
                            }
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

    let job_id2 = job_id.to_string();
    let is_image = job.task_type == "image";

    // 进度回调：更新内存 + 广播事件（不落 DB 每次进度，避免高频写库）
    let app_p = app.clone();
    let job_id_p = job_id2.clone();
    let on_progress: std::sync::Arc<dyn Fn(f64, &str) + Send + Sync> =
        std::sync::Arc::new(move |percent, stage| {
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

    let result: Result<(), String> = if is_image {
        crate::commands::video::run_image_upscale_blocking(
            &job.input_path,
            &job.output_path,
            &job.model,
            job.scale,
            app.clone(),
            cancel,
            on_progress,
        )
    } else {
        let workspace_path: Result<String, String> = util::open_app_conn(app).and_then(|conn| {
            conn.query_row(
                "SELECT p.workspace_path FROM storyboards s JOIN projects p ON p.id = s.project_id WHERE s.id = ?1",
                rusqlite::params![&job.storyboard_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        });
        match workspace_path {
            Ok(workspace_path) => run_upscale_blocking(
                UpscaleVideoInput {
                    input_path: job.input_path.clone(),
                    output_path: job.output_path.clone(),
                    workspace_path,
                    model: job.model.clone(),
                },
                app.clone(),
                job.scale,
                job_id2,
                false,
                cancel,
                on_progress,
            )
            .map(|_| ()),
            Err(error) => Err(format!("读取超分项目工作区失败：{}", error)),
        }
    };

    let mgr = app.state::<UpscaleManager>();
    let mut inner = mgr.inner.lock().unwrap();
    inner.active = None;
    match result {
        Ok(()) => {
            if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
                j.status = UpscaleJobStatus::Done;
                j.percent = 100.0;
                j.stage = "完成".to_string();
            }
            let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
            drop(inner);
            let s = snapshot.unwrap_or(job.clone());
            if is_image {
                finalize_image_success(app, &s);
            } else {
                finalize_success(app, job, &s);
            }
        }
        Err(e) => {
            if e.contains(crate::commands::video::UPSCALE_CANCELED) {
                // ── 取消 = 用户主动放弃：删任务（图片无批次可删） ──
                if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
                    j.status = UpscaleJobStatus::Cancelled;
                    j.error = Some(e.clone());
                    j.percent = 0.0;
                    j.stage = "已取消".to_string();
                }
                let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
                drop(inner);
                log_upscale(app, "WARN", &format!("超分已取消：{}", job_label(job)));
                if let Some(s) = snapshot {
                    if let Ok(conn) = util::open_app_conn(app) {
                        if let Err(error) = conn.execute(
                            "UPDATE upscale_jobs
                             SET status='cancelled', cancelled_at=datetime('now'), cancel_reason='execution cancelled', updated_at=datetime('now')
                             WHERE id=?1 AND status IN ('running','queued')",
                            rusqlite::params![job_id],
                        ) {
                            log_upscale(app, "ERROR", &format!("持久化超分取消失败：{}", error));
                        }
                        if !is_image {
                            cleanup_video_batch_files(app, &job.video_id);
                        }
                    }
                    broadcast_change(app, &s, true);
                }
            } else if e.starts_with(crate::commands::video::UPSCALE_TIMEOUT_PREFIX) {
                // ── 超时自动重试：图片任务也支持自动重试（至多 MAX_AUTO_RETRIES 次） ──
                let retries = {
                    let ent = inner.timeout_retries.entry(job_id.to_string()).or_insert(0);
                    *ent += 1;
                    *ent
                };
                let exhausted = retries > MAX_AUTO_RETRIES;
                if exhausted {
                    inner.timeout_retries.remove(job_id);
                    if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
                        j.status = UpscaleJobStatus::Failed;
                        j.error = Some(e.clone());
                        j.stage = format!("失败：{}", e);
                    }
                    let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
                    drop(inner);
                    log_upscale(
                        app,
                        "ERROR",
                        &format!("超分超时重试耗尽：{} 错误={}", job_label(job), e),
                    );
                    if let Some(s) = snapshot {
                        if let Ok(conn) = util::open_app_conn(app) {
                            let _ = conn.execute(
                                "UPDATE upscale_jobs SET status='failed', error_message=?1, updated_at=datetime('now') WHERE id=?2",
                                rusqlite::params![&e, job_id],
                            );
                            if !is_image {
                                let _ = conn.execute(
                                    "UPDATE storyboard_videos SET file_path='', file_name='超分失败' WHERE id=?1 AND source='upscale'",
                                    rusqlite::params![&job.video_id],
                                );
                            }
                        }
                        broadcast_change(app, &s, true);
                    }
                } else {
                    // 自动重试：重新入队
                    if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
                        j.status = UpscaleJobStatus::Queued;
                        j.percent = 0.0;
                        j.stage =
                            format!("排队中…（超时自动重试 {}/{}）", retries, MAX_AUTO_RETRIES);
                        j.error = None;
                    }
                    inner.queue.push_back(job_id.to_string());
                    let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
                    drop(inner);
                    log_upscale(
                        app,
                        "WARN",
                        &format!(
                            "超分超时，自动重试（{}/{}）：{}",
                            retries,
                            MAX_AUTO_RETRIES,
                            job_label(job)
                        ),
                    );
                    if let Ok(conn) = util::open_app_conn(app) {
                        let _ = conn.execute(
                            "UPDATE upscale_jobs SET status='queued', error_message=NULL, updated_at=datetime('now') WHERE id=?1",
                            rusqlite::params![job_id],
                        );
                        if !is_image {
                            let _ = conn.execute(
                                "UPDATE storyboard_videos SET file_name='视频超分排队中' WHERE id=?1 AND source='upscale'",
                                rusqlite::params![&job.video_id],
                            );
                        }
                    }
                    if let Some(s) = snapshot {
                        broadcast_change(app, &s, false);
                    }
                }
            } else {
                // ── 其他失败 = 保留现场 ──
                let status = UpscaleJobStatus::Failed;
                if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
                    j.status = status;
                    j.error = Some(e.clone());
                    j.stage = format!("失败：{}", e);
                }
                let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
                drop(inner);
                log_upscale(
                    app,
                    "ERROR",
                    &format!("超分失败：{} 错误={}", job_label(job), e),
                );
                if let Some(s) = snapshot {
                    if let Ok(conn) = util::open_app_conn(app) {
                        let _ = conn.execute(
                            "UPDATE upscale_jobs SET status=?1, error_message=?2, updated_at=datetime('now') WHERE id=?3",
                            rusqlite::params![status.as_str(), &e, job_id],
                        );
                        if !is_image {
                            let _ = conn.execute(
                                "UPDATE storyboard_videos SET file_path='', file_name='超分失败' WHERE id=?1 AND source='upscale'",
                                rusqlite::params![&job.video_id],
                            );
                        }
                    }
                    broadcast_change(app, &s, true);
                }
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
    let mut conn = match util::open_app_conn(app) {
        Ok(conn) => conn,
        Err(error) => {
            log_upscale(app, "ERROR", &format!("打开超分完成数据库失败：{}", error));
            return;
        }
    };
    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(error) => {
            log_upscale(app, "ERROR", &format!("开启超分完成事务失败：{}", error));
            return;
        }
    };
    let claimed = match tx.execute(
        "UPDATE upscale_jobs SET status='done', updated_at=datetime('now') WHERE id=?1 AND status='running'",
        rusqlite::params![&job.id],
    ) {
        Ok(changes) => changes == 1,
        Err(error) => {
            log_upscale(app, "ERROR", &format!("更新视频超分状态失败：{}", error));
            return;
        }
    };
    if !claimed {
        log_upscale(
            app,
            "WARN",
            &format!("跳过已取消或失效的视频超分回写 jobId={}", job.id),
        );
        mark_job_cancelled_in_memory(app, &job.id);
        return;
    }
    let cover_path = crate::media::generate_video_cover(app, Path::new(&job.output_path)).ok();
    if let Err(error) = tx.execute(
        "UPDATE storyboard_videos SET file_path=?1, file_name=?2, cover_path=?3
         WHERE id=?4 AND EXISTS (SELECT 1 FROM upscale_jobs WHERE id=?5 AND status='done')",
        rusqlite::params![
            &job.output_path,
            Path::new(&job.output_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&job.output_path),
            cover_path
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            &job.video_id,
            &job.id,
        ],
    ) {
        log_upscale(app, "ERROR", &format!("更新超分视频批次失败：{}", error));
        return;
    }
    if let Err(error) = tx.commit() {
        log_upscale(
            app,
            "ERROR",
            &format!("提交视频超分完成事务失败：{}", error),
        );
        return;
    }
    broadcast_change(app, snapshot, true);
}

/// 图片超分成功：将产物写入 asset_images 表（source='upscale'），供前端轮询刷新画廊。
fn finalize_image_success(app: &AppHandle, snapshot: &UpscaleJob) {
    log_upscale(
        app,
        "INFO",
        &format!(
            "图片超分完成：{} model={} scale={}x output={}",
            &snapshot.id[..snapshot.id.len().min(8)],
            snapshot.model,
            snapshot.scale,
            short_path_str(&snapshot.output_path),
        ),
    );
    if let Ok(conn) = util::open_app_conn(app) {
        let changed = conn.execute(
            "UPDATE upscale_jobs SET status='done', updated_at=datetime('now') WHERE id=?1 AND status='running'",
            rusqlite::params![&snapshot.id],
        );
        if changed.as_ref().ok().copied() != Some(1) {
            log_upscale(
                app,
                "WARN",
                &format!("跳过已取消或失效的图片超分回写 jobId={}", snapshot.id),
            );
            mark_job_cancelled_in_memory(app, &snapshot.id);
            return;
        }
        // 来源在入队事务中已完成外键与归属校验；完成时再要求 job 仍持有 running 所有权。
        let asset_id: Option<String> = conn
            .query_row(
                "SELECT source_asset_id FROM upscale_jobs WHERE id = ?1 AND task_type = 'image'",
                rusqlite::params![&snapshot.id],
                |row| row.get(0),
            )
            .ok();
        if let Some(ref aid) = asset_id {
            let image_id = uuid::Uuid::new_v4().to_string();
            let file_name = Path::new(&snapshot.output_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("upscaled")
                .to_string();
            let thumbnail_path =
                match crate::media::generate_image_thumbnail(app, Path::new(&snapshot.output_path))
                {
                    Ok(path) => Some(path.to_string_lossy().to_string()),
                    Err(error) => {
                        log_upscale(
                            app,
                            "WARN",
                            &format!(
                                "图片超分缩略图生成失败，将保留原图记录 imageId={} error={}",
                                image_id, error
                            ),
                        );
                        None
                    }
                };
            let _ = conn.execute(
                "INSERT INTO asset_images (id, asset_id, prompt, size, style, image_path, thumbnail_path, is_selected, source, file_name, created_at)
                 VALUES (?1, ?2, '', '', '', ?3, ?4, 0, 'upscale', ?5, datetime('now'))",
                rusqlite::params![
                    &image_id,
                    aid.as_str(),
                    &snapshot.output_path,
                    thumbnail_path.as_deref(),
                    &file_name
                ],
            );
            // 超分只新增候选图片，不隐式改变用户已选择的参考图。
            // `assets.selected_image_id` 是运行时权威，必须由显式选择操作更新。
        }
    }
    broadcast_change(app, snapshot, true);
}

/// 广播任务状态变化事件
fn broadcast_change(app: &AppHandle, job: &UpscaleJob, is_final: bool) {
    let _ = app.emit("upscale-changed", job.clone());
    if is_final && job.status != UpscaleJobStatus::Running && job.status != UpscaleJobStatus::Queued
    {
        let is_image = job.task_type == "image";
        let _ = app.emit(
            "upscale-done",
            UpscaleDonePayload {
                storyboard_id: job.storyboard_id.clone(),
                video_id: job.video_id.clone(),
                result_id: if job.status == UpscaleJobStatus::Done {
                    if is_image {
                        job.output_path.clone() // 图片超分：返回产物路径供前端刷新
                    } else {
                        job.video_id.clone()
                    }
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
                task_type: job.task_type.clone(),
                asset_image_id: if is_image {
                    job.asset_image_id.clone()
                } else {
                    String::new()
                },
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
    /// 'video' | 'image'（素材图片超分时，前端据此区分刷新目标）
    #[serde(default)]
    pub task_type: String,
    /// 图片超分的源 asset_image_id（仅 task_type='image' 时有值）
    #[serde(default)]
    pub asset_image_id: String,
}

/// 入队超分任务。
///
/// 创建任务（写 DB）→ 放入队列 → 广播 queued 事件。worker 串行消费。
#[tauri::command]
pub fn enqueue_upscale(input: UpscaleEnqueueInput, app: AppHandle) -> Result<UpscaleJob, String> {
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
    let mut conn = util::open_app_conn(&app)?;
    let (file_path, workspace_path): (String, String) = conn
        .query_row(
            "SELECT sv.file_path, p.workspace_path
             FROM storyboard_videos sv
             JOIN storyboards s ON s.id = sv.storyboard_id
             JOIN projects p ON p.id = s.project_id
             WHERE sv.id = ?1 AND sv.storyboard_id = ?2",
            rusqlite::params![&input.video_id, &input.storyboard_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("查询镜头视频失败：{}", e))?;

    // 生成输出路径：视频超分产物统一写入作品 exports/upscaled。
    let src_path = Path::new(&file_path);
    let name = src_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法解析源视频路径".to_string())?;
    let (base, ext) = match name.rsplit_once('.') {
        Some((base, ext)) if !ext.is_empty() => (base.to_string(), format!(".{ext}")),
        _ => (name.to_string(), ".mp4".to_string()),
    };
    let output_dir = Path::new(&workspace_path).join("exports").join("upscaled");
    std::fs::create_dir_all(&output_dir)
        .map_err(|error| format!("创建超分输出目录失败：{}", error))?;
    let rand = &uuid::Uuid::new_v4().to_string()[..8];
    let out_path = output_dir.join(format!("{base}_up{scale}x_{rand}{ext}"));
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
    // 批次与作业必须同一事务创建，避免 job 插入失败遗留无主 video batch。
    let job_id = uuid::Uuid::new_v4().to_string();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启超分入队事务失败：{}", e))?;
    tx.execute(
        "INSERT INTO storyboard_videos (id, storyboard_id, file_path, file_name, source)
         VALUES (?1, ?2, ?3, ?4, 'upscale')",
        rusqlite::params![
            &batch_id,
            &input.storyboard_id,
            &out_path_str,
            &out_file_name
        ],
    )
    .map_err(|e| format!("创建超分批次失败：{}", e))?;
    tx.execute(
        "INSERT INTO upscale_jobs (id, storyboard_id, video_id, input_path, output_path, model, scale, status, task_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 'video', datetime('now'))",
        rusqlite::params![&job_id, &input.storyboard_id, &batch_id, &file_path, &out_path_str, &input.model, scale],
    )
    .map_err(|e| format!("保存超分任务失败：{}", e))?;
    let created_at: String = tx
        .query_row(
            "SELECT created_at FROM upscale_jobs WHERE id = ?1",
            rusqlite::params![&job_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit()
        .map_err(|e| format!("提交超分入队事务失败：{}", e))?;

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
        task_type: "video".to_string(),
        asset_clip_id: String::new(),
        asset_type_name: String::new(),
        asset_image_id: String::new(),
    };

    // 加入内存队列
    let mgr = app.state::<UpscaleManager>();
    let mut inner = mgr.inner.lock().unwrap();
    inner.jobs.push(job.clone());
    inner.queue.push_back(job_id.clone());
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

/// 素材图片超分入参
#[derive(Debug, Deserialize)]
pub struct AssetUpscaleInput {
    pub clip_id: String,
    pub image_id: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_scale")]
    pub scale: u32,
}

/// 图片超分入队。来源路径、素材和分集归属全部从数据库读取，IPC 参数不再能够伪造关系。
#[tauri::command]
pub fn enqueue_asset_upscale(
    input: AssetUpscaleInput,
    app: AppHandle,
) -> Result<UpscaleJob, String> {
    let scale = if input.model == "x4plus" || input.model == "x4plus-anime" {
        4
    } else {
        match input.scale {
            2 | 3 | 4 => input.scale,
            _ => 4,
        }
    };
    let mut conn = util::open_app_conn(&app)?;
    let (image_path, asset_id, asset_type_name): (String, String, String) = conn
        .query_row(
            "SELECT ai.image_path, a.id, a.type || '|' || a.name
             FROM asset_images ai
             JOIN assets a ON a.id = ai.asset_id
             JOIN clip_assets ca ON ca.asset_id = a.id
             JOIN clips c ON c.id = ca.clip_id
             WHERE ai.id = ?1 AND ca.clip_id = ?2 AND c.deleted_at IS NULL",
            rusqlite::params![&input.image_id, &input.clip_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "图片不存在、不属于当前分集或分集已删除".to_string())?;

    let src_path = Path::new(&image_path);
    let out_path = match (src_path.parent(), src_path.file_name()) {
        (Some(parent), Some(name)) => {
            let name = name.to_string_lossy().to_string();
            let (base, ext) = match name.rsplit_once('.') {
                Some((b, e)) if !e.is_empty() => (b.to_string(), format!(".{e}")),
                _ => (name, ".jpg".to_string()),
            };
            parent.join(format!(
                "{base}_up{scale}x_{}{}",
                &uuid::Uuid::new_v4().to_string()[..8],
                ext
            ))
        }
        _ => return Err("无法解析源图路径".to_string()),
    };
    let out_path_str = out_path.to_string_lossy().to_string();
    let job_id = uuid::Uuid::new_v4().to_string();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO upscale_jobs (
            id, source_clip_id, source_asset_id, source_asset_image_id,
            input_path, output_path, model, scale, status, task_type, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', 'image', datetime('now'))",
        rusqlite::params![
            &job_id,
            &input.clip_id,
            &asset_id,
            &input.image_id,
            &image_path,
            &out_path_str,
            &input.model,
            scale,
        ],
    )
    .map_err(|e| format!("保存图片超分任务失败：{}", e))?;
    let created_at: String = tx
        .query_row(
            "SELECT created_at FROM upscale_jobs WHERE id = ?1",
            rusqlite::params![&job_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let job = UpscaleJob {
        id: job_id.clone(),
        storyboard_id: String::new(),
        video_id: String::new(),
        input_path: image_path,
        output_path: out_path_str,
        model: input.model,
        scale,
        status: UpscaleJobStatus::Queued,
        percent: 0.0,
        stage: "排队中…".to_string(),
        error: None,
        created_at,
        task_type: "image".to_string(),
        asset_clip_id: input.clip_id,
        asset_type_name,
        asset_image_id: input.image_id,
    };
    let mgr = app.state::<UpscaleManager>();
    let mut inner = mgr.inner.lock().unwrap();
    inner.jobs.push(job.clone());
    inner.queue.push_back(job_id.clone());
    drop(inner);
    log_upscale(
        &app,
        "INFO",
        &format!(
            "收到图片超分请求：id={} model={} scale={}x input={}",
            &job_id[..job_id.len().min(8)],
            job.model,
            job.scale,
            short_path_str(&job.input_path)
        ),
    );
    broadcast_change(&app, &job, false);
    Ok(job)
}

fn short_path_str(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
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
    let status = inner.jobs.iter().find(|j| j.id == job_id).map(|j| j.status);
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
                // 取消记录保留为审计/删除墓碑；不再删除 job 或稳定的视频批次 ID。
                if let Some(s) = &snapshot {
                    if s.task_type != "image" {
                        cleanup_video_batch_files(&app, &s.video_id);
                    }
                    if let Err(error) = conn.execute(
                        "UPDATE upscale_jobs
                         SET status='cancelled', cancelled_at=datetime('now'), cancel_reason='user cancelled before start', updated_at=datetime('now')
                         WHERE id=?1 AND status='queued'",
                        rusqlite::params![&job_id],
                    ) {
                        log_upscale(&app, "ERROR", &format!("持久化排队任务取消失败：{}", error));
                    }
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
                    if let Ok(conn) = util::open_app_conn(&app) {
                        if let Err(error) = conn.execute(
                            "UPDATE upscale_jobs
                             SET status='cancelled', cancelled_at=datetime('now'), cancel_reason='user cancelled while running', updated_at=datetime('now')
                             WHERE id=?1 AND status='running'",
                            rusqlite::params![&job_id],
                        ) {
                            log_upscale(&app, "ERROR", &format!("持久化运行任务取消失败：{}", error));
                        }
                    }
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

/// 重试失败的超分任务。
///
/// - 仅 `failed` 状态可重试（取消/排队中/运行中/已完成均拒绝）；
/// - 复用原任务的 `input_path/model/scale/video_id`（批次 id 全程不变，预览/选中不丢）；
/// - 重置为 `queued` 重新入队，由 worker 串行消费；
/// - 失败批次（file_path=NULL, file_name='超分失败'）随后由前端按任务状态渲染为排队中。
#[tauri::command]
pub fn retry_upscale_job(job_id: String, app: AppHandle) -> Result<UpscaleJob, String> {
    let mgr = app.state::<UpscaleManager>();
    let mut inner = mgr.inner.lock().unwrap();
    let Some(job) = inner.jobs.iter().find(|j| j.id == job_id).cloned() else {
        drop(inner);
        return Err("任务不存在".to_string());
    };
    if job.status != UpscaleJobStatus::Failed {
        drop(inner);
        return Err(format!(
            "只有失败的超分任务可以重试，当前状态：{}",
            job.status.as_str()
        ));
    }
    // 内存：重置为排队中，清空错误
    if let Some(j) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
        j.status = UpscaleJobStatus::Queued;
        j.percent = 0.0;
        j.stage = "排队中…".to_string();
        j.error = None;
    }
    inner.queue.push_back(job_id.clone());
    let snapshot = inner.jobs.iter().find(|j| j.id == job_id).cloned();
    drop(inner);
    if let Ok(conn) = util::open_app_conn(&app) {
        // DB：任务重置为 queued 并清空错误；批次标记恢复为排队中（产物未生成，file_path 保持空）
        let _ = conn.execute(
            "UPDATE upscale_jobs SET status='queued', error_message=NULL, updated_at=datetime('now') WHERE id=?1",
            rusqlite::params![&job_id],
        );
        let _ = conn.execute(
            "UPDATE storyboard_videos SET file_name='视频超分排队中' WHERE id=?1 AND source='upscale'",
            rusqlite::params![&job.video_id],
        );
    }
    if let Some(s) = &snapshot {
        broadcast_change(&app, s, false);
    }
    Ok(snapshot.unwrap_or(job))
}

/// 供 setup 调用：创建并注册 manager（Tauri state），并启动 worker（含断点续跑）。
pub fn setup_manager(app: &AppHandle) {
    app.manage(UpscaleManager::new(app.clone()));
}

/// 数据库结构准备完成后启动恢复队列，避免使用旧 schema 读取作业。
pub fn start_manager(app: &AppHandle) {
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
    if ids.is_empty() {
        // manager 尚未在 DB 初始化前启动时，仍以持久化状态保护工作目录。
        if let Ok(conn) = util::open_app_conn(app) {
            if let Ok(mut statement) =
                conn.prepare("SELECT id FROM upscale_jobs WHERE status IN ('queued', 'running')")
            {
                if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
                    ids.extend(rows.filter_map(Result::ok));
                }
            }
        }
    }
    ids
}

/// 返回数据库中登记的所有项目工作区，用于只在受管 `.work/upscale` 根下清理孤儿目录。
pub fn project_workspace_paths(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let Ok(conn) = util::open_app_conn(app) else {
        return Vec::new();
    };
    let Ok(mut statement) = conn
        .prepare("SELECT DISTINCT workspace_path FROM projects WHERE TRIM(workspace_path) <> ''")
    else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(std::path::PathBuf::from)
        .collect()
}

/// 取消归属于指定分集的本地超分。取消先持久化，再通知内存执行器；
/// 已完成任务保留历史，运行中的任务会在下一阶段检查取消令牌。
pub fn cancel_upscale_jobs_for_clips(
    app: &AppHandle,
    clip_ids: &[String],
) -> Result<usize, String> {
    let conn = util::open_app_conn(app)?;
    let mut job_ids = std::collections::BTreeSet::new();
    for clip_id in clip_ids {
        let mut statement = conn
            .prepare(
                "SELECT id FROM upscale_jobs
                 WHERE status IN ('queued', 'running')
                   AND (source_clip_id = ?1 OR storyboard_id IN (
                        SELECT id FROM storyboards WHERE clip_id = ?1
                   ))",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(rusqlite::params![clip_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for id in rows {
            job_ids.insert(id.map_err(|e| e.to_string())?);
        }
    }
    let mut cancelled = 0usize;
    for id in job_ids {
        if cancel_upscale_job(id, app.clone())? {
            cancelled += 1;
        }
    }
    Ok(cancelled)
}

/// 取消以指定素材为来源的图片超分，供素材/项目永久删除前调用。
pub fn cancel_upscale_jobs_for_assets(
    app: &AppHandle,
    asset_ids: &[String],
) -> Result<usize, String> {
    let conn = util::open_app_conn(app)?;
    let mut job_ids = std::collections::BTreeSet::new();
    for asset_id in asset_ids {
        let mut statement = conn
            .prepare("SELECT id FROM upscale_jobs WHERE source_asset_id = ?1 AND status IN ('queued', 'running')")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(rusqlite::params![asset_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for id in rows {
            job_ids.insert(id.map_err(|e| e.to_string())?);
        }
    }
    let mut cancelled = 0usize;
    for id in job_ids {
        if cancel_upscale_job(id, app.clone())? {
            cancelled += 1;
        }
    }
    Ok(cancelled)
}

/// 当最终持久化失去 running 所有权时，同步修正内存投影，避免 UI 把已取消任务显示为完成。
fn mark_job_cancelled_in_memory(app: &AppHandle, job_id: &str) {
    let mgr = app.state::<UpscaleManager>();
    let mut inner = mgr.inner.lock().unwrap();
    if let Some(job) = inner.jobs.iter_mut().find(|job| job.id == job_id) {
        job.status = UpscaleJobStatus::Cancelled;
        job.stage = "已取消或失效".to_string();
    }
    let snapshot = inner.jobs.iter().find(|job| job.id == job_id).cloned();
    drop(inner);
    if let Some(snapshot) = snapshot {
        broadcast_change(app, &snapshot, true);
    }
}
