//! 剧本导入/拆解相关命令
//!
//! @author yt @date 20260703

use crate::commands::util;
use crate::sidecar::SharedSidecarManager;
use serde::{Deserialize, Serialize};

/// 导入剧本输入参数
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportScriptInput {
    pub project_id: String,
    pub source_type: String,
    pub content: Option<String>,
    pub file_path: Option<String>,
}

/// 导入剧本返回结果
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportScriptResult {
    pub source_id: String,
}

/// 生成片段拆解输入
#[derive(Debug, Deserialize)]
pub struct GenerateClipScriptInput {
    pub clip_id: String,
}

/// 片段拆解脚本信息
#[derive(Debug, Serialize)]
pub struct ClipScriptInfo {
    pub id: String,
    pub clip_id: String,
    pub script_summary: String,
    pub extracted_resources_json: String,
    pub status: String,
}

/// 导入剧本内容
#[tauri::command]
pub fn import_script(
    input: ImportScriptInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<ImportScriptResult, String> {
    let mut conn = util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    let raw_content = match (input.content, input.file_path) {
        (Some(c), _) => c,
        (None, Some(path)) => {
            std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?
        }
        (None, None) => return Err("content or file_path is required".to_string()),
    };

    let normalized = util::normalize_text(&raw_content);

    let source_id = uuid::Uuid::new_v4().to_string();
    let task_id = uuid::Uuid::new_v4().to_string();
    let lock_key = format!("split_script:{}", source_id);
    let input_json = serde_json::json!({
        "projectId": &input.project_id,
        "sourceId": &source_id,
        "forceAi": false
    })
    .to_string();

    // 自动生成剧本标题（剧本1, 剧本2, ...）
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM script_sources WHERE project_id = ?1",
            rusqlite::params![&input.project_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let file_name = format!("剧本{}", count + 1);

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO script_sources (id, project_id, source_type, file_name, raw_content, normalized_content, split_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
        rusqlite::params![
            &source_id,
            &input.project_id,
            &input.source_type,
            &file_name,
            &raw_content,
            &normalized,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO tasks (id, project_id, type, status, lock_key, input_json, max_retry)
         VALUES (?1, ?2, 'split_script', 'pending', ?3, ?4, 2)",
        rusqlite::params![&task_id, &input.project_id, &lock_key, &input_json],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    crate::project_log::append_log(
        &log_path,
        "剧本",
        "INFO",
        &format!(
            "剧本已入队 sourceId={} taskId={} sourceType={}",
            source_id, task_id, input.source_type
        ),
    );

    // 通知 Worker 立即调度（与 generate_clip_script 保持一致）
    if let Err(e) = util::send_enqueue_to_worker(&state, &task_id, "split_script") {
        crate::project_log::append_log(
            &log_path,
            "剧本",
            "WARN",
            &format!("发送 enqueue 通知失败（任务仍会被轮询拾取）：{}", e),
        );
    }

    Ok(ImportScriptResult { source_id })
}

/// 生成片段拆解脚本
#[tauri::command]
pub fn generate_clip_script(
    input: GenerateClipScriptInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<serde_json::Value, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = util::open_app_conn(&app)?;

    // 查询片段所属项目和原文
    let row = conn
        .query_row(
            "SELECT project_id, source_text FROM clips WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![&input.clip_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| format!("片段查询失败：{}", e))?;

    let (project_id, source_text) = row;
    if source_text.trim().is_empty() {
        return Err("片段原文为空，无法拆解".to_string());
    }

    // 确保 Worker 在线（插入任务前保证消费者存在）
    util::ensure_worker_running(&state, &app, &project_id)?;

    let task_id = uuid::Uuid::new_v4().to_string();
    let lock_key = format!("generate_clip_script:{}", input.clip_id);
    let input_json = serde_json::json!({
        "projectId": &project_id,
        "clipId": input.clip_id,
        "sourceText": &source_text,
    })
    .to_string();

    // 事务：创建 clip_script 记录 + 插入任务 + 更新片段状态
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 先删旧的拆解记录（重拆）
    tx.execute(
        "DELETE FROM clip_scripts WHERE clip_id = ?1",
        rusqlite::params![&input.clip_id],
    )
    .map_err(|e| e.to_string())?;

    let script_id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO clip_scripts (id, project_id, clip_id, source_text, status)
         VALUES (?1, ?2, ?3, ?4, 'pending')",
        rusqlite::params![&script_id, &project_id, &input.clip_id, &source_text],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO tasks (id, project_id, clip_id, type, status, lock_key, input_json, max_retry)
         VALUES (?1, ?2, ?3, 'generate_clip_script', 'pending', ?4, ?5, 3)",
        rusqlite::params![
            &task_id,
            &project_id,
            &input.clip_id,
            &lock_key,
            &input_json
        ],
    )
    .map_err(|e| e.to_string())?;

    // 标记片段拆解中
    tx.execute(
        "UPDATE clips SET status = 'running', updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![&input.clip_id],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    crate::project_log::append_log(
        &log_path,
        "拆解",
        "INFO",
        &format!(
            "拆解已入队 clipId={} taskId={} 原文={}字符",
            input.clip_id,
            task_id,
            source_text.len()
        ),
    );

    // 通知 Worker 立即调度（不必等下一轮轮询）
    if let Err(e) = util::send_enqueue_to_worker(&state, &task_id, "generate_clip_script") {
        crate::project_log::append_log(
            &log_path,
            "设置",
            "WARN",
            &format!("发送 enqueue 通知失败（任务仍会被轮询拾取）：{}", e),
        );
    }

    Ok(serde_json::json!({ "task_id": task_id }))
}

/// 取消片段拆解任务
#[tauri::command]
pub fn cancel_clip_script(
    input: GenerateClipScriptInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<(), String> {
    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let lock_key = format!("generate_clip_script:{}", input.clip_id);

    // 先查出 running 状态的任务 ID，以便发送取消命令给 Worker
    let running_task_ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM tasks WHERE lock_key = ?1 AND status = 'running'")
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(rusqlite::params![&lock_key], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        ids.filter_map(|r| r.ok()).collect()
    };

    let deleted = tx
        .execute(
            "DELETE FROM tasks WHERE lock_key = ?1 AND status IN ('pending', 'running')",
            rusqlite::params![&lock_key],
        )
        .map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE clip_scripts SET status = 'cancelled', updated_at = datetime('now') WHERE clip_id = ?1 AND status IN ('pending', 'running')",
        rusqlite::params![&input.clip_id],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE clips SET status = 'pending', updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![&input.clip_id],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    // 通知 Worker 中止正在执行的任务
    for task_id in &running_task_ids {
        if let Err(e) = util::send_cancel_to_worker(&state, task_id) {
            crate::project_log::append_log(
                &log_path,
                "设置",
                "WARN",
                &format!("发送 cancel 通知失败（任务可能已完成）：{}", e),
            );
        }
    }
    crate::project_log::append_log(
        &log_path,
        "拆解",
        "INFO",
        &format!(
            "拆解已取消 clipId={}（{}个任务）",
            input.clip_id, deleted
        ),
    );

    Ok(())
}

/// 获取项目片段拆解结果
#[tauri::command]
pub fn get_clip_scripts(
    project_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<ClipScriptInfo>, String> {
    let conn = util::open_app_conn(&app)?;
    // 子查询取每个 clip_id 最新一条记录（按 created_at DESC），避免历史 pending 记录干扰
    let mut stmt = conn
        .prepare(
            "SELECT cs.id, cs.clip_id, cs.script_summary, cs.extracted_resources_json, cs.status
             FROM clip_scripts cs
             JOIN clips c ON c.id = cs.clip_id
             WHERE c.project_id = ?1 AND c.deleted_at IS NULL
               AND cs.id IN (
                 SELECT id FROM (
                   SELECT id, ROW_NUMBER() OVER (PARTITION BY clip_id ORDER BY created_at DESC) AS rn
                   FROM clip_scripts
                 ) WHERE rn = 1
               )
             ORDER BY cs.created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![&project_id], |row| {
            Ok(ClipScriptInfo {
                id: row.get(0)?,
                clip_id: row.get(1)?,
                script_summary: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                extracted_resources_json: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                status: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}
