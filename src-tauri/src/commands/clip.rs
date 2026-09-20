//! 分集/剧本源相关命令

use crate::commands::util;
use crate::sidecar::SharedSidecarManager;
use serde::{Deserialize, Serialize};

/// 分集信息
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

/// 批量删除分集输入
#[derive(Debug, Deserialize)]
pub struct DeleteClipsInput {
    pub clip_ids: Vec<String>,
    /// 是否一并删除数据库记录所引用的作品工作区内本地文件，默认不删除。
    #[serde(default)]
    pub delete_files: bool,
}

/// 分集删除结果，供前端在勾选文件清理时展示实际处理情况。
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

/// 安全删除记录中引用的作品工作区文件。
///
/// 调用方必须在数据库事务提交后使用此函数；工作区外、符号链接解析后越界或
/// 不存在的路径不会被删除，且不会把已提交的数据库删除回报为失败。
pub(crate) fn delete_managed_files(candidates: Vec<ClipFileCandidate>) -> DeleteClipsResult {
    delete_managed_clip_files(candidates)
}

/// 更新分集输入，三个内容字段均可选，传哪个改哪个
#[derive(Debug, Deserialize)]
pub struct UpdateClipInput {
    pub clip_id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub source_text: Option<String>,
}

/// 分集拆分输入：在原 source_text 的第 split_position 个字符处拆成两段
#[derive(Debug, Deserialize)]
pub struct SplitClipInput {
    pub clip_id: String,
    pub split_position: i64,
}

/// 拆分分集返回结果
#[derive(Debug, Serialize)]
pub struct SplitClipResult {
    pub first_clip_id: String,
    pub second_clip_id: String,
}

/// 手动创建单个分集输入
#[derive(Debug, Deserialize)]
pub struct CreateClipInput {
    pub project_id: String,
    pub title: String,
    pub source_text: String,
}

/// 手动创建单个分集（无剧本源归属）
#[tauri::command]
pub fn create_clip(input: CreateClipInput, app: tauri::AppHandle) -> Result<ClipInfo, String> {
    let conn = util::open_app_conn(&app)?;
    let clip_id = uuid::Uuid::new_v4().to_string();

    // 取当前作品最大 sort_index + 1
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

/// 列出作品下所有分集
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

/// 列出作品下所有剧本源
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

#[allow(dead_code)]
fn collect_clip_file_paths(
    tx: &rusqlite::Transaction<'_>,
    clip_id: &str,
) -> Result<Vec<String>, String> {
    // 1. 查出哪些素材被其他分集引用（需保护）
    let protected: Vec<String>;
    let protect_sql = "
        SELECT ca.asset_id
        FROM clip_assets ca
        JOIN clips c ON c.id = ca.clip_id
        WHERE ca.clip_id != ?1 AND c.deleted_at IS NULL
    ";
    {
        let mut stmt = tx
            .prepare(protect_sql)
            .map_err(|e| format!("查询共享素材失败: {}", e))?;
        protected = stmt
            .query_map(rusqlite::params![clip_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("遍历共享素材失败: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
    }

    // 2. 本分集下的全部 asset id
    let owned: Vec<String>;
    {
        let mut stmt = tx
            .prepare("SELECT asset_id FROM clip_assets WHERE clip_id = ?1")
            .map_err(|e| format!("查询本分集素材失败: {}", e))?;
        owned = stmt
            .query_map(rusqlite::params![clip_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("遍历本分集素材失败: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
    }

    // 3. 可删除的 = 本分集的 - 被保护的
    let protected_set: std::collections::HashSet<&str> =
        protected.iter().map(|s| s.as_str()).collect();
    let deletable: Vec<&str> = owned
        .iter()
        .map(|s| s.as_str())
        .filter(|id| !protected_set.contains(id))
        .collect();

    // 4. 收集文件路径：仅可删除素材的图片
    let mut paths: Vec<String> = Vec::new();
    if !deletable.is_empty() {
        let placeholders: Vec<String> = deletable
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect();
        let img_sql = format!(
            "SELECT image_path FROM asset_images WHERE asset_id IN ({})
             UNION
             SELECT thumbnail_path FROM asset_images WHERE asset_id IN ({}) AND thumbnail_path IS NOT NULL",
            placeholders.join(","),
            placeholders.join(",")
        );
        {
            let mut stmt = tx
                .prepare(&img_sql)
                .map_err(|e| format!("查询可删素材图片失败: {}", e))?;
            let params: Vec<&dyn rusqlite::types::ToSql> = deletable
                .iter()
                .map(|id| id as &dyn rusqlite::types::ToSql)
                .collect();
            let rows = stmt
                .query_map(params.as_slice(), |row| row.get::<_, String>(0))
                .map_err(|e| format!("遍历可删素材图片失败: {}", e))?;
            for r in rows {
                if let Ok(p) = r {
                    paths.push(p);
                }
            }
        }
        // reference_image_path 也是受素材实体管理的外部引用。
        let ref_sql = format!(
            "SELECT reference_image_path FROM assets WHERE id IN ({}) AND reference_image_path IS NOT NULL",
            placeholders.join(",")
        );
        {
            let mut stmt = tx
                .prepare(&ref_sql)
                .map_err(|e| format!("查询可删素材引用图失败: {}", e))?;
            let params: Vec<&dyn rusqlite::types::ToSql> = deletable
                .iter()
                .map(|id| id as &dyn rusqlite::types::ToSql)
                .collect();
            let rows = stmt
                .query_map(params.as_slice(), |row| row.get::<_, String>(0))
                .map_err(|e| format!("遍历可删素材引用图失败: {}", e))?;
            for r in rows {
                if let Ok(p) = r {
                    paths.push(p);
                }
            }
        }
    }

    // 5. 镜头/拼接输出不受素材复用影响，始终收集
    {
        let mut stmt = tx
            .prepare(
                "SELECT voice_path FROM storyboards WHERE clip_id = ?1 AND voice_path IS NOT NULL
                 UNION
                 SELECT file_path FROM storyboard_videos
                 WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)
                 UNION
                 SELECT cover_path FROM storyboard_videos
                 WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1) AND cover_path IS NOT NULL
                 UNION
                 SELECT output_path FROM concat_outputs WHERE clip_id = ?1
                 UNION
                 SELECT cover_path FROM concat_outputs WHERE clip_id = ?1 AND cover_path IS NOT NULL
                 UNION
                 SELECT output_path FROM upscale_jobs
                 WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1) AND TRIM(output_path) <> ''",
            )
            .map_err(|e| format!("查询镜头/视频文件失败: {}", e))?;
        let rows = stmt
            .query_map(rusqlite::params![clip_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("遍历镜头/视频文件失败: {}", e))?;
        for r in rows {
            if let Ok(p) = r {
                paths.push(p);
            }
        }
    }

    Ok(paths)
}

/// 删除数据库记录中列出的、且位于所属作品工作区中的文件。
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

/// 批量软删除分集及其派生数据。
///
/// `clips` 采用软删除，但其镜头、素材、任务和拼接记录均是分集私有的派生数据，
/// 必须在同一事务内按外键依赖顺序清理。这样既不会影响同作品的其他分集，也不会
/// 留下阻止后续清理的子记录。
#[tauri::command]
pub fn delete_clips(
    input: DeleteClipsInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<DeleteClipsResult, String> {
    let mut clip_ids = Vec::new();
    for id in input.clip_ids {
        if id.is_empty() {
            return Err("分集 ID 不能为空".to_string());
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

    // 真正软删：派生剧本、镜头、视频和素材池都保留，以便 restore_clips 恢复完整状态。
    // 异步任务改为 invalidated 而不是删除，Worker 写回时可观察到持久化墓碑。
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut running_task_ids = Vec::new();
    for id in &clip_ids {
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM clips WHERE id = ?1 AND deleted_at IS NULL",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists != 1 {
            return Err(format!("分集不存在或已删除：{}", id));
        }
        let mut task_stmt = tx
            .prepare(
                "SELECT id FROM tasks
                 WHERE status = 'running' AND (clip_id = ?1 OR storyboard_id IN (
                    SELECT id FROM storyboards WHERE clip_id = ?1
                 ))",
            )
            .map_err(|e| e.to_string())?;
        let rows = task_stmt
            .query_map(rusqlite::params![id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        running_task_ids.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?,
        );
        tx.execute(
            "UPDATE tasks
             SET status = CASE WHEN status IN ('pending','running','waiting_remote','downloading') THEN 'invalidated' ELSE status END,
                 cancel_requested_at = COALESCE(cancel_requested_at, datetime('now')),
                 cancel_reason = 'clip deleted', updated_at = datetime('now')
             WHERE clip_id = ?1 OR storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE clips SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    // DB 墓碑已提交后再请求各执行器停止；即使进程在此刻退出，写回 CAS 也会拒绝旧结果。
    for task_id in &running_task_ids {
        let _ = util::send_cancel_to_worker(&state, task_id);
    }
    crate::upscale_manager::cancel_upscale_jobs_for_clips(&app, &clip_ids)?;
    if input.delete_files {
        log::warn!("分集软删除忽略 delete_files=true；物理文件仅可由后续永久清理流程删除");
    }
    return Ok(DeleteClipsResult {
        deleted_file_count: 0,
        skipped_file_count: 0,
        failed_file_count: 0,
    });
}

/* 已替换的旧硬删实现：仅保留在源文件中供后续永久清理（purge）迁移参考，不参与编译。 = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut file_candidates = Vec::new();
    let target_asset_ids = {
        let placeholders = std::iter::repeat("?")
            .take(clip_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT DISTINCT asset_id FROM clip_assets WHERE clip_id IN ({})",
            placeholders
        );
        let mut statement = tx.prepare(&sql).map_err(|error| error.to_string())?;
        let params: Vec<&dyn rusqlite::types::ToSql> = clip_ids
            .iter()
            .map(|id| id as &dyn rusqlite::types::ToSql)
            .collect();
        let rows = statement
            .query_map(params.as_slice(), |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    // 先验证全部目标，任意一个失效时整个批次回滚，避免批量操作只删一部分。
    for id in &clip_ids {
        let project_id: String = tx
            .query_row(
                "SELECT project_id FROM clips WHERE id = ?1 AND deleted_at IS NULL",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|_| format!("分集不存在或已删除：{}", id))?;

        if input.delete_files {
            let workspace_path: String = tx
                .query_row(
                    "SELECT workspace_path FROM projects WHERE id = ?1",
                    rusqlite::params![&project_id],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    format!("读取作品工作区失败 projectId={}: {}", project_id, error)
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
             )
             OR locked_by IN (
                SELECT id FROM tasks
                WHERE clip_id = ?1
                   OR storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)
             )",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除任务锁 clipId={}: {}", id, e))?;

        // 2.5. 超分任务外键引用 storyboard_videos/storyboards，需在二者之前删除
        tx.execute(
            "DELETE FROM upscale_jobs WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除超分任务 clipId={}: {}", id, e))?;

        // 3. storyboard_videos 同时引用 storyboards 与 tasks，必须先于二者删除。
        tx.execute(
            "DELETE FROM storyboard_videos WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除镜头视频 clipId={}: {}", id, e))?;

        // 素材实体的回收统一在批次全部解除 clip_assets 关联后执行，避免批量删除
        // 共享素材时因处理顺序误删图片或留下孤儿记录。
        tx.execute(
            "DELETE FROM concat_outputs WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除拼接记录 clipId={}: {}", id, e))?;
        tx.execute(
            "DELETE FROM storyboard_assets
             WHERE storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除镜头素材关联 clipId={}: {}", id, e))?;

        // 5. 先删除绑定任务的拆解子记录，再删除所有以该分集、其镜头或其素材为目标的任务。
        tx.execute(
            "DELETE FROM clip_scripts WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除拆解记录 clipId={}: {}", id, e))?;
        tx.execute(
            "DELETE FROM tasks
             WHERE clip_id = ?1
                OR storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除关联任务 clipId={}: {}", id, e))?;

        // 6. 删除父级派生数据，最后才标记分集本体删除。
        tx.execute(
            "DELETE FROM storyboards WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除镜头 clipId={}: {}", id, e))?;
        tx.execute(
            "DELETE FROM clip_assets WHERE clip_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| format!("无法删除分集素材池关联 clipId={}: {}", id, e))?;

        let affected = tx
            .execute(
                "UPDATE clips
                 SET deleted_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ?1 AND deleted_at IS NULL",
                rusqlite::params![id],
            )
            .map_err(|e| format!("无法删除分集 clipId={}: {}", id, e))?;
        if affected != 1 {
            return Err(format!("删除分集时记录状态异常：{}", id));
        }
    }

    // 所有待删分集均已解除素材池关联后，再回收整个批次中没有任何剩余分集引用的实体。
    // 这样 A/B 同时删除且共同复用同一素材时，不会因顺序而遗漏回收或误删。
    for asset_id in target_asset_ids {
        let remaining_links: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM clip_assets WHERE asset_id = ?1",
                rusqlite::params![&asset_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if remaining_links > 0 {
            continue;
        }

        if input.delete_files {
            let workspace_path: String = tx
                .query_row(
                    "SELECT p.workspace_path FROM assets a JOIN projects p ON p.id = a.project_id WHERE a.id = ?1",
                    rusqlite::params![&asset_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            let mut statement = tx
                .prepare(
                    "SELECT image_path FROM asset_images WHERE asset_id = ?1
                     UNION SELECT thumbnail_path FROM asset_images WHERE asset_id = ?1 AND thumbnail_path IS NOT NULL
                     UNION SELECT reference_image_path FROM assets WHERE id = ?1 AND reference_image_path IS NOT NULL",
                )
                .map_err(|error| error.to_string())?;
            let paths = statement
                .query_map(rusqlite::params![&asset_id], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            for file_path in paths {
                file_candidates.push(ClipFileCandidate {
                    workspace_path: std::path::PathBuf::from(&workspace_path),
                    file_path: std::path::PathBuf::from(file_path),
                });
            }
        }

        tx.execute(
            "DELETE FROM storyboard_assets WHERE asset_id = ?1",
            rusqlite::params![&asset_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM task_locks
             WHERE lock_key IN (SELECT lock_key FROM tasks WHERE asset_id = ?1)
                OR locked_by IN (SELECT id FROM tasks WHERE asset_id = ?1)",
            rusqlite::params![&asset_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM tasks WHERE asset_id = ?1",
            rusqlite::params![&asset_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM asset_images WHERE asset_id = ?1",
            rusqlite::params![&asset_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM assets WHERE id = ?1",
            rusqlite::params![&asset_id],
        )
        .map_err(|error| error.to_string())?;
    }

    tx.commit().map_err(|e| {
        crate::project_log::append_log(
            &log_path,
            "作品",
            "ERROR",
            &format!("删除分集事务提交失败: {}", e),
        );
        e.to_string()
    })?;

    crate::project_log::append_log(
        &log_path,
        "删除文件",
        "INFO",
        &format!(
            "即将删除 {} 个候选文件: {:?}",
            file_candidates.len(),
            file_candidates
                .iter()
                .map(|c| c.file_path.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
        ),
    );

    let result = if input.delete_files {
        delete_managed_clip_files(file_candidates)
    } else {
        DeleteClipsResult {
            deleted_file_count: 0,
            skipped_file_count: 0,
            failed_file_count: 0,
        }
    };

    crate::project_log::append_log(
        &log_path,
        "删除文件",
        "INFO",
        &format!(
            "删除结果: deleted={}, skipped={}, failed={}",
            result.deleted_file_count, result.skipped_file_count, result.failed_file_count,
        ),
    );

    for id in &clip_ids {
        crate::project_log::append_log(
            &log_path,
            "作品",
            "INFO",
            &format!("已删除分集及其关联数据 clipId={}", id),
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
            "作品",
            level,
            &format!(
                "分集关联文件清理完成：已删除 {}，已跳过 {}，失败 {}",
                result.deleted_file_count, result.skipped_file_count, result.failed_file_count
            ),
        );
    }
    Ok(result)
}
*/

/// 恢复此前软删除的分集；派生数据从未被删除，因此恢复不会重新触发旧任务。
#[derive(Debug, Deserialize)]
pub struct RestoreClipsInput {
    pub clip_ids: Vec<String>,
}

#[tauri::command]
pub fn restore_clips(input: RestoreClipsInput, app: tauri::AppHandle) -> Result<usize, String> {
    if input.clip_ids.is_empty() {
        return Ok(0);
    }
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut restored = 0usize;
    for clip_id in input.clip_ids {
        let affected = tx
            .execute(
                "UPDATE clips SET deleted_at = NULL, updated_at = datetime('now')
                 WHERE id = ?1 AND deleted_at IS NOT NULL",
                rusqlite::params![clip_id],
            )
            .map_err(|e| e.to_string())?;
        if affected != 1 {
            return Err("分集不存在、未删除或已被永久清理".to_string());
        }
        restored += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(restored)
}

/// 更新分集内容
#[tauri::command]
pub fn update_clip(
    input: UpdateClipInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<ClipInfo, String> {
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (current_source_text, had_success): (String, bool) = tx
        .query_row(
            "SELECT source_text,
                    EXISTS(SELECT 1 FROM clip_scripts WHERE clip_id = clips.id AND status = 'success')
             FROM clips WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![&input.clip_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| format!("分集不存在或已删除：{}", input.clip_id))?;

    let title_val = input.title.as_deref().unwrap_or("");
    let summary_val = input.summary.as_deref().unwrap_or("");
    let source_text_val = input.source_text.as_deref().unwrap_or("");
    // 空串沿用既有“不覆盖”语义；只有实际写入不同原文时才推进 revision。
    let source_changed = !source_text_val.is_empty() && source_text_val != current_source_text;

    tx.execute(
        "UPDATE clips SET
            title = CASE WHEN ?1 != '' THEN ?1 ELSE title END,
            summary = CASE WHEN ?2 != '' THEN ?2 ELSE summary END,
            source_text = CASE WHEN ?4 THEN ?3 ELSE source_text END,
            source_revision = source_revision + CASE WHEN ?4 THEN 1 ELSE 0 END,
            status = CASE WHEN ?4 THEN 'pending' ELSE status END,
            current_step = CASE WHEN ?4 THEN 'project' ELSE current_step END,
            active_optimization_id = CASE WHEN ?4 THEN NULL ELSE active_optimization_id END,
            updated_at = datetime('now')
         WHERE id = ?5 AND deleted_at IS NULL",
        rusqlite::params![
            title_val,
            summary_val,
            source_text_val,
            source_changed,
            &input.clip_id,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    // 返回最新行，同时读取自动重拆必须绑定的更新后 revision。
    let (clip, source_revision) = conn
        .query_row(
            "SELECT id, project_id, source_id, sort_index, title, summary, source_text,
                    estimated_duration, status, current_step, created_at, updated_at,
                    source_revision
             FROM clips WHERE id = ?1",
            rusqlite::params![&input.clip_id],
            |row| {
                Ok((
                    ClipInfo {
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
                    },
                    row.get::<_, i64>(12)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    // 原文真正变更且存在历史成功拆解时，自动创建新 revision 的拆解任务。
    if source_changed && had_success {
        let project_id = clip.project_id.clone();
        let clip_id = clip.id.clone();
        let source_text = clip.source_text.clone();

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
            let task_id = uuid::Uuid::new_v4().to_string();
            let script_id = uuid::Uuid::new_v4().to_string();
            let lock_key = format!("generate_clip_script:{}", clip_id);
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
                "clipScriptId": &script_id,
                "sourceRevision": source_revision,
                "sourceText": &source_text,
                "styleMode": &style_mode,
            })
            .to_string();

            // CAS、task、clip_script 必须在同一事务，且 task 先于其 FK 子记录。
            let enqueue_tx = conn.transaction().map_err(|e| e.to_string())?;
            let claimed = enqueue_tx
                .execute(
                    "UPDATE clips
                     SET status = 'running', updated_at = datetime('now')
                     WHERE id = ?1 AND deleted_at IS NULL AND source_revision = ?2
                       AND status = 'pending'",
                    rusqlite::params![&clip_id, source_revision],
                )
                .map_err(|e| e.to_string())?;

            if claimed == 1 {
                enqueue_tx
                    .execute(
                        "INSERT INTO tasks
                           (id, project_id, clip_id, type, status, lock_key, input_json, max_retry)
                         VALUES (?1, ?2, ?3, 'generate_clip_script', 'pending', ?4, ?5, 3)",
                        rusqlite::params![&task_id, &project_id, &clip_id, &lock_key, &input_json],
                    )
                    .map_err(|e| e.to_string())?;
                enqueue_tx
                    .execute(
                        "INSERT INTO clip_scripts
                           (id, project_id, clip_id, task_id, source_revision, source_text, status)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
                        rusqlite::params![
                            &script_id,
                            &project_id,
                            &clip_id,
                            &task_id,
                            source_revision,
                            &source_text
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                enqueue_tx.commit().map_err(|e| e.to_string())?;

                if let Err(e) =
                    util::send_enqueue_to_worker(&state, &task_id, "generate_clip_script")
                {
                    crate::project_log::append_log(
                        &crate::project_log::log_path_for_app_data(
                            &crate::app_paths::resolve_app_data_dir(&app)?,
                        ),
                        "拆解",
                        "WARN",
                        &format!("自动重拆 enqueue 通知失败（任务仍会被轮询拾取）：{}", e),
                    );
                }
            } else {
                // 其他请求已取得该 revision 的所有权，不再创建重复任务。
                enqueue_tx.rollback().map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(clip)
}

/// 删除素材输入
#[derive(Debug, Deserialize)]
pub struct DeleteAssetsInput {
    pub asset_ids: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct DeletedAsset;

/// 防止删除仍由镜头提示词执行快照引用的素材。
/// 不自动重写用户编辑的提示词或 @图片编号，必须先由用户在镜头侧移除引用。
fn ensure_asset_not_mentioned_in_clip(
    tx: &rusqlite::Transaction<'_>,
    clip_id: &str,
    asset_id: &str,
) -> Result<(), String> {
    let params = {
        let mut statement = tx
            .prepare(
                "SELECT id, COALESCE(video_param_json, '') FROM storyboards WHERE clip_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params![clip_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    for (storyboard_id, raw) in params {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let mentioned = value
            .get("mention_map")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|entries| {
                entries.iter().any(|entry| {
                    entry.get("assetId").and_then(serde_json::Value::as_str) == Some(asset_id)
                })
            });
        if mentioned {
            return Err(format!(
                "素材仍被镜头提示词引用，请先在镜头中移除引用后再删除（storyboardId={}）",
                storyboard_id
            ));
        }
    }
    Ok(())
}

/// 从一个分集移除素材。若其它存活分集仍持有 clip_assets 关联，只解除当前分集关系；
/// 否则回收该素材及其派生图片、任务。
pub(crate) fn detach_asset_from_clip(
    tx: &rusqlite::Transaction<'_>,
    clip_id: &str,
    asset_id: &str,
) -> Result<Option<DeletedAsset>, String> {
    let _asset = tx
        .query_row(
            "SELECT 1 FROM assets WHERE id = ?1",
            rusqlite::params![asset_id],
            |_| Ok(DeletedAsset),
        )
        .map_err(|error| format!("素材不存在：{}", error))?;
    let linked: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM clip_assets WHERE clip_id = ?1 AND asset_id = ?2",
            rusqlite::params![clip_id, asset_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if linked == 0 {
        return Err(format!("素材不属于当前分集：{}", asset_id));
    }

    ensure_asset_not_mentioned_in_clip(tx, clip_id, asset_id)?;
    tx.execute(
        "DELETE FROM storyboard_assets
         WHERE asset_id = ?1 AND storyboard_id IN (SELECT id FROM storyboards WHERE clip_id = ?2)",
        rusqlite::params![asset_id, clip_id],
    )
    .map_err(|error| format!("删除分集镜头素材关联失败：{}", error))?;
    tx.execute(
        "DELETE FROM clip_assets WHERE clip_id = ?1 AND asset_id = ?2",
        rusqlite::params![clip_id, asset_id],
    )
    .map_err(|error| format!("删除分集素材关联失败：{}", error))?;

    let remaining: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM clip_assets WHERE asset_id = ?1",
            rusqlite::params![asset_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if remaining > 0 {
        return Ok(None);
    }
    delete_asset_by_id(tx, asset_id).map(Some)
}

/// 删除单个素材及其只属于该素材的引用和派生记录。
///
/// 调用者必须持有事务；本函数不接触磁盘文件，避免无确认的物理文件删除。
pub(crate) fn delete_asset_by_id(
    tx: &rusqlite::Transaction<'_>,
    asset_id: &str,
) -> Result<DeletedAsset, String> {
    let asset = tx
        .query_row(
            "SELECT 1 FROM assets WHERE id = ?1",
            rusqlite::params![asset_id],
            |_| Ok(DeletedAsset),
        )
        .map_err(|error| format!("素材不存在：{}", error))?;

    tx.execute(
        "DELETE FROM clip_assets WHERE asset_id = ?1",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除分集素材关联失败 assetId={}: {}", asset_id, error))?;
    tx.execute(
        "DELETE FROM storyboard_assets WHERE asset_id = ?1",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除镜头素材关联失败 assetId={}: {}", asset_id, error))?;
    tx.execute(
        "DELETE FROM task_locks
         WHERE lock_key IN (SELECT lock_key FROM tasks WHERE asset_id = ?1)
            OR locked_by IN (SELECT id FROM tasks WHERE asset_id = ?1)",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除素材任务锁失败 assetId={}: {}", asset_id, error))?;
    tx.execute(
        "DELETE FROM tasks WHERE asset_id = ?1",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除素材任务失败 assetId={}: {}", asset_id, error))?;
    // 本地执行器已在命令入口收到取消；删除 job 记录会让最终写回的条件更新失败。
    tx.execute(
        "DELETE FROM upscale_jobs WHERE source_asset_id = ?1",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除素材超分任务失败 assetId={}: {}", asset_id, error))?;
    tx.execute(
        "DELETE FROM asset_images WHERE asset_id = ?1",
        rusqlite::params![asset_id],
    )
    .map_err(|error| format!("删除素材图片失败 assetId={}: {}", asset_id, error))?;
    let affected = tx
        .execute(
            "DELETE FROM assets WHERE id = ?1",
            rusqlite::params![asset_id],
        )
        .map_err(|error| format!("删除素材失败 assetId={}: {}", asset_id, error))?;
    if affected != 1 {
        return Err(format!("删除素材时记录状态异常：{}", asset_id));
    }

    Ok(asset)
}

/// 按素材 ID 批量删除素材。
///
/// 每个 ID 先完整验证并在同一事务中清理，任一 ID 失效都会回滚整个批次。
#[tauri::command]
pub fn delete_assets(input: DeleteAssetsInput, app: tauri::AppHandle) -> Result<(), String> {
    let mut asset_ids = Vec::new();
    for id in input.asset_ids {
        if id.is_empty() {
            return Err("素材 ID 不能为空".to_string());
        }
        if !asset_ids.contains(&id) {
            asset_ids.push(id);
        }
    }
    if asset_ids.is_empty() {
        return Ok(());
    }

    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    // 硬删前先让本地执行器停止；随后删除 job 使陈旧完成回写失去所有权。
    crate::upscale_manager::cancel_upscale_jobs_for_assets(&app, &asset_ids)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for asset_id in &asset_ids {
        delete_asset_by_id(&tx, asset_id)?;
    }
    tx.commit().map_err(|error| error.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "素材",
        "INFO",
        &format!("已删除 {} 个素材及其关联数据", asset_ids.len()),
    );
    Ok(())
}

/// 在指定位置拆分分集
#[tauri::command]
pub fn split_clip(input: SplitClipInput, app: tauri::AppHandle) -> Result<SplitClipResult, String> {
    let mut conn = util::open_app_conn(&app)?;

    // 读取原分集
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

    // 原分集更新为前半段，状态重置
    tx.execute(
        "UPDATE clips
         SET source_text = ?1, source_revision = source_revision + 1,
             status = 'pending', current_step = 'project',
             updated_at = datetime('now')
         WHERE id = ?2",
        rusqlite::params![&first_text, &input.clip_id],
    )
    .map_err(|e| e.to_string())?;

    // 后续分集 sort_index 顺延
    tx.execute(
        "UPDATE clips
         SET sort_index = sort_index + 1, updated_at = datetime('now')
         WHERE project_id = ?1 AND sort_index > ?2 AND deleted_at IS NULL",
        rusqlite::params![&project_id, sort_index],
    )
    .map_err(|e| e.to_string())?;

    // 插入后半段新分集
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
        "作品",
        "INFO",
        &format!(
            "分集已拆分 origin={} first={} second={} pos={}",
            input.clip_id, input.clip_id, second_id, input.split_position,
        ),
    );

    Ok(SplitClipResult {
        first_clip_id: input.clip_id,
        second_clip_id: second_id,
    })
}

// ── 剧本优化 ──────────────────────────────────────────────────────

/// 剧本优化输入
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeScriptInput {
    pub project_id: String,
    pub clip_id: String,
    pub text: String,
    pub mode: String,
    #[serde(default)]
    pub instruction: Option<String>,
}

/// 剧本优化返回
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeScriptResult {
    pub task_id: String,
    pub optimization_id: String,
}

/// 对分集原文进行 AI 优化（润色 / 扩写 / 精简）
#[tauri::command]
pub fn optimize_script(
    input: OptimizeScriptInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::sidecar::SharedSidecarManager>,
) -> Result<OptimizeScriptResult, String> {
    let conn = util::open_app_conn(&app)?;
    let task_id = uuid::Uuid::new_v4().to_string();
    let optimization_id = uuid::Uuid::new_v4().to_string();

    // 1. 先创建优化记录（status=running，optimized_text 为空，前端立即看到新 Tab）
    let char_count_before = input.text.chars().count() as i64;
    conn.execute(
        "INSERT INTO script_optimizations
           (id, project_id, clip_id, source_text, optimized_text, mode, instruction,
            char_count_before, char_count_after, task_id, status)
         VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7, 0, ?8, 'running')",
        rusqlite::params![
            &optimization_id,
            &input.project_id,
            &input.clip_id,
            &input.text,
            &input.mode,
            input.instruction.as_deref().unwrap_or(""),
            char_count_before,
            &task_id,
        ],
    )
    .map_err(|e| e.to_string())?;

    // 2. 创建异步任务，传入 optimization_id 供 Worker 后续 UPDATE
    let input_json = serde_json::json!({
        "projectId": input.project_id,
        "clipId": input.clip_id,
        "text": input.text,
        "mode": input.mode,
        "instruction": input.instruction,
        "optimizationId": optimization_id,
    })
    .to_string();

    let lock_key = format!("optimize_script:{}:{}", input.project_id, input.clip_id);

    conn.execute(
        "INSERT INTO tasks (id, project_id, clip_id, type, status, lock_key, input_json, max_retry)
         VALUES (?1, ?2, ?3, 'optimize_script', 'pending', ?4, ?5, 2)",
        rusqlite::params![
            &task_id,
            &input.project_id,
            &input.clip_id,
            &lock_key,
            &input_json
        ],
    )
    .map_err(|e| e.to_string())?;

    let log_path =
        crate::project_log::log_path_for_app_data(&crate::app_paths::resolve_app_data_dir(&app)?);
    crate::project_log::append_log(
        &log_path,
        "剧本优化",
        "INFO",
        &format!(
            "优化任务已入队 projectId={} clipId={} mode={} taskId={} optimizationId={}",
            input.project_id, input.clip_id, input.mode, task_id, optimization_id
        ),
    );

    if let Err(e) = util::send_enqueue_to_worker(&state, &task_id, "optimize_script") {
        crate::project_log::append_log(
            &log_path,
            "剧本优化",
            "WARN",
            &format!("发送 enqueue 通知失败（Worker 仍会轮询任务）：{}", e),
        );
    }

    Ok(OptimizeScriptResult {
        task_id,
        optimization_id,
    })
}

// ── 剧本优化：版本管理 ──────────────────────────────────────────────

#[derive(Debug, serde::Serialize)]
pub struct OptimizationRecord {
    id: String,
    project_id: String,
    clip_id: String,
    source_text: String,
    optimized_text: String,
    mode: String,
    instruction: String,
    char_count_before: i64,
    char_count_after: i64,
    task_id: Option<String>,
    status: String,
    created_at: String,
}

#[derive(Debug, serde::Serialize)]
pub struct OptimizationsResult {
    active_id: Option<String>,
    items: Vec<OptimizationRecord>,
}

/// 列出某分集的全部 AI 优化版本，并返回当前生效版本 id。
#[tauri::command]
pub fn list_optimizations(
    clip_id: String,
    app: tauri::AppHandle,
) -> Result<OptimizationsResult, String> {
    let conn = util::open_app_conn(&app)?;

    let active_id: Option<String> = conn
        .query_row(
            "SELECT active_optimization_id FROM clips WHERE id = ?1",
            rusqlite::params![&clip_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap_or(None);

    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, clip_id, source_text, optimized_text, mode, instruction,
                    char_count_before, char_count_after, task_id, status, created_at
             FROM script_optimizations WHERE clip_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(rusqlite::params![&clip_id], |row| {
            Ok(OptimizationRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                clip_id: row.get(2)?,
                source_text: row.get(3)?,
                optimized_text: row.get(4)?,
                mode: row.get(5)?,
                instruction: row.get(6)?,
                char_count_before: row.get(7)?,
                char_count_after: row.get(8)?,
                task_id: row.get(9)?,
                status: row.get(10)?,
                created_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(OptimizationsResult { active_id, items })
}

/// 选定某优化版本为当前生效版本（拆解镜头 / 素材将使用此版本）。
#[tauri::command]
pub fn select_optimization(
    clip_id: String,
    optimization_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (current_active_id, current_effective_text, selected_status, selected_text): (
        Option<String>,
        String,
        String,
        String,
    ) = tx
        .query_row(
            "SELECT c.active_optimization_id,
                    CASE
                      WHEN current_so.status = 'completed' AND TRIM(current_so.optimized_text) <> ''
                        THEN current_so.optimized_text
                      ELSE c.source_text
                    END,
                    selected_so.status, selected_so.optimized_text
             FROM clips c
             JOIN script_optimizations selected_so
               ON selected_so.id = ?1 AND selected_so.clip_id = c.id
             LEFT JOIN script_optimizations current_so ON current_so.id = c.active_optimization_id
             WHERE c.id = ?2 AND c.deleted_at IS NULL",
            rusqlite::params![&optimization_id, &clip_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "优化版本不存在或不属于该分集".to_string())?;

    if selected_status != "completed" || selected_text.trim().is_empty() {
        return Err("只能使用已完成且内容非空的优化版本".to_string());
    }
    let selected_effective_text = selected_text;
    let effective_changed = current_effective_text != selected_effective_text;

    if effective_changed {
        tx.execute(
            "UPDATE clips
             SET active_optimization_id = ?1, source_revision = source_revision + 1,
                 status = 'pending', current_step = 'project', updated_at = datetime('now')
             WHERE id = ?2",
            rusqlite::params![&optimization_id, &clip_id],
        )
        .map_err(|e| e.to_string())?;
    } else if current_active_id.as_deref() != Some(optimization_id.as_str()) {
        tx.execute(
            "UPDATE clips
             SET active_optimization_id = ?1, updated_at = datetime('now')
             WHERE id = ?2",
            rusqlite::params![&optimization_id, &clip_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

/// 删除某条优化记录；若其为当前生效版本则一并清除。
#[tauri::command]
pub fn delete_optimization(optimization_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (clip_id, is_active, source_text, optimization_status, optimization_text): (
        String,
        bool,
        String,
        String,
        String,
    ) = tx
        .query_row(
            "SELECT so.clip_id, c.active_optimization_id = so.id, c.source_text,
                    so.status, so.optimized_text
             FROM script_optimizations so
             JOIN clips c ON c.id = so.clip_id
             WHERE so.id = ?1",
            rusqlite::params![&optimization_id],
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
        .map_err(|_| "优化版本不存在".to_string())?;

    if is_active {
        let current_effective_text =
            if optimization_status == "completed" && !optimization_text.trim().is_empty() {
                optimization_text
            } else {
                source_text.clone()
            };
        if current_effective_text != source_text {
            tx.execute(
                "UPDATE clips
                 SET active_optimization_id = NULL, source_revision = source_revision + 1,
                     status = 'pending', current_step = 'project', updated_at = datetime('now')
                 WHERE id = ?1",
                rusqlite::params![&clip_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            tx.execute(
                "UPDATE clips
                 SET active_optimization_id = NULL, updated_at = datetime('now')
                 WHERE id = ?1",
                rusqlite::params![&clip_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.execute(
        "DELETE FROM script_optimizations WHERE id = ?1",
        rusqlite::params![&optimization_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

/// 修改某优化记录的结果文本（前端编辑后实时落库）
#[tauri::command]
pub fn update_optimization_text(
    optimization_id: String,
    optimized_text: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (old_text, status, source_text, is_active): (String, String, String, bool) = tx
        .query_row(
            "SELECT so.optimized_text, so.status, c.source_text,
                    c.active_optimization_id = so.id
             FROM script_optimizations so
             JOIN clips c ON c.id = so.clip_id
             WHERE so.id = ?1",
            rusqlite::params![&optimization_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "优化版本不存在".to_string())?;

    if old_text == optimized_text {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let char_count = optimized_text.chars().count() as i64;
    tx.execute(
        "UPDATE script_optimizations SET optimized_text = ?1, char_count_after = ?2 WHERE id = ?3",
        rusqlite::params![&optimized_text, char_count, &optimization_id],
    )
    .map_err(|e| e.to_string())?;

    if is_active && status == "completed" {
        let old_effective_text = if old_text.trim().is_empty() {
            source_text.clone()
        } else {
            old_text
        };
        let new_effective_text = if optimized_text.trim().is_empty() {
            source_text
        } else {
            optimized_text
        };
        if old_effective_text != new_effective_text {
            tx.execute(
                "UPDATE clips
                 SET source_revision = source_revision + 1,
                     status = 'pending', current_step = 'project', updated_at = datetime('now')
                 WHERE active_optimization_id = ?1",
                rusqlite::params![&optimization_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
