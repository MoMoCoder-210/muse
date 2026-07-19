//! 片段/剧本源相关命令

use crate::commands::util;
use crate::sidecar::SharedSidecarManager;
use serde::{Deserialize, Serialize};

/// 片段信息
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
    /// 是否一并删除数据库记录所引用的项目工作区内本地文件，默认不删除。
    #[serde(default)]
    pub delete_files: bool,
}

/// 片段删除结果，供前端在勾选文件清理时展示实际处理情况。
#[derive(Debug, Serialize)]
pub struct DeleteClipsResult {
    pub deleted_file_count: usize,
    pub skipped_file_count: usize,
    pub failed_file_count: usize,
}

#[derive(Debug)]
pub(crate) struct ClipFileCandidate {
    pub(crate) workspace_path: std::path::PathBuf,
    pub(crate) file_path: std::path::PathBuf,
}

/// 安全删除记录中引用的项目工作区文件。
///
/// 调用方必须在数据库事务提交后使用此函数；工作区外、符号链接解析后越界或
/// 不存在的路径不会被删除，且不会把已提交的数据库删除回报为失败。
pub(crate) fn delete_managed_files(candidates: Vec<ClipFileCandidate>) -> DeleteClipsResult {
    delete_managed_clip_files(candidates)
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
pub fn create_clip(input: CreateClipInput, app: tauri::AppHandle) -> Result<ClipInfo, String> {
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

fn collect_clip_file_paths(
    tx: &rusqlite::Transaction<'_>,
    clip_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = tx
        .prepare(
            "SELECT image_path FROM asset_images
             WHERE asset_id IN (SELECT id FROM assets WHERE clip_id = ?1)
             UNION
             SELECT reference_image_path FROM assets
             WHERE clip_id = ?1 AND reference_image_path IS NOT NULL
             UNION
             SELECT generated_image_path FROM assets
             WHERE clip_id = ?1 AND generated_image_path IS NOT NULL
             UNION
             SELECT fused_image_path FROM storyboards
             WHERE clip_id = ?1 AND fused_image_path IS NOT NULL
             UNION
             SELECT voice_path FROM storyboards
             WHERE clip_id = ?1 AND voice_path IS NOT NULL
             UNION
             SELECT file_path FROM storyboard_videos
             WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)
             UNION
             SELECT output_path FROM concat_outputs WHERE clip_id = ?1",
        )
        .map_err(|error| format!("读取片段关联文件失败 clipId={}: {}", clip_id, error))?;
    let rows = statement
        .query_map(rusqlite::params![clip_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("查询片段关联文件失败 clipId={}: {}", clip_id, error))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取片段关联文件失败 clipId={}: {}", clip_id, error))
}

/// 删除数据库记录中列出的、且位于所属项目工作区中的文件。
///
/// 绝不删除工作区外部路径；解析符号链接后的真实路径也必须仍在工作区内。
/// 数据库事务已经提交时，物理文件删除失败只计入结果并记录日志，避免把已成功的
/// 数据库删除错误地回报为整个操作失败。
fn delete_managed_clip_files(candidates: Vec<ClipFileCandidate>) -> DeleteClipsResult {
    let mut result = DeleteClipsResult {
        deleted_file_count: 0,
        skipped_file_count: 0,
        failed_file_count: 0,
    };
    let mut handled_paths = std::collections::HashSet::new();

    for candidate in candidates {
        if !candidate.file_path.is_absolute()
            || !candidate.file_path.starts_with(&candidate.workspace_path)
            || !handled_paths.insert(candidate.file_path.clone())
        {
            result.skipped_file_count += 1;
            continue;
        }

        let canonical_workspace = match std::fs::canonicalize(&candidate.workspace_path) {
            Ok(path) => path,
            Err(_) => {
                result.skipped_file_count += 1;
                continue;
            }
        };
        let canonical_file = match std::fs::canonicalize(&candidate.file_path) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                result.failed_file_count += 1;
                continue;
            }
        };
        if !canonical_file.starts_with(&canonical_workspace) {
            result.skipped_file_count += 1;
            continue;
        }

        match std::fs::remove_file(&candidate.file_path) {
            Ok(()) => result.deleted_file_count += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => result.failed_file_count += 1,
        }
    }

    result
}

/// 批量软删除片段及其派生数据。
///
/// `clips` 采用软删除，但其分镜、资产、任务和拼接记录均是片段私有的派生数据，
/// 必须在同一事务内按外键依赖顺序清理。这样既不会影响同项目的其他片段，也不会
/// 留下阻止后续清理的子记录。
#[tauri::command]
pub fn delete_clips(
    input: DeleteClipsInput,
    app: tauri::AppHandle,
) -> Result<DeleteClipsResult, String> {
    let mut clip_ids = Vec::new();
    for id in input.clip_ids {
        if id.is_empty() {
            return Err("片段 ID 不能为空".to_string());
        }
        if !clip_ids.contains(&id) {
            clip_ids.push(id);
        }
    }
    if clip_ids.is_empty() {
        return Ok(DeleteClipsResult {
            deleted_file_count: 0,
            skipped_file_count: 0,
            failed_file_count: 0,
        });
    }

    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut file_candidates = Vec::new();

    // 先验证全部目标，任意一个失效时整个批次回滚，避免批量操作只删一部分。
    for id in &clip_ids {
        let project_id: String = tx
            .query_row(
                "SELECT project_id FROM clips WHERE id = ?1 AND deleted_at IS NULL",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|_| format!("片段不存在或已删除：{}", id))?;

        if input.delete_files {
            let workspace_path: String = tx
                .query_row(
                    "SELECT workspace_path FROM projects WHERE id = ?1",
                    rusqlite::params![&project_id],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    format!("读取项目工作区失败 projectId={}: {}", project_id, error)
                })?;
            for file_path in collect_clip_file_paths(&tx, id)? {
                file_candidates.push(ClipFileCandidate {
                    workspace_path: std::path::PathBuf::from(&workspace_path),
                    file_path: std::path::PathBuf::from(file_path),
                });
            }
        }
    }

    for id in &clip_ids {
        // 1. 先断开 storyboards → storyboard_videos 的循环引用；否则删除最终视频会触发 FK 失败。
        tx.execute(
            "UPDATE storyboards SET selected_video_id = NULL, updated_at = datetime('now') WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法解除最终视频引用 clipId={}: {}", id, e))?;

        // 2. task_locks 不声明外键，但必须和对应任务一起清理，避免留下不可再获取的逻辑锁。
        tx.execute(
            "DELETE FROM task_locks
             WHERE lock_key IN (
                SELECT lock_key FROM tasks
                WHERE clip_id = ?1
                   OR storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)
                   OR asset_id IN (SELECT id FROM assets WHERE clip_id = ?1)
             )
             OR locked_by IN (
                SELECT id FROM tasks
                WHERE clip_id = ?1
                   OR storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)
                   OR asset_id IN (SELECT id FROM assets WHERE clip_id = ?1)
             )",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除任务锁 clipId={}: {}", id, e))?;

        // 3. storyboard_videos 同时引用 storyboards 与 tasks，必须先于二者删除。
        tx.execute(
            "DELETE FROM storyboard_videos WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除分镜视频 clipId={}: {}", id, e))?;

        // 4. 删除其余叶子记录。
        tx.execute(
            "DELETE FROM asset_images WHERE asset_id IN (SELECT id FROM assets WHERE clip_id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除资产图片 clipId={}: {}", id, e))?;
        tx.execute(
            "DELETE FROM concat_outputs WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除拼接记录 clipId={}: {}", id, e))?;
        tx.execute(
            "DELETE FROM storyboard_assets
             WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)
                OR asset_id IN (SELECT id FROM assets WHERE clip_id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除分镜资产关联 clipId={}: {}", id, e))?;

        // 5. 删除所有以该片段、其分镜或其资产为目标的任务，而非只删除 pending/running 子集。
        tx.execute(
            "DELETE FROM tasks
             WHERE clip_id = ?1
                OR storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)
                OR asset_id IN (SELECT id FROM assets WHERE clip_id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除关联任务 clipId={}: {}", id, e))?;

        // 6. 删除父级派生数据，最后才标记片段本体删除。
        tx.execute(
            "DELETE FROM storyboards WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除分镜 clipId={}: {}", id, e))?;
        tx.execute(
            "DELETE FROM assets WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除资产 clipId={}: {}", id, e))?;
        tx.execute(
            "DELETE FROM clip_scripts WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除拆解记录 clipId={}: {}", id, e))?;

        let affected = tx
            .execute(
                "UPDATE clips
                 SET deleted_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ?1 AND deleted_at IS NULL",
                rusqlite::params![id],
            )
            .map_err(|e| format!("无法删除片段 clipId={}: {}", id, e))?;
        if affected != 1 {
            return Err(format!("删除片段时记录状态异常：{}", id));
        }
    }

    tx.commit().map_err(|e| {
        crate::project_log::append_log(
            &log_path,
            "项目",
            "ERROR",
            &format!("删除片段事务提交失败: {}", e),
        );
        e.to_string()
    })?;

    let result = if input.delete_files {
        delete_managed_clip_files(file_candidates)
    } else {
        DeleteClipsResult {
            deleted_file_count: 0,
            skipped_file_count: 0,
            failed_file_count: 0,
        }
    };
    for id in &clip_ids {
        crate::project_log::append_log(
            &log_path,
            "项目",
            "INFO",
            &format!("已删除片段及其关联数据 clipId={}", id),
        );
    }
    if input.delete_files {
        let level = if result.failed_file_count > 0 {
            "WARN"
        } else {
            "INFO"
        };
        crate::project_log::append_log(
            &log_path,
            "项目",
            level,
            &format!(
                "片段关联文件清理完成：已删除 {}，已跳过 {}，失败 {}",
                result.deleted_file_count, result.skipped_file_count, result.failed_file_count
            ),
        );
    }
    Ok(result)
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
        .unwrap_or(0)
        > 0;

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

            // 查询项目风格（用于视频提示词风格拼接）
            let style_mode: String = conn
                .query_row(
                    "SELECT style_mode FROM projects WHERE id = ?1",
                    rusqlite::params![&project_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap_or(None)
                .unwrap_or_default();

            let input_json = serde_json::json!({
                "projectId": &project_id,
                "clipId": &clip_id,
                "sourceText": &source_text,
                "styleMode": &style_mode,
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

/// 删除资产输入
#[derive(Debug, Deserialize)]
pub struct DeleteAssetsInput {
    pub asset_ids: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct DeletedAsset {
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
}

/// 从片段最新的拆解结果中移除一个资产描述。
///
/// 资产卡片以该 JSON 为展示来源，因此数据库资产记录删除后也必须同步更新；
/// 没有拆解记录的手动资产则无需更新，直接返回成功。
pub(crate) fn remove_asset_from_latest_clip_script(
    tx: &rusqlite::Transaction<'_>,
    clip_id: &str,
    asset_type: &str,
    name: &str,
) -> Result<(), String> {
    let row = tx.query_row(
        "SELECT id, COALESCE(extracted_resources_json, '')
         FROM clip_scripts WHERE clip_id = ?1 ORDER BY created_at DESC LIMIT 1",
        rusqlite::params![clip_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    let (script_id, raw_resources) = match row {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(()),
        Err(error) => return Err(format!("读取片段资源失败 clipId={}: {}", clip_id, error)),
    };

    let key = match asset_type {
        "character" => "characters",
        "scene" => "scenes",
        "item" => "items",
        _ => return Err(format!("无效的资产类型：{}", asset_type)),
    };
    let mut resources: serde_json::Value = if raw_resources.trim().is_empty() {
        serde_json::json!({ "characters": [], "scenes": [], "items": [] })
    } else {
        serde_json::from_str(&raw_resources)
            .map_err(|error| format!("解析片段资源 JSON 失败 clipId={}: {}", clip_id, error))?
    };
    if !resources.is_object() {
        return Err(format!("片段资源 JSON 格式无效 clipId={}", clip_id));
    }
    if let Some(items) = resources
        .get_mut(key)
        .and_then(serde_json::Value::as_array_mut)
    {
        items.retain(|item| {
            item.get("name")
                .and_then(serde_json::Value::as_str)
                .map(|item_name| item_name != name)
                .unwrap_or(true)
        });
    }

    let updated_resources = serde_json::to_string(&resources).map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE clip_scripts SET extracted_resources_json = ?1, updated_at = datetime('now') WHERE id = ?2",
        rusqlite::params![updated_resources, script_id],
    )
    .map_err(|error| format!("更新片段资源失败 clipId={}: {}", clip_id, error))?;
    Ok(())
}

/// 删除单个资产及其只属于该资产的引用和派生记录。
///
/// 调用者必须持有事务；本函数不接触磁盘文件，避免无确认的物理文件删除。
pub(crate) fn delete_asset_by_id(
    tx: &rusqlite::Transaction<'_>,
    asset_id: &str,
) -> Result<DeletedAsset, String> {
    let asset = tx
        .query_row(
            "SELECT clip_id, type, name FROM assets WHERE id = ?1",
            rusqlite::params![asset_id],
            |row| {
                Ok(DeletedAsset {
                    clip_id: row.get(0)?,
                    asset_type: row.get(1)?,
                    name: row.get(2)?,
                })
            },
        )
        .map_err(|error| format!("资产不存在：{}", error))?;

    remove_asset_from_latest_clip_script(tx, &asset.clip_id, &asset.asset_type, &asset.name)?;

    // 先将关联分镜中的 JSON ID 清掉；仅处理实际关联该资产的分镜，不影响同片段其他分镜。
    let storyboard_ids = {
        let mut statement = tx
            .prepare("SELECT DISTINCT storyboard_id FROM storyboard_assets WHERE asset_id = ?1")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params![asset_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let column = match asset.asset_type.as_str() {
        "character" => "character_ids_json",
        "scene" => "scene_ids_json",
        "item" => "item_ids_json",
        _ => return Err(format!("无效的资产类型：{}", asset.asset_type)),
    };
    for storyboard_id in storyboard_ids {
        let ids_json: String = tx
            .query_row(
                &format!("SELECT {} FROM storyboards WHERE id = ?1", column),
                rusqlite::params![&storyboard_id],
                |row| row.get(0),
            )
            .map_err(|error| {
                format!(
                    "读取分镜资产关联失败 storyboardId={}: {}",
                    storyboard_id, error
                )
            })?;
        let mut ids: Vec<String> = serde_json::from_str(&ids_json).map_err(|error| {
            format!(
                "解析分镜资产关联失败 storyboardId={}: {}",
                storyboard_id, error
            )
        })?;
        ids.retain(|id| id != asset_id);
        let updated_ids = serde_json::to_string(&ids).map_err(|error| error.to_string())?;
        tx.execute(
            &format!(
                "UPDATE storyboards SET {} = ?1, updated_at = datetime('now') WHERE id = ?2",
                column
            ),
            rusqlite::params![updated_ids, &storyboard_id],
        )
        .map_err(|error| {
            format!(
                "更新分镜资产关联失败 storyboardId={}: {}",
                storyboard_id, error
            )
        })?;
    }

    tx.execute(
        "DELETE FROM storyboard_assets WHERE asset_id = ?1",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除分镜资产关联失败 assetId={}: {}", asset_id, error))?;
    tx.execute(
        "DELETE FROM task_locks
         WHERE lock_key IN (SELECT lock_key FROM tasks WHERE asset_id = ?1)
            OR locked_by IN (SELECT id FROM tasks WHERE asset_id = ?1)",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除资产任务锁失败 assetId={}: {}", asset_id, error))?;
    tx.execute(
        "DELETE FROM tasks WHERE asset_id = ?1",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除资产任务失败 assetId={}: {}", asset_id, error))?;
    tx.execute(
        "DELETE FROM asset_images WHERE asset_id = ?1",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除资产图片失败 assetId={}: {}", asset_id, error))?;
    let affected = tx
        .execute(
            "DELETE FROM assets WHERE id = ?1",
            rusqlite::params![asset_id],
        )
        .map_err(|error| format!("删除资产失败 assetId={}: {}", asset_id, error))?;
    if affected != 1 {
        return Err(format!("删除资产时记录状态异常：{}", asset_id));
    }

    Ok(asset)
}

/// 按资产 ID 批量删除资产。
///
/// 每个 ID 先完整验证并在同一事务中清理，任一 ID 失效都会回滚整个批次。
#[tauri::command]
pub fn delete_assets(input: DeleteAssetsInput, app: tauri::AppHandle) -> Result<(), String> {
    let mut asset_ids = Vec::new();
    for id in input.asset_ids {
        if id.is_empty() {
            return Err("资产 ID 不能为空".to_string());
        }
        if !asset_ids.contains(&id) {
            asset_ids.push(id);
        }
    }
    if asset_ids.is_empty() {
        return Ok(());
    }

    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for asset_id in &asset_ids {
        delete_asset_by_id(&tx, asset_id)?;
    }
    tx.commit().map_err(|error| error.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "资产",
        "INFO",
        &format!("已删除 {} 个资产及其关联数据", asset_ids.len()),
    );
    Ok(())
}

/// 在指定位置拆分片段
#[tauri::command]
pub fn split_clip(input: SplitClipInput, app: tauri::AppHandle) -> Result<SplitClipResult, String> {
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
            input.clip_id, input.clip_id, second_id, input.split_position,
        ),
    );

    Ok(SplitClipResult {
        first_clip_id: input.clip_id,
        second_clip_id: second_id,
    })
}
