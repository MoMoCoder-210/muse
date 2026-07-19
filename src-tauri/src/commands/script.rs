//! 剧本导入/拆解相关命令

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
    /// 是否同时删除数据库记录所引用的项目工作区内本地文件，默认不删除。
    #[serde(default)]
    pub delete_files: bool,
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

    // 查询片段所属项目、原文和当前状态
    let row = conn
        .query_row(
            "SELECT project_id, source_text, status FROM clips WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![&input.clip_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .map_err(|e| format!("片段查询失败：{}", e))?;

    let (project_id, source_text, clip_status) = row;

    // 只有 pending 或 failed 状态的片段才能拆解
    if clip_status != "pending" && clip_status != "failed" {
        return Err(format!(
            "当前片段状态为「{}」，不允许重新拆解。只有待处理或失败的片段可以拆解",
            clip_status
        ));
    }

    if source_text.trim().is_empty() {
        return Err("片段原文为空，无法拆解".to_string());
    }

    // 查询项目风格（用于视频提示词风格拼接）
    let style_mode: String = conn
        .query_row(
            "SELECT style_mode FROM projects WHERE id = ?1",
            rusqlite::params![&project_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap_or(None)
        .unwrap_or_default();

    // 确保 Worker 在线（插入任务前保证消费者存在）
    util::ensure_worker_running(&state, &app, &project_id)?;

    let task_id = uuid::Uuid::new_v4().to_string();
    let lock_key = format!("generate_clip_script:{}", input.clip_id);
    let input_json = serde_json::json!({
        "projectId": &project_id,
        "clipId": input.clip_id,
        "sourceText": &source_text,
        "styleMode": &style_mode,
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

    // 一个图片对应一个任务：抽屉可以从提交起就完整展示每个待生成图片。
    // 所有子任务共享同一 lock_key，Worker 会按顺序生成，仍保持单资产串行。
    let image_count = input.n.unwrap_or(1).clamp(1, 4) as usize;
    let batch_id = uuid::Uuid::new_v4().to_string();
    let task_ids: Vec<String> = (0..image_count)
        .map(|_| uuid::Uuid::new_v4().to_string())
        .collect();
    let lock_key = format!(
        "generate_asset_image:{}:{}:{}",
        input.clip_id, input.asset_type, input.name
    );

    let mut conn = util::open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (index, task_id) in task_ids.iter().enumerate() {
        // Worker 每次只处理一张；批次元数据保留在输入中，便于排查和后续扩展。
        let mut task_input = serde_json::json!({
            "projectId": &input.project_id,
            "clipId": &input.clip_id,
            "assetType": &input.asset_type,
            "name": &input.name,
            "prompt": &input.prompt,
            "n": 1,
            "batchId": &batch_id,
            "batchIndex": index + 1,
            "batchSize": image_count,
        });
        if let Some(ref size) = input.size {
            task_input["size"] = serde_json::Value::String(size.clone());
        }
        if let Some(ref style) = input.style {
            task_input["style"] = serde_json::Value::String(style.clone());
        }

        tx.execute(
            "INSERT INTO tasks (id, project_id, clip_id, batch_id, type, status, lock_key, input_json, max_retry)
             VALUES (?1, ?2, ?3, ?4, 'generate_asset_image', 'pending', ?5, ?6, 3)",
            rusqlite::params![
                task_id,
                &input.project_id,
                &input.clip_id,
                &batch_id,
                &lock_key,
                task_input.to_string(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "资产生图",
        "INFO",
        &format!(
            "资产生图批次已入队 projectId={} clipId={} assetType={} name={} batchId={} imageCount={}",
            input.project_id, input.clip_id, input.asset_type, input.name, batch_id, image_count
        ),
    );

    for task_id in &task_ids {
        if let Err(e) = util::send_enqueue_to_worker(&state, task_id, "generate_asset_image") {
            crate::project_log::append_log(
                &log_path,
                "资产生图",
                "WARN",
                &format!(
                    "发送 enqueue 通知失败 taskId={}（任务仍会被轮询拾取）：{}",
                    task_id, e
                ),
            );
        }
    }

    Ok(serde_json::json!({
        "task_id": task_ids[0],
        "task_ids": task_ids,
        "batch_id": batch_id,
    }))
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
            .query_map(rusqlite::params![&lock_key], |row| row.get::<_, String>(0))
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
        &format!("拆解已取消 clipId={}（{}个任务）", input.clip_id, deleted),
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
pub fn add_asset_to_clip(input: AddAssetInput, app: tauri::AppHandle) -> Result<(), String> {
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

/// 从片段拆解结果中删除单个资产。
///
/// 卡片展示依赖 `clip_scripts.extracted_resources_json`，而分镜、图片和任务依赖
/// `assets` 记录；两侧必须在同一事务内同步删除，避免 UI 已消失但数据库仍残留资产。
#[tauri::command]
pub fn delete_asset_from_clip(
    input: DeleteAssetInput,
    app: tauri::AppHandle,
) -> Result<crate::commands::clip::DeleteClipsResult, String> {
    let mut conn = util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 保持原有语义：只能从已有拆解结果中删除资产。
    let script_exists: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM clip_scripts WHERE clip_id = ?1",
            rusqlite::params![&input.clip_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if script_exists == 0 {
        return Err(format!("未找到该片段的拆解记录：{}", input.clip_id));
    }

    // 资产表通过所属片段关联项目；在删除任何记录前一并读取工作区和仅属于该资产的文件。
    let assets = {
        let mut statement = tx
            .prepare(
                "SELECT a.id, p.workspace_path
                 FROM assets a
                 JOIN clips c ON c.id = a.clip_id
                 JOIN projects p ON p.id = c.project_id
                 WHERE a.clip_id = ?1 AND a.type = ?2 AND a.name = ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                rusqlite::params![&input.clip_id, &input.asset_type, &input.name],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    let mut file_candidates = Vec::new();
    if input.delete_files {
        for (asset_id, workspace_path) in &assets {
            let file_paths = {
                let mut statement = tx
                    .prepare(
                        "SELECT image_path FROM asset_images WHERE asset_id = ?1
                         UNION
                         SELECT reference_image_path FROM assets
                         WHERE id = ?1 AND reference_image_path IS NOT NULL
                         UNION
                         SELECT generated_image_path FROM assets
                         WHERE id = ?1 AND generated_image_path IS NOT NULL",
                    )
                    .map_err(|error| {
                        format!("读取资产关联文件失败 assetId={}: {}", asset_id, error)
                    })?;
                let rows = statement
                    .query_map(rusqlite::params![asset_id], |row| row.get::<_, String>(0))
                    .map_err(|error| {
                        format!("查询资产关联文件失败 assetId={}: {}", asset_id, error)
                    })?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
                    format!("读取资产关联文件失败 assetId={}: {}", asset_id, error)
                })?
            };
            for file_path in file_paths {
                file_candidates.push(crate::commands::clip::ClipFileCandidate {
                    workspace_path: std::path::PathBuf::from(workspace_path),
                    file_path: std::path::PathBuf::from(file_path),
                });
            }
        }
    }

    // 即使历史数据中没有 assets 行，也要把资源从拆解 JSON 中移除。
    if assets.is_empty() {
        crate::commands::clip::remove_asset_from_latest_clip_script(
            &tx,
            &input.clip_id,
            &input.asset_type,
            &input.name,
        )?;
    } else {
        for (asset_id, _) in &assets {
            crate::commands::clip::delete_asset_by_id(&tx, asset_id)?;
        }
    }

    tx.commit().map_err(|error| error.to_string())?;
    let result = if input.delete_files {
        crate::commands::clip::delete_managed_files(file_candidates)
    } else {
        crate::commands::clip::DeleteClipsResult {
            deleted_file_count: 0,
            skipped_file_count: 0,
            failed_file_count: 0,
        }
    };
    crate::project_log::append_log(
        &log_path,
        "资产",
        if input.delete_files && result.failed_file_count > 0 {
            "WARN"
        } else {
            "INFO"
        },
        &format!(
            "已删除资产及其关联数据 clipId={} type={} name={}；文件已删除 {}，跳过 {}，失败 {}",
            input.clip_id,
            input.asset_type,
            input.name,
            result.deleted_file_count,
            result.skipped_file_count,
            result.failed_file_count,
        ),
    );
    Ok(result)
}

/// 更新 clip_scripts 中的单个资产（提示词/描述）。
///
/// 按 type + name 匹配并就地更新对应字段，再写回 extracted_resources_json。
#[tauri::command]
pub fn update_asset_in_clip(input: UpdateAssetInput, app: tauri::AppHandle) -> Result<(), String> {
    let mut conn = util::open_app_conn(&app)?;
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

    let mut found = false;
    if let Some(arr) = parsed[key].as_array_mut() {
        for item in arr.iter_mut() {
            if item.get("name").and_then(|v| v.as_str()) == Some(input.name.as_str()) {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert(
                        "prompt".to_string(),
                        serde_json::Value::String(input.prompt.clone()),
                    );
                    obj.insert(
                        "description".to_string(),
                        serde_json::Value::String(input.description.clone()),
                    );
                    // 角色绑定声音：写回 extracted_resources_json 的角色对象，
                    // 使前端 AssetResource.voiceBinding 能直接读取。
                    if let Some(vb) = &input.voice_binding {
                        obj.remove("voice_binding"); // 清理旧命名
                        obj.insert(
                            "voiceBinding".to_string(),
                            serde_json::from_str(vb).unwrap_or(serde_json::Value::Null),
                        );
                    } else {
                        obj.remove("voice_binding");
                        obj.remove("voiceBinding");
                    }
                    found = true;
                }
                break;
            }
        }
    }

    if !found {
        return Err(format!("未找到资产：{}/{}", input.asset_type, input.name));
    }

    let updated_json = serde_json::to_string(&parsed).map_err(|e| e.to_string())?;

    // 事务：同步更新 assets 表和 clip_scripts 表，避免半成功状态
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE assets SET prompt = ?1, description = ?2, voice_binding_json = ?3
         WHERE clip_id = ?4 AND type = ?5 AND name = ?6",
        rusqlite::params![
            &input.prompt,
            &input.description,
            &input.voice_binding,
            &input.clip_id,
            &input.asset_type,
            &input.name
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE clip_scripts SET extracted_resources_json = ?, updated_at = datetime('now') WHERE id = ?",
        rusqlite::params![&updated_json, &script_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "资产",
        "INFO",
        &format!(
            "已更新资产 clipId={} type={} name={}",
            input.clip_id, input.asset_type, input.name
        ),
    );

    Ok(())
}

/// 更新资产输入
#[derive(Debug, Deserialize)]
pub struct UpdateAssetInput {
    pub clip_id: String,
    pub asset_type: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    /// 角色绑定声音（JSON 字符串：公共音色 / 本地上传），场景与物品为空
    #[serde(default)]
    pub voice_binding: Option<String>,
}

/// 返回项目工作区中已导入的音频文件列表（用于本地上传 tab 的文件选择）。
#[derive(Debug, Serialize)]
pub struct VoiceFileEntry {
    pub file_path: String,
    pub file_name: String,
}

#[tauri::command]
pub fn list_workspace_voice_files(
    clip_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<VoiceFileEntry>, String> {
    let conn = util::open_app_conn(&app)?;
    let workspace: String = conn
        .query_row(
            "SELECT p.workspace_path FROM clips c JOIN projects p ON c.project_id = p.id WHERE c.id = ?1",
            rusqlite::params![&clip_id],
            |row| row.get(0),
        )
        .map_err(|_| "未找到项目工作区".to_string())?;

    let voices_dir = std::path::PathBuf::from(&workspace)
        .join("audio")
        .join("voices");
    if !voices_dir.exists() {
        return Ok(vec![]);
    }

    let mut files = Vec::new();
    for entry in std::fs::read_dir(&voices_dir).map_err(|e| format!("读取音频目录失败：{}", e))?
    {
        if let Ok(entry) = entry {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext = ext.to_string_lossy().to_lowercase();
                if ["mp3", "wav", "m4a", "ogg", "flac"].contains(&ext.as_str()) {
                    files.push(VoiceFileEntry {
                        file_path: path.to_string_lossy().to_string(),
                        file_name: path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string(),
                    });
                }
            }
        }
    }

    Ok(files)
}

/// 将外部音频文件导入项目工作区，返回工作区内的路径。
#[derive(Debug, Serialize)]
pub struct ImportVoiceResult {
    pub file_path: String,
    pub file_name: String,
}

#[tauri::command]
pub fn import_voice_file(
    clip_id: String,
    source_path: String,
    app: tauri::AppHandle,
) -> Result<ImportVoiceResult, String> {
    let conn = util::open_app_conn(&app)?;
    let workspace: String = conn
        .query_row(
            "SELECT p.workspace_path FROM clips c JOIN projects p ON c.project_id = p.id WHERE c.id = ?1",
            rusqlite::params![&clip_id],
            |row| row.get(0),
        )
        .map_err(|_| "未找到项目工作区".to_string())?;

    let voices_dir = std::path::PathBuf::from(&workspace)
        .join("audio")
        .join("voices");
    std::fs::create_dir_all(&voices_dir).map_err(|e| format!("创建音频目录失败：{}", e))?;

    let fname = std::path::Path::new(&source_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("voice.mp3")
        .to_string();
    let dest = voices_dir.join(&fname);

    std::fs::copy(&source_path, &dest).map_err(|e| format!("复制音频文件失败：{}", e))?;

    Ok(ImportVoiceResult {
        file_path: dest.to_string_lossy().to_string(),
        file_name: fname,
    })
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

    let row = conn.query_row(
        "SELECT a.generated_image_path, a.selected_image_id, a.status,
                    (SELECT COUNT(*) FROM asset_images ai WHERE ai.asset_id = a.id) as image_count
             FROM assets a
             WHERE a.clip_id = ?1 AND a.type = ?2 AND a.name = ?3
             LIMIT 1",
        rusqlite::params![&input.clip_id, &input.asset_type, &input.name],
        |row| {
            Ok(AssetImageInfo {
                generated_image_path: row.get(0)?,
                selected_image_id: row.get(1)?,
                status: row.get(2)?,
                image_count: row.get(3)?,
            })
        },
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
                "SELECT id, image_path, size, style, is_selected, created_at
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
                let (size, style) =
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&input_json_str) {
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

/// 查询片段下「正在生成图片」的资产
///
/// 返回所有存在 `generate_asset_image` 类型、且状态为 pending/running 任务的
/// 资产（按 assetType + name 去重）。供资产列表实时展示「生成中」角标。
#[derive(Debug, Deserialize)]
pub struct BatchAssetGeneratingQuery {
    pub clip_id: String,
}

#[derive(Debug, Serialize)]
pub struct GeneratingAssetItem {
    pub asset_type: String,
    pub name: String,
}

#[tauri::command]
pub fn batch_get_asset_generating(
    input: BatchAssetGeneratingQuery,
    app: tauri::AppHandle,
) -> Result<Vec<GeneratingAssetItem>, String> {
    let conn = util::open_app_conn(&app)?;

    let mut stmt = conn
        .prepare(
            "SELECT input_json FROM tasks
             WHERE type = 'generate_asset_image'
               AND clip_id = ?1
               AND status IN ('pending', 'running')",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![&input.clip_id], |row| {
            let raw: String = row.get(0)?;
            Ok(raw)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut seen = std::collections::HashSet::<(String, String)>::new();
    let mut items = Vec::new();
    for raw in rows {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            let asset_type = val
                .get("assetType")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = val
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if asset_type.is_empty() || name.is_empty() {
                continue;
            }
            if seen.insert((asset_type.clone(), name.clone())) {
                items.push(GeneratingAssetItem { asset_type, name });
            }
        }
    }

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
) -> Result<crate::commands::clip::DeleteClipsResult, String> {
    let mut conn = util::open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (asset_id, workspace_path): (String, String) = tx
        .query_row(
            "SELECT a.id, p.workspace_path
             FROM assets a
             JOIN clips c ON c.id = a.clip_id
             JOIN projects p ON p.id = c.project_id
             WHERE a.clip_id = ?1 AND a.type = ?2 AND a.name = ?3
             LIMIT 1",
            rusqlite::params![&input.clip_id, &input.asset_type, &input.name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("未找到资产：{}", e))?;

    // 先尝试 asset_images 表（已完成图片）
    let img_result = tx.query_row(
        "SELECT image_path, is_selected, ark_file_id FROM asset_images WHERE id = ?1 AND asset_id = ?2",
        rusqlite::params![&input.image_id, &asset_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0, row.get::<_, Option<String>>(2)?)),
    );

    // 若 asset_images 中找不到，则尝试 tasks 表（pending / running / failed 任务）
    if img_result.is_err() {
        let task_exists = tx
            .query_row(
                "SELECT id FROM tasks
                 WHERE id = ?1
                   AND asset_id = ?2
                   AND clip_id = ?3
                   AND type = 'generate_asset_image'
                   AND status IN ('pending', 'running', 'failed')",
                rusqlite::params![&input.image_id, &asset_id, &input.clip_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| format!("图片/任务记录不存在：{}", e))?;

        tx.execute(
            "DELETE FROM task_locks WHERE lock_key IN (SELECT lock_key FROM tasks WHERE id = ?1) OR locked_by = ?1",
            rusqlite::params![&task_exists],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM tasks WHERE id = ?1",
            rusqlite::params![&task_exists],
        )
        .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;

        crate::project_log::append_log(
            &log_path,
            "资产",
            "INFO",
            &format!("已删除失败任务 taskId={}", input.image_id),
        );
        return Ok(crate::commands::clip::DeleteClipsResult {
            deleted_file_count: 0,
            skipped_file_count: 0,
            failed_file_count: 0,
        });
    }

    let (image_path, was_selected, ark_file_id) = img_result.unwrap();

    tx.execute(
        "DELETE FROM asset_images WHERE id = ?1",
        rusqlite::params![&input.image_id],
    )
    .map_err(|e| e.to_string())?;

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

    // 数据库事务已提交后再删除文件，且只能清理该项目工作区内的安全路径。
    let result = if input.delete_file {
        crate::commands::clip::delete_managed_files(vec![
            crate::commands::clip::ClipFileCandidate {
                workspace_path: std::path::PathBuf::from(workspace_path),
                file_path: std::path::PathBuf::from(image_path),
            },
        ])
    } else {
        crate::commands::clip::DeleteClipsResult {
            deleted_file_count: 0,
            skipped_file_count: 0,
            failed_file_count: 0,
        }
    };

    crate::project_log::append_log(
        &log_path,
        "资产",
        if result.failed_file_count > 0 {
            "WARN"
        } else {
            "INFO"
        },
        &format!(
            "已删除资产图片 imageId={} deleteFile={} arkFileId={}；本地文件已删除 {}，失败 {}",
            input.image_id,
            input.delete_file,
            ark_file_id.as_deref().unwrap_or("none"),
            result.deleted_file_count,
            result.failed_file_count,
        ),
    );

    // 事务提交后，若有方舟平台 file_id，同步删除（阻塞直到 API 返回）。远端结果仅写日志，
    // 不混入本地文件统计，避免用户误以为工作区文件删除失败。
    if let Some(ref file_id) = ark_file_id {
        match util::delete_ark_file_sync(&app, file_id) {
            Ok(()) => {
                crate::project_log::append_log(
                    &log_path,
                    "资产",
                    "INFO",
                    &format!(
                        "方舟文件删除成功 imageId={} arkFileId={}",
                        input.image_id, file_id
                    ),
                );
            }
            Err(e) => {
                crate::project_log::append_log(
                    &log_path,
                    "资产",
                    "WARN",
                    &format!(
                        "方舟文件删除失败（本地记录已删除） imageId={} arkFileId={}: {}",
                        input.image_id, file_id, e
                    ),
                );
            }
        }
    }

    Ok(result)
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
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
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
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
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
                    target_path.display(),
                    remove_err
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

    Ok(CopyAssetImageFromResult {
        image_id: new_image_id,
        image_path: target_path_str,
        is_selected,
    })
}
