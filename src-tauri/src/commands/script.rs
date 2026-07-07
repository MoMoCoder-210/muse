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

/// 资产生图输入
#[derive(Debug, Deserialize)]
pub struct GenerateAssetImageInput {
    pub project_id: String,
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
    pub prompt: String,
    pub size: Option<String>,
    pub n: Option<i32>,
    pub style: Option<String>,
}

/// 添加资产输入
#[derive(Debug, Deserialize)]
pub struct AddAssetInput {
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
}

/// 删除资产输入
#[derive(Debug, Deserialize)]
pub struct DeleteAssetInput {
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
}

/// 资产查询输入
#[derive(Debug, Deserialize)]
pub struct AssetQueryInput {
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
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

/// 资产生图
///
/// 根据资产拆解阶段生成的 prompt 创建 image 生成任务，由 Worker 异步调用生图模型。
#[tauri::command]
pub fn generate_asset_image(
    input: GenerateAssetImageInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<serde_json::Value, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    util::ensure_worker_running(&state, &app, &input.project_id)?;

    let task_id = uuid::Uuid::new_v4().to_string();
    let lock_key = format!(
        "generate_asset_image:{}:{}:{}",
        input.clip_id, input.asset_type, input.name
    );
    let mut input_json = serde_json::json!({
        "projectId": input.project_id,
        "clipId": input.clip_id,
        "assetType": input.asset_type,
        "name": input.name,
        "prompt": input.prompt,
    });

    if let Some(ref size) = input.size {
        input_json["size"] = serde_json::Value::String(size.clone());
    }
    if let Some(n) = input.n {
        input_json["n"] = serde_json::Value::Number((n as i64).into());
    }
    if let Some(ref style) = input.style {
        input_json["style"] = serde_json::Value::String(style.clone());
    }

    let input_json = input_json.to_string();

    let conn = util::open_app_conn(&app)?;
    conn.execute(
        "INSERT INTO tasks (id, project_id, clip_id, type, status, lock_key, input_json, max_retry)
         VALUES (?1, ?2, ?3, 'generate_asset_image', 'pending', ?4, ?5, 3)",
        rusqlite::params![&task_id, &input.project_id, &input.clip_id, &lock_key, &input_json],
    )
    .map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "资产生图",
        "INFO",
        &format!(
            "资产生图已入队 projectId={} clipId={} assetType={} name={} taskId={}",
            input.project_id, input.clip_id, input.asset_type, input.name, task_id
        ),
    );

    if let Err(e) = util::send_enqueue_to_worker(&state, &task_id, "generate_asset_image") {
        crate::project_log::append_log(
            &log_path,
            "资产生图",
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

/// 添加单个资产到 clip_scripts.extracted_resources_json
///
/// 读取当前 clip 的拆解结果，将新资产追加到对应分类，再写回。
#[tauri::command]
pub fn add_asset_to_clip(
    input: AddAssetInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let conn = util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    let row = conn
        .query_row(
            "SELECT id, extracted_resources_json FROM clip_scripts WHERE clip_id = ?1 ORDER BY created_at DESC LIMIT 1",
            rusqlite::params![&input.clip_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default())),
        )
        .map_err(|e| format!("未找到该片段的拆解记录：{}", e))?;

    let (script_id, resources_json) = row;

    let mut parsed: serde_json::Value = if resources_json.is_empty() {
        serde_json::json!({ "characters": [], "scenes": [], "items": [] })
    } else {
        serde_json::from_str(&resources_json).map_err(|e| format!("解析资源 JSON 失败：{}", e))?
    };

    let key = match input.asset_type.as_str() {
        "character" => "characters",
        "scene" => "scenes",
        "item" => "items",
        _ => return Err(format!("无效的资产类型：{}", input.asset_type)),
    };

    let new_item = serde_json::json!({
        "type": input.asset_type,
        "name": input.name,
        "description": input.description,
        "prompt": input.prompt,
    });

    if let Some(arr) = parsed[key].as_array_mut() {
        arr.push(new_item);
    } else {
        parsed[key] = serde_json::json!([new_item]);
    }

    let updated_json = serde_json::to_string(&parsed).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE clip_scripts SET extracted_resources_json = ?, updated_at = datetime('now') WHERE id = ?",
        rusqlite::params![&updated_json, &script_id],
    )
    .map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "资产",
        "INFO",
        &format!(
            "已添加资产 clipId={} type={} name={}",
            input.clip_id, input.asset_type, input.name
        ),
    );

    Ok(())
}

/// 从 clip_scripts 中删除单个资产
///
/// 按 type + name 匹配并从 extracted_resources_json 中移除。
#[tauri::command]
pub fn delete_asset_from_clip(
    input: DeleteAssetInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let conn = util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    let row = conn
        .query_row(
            "SELECT id, extracted_resources_json FROM clip_scripts WHERE clip_id = ?1 ORDER BY created_at DESC LIMIT 1",
            rusqlite::params![&input.clip_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default())),
        )
        .map_err(|e| format!("未找到该片段的拆解记录：{}", e))?;

    let (script_id, resources_json) = row;

    let mut parsed: serde_json::Value = serde_json::from_str(&resources_json)
        .map_err(|e| format!("解析资源 JSON 失败：{}", e))?;

    let key = match input.asset_type.as_str() {
        "character" => "characters",
        "scene" => "scenes",
        "item" => "items",
        _ => return Err(format!("无效的资产类型：{}", input.asset_type)),
    };

    if let Some(arr) = parsed[key].as_array_mut() {
        arr.retain(|item| {
            item.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n != input.name)
                .unwrap_or(true)
        });
    }

    let updated_json = serde_json::to_string(&parsed).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE clip_scripts SET extracted_resources_json = ?, updated_at = datetime('now') WHERE id = ?",
        rusqlite::params![&updated_json, &script_id],
    )
    .map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "资产",
        "INFO",
        &format!(
            "已删除资产 clipId={} type={} name={}",
            input.clip_id, input.asset_type, input.name
        ),
    );

    Ok(())
}

/// 查询资产图片信息
#[derive(Debug, Serialize)]
pub struct AssetImageInfo {
    pub generated_image_path: Option<String>,
    pub selected_image_id: Option<String>,
    pub status: String,
    pub image_count: i64,
}

/// 获取指定资产的图片信息（按 clip_id + type + name 查 assets 表）
#[tauri::command]
pub fn get_asset_image_info(
    input: AssetQueryInput,
    app: tauri::AppHandle,
) -> Result<AssetImageInfo, String> {
    let conn = util::open_app_conn(&app)?;

    let row = conn
        .query_row(
            "SELECT a.generated_image_path, a.selected_image_id, a.status,
                    (SELECT COUNT(*) FROM asset_images ai WHERE ai.asset_id = a.id) as image_count
             FROM assets a
             WHERE a.clip_id = ?1 AND a.type = ?2 AND a.name = ?3
             LIMIT 1",
            rusqlite::params![&input.clip_id, &input.asset_type, &input.name],
            |row| Ok(AssetImageInfo {
                generated_image_path: row.get(0)?,
                selected_image_id: row.get(1)?,
                status: row.get(2)?,
                image_count: row.get(3)?,
            }),
        );

    match row {
        Ok(info) => Ok(info),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(AssetImageInfo {
            generated_image_path: None,
            selected_image_id: None,
            status: "draft".to_string(),
            image_count: 0,
        }),
        Err(e) => Err(format!("查询资产图片信息失败：{}", e)),
    }
}

/// 资产图片列表项
#[derive(Debug, Serialize)]
pub struct AssetImageItem {
    pub id: String,
    pub image_path: String,
    pub size: Option<String>,
    pub style: Option<String>,
    pub is_selected: bool,
    pub created_at: String,
}

/// 资产图片+任务混合列表项（供抽屉实时展示：生成中/成功/失败）
#[derive(Debug, Serialize)]
pub struct AssetImageTaskItem {
    pub id: String,
    /// 已生成图片路径（pending / running / failed 时为 null）
    pub image_path: Option<String>,
    pub size: Option<String>,
    pub style: Option<String>,
    pub is_selected: bool,
    /// ready（已生成）| pending | running | failed
    pub status: String,
    pub error_message: Option<String>,
    /// 方舟上传状态：null（无需上传）| pending | uploaded | failed
    pub ark_upload_status: Option<String>,
    pub ark_upload_error: Option<String>,
    pub created_at: String,
}

/// 获取指定资产的所有生成图片列表
#[tauri::command]
pub fn list_asset_images(
    input: AssetQueryInput,
    app: tauri::AppHandle,
) -> Result<Vec<AssetImageItem>, String> {
    let conn = util::open_app_conn(&app)?;

    // 先查 asset_id
    let asset_row = conn
        .query_row(
            "SELECT id FROM assets WHERE clip_id = ?1 AND type = ?2 AND name = ?3 LIMIT 1",
            rusqlite::params![&input.clip_id, &input.asset_type, &input.name],
            |row| row.get::<_, String>(0),
        )
        .ok();

    let asset_id = match asset_row {
        Some(id) => id,
        None => return Ok(vec![]),
    };

    let mut stmt = conn
        .prepare(
            "SELECT id, image_path, size, style, is_selected, created_at
             FROM asset_images WHERE asset_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(rusqlite::params![&asset_id], |row| {
            Ok(AssetImageItem {
                id: row.get(0)?,
                image_path: row.get(1)?,
                size: row.get(2)?,
                style: row.get(3)?,
                is_selected: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

/// 获取资产图片+任务混合列表（含 pending / running / failed 任务）
///
/// 抽屉实时轮询：已完成的图片 + 进行中的任务，统一按时间排序展示。
#[tauri::command]
pub fn list_asset_image_tasks(
    input: AssetQueryInput,
    app: tauri::AppHandle,
) -> Result<Vec<AssetImageTaskItem>, String> {
    let conn = util::open_app_conn(&app)?;

    // 查 asset_id
    let asset_row = conn
        .query_row(
            "SELECT id FROM assets WHERE clip_id = ?1 AND type = ?2 AND name = ?3 LIMIT 1",
            rusqlite::params![&input.clip_id, &input.asset_type, &input.name],
            |row| row.get::<_, String>(0),
        )
        .ok();

    let mut results: Vec<AssetImageTaskItem> = Vec::new();

    // 1. 已生成的图片（asset_images 表）
    if let Some(ref asset_id) = asset_row {
        let mut stmt = conn
            .prepare(
                "SELECT id, image_path, size, style, is_selected, created_at, ark_upload_status, ark_upload_error
                 FROM asset_images WHERE asset_id = ?1",
            )
            .map_err(|e| e.to_string())?;

        let img_items = stmt
            .query_map(rusqlite::params![asset_id], |row| {
                Ok(AssetImageTaskItem {
                    id: row.get(0)?,
                    image_path: Some(row.get(1)?),
                    size: row.get(2)?,
                    style: row.get(3)?,
                    is_selected: row.get::<_, i64>(4)? != 0,
                    status: "ready".to_string(),
                    error_message: None,
                    ark_upload_status: row.get(6)?,
                    ark_upload_error: row.get(7)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        results.extend(img_items);
    }

    // 2. 进行中/失败的任务（tasks 表，按 lock_key 匹配）
    {
        let lock_prefix = format!(
            "generate_asset_image:{}:{}:{}",
            input.clip_id, input.asset_type, input.name
        );

        let mut stmt = conn
            .prepare(
                "SELECT id, status, error_message, created_at, input_json
                 FROM tasks
                 WHERE type = 'generate_asset_image'
                   AND lock_key = ?1
                   AND status IN ('pending', 'running', 'failed')
                 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;

        let task_items = stmt
            .query_map(rusqlite::params![&lock_prefix], |row| {
                let status: String = row.get(1)?;
                let input_json_str: String = row.get(4)?;
                let (size, style) = if let Ok(val) =
                    serde_json::from_str::<serde_json::Value>(&input_json_str)
                {
                    (
                        val.get("size")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        val.get("style")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    )
                } else {
                    (None, None)
                };

                Ok(AssetImageTaskItem {
                    id: row.get(0)?,
                    image_path: None,
                    size,
                    style,
                    is_selected: false,
                    status,
                    error_message: row.get(2)?,
                    ark_upload_status: None,
                    ark_upload_error: None,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        results.extend(task_items);
    }

    // 按创建时间排序
    results.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    Ok(results)
}

/// 选中资产图片输入
#[derive(Debug, Deserialize)]
pub struct SelectAssetImageInput {
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
    pub image_id: String,
}

/// 批量查询资产选定图片
#[derive(Debug, Deserialize)]
pub struct BatchAssetImageQuery {
    pub clip_id: String,
}

/// 批量查询结果项
#[derive(Debug, Serialize)]
pub struct BatchAssetImageItem {
    pub asset_type: String,
    pub name: String,
    pub selected_image_path: Option<String>,
}

/// 批量获取指定片段下所有资产的选定图片
///
/// AssetPanel 用来快速渲染卡片缩略图，避免逐卡查询。
#[tauri::command]
pub fn batch_get_asset_selected_images(
    input: BatchAssetImageQuery,
    app: tauri::AppHandle,
) -> Result<Vec<BatchAssetImageItem>, String> {
    let conn = util::open_app_conn(&app)?;

    let mut stmt = conn
        .prepare(
            "SELECT a.type, a.name, (
                SELECT ai.image_path FROM asset_images ai
                WHERE ai.id = a.selected_image_id
                LIMIT 1
            ) as sel_path
            FROM assets a
            WHERE a.clip_id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(rusqlite::params![&input.clip_id], |row| {
            Ok(BatchAssetImageItem {
                asset_type: row.get(0)?,
                name: row.get(1)?,
                selected_image_path: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

/// 清洗文件名（与 Worker 端 sanitizeFileName 保持一致）
fn sanitize_file_name(name: &str) -> String {
    name.trim()
        .replace(|c: char| "\\/:*?\"<>|".contains(c), "_")
        .replace(char::is_whitespace, "_")
        .chars()
        .take(64)
        .collect::<String>()
}

/// 将指定图片设为资产的选中图片
///
/// 纯 DB 操作：只更新 is_selected 标记和 assets.selected_image_id，
/// 不做任何文件重命名。文件路径创建后不可变。
#[tauri::command]
pub fn select_asset_image(
    input: SelectAssetImageInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut conn = util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 查 asset_id
    let asset_id = tx
        .query_row(
            "SELECT id FROM assets WHERE clip_id = ?1 AND type = ?2 AND name = ?3 LIMIT 1",
            rusqlite::params![&input.clip_id, &input.asset_type, &input.name],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("未找到资产：{}", e))?;

    // 查新选中图片的路径
    let image_path: String = tx
        .query_row(
            "SELECT image_path FROM asset_images WHERE id = ?1",
            rusqlite::params![&input.image_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("图片记录不存在：{}", e))?;

    // 1. 清除该资产所有图片的选中状态
    tx.execute(
        "UPDATE asset_images SET is_selected = 0 WHERE asset_id = ?1",
        rusqlite::params![&asset_id],
    )
    .map_err(|e| e.to_string())?;

    // 2. 设置目标图片为选中
    tx.execute(
        "UPDATE asset_images SET is_selected = 1 WHERE id = ?1",
        rusqlite::params![&input.image_id],
    )
    .map_err(|e| e.to_string())?;

    // 3. 回写 assets 表
    tx.execute(
        "UPDATE assets SET selected_image_id = ?, generated_image_path = ?, status = 'image_ready', updated_at = datetime('now') WHERE id = ?",
        rusqlite::params![&input.image_id, &image_path, &asset_id],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "资产",
        "INFO",
        &format!(
            "已切换绑定图片 clipId={} type={} name={} imageId={} path={}",
            input.clip_id, input.asset_type, input.name, input.image_id, image_path
        ),
    );

    Ok(())
}

/// 删除单张资产图片输入
#[derive(Debug, Deserialize)]
pub struct DeleteAssetImageInput {
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
    pub image_id: String,
    pub delete_file: bool,
}

/// 删除单张 asset_image 记录
///
/// 删除本地数据库记录和磁盘文件后，若有方舟平台 file_id，
/// 异步通知 Worker 删除平台文件（best-effort，失败仅记录日志）。
/// 如果删除的是当前选中的图片，自动选择下一张作为选中图（如果有）。
#[tauri::command]
pub fn delete_asset_image(
    input: DeleteAssetImageInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use std::fs;

    let mut conn = util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let asset_id: String = tx
        .query_row(
            "SELECT id FROM assets WHERE clip_id = ?1 AND type = ?2 AND name = ?3 LIMIT 1",
            rusqlite::params![&input.clip_id, &input.asset_type, &input.name],
            |row| row.get(0),
        )
        .map_err(|e| format!("未找到资产：{}", e))?;

    let img: (String, bool, Option<String>) = tx
        .query_row(
            "SELECT image_path, is_selected, ark_file_id FROM asset_images WHERE id = ?1 AND asset_id = ?2",
            rusqlite::params![&input.image_id, &asset_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0, row.get::<_, Option<String>>(2)?)),
        )
        .map_err(|e| format!("图片记录不存在：{}", e))?;

    let (image_path, was_selected, ark_file_id) = img;

    // 删除数据库记录
    tx.execute(
        "DELETE FROM asset_images WHERE id = ?1",
        rusqlite::params![&input.image_id],
    )
    .map_err(|e| e.to_string())?;

    // 删除磁盘文件
    if input.delete_file {
        let file_path = std::path::PathBuf::from(&image_path);
        if file_path.exists() {
            fs::remove_file(&file_path).map_err(|e| format!("删除文件失败：{}", e))?;
        }
    }

    // 如果删除的是选中图片，自动选择下一张
    if was_selected {
        let next: Option<(String, String)> = tx
            .query_row(
                "SELECT id, image_path FROM asset_images WHERE asset_id = ?1 ORDER BY created_at ASC LIMIT 1",
                rusqlite::params![&asset_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .ok();

        if let Some((next_id, next_path)) = next {
            tx.execute(
                "UPDATE asset_images SET is_selected = 1 WHERE id = ?1",
                rusqlite::params![&next_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE assets SET selected_image_id = ?, generated_image_path = ?, updated_at = datetime('now') WHERE id = ?",
                rusqlite::params![&next_id, &next_path, &asset_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            tx.execute(
                "UPDATE assets SET selected_image_id = NULL, generated_image_path = NULL, status = 'confirmed', updated_at = datetime('now') WHERE id = ?",
                rusqlite::params![&asset_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "资产",
        "INFO",
        &format!(
            "已删除资产图片 imageId={} deleteFile={} arkFileId={}",
            input.image_id,
            input.delete_file,
            ark_file_id.as_deref().unwrap_or("none")
        ),
    );

    // 事务提交后，若有方舟平台 file_id，同步删除（阻塞直到 API 返回）
    if let Some(ref file_id) = ark_file_id {
        match util::delete_ark_file_sync(&app, file_id) {
            Ok(()) => {
                crate::project_log::append_log(
                    &log_path,
                    "资产",
                    "INFO",
                    &format!("方舟文件删除成功 imageId={} arkFileId={}", input.image_id, file_id),
                );
            }
            Err(e) => {
                crate::project_log::append_log(
                    &log_path,
                    "资产",
                    "WARN",
                    &format!(
                        "方舟文件删除失败（本地已删除） imageId={} arkFileId={}: {}",
                        input.image_id, file_id, e
                    ),
                );
            }
        }
    }

    Ok(())
}

/// 导入本地图片输入
#[derive(Debug, Deserialize)]
pub struct ImportLocalAssetImageInput {
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
    pub local_file_path: String,
}

/// 导入本地图片返回结果
#[derive(Debug, Serialize)]
pub struct ImportLocalAssetImageResult {
    pub image_id: String,
    pub image_path: String,
    pub is_selected: bool,
}

/// 导入本地图片到指定资产
///
/// 将用户本地图片复制到项目 assets 目录，注册为资产图片，与生成图片同等处理。
/// 若资产尚无绑定图片，自动绑定该图片。
#[tauri::command]
pub fn import_local_asset_image(
    input: ImportLocalAssetImageInput,
    app: tauri::AppHandle,
) -> Result<ImportLocalAssetImageResult, String> {
    use std::fs;
    use std::path::PathBuf;

    let mut conn = util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    // 1. 校验本地文件存在
    let src = PathBuf::from(&input.local_file_path);
    if !src.exists() {
        return Err(format!("本地文件不存在：{}", input.local_file_path));
    }

    // 确定扩展名（默认 png）
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let ext = if ext.is_empty() { "png" } else { ext };

    // 2. 查片段所属项目 + 工作区路径
    let row = conn
        .query_row(
            "SELECT c.project_id, p.workspace_path FROM clips c
             JOIN projects p ON p.id = c.project_id
             WHERE c.id = ?1 AND c.deleted_at IS NULL",
            rusqlite::params![&input.clip_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| format!("片段不存在或已删除：{}", e))?;

    let (project_id, workspace_path) = row;

    // 3. 构造目标目录和文件名
    let safe_name = sanitize_file_name(&input.name);
    let type_dir = format!("{}s", input.asset_type); // characters / scenes / items
    let save_dir = PathBuf::from(&workspace_path).join("assets").join(&type_dir);
    fs::create_dir_all(&save_dir).map_err(|e| format!("创建目录失败：{}", e))?;

    let timestamp = chrono::Local::now().timestamp_millis();
    let image_uuid = uuid::Uuid::new_v4();
    let uuid_short = &image_uuid.to_string()[..8];
    let target_filename = format!("{}_{}_{}.{}", safe_name, uuid_short, timestamp, ext);
    let target_path = save_dir.join(&target_filename);
    let target_path_str = target_path.to_string_lossy().to_string();

    // 4. 事务：确保 assets + asset_images 记录就绪，然后复制文件并提交
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let asset_id: String = match tx.query_row(
        "SELECT id FROM assets WHERE project_id = ?1 AND clip_id = ?2 AND type = ?3 AND name = ?4 LIMIT 1",
        rusqlite::params![&project_id, &input.clip_id, &input.asset_type, &input.name],
        |row| row.get(0),
    ) {
        Ok(id) => id,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            let new_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO assets (id, project_id, clip_id, type, name, description, prompt, status, source)
                 VALUES (?1, ?2, ?3, ?4, ?5, '', '', 'draft', 'local')",
                rusqlite::params![&new_id, &project_id, &input.clip_id, &input.asset_type, &input.name],
            )
            .map_err(|e| e.to_string())?;
            new_id
        }
        Err(e) => return Err(e.to_string()),
    };

    // 5. 检查是否已有绑定图片
    let existing_selected: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM asset_images WHERE asset_id = ?1 AND is_selected = 1",
            rusqlite::params![&asset_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let has_binding = existing_selected > 0;
    let is_selected = !has_binding; // 无绑定时自动绑定

    // 6. 插入 asset_images 记录
    let image_id = image_uuid.to_string();
    tx.execute(
        "INSERT INTO asset_images (id, asset_id, prompt, size, style, image_path, file_name, is_selected, source, task_id, ark_upload_status, created_at)
         VALUES (?1, ?2, '', NULL, NULL, ?3, ?4, ?5, 'local', NULL, 'pending', datetime('now'))",
        rusqlite::params![&image_id, &asset_id, &target_path_str, &target_filename, if is_selected { 1 } else { 0 }],
    )
    .map_err(|e| e.to_string())?;

    // 7. 若自动绑定，回写 assets 表
    if is_selected {
        tx.execute(
            "UPDATE assets SET selected_image_id = ?, generated_image_path = ?, status = 'image_ready', updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![&image_id, &target_path_str, &asset_id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "UPDATE assets SET status = 'image_ready', updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![&asset_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // 8. 复制文件（在 DB 记录就绪后，提交前）
    //    若复制失败则回滚事务，不留孤儿数据
    if let Err(e) = fs::copy(&src, &target_path) {
        // 事务自动回滚（tx drop），DB 无残留
        return Err(format!("复制文件失败：{}", e));
    }

    // 9. 提交事务
    tx.commit().map_err(|e| {
        // 提交失败时清理已复制到磁盘的文件
        let _ = fs::remove_file(&target_path);
        format!("保存记录失败：{}", e)
    })?;

    crate::project_log::append_log(
        &log_path,
        "资产",
        "INFO",
        &format!(
            "已导入本地图片 clipId={} type={} name={} imageId={} path={} isSelected={}",
            input.clip_id, input.asset_type, input.name, image_id, target_path_str, is_selected
        ),
    );

    // 10. 同步上传到方舟平台（阻塞当前线程，但不阻塞 UI）
    let upload_result = util::upload_ark_file_sync(&app, &target_path_str);
    match upload_result {
        Ok(file_id) => {
            // 上传成功，更新数据库
            let _ = conn.execute(
                "UPDATE asset_images SET ark_file_id = ?1, ark_upload_status = 'uploaded', ark_upload_error = NULL WHERE id = ?2",
                rusqlite::params![&file_id, &image_id],
            );
            crate::project_log::append_log(
                &log_path,
                "资产",
                "INFO",
                &format!("方舟文件上传成功 imageId={} arkFileId={}", image_id, file_id),
            );
        }
        Err(err) => {
            // 上传失败，记录错误状态
            let _ = conn.execute(
                "UPDATE asset_images SET ark_upload_status = 'failed', ark_upload_error = ?1 WHERE id = ?2",
                rusqlite::params![&err, &image_id],
            );
            crate::project_log::append_log(
                &log_path,
                "资产",
                "WARN",
                &format!("方舟文件上传失败 imageId={}: {}", image_id, err),
            );
        }
    }

    Ok(ImportLocalAssetImageResult {
        image_id,
        image_path: target_path_str,
        is_selected,
    })
}

/// 项目资产图片简要信息（资产选择器用）
#[derive(Debug, Serialize)]
pub struct ProjectAssetImageItem {
    pub asset_id: String,
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub selected_image_path: String,
    pub selected_image_id: String,
}

/// 查询项目下指定类型的所有资产及其选中图片
///
/// 供资产选择器抽屉使用：展示同项目内同类型的所有资产图片，
/// 排除当前分镜的所有资产（通过 exclude_clip_id）。
#[tauri::command]
pub fn list_project_asset_images(
    app: tauri::AppHandle,
    project_id: String,
    asset_type: String,
    exclude_clip_id: String,
) -> Result<Vec<ProjectAssetImageItem>, String> {
    let conn = util::open_app_conn(&app)?;

    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.clip_id, a.type, a.name, a.description, a.prompt,
                    ai.image_path, ai.id as image_id
             FROM assets a
             JOIN asset_images ai ON ai.id = a.selected_image_id
             WHERE a.project_id = ?1
               AND a.type = ?2
               AND a.clip_id != ?3
             ORDER BY a.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(
            rusqlite::params![&project_id, &asset_type, &exclude_clip_id],
            |row| {
                Ok(ProjectAssetImageItem {
                    asset_id: row.get(0)?,
                    clip_id: row.get(1)?,
                    asset_type: row.get(2)?,
                    name: row.get(3)?,
                    description: row.get(4)?,
                    prompt: row.get(5)?,
                    selected_image_path: row.get(6)?,
                    selected_image_id: row.get(7)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

/// 从其他资产复制图片输入
#[derive(Debug, Deserialize)]
pub struct CopyAssetImageFromInput {
    pub source_image_id: String,
    pub target_clip_id: String,
    pub target_asset_type: String,
    pub target_name: String,
}

/// 从其他资产复制图片返回结果
#[derive(Debug, Serialize)]
pub struct CopyAssetImageFromResult {
    pub image_id: String,
    pub image_path: String,
    pub is_selected: bool,
}

/// 从项目内另一个资产复制选中图片到当前资产
///
/// 复制磁盘文件 + 创建新的 asset_images 记录。
/// 若目标资产尚无绑定图片，自动绑定。
#[tauri::command]
pub fn copy_asset_image_from(
    input: CopyAssetImageFromInput,
    app: tauri::AppHandle,
) -> Result<CopyAssetImageFromResult, String> {
    use std::fs;
    use std::path::PathBuf;

    let mut conn = util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    // 1. 查源图片路径
    let source_image_path: String = conn
        .query_row(
            "SELECT image_path FROM asset_images WHERE id = ?1",
            rusqlite::params![&input.source_image_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("源图片不存在：{}", e))?;

    let src = PathBuf::from(&source_image_path);
    if !src.exists() {
        return Err(format!("源图片文件不存在：{}", source_image_path));
    }

    // 2. 查目标片段所属项目 + 工作区路径
    let (project_id, workspace_path): (String, String) = conn
        .query_row(
            "SELECT c.project_id, p.workspace_path FROM clips c
             JOIN projects p ON p.id = c.project_id
             WHERE c.id = ?1 AND c.deleted_at IS NULL",
            rusqlite::params![&input.target_clip_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("目标片段不存在：{}", e))?;

    // 3. 构造目标文件路径
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let ext = if ext.is_empty() { "png" } else { ext };

    let safe_name = sanitize_file_name(&input.target_name);
    let type_dir = format!("{}s", input.target_asset_type);
    let save_dir = PathBuf::from(&workspace_path)
        .join("assets")
        .join(&type_dir);
    fs::create_dir_all(&save_dir).map_err(|e| format!("创建目录失败：{}", e))?;

    let timestamp = chrono::Local::now().timestamp_millis();
    let image_uuid = uuid::Uuid::new_v4();
    let uuid_short = &image_uuid.to_string()[..8];
    let target_filename = format!("{}_{}_{}.{}", safe_name, uuid_short, timestamp, ext);
    let target_path = save_dir.join(&target_filename);
    let target_path_str = target_path.to_string_lossy().to_string();

    // 4. 事务：确保目标 assets 记录存在，插入 asset_images，复制文件
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let target_asset_id: String = match tx.query_row(
        "SELECT id FROM assets WHERE project_id = ?1 AND clip_id = ?2 AND type = ?3 AND name = ?4 LIMIT 1",
        rusqlite::params![&project_id, &input.target_clip_id, &input.target_asset_type, &input.target_name],
        |row| row.get(0),
    ) {
        Ok(id) => id,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            let new_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO assets (id, project_id, clip_id, type, name, description, prompt, status, source)
                 VALUES (?1, ?2, ?3, ?4, ?5, '', '', 'draft', 'imported')",
                rusqlite::params![&new_id, &project_id, &input.target_clip_id, &input.target_asset_type, &input.target_name],
            )
            .map_err(|e| e.to_string())?;
            new_id
        }
        Err(e) => return Err(e.to_string()),
    };

    // 5. 检查是否已有绑定图片
    let existing_selected: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM asset_images WHERE asset_id = ?1 AND is_selected = 1",
            rusqlite::params![&target_asset_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let has_binding = existing_selected > 0;
    let is_selected = !has_binding;

    // 6. 插入新的 asset_images 记录
    let new_image_id = image_uuid.to_string();
    tx.execute(
        "INSERT INTO asset_images (id, asset_id, prompt, size, style, image_path, file_name, is_selected, source, task_id, ark_upload_status, created_at)
         VALUES (?1, ?2, '', NULL, NULL, ?3, ?4, ?5, 'imported', NULL, 'pending', datetime('now'))",
        rusqlite::params![&new_image_id, &target_asset_id, &target_path_str, &target_filename, if is_selected { 1 } else { 0 }],
    )
    .map_err(|e| e.to_string())?;

    // 7. 若自动绑定，回写 assets 表
    if is_selected {
        tx.execute(
            "UPDATE assets SET selected_image_id = ?, generated_image_path = ?, status = 'image_ready', updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![&new_image_id, &target_path_str, &target_asset_id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "UPDATE assets SET status = 'image_ready', updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![&target_asset_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // 8. 复制文件
    if let Err(e) = fs::copy(&src, &target_path) {
        return Err(format!("复制文件失败：{}", e));
    }

    // 9. 提交事务
    tx.commit().map_err(|e| {
        if let Err(remove_err) = fs::remove_file(&target_path) {
            crate::project_log::append_log(
                &log_path,
                "资产",
                "WARN",
                &format!(
                    "事务回滚后清理残留文件失败 path={} error={}",
                    target_path.display(), remove_err
                ),
            );
        }
        format!("保存记录失败：{}", e)
    })?;

    crate::project_log::append_log(
        &log_path,
        "资产",
        "INFO",
        &format!(
            "已从其他资产复制图片 sourceImageId={} targetClipId={} targetType={} targetName={} newImageId={} isSelected={}",
            input.source_image_id, input.target_clip_id, input.target_asset_type, input.target_name, new_image_id, is_selected
        ),
    );

    // 10. 同步上传到方舟平台
    let upload_result = util::upload_ark_file_sync(&app, &target_path_str);
    match upload_result {
        Ok(file_id) => {
            let _ = conn.execute(
                "UPDATE asset_images SET ark_file_id = ?1, ark_upload_status = 'uploaded', ark_upload_error = NULL WHERE id = ?2",
                rusqlite::params![&file_id, &new_image_id],
            );
            crate::project_log::append_log(
                &log_path,
                "资产",
                "INFO",
                &format!("复制图片方舟上传成功 imageId={} arkFileId={}", new_image_id, file_id),
            );
        }
        Err(err) => {
            let _ = conn.execute(
                "UPDATE asset_images SET ark_upload_status = 'failed', ark_upload_error = ?1 WHERE id = ?2",
                rusqlite::params![&err, &new_image_id],
            );
            crate::project_log::append_log(
                &log_path,
                "资产",
                "WARN",
                &format!("复制图片方舟上传失败 imageId={}: {}", new_image_id, err),
            );
        }
    }

    Ok(CopyAssetImageFromResult {
        image_id: new_image_id,
        image_path: target_path_str,
        is_selected,
    })
}

/// 重试上传失败的资产图片
///
/// 当 ark_upload_status = 'failed' 时，重新上传到方舟平台。
#[tauri::command]
pub fn retry_upload_asset_image(
    image_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    let conn = util::open_app_conn(&app)?;

    // 查询图片路径和当前状态
    let (image_path, current_status): (String, Option<String>) = conn
        .query_row(
            "SELECT image_path, ark_upload_status FROM asset_images WHERE id = ?1",
            rusqlite::params![&image_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .map_err(|e| format!("图片记录不存在：{}", e))?;

    // 只有 failed 状态才允许重试
    if current_status.as_deref() != Some("failed") {
        return Err("该图片上传状态不是失败，无法重试".to_string());
    }

    // 先标记为 pending
    let _ = conn.execute(
        "UPDATE asset_images SET ark_upload_status = 'pending', ark_upload_error = NULL WHERE id = ?1",
        rusqlite::params![&image_id],
    );

    // 同步上传
    match util::upload_ark_file_sync(&app, &image_path) {
        Ok(file_id) => {
            let _ = conn.execute(
                "UPDATE asset_images SET ark_file_id = ?1, ark_upload_status = 'uploaded', ark_upload_error = NULL WHERE id = ?2",
                rusqlite::params![&file_id, &image_id],
            );
            crate::project_log::append_log(
                &log_path,
                "资产",
                "INFO",
                &format!("方舟文件重传成功 imageId={} arkFileId={}", image_id, file_id),
            );
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute(
                "UPDATE asset_images SET ark_upload_status = 'failed', ark_upload_error = ?1 WHERE id = ?2",
                rusqlite::params![&err, &image_id],
            );
            crate::project_log::append_log(
                &log_path,
                "资产",
                "WARN",
                &format!("方舟文件重传失败 imageId={}: {}", image_id, err),
            );
            Err(format!("上传失败：{}", err))
        }
    }
}
