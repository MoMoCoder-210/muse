//! 片段/剧本源相关命令
//!
//! @author yt @date 20260703

use crate::commands::util;
use crate::sidecar::SharedSidecarManager;
use serde::{Deserialize, Serialize};

/// @author yt @date 20260702 片段信息
#[derive(Debug, Serialize, Deserialize)]
pub struct ClipInfo {
    pub id: String,
    pub project_id: String,
    pub source_id: Option<String>,
    pub sort_index: i64,
    pub title: String,
    pub summary: String,
    pub source_text: String,
    pub estimated_duration: Option<f64>,
    pub status: String,
    pub current_step: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 批量删除片段输入
#[derive(Debug, Deserialize)]
pub struct DeleteClipsInput {
    pub clip_ids: Vec<String>,
}

/// 更新片段输入，三个内容字段均可选，传哪个改哪个
#[derive(Debug, Deserialize)]
pub struct UpdateClipInput {
    pub clip_id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub source_text: Option<String>,
}

/// 片段拆分输入：在原 source_text 的第 split_position 个字符处拆成两段
#[derive(Debug, Deserialize)]
pub struct SplitClipInput {
    pub clip_id: String,
    pub split_position: i64,
}

/// 拆分片段返回结果
#[derive(Debug, Serialize)]
pub struct SplitClipResult {
    pub first_clip_id: String,
    pub second_clip_id: String,
}

/// 手动创建单个片段输入
#[derive(Debug, Deserialize)]
pub struct CreateClipInput {
    pub project_id: String,
    pub title: String,
    pub source_text: String,
}

/// 手动创建单个片段（无剧本源归属）
#[tauri::command]
pub fn create_clip(
    input: CreateClipInput,
    app: tauri::AppHandle,
) -> Result<ClipInfo, String> {
    let conn = util::open_app_conn(&app)?;
    let clip_id = uuid::Uuid::new_v4().to_string();

    // 取当前项目最大 sort_index + 1
    let max_idx: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_index), 0) FROM clips WHERE project_id = ?1 AND deleted_at IS NULL",
            rusqlite::params![&input.project_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let sort_index = max_idx + 1;

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    conn.execute(
        "INSERT INTO clips (id, project_id, source_id, sort_index, title, source_text, status, current_step, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, 'pending', 'project', ?6, ?6)",
        rusqlite::params![&clip_id, &input.project_id, sort_index, &input.title, &input.source_text, &now],
    )
    .map_err(|e| e.to_string())?;

    Ok(ClipInfo {
        id: clip_id,
        project_id: input.project_id,
        source_id: None,
        sort_index,
        title: input.title,
        summary: String::new(),
        source_text: input.source_text,
        estimated_duration: None,
        status: "pending".to_string(),
        current_step: "project".to_string(),
        created_at: now.clone(),
        updated_at: now,
    })
}

/// 列出项目下所有片段
#[tauri::command]
pub fn list_clips(project_id: String, app: tauri::AppHandle) -> Result<Vec<ClipInfo>, String> {
    let conn = util::open_app_conn(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, source_id, sort_index, title, summary, source_text,
                    estimated_duration, status, current_step, created_at, updated_at
             FROM clips
             WHERE project_id = ?1 AND deleted_at IS NULL
             ORDER BY sort_index ASC",
        )
        .map_err(|e| e.to_string())?;

    let clips = stmt
        .query_map(rusqlite::params![&project_id], |row| {
            Ok(ClipInfo {
                id: row.get(0)?,
                project_id: row.get(1)?,
                source_id: row.get(2)?,
                sort_index: row.get(3)?,
                title: row.get(4)?,
                summary: row.get(5)?,
                source_text: row.get(6)?,
                estimated_duration: row.get(7)?,
                status: row.get(8)?,
                current_step: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(clips)
}

/// 获取剧本源信息
#[tauri::command]
pub fn get_script_source(
    project_id: String,
    app: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    let conn = util::open_app_conn(&app)?;
    let result = conn.query_row(
        "SELECT id, project_id, source_type, file_name, split_status, error_message,
                retry_count, created_at, updated_at
         FROM script_sources WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 1",
        rusqlite::params![&project_id],
        |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "project_id": row.get::<_, String>(1)?,
                "source_type": row.get::<_, String>(2)?,
                "file_name": row.get::<_, Option<String>>(3)?,
                "split_status": row.get::<_, String>(4)?,
                "error_message": row.get::<_, Option<String>>(5)?,
                "retry_count": row.get::<_, i64>(6)?,
                "created_at": row.get::<_, String>(7)?,
                "updated_at": row.get::<_, String>(8)?,
            }))
        },
    );

    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 列出项目下所有剧本源
#[tauri::command]
pub fn list_script_sources(
    project_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = util::open_app_conn(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, source_type, file_name, split_status, error_message,
                    retry_count, created_at, updated_at
             FROM script_sources
             WHERE project_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let sources = stmt
        .query_map(rusqlite::params![&project_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "project_id": row.get::<_, String>(1)?,
                "source_type": row.get::<_, String>(2)?,
                "file_name": row.get::<_, Option<String>>(3)?,
                "split_status": row.get::<_, String>(4)?,
                "error_message": row.get::<_, Option<String>>(5)?,
                "retry_count": row.get::<_, i64>(6)?,
                "created_at": row.get::<_, String>(7)?,
                "updated_at": row.get::<_, String>(8)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(sources)
}

/// 批量软删除片段
#[tauri::command]
pub fn delete_clips(input: DeleteClipsInput, app: tauri::AppHandle) -> Result<(), String> {
    if input.clip_ids.is_empty() {
        return Ok(());
    }
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for id in &input.clip_ids {
        // 检查是否有拆解任务在执行中
        let lock_prefix = format!("generate_clip_script:{}", id);
        let task_count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE lock_key = ?1 AND status IN ('pending', 'running')",
                rusqlite::params![&lock_prefix],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // 软删除片段本体
        tx.execute(
            "UPDATE clips
             SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;

        crate::project_log::append_log(
            &log_path,
            "项目",
            "INFO",
            &format!("片段已删除 clipId={}", id),
        );

        // 有拆解任务则取消
        if task_count > 0 {
            tx.execute(
                "DELETE FROM tasks WHERE lock_key = ?1 AND status IN ('pending', 'running')",
                rusqlite::params![&lock_prefix],
            )
            .map_err(|e| e.to_string())?;

            crate::project_log::append_log(
                &log_path,
                "拆解",
                "INFO",
                &format!(
                    "拆解任务已取消 clipId={}（共{}个任务）",
                    id, task_count
                ),
            );
        }

        // 删除片段拆解记录
        tx.execute(
            "DELETE FROM clip_scripts WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;

        // 删除关联故事板
        tx.execute(
            "DELETE FROM storyboards WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 更新片段内容
#[tauri::command]
pub fn update_clip(
    input: UpdateClipInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<ClipInfo, String> {
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 校验片段存在且未删除
    let exists: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM clips WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![&input.clip_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err(format!("片段不存在或已删除：{}", input.clip_id));
    }

    let source_changed = input.source_text.is_some();

    // 查询该片段是否已有成功的拆解记录（用于判断是否需要自动重拆）
    let had_success: bool = tx
        .query_row(
            "SELECT COUNT(*) FROM clip_scripts WHERE clip_id = ?1 AND status = 'success'",
            rusqlite::params![&input.clip_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    // 使用参数化 SQL，避免动态拼接
    let title_val = input.title.as_deref().unwrap_or("");
    let summary_val = input.summary.as_deref().unwrap_or("");
    let source_text_val = input.source_text.as_deref().unwrap_or("");
    let clip_id = &input.clip_id;

    // COALESCE: 新值不为空串时覆盖，否则保留原值
    tx.execute(
        "UPDATE clips SET
            title = CASE WHEN ?1 != '' THEN ?1 ELSE title END,
            summary = CASE WHEN ?2 != '' THEN ?2 ELSE summary END,
            source_text = CASE WHEN ?3 != '' THEN ?3 ELSE source_text END,
            status = CASE WHEN ?4 THEN 'pending' ELSE status END,
            current_step = CASE WHEN ?4 THEN 'project' ELSE current_step END,
            updated_at = datetime('now')
         WHERE id = ?5 AND deleted_at IS NULL",
        rusqlite::params![
            title_val,
            summary_val,
            source_text_val,
            source_changed,
            clip_id,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    // 返回最新行
    let clip = conn
        .query_row(
            "SELECT id, project_id, source_id, sort_index, title, summary, source_text,
                    estimated_duration, status, current_step, created_at, updated_at
             FROM clips WHERE id = ?1",
            rusqlite::params![&input.clip_id],
            |row| {
                Ok(ClipInfo {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    source_id: row.get(2)?,
                    sort_index: row.get(3)?,
                    title: row.get(4)?,
                    summary: row.get(5)?,
                    source_text: row.get(6)?,
                    estimated_duration: row.get(7)?,
                    status: row.get(8)?,
                    current_step: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    // source_text 变更且之前有成功拆解记录 → 自动触发重新拆解
    if source_changed && had_success && !source_text_val.is_empty() {
        let project_id = clip.project_id.clone();
        let clip_id = clip.id.clone();
        let source_text = source_text_val.to_string();

        // 确保 Worker 在线
        if let Err(e) = util::ensure_worker_running(&state, &app, &project_id) {
            crate::project_log::append_log(
                &crate::project_log::log_path_for_app_data(
                    &crate::app_paths::resolve_app_data_dir(&app)?,
                ),
                "拆解",
                "WARN",
                &format!("自动重拆失败（Worker 未就绪）：{}", e),
            );
        } else {
            // 插入重拆任务 + 通知 Worker
            let task_id = uuid::Uuid::new_v4().to_string();
            let lock_key = format!("generate_clip_script:{}", clip_id);
            let input_json = serde_json::json!({
                "projectId": &project_id,
                "clipId": &clip_id,
                "sourceText": &source_text,
            })
            .to_string();

            // 删旧拆解记录 + 插入新任务
            conn.execute(
                "DELETE FROM clip_scripts WHERE clip_id = ?1",
                rusqlite::params![&clip_id],
            )
            .map_err(|e| e.to_string())?;

            let script_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO clip_scripts (id, project_id, clip_id, source_text, status)
                 VALUES (?1, ?2, ?3, ?4, 'pending')",
                rusqlite::params![&script_id, &project_id, &clip_id, &source_text],
            )
            .map_err(|e| e.to_string())?;

            conn.execute(
                "INSERT INTO tasks (id, project_id, clip_id, type, status, lock_key, input_json, max_retry)
                 VALUES (?1, ?2, ?3, 'generate_clip_script', 'pending', ?4, ?5, 3)",
                rusqlite::params![
                    &task_id,
                    &project_id,
                    &clip_id,
                    &lock_key,
                    &input_json
                ],
            )
            .map_err(|e| e.to_string())?;

            conn.execute(
                "UPDATE clips SET status = 'running', updated_at = datetime('now') WHERE id = ?1",
                rusqlite::params![&clip_id],
            )
            .map_err(|e| e.to_string())?;

            if let Err(e) = util::send_enqueue_to_worker(&state, &task_id, "generate_clip_script") {
                crate::project_log::append_log(
                    &crate::project_log::log_path_for_app_data(
                        &crate::app_paths::resolve_app_data_dir(&app)?,
                    ),
                    "拆解",
                    "WARN",
                    &format!("自动重拆 enqueue 通知失败（任务仍会被轮询拾取）：{}", e),
                );
            }
        }
    }

    Ok(clip)
}

/// 在指定位置拆分片段
#[tauri::command]
pub fn split_clip(
    input: SplitClipInput,
    app: tauri::AppHandle,
) -> Result<SplitClipResult, String> {
    let mut conn = util::open_app_conn(&app)?;

    // 读取原片段
    let (project_id, source_id, sort_index, title, source_text): (
        String,
        Option<String>,
        i64,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT project_id, source_id, sort_index, title, source_text
             FROM clips WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![&input.clip_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    // 按字符切分（非字节），避免截断 UTF-8
    let total_chars = source_text.chars().count() as i64;
    if input.split_position <= 0 || input.split_position >= total_chars {
        return Err(format!(
            "拆分位置越界：split_position={}，有效范围 (0, {})",
            input.split_position, total_chars
        ));
    }

    let pos = input.split_position as usize;
    let first_text: String = source_text
        .chars()
        .take(pos)
        .collect::<String>()
        .trim()
        .to_string();
    let second_text: String = source_text
        .chars()
        .skip(pos)
        .collect::<String>()
        .trim()
        .to_string();
    if first_text.is_empty() || second_text.is_empty() {
        return Err("拆分后某一段为空，请调整拆分位置".to_string());
    }

    let second_id = uuid::Uuid::new_v4().to_string();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 原片段更新为前半段，状态重置
    tx.execute(
        "UPDATE clips
         SET source_text = ?1, status = 'pending', current_step = 'project',
             updated_at = datetime('now')
         WHERE id = ?2",
        rusqlite::params![&first_text, &input.clip_id],
    )
    .map_err(|e| e.to_string())?;

    // 后续片段 sort_index 顺延
    tx.execute(
        "UPDATE clips
         SET sort_index = sort_index + 1, updated_at = datetime('now')
         WHERE project_id = ?1 AND sort_index > ?2 AND deleted_at IS NULL",
        rusqlite::params![&project_id, sort_index],
    )
    .map_err(|e| e.to_string())?;

    // 插入后半段新片段
    tx.execute(
        "INSERT INTO clips
            (id, project_id, source_id, sort_index, title, summary, source_text, status, current_step)
         VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, 'pending', 'project')",
        rusqlite::params![
            &second_id,
            &project_id,
            &source_id,
            sort_index + 1,
            &title,
            &second_text,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    crate::project_log::append_log(
        &log_path,
        "项目",
        "INFO",
        &format!(
            "片段已拆分 origin={} first={} second={} pos={}",
            input.clip_id,
            input.clip_id,
            second_id,
            input.split_position,
        ),
    );

    Ok(SplitClipResult {
        first_clip_id: input.clip_id,
        second_clip_id: second_id,
    })
}
