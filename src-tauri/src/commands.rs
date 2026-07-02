use crate::sidecar::SharedSidecarManager;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    pub description: Option<String>,
    pub workspace_path: String,
    pub input_mode: Option<String>,
    pub style_mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub workspace_path: String,
    pub status: String,
    pub current_step: String,
    pub style_mode: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportScriptInput {
    pub project_id: String,
    pub source_type: String,
    pub content: Option<String>,
    pub file_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportScriptResult {
    pub source_id: String,
}

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
/// @author yt @date 20260702
#[derive(Debug, Deserialize)]
pub struct DeleteClipsInput {
    pub clip_ids: Vec<String>,
}

/// 更新片段输入，三个内容字段均可选，传哪个改哪个
/// @author yt @date 20260702
#[derive(Debug, Deserialize)]
pub struct UpdateClipInput {
    pub clip_id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub source_text: Option<String>,
}

/// 片段拆分输入：在原 source_text 的第 split_position 个字符处拆成两段
/// @author yt @date 20260702
#[derive(Debug, Deserialize)]
pub struct SplitClipInput {
    pub clip_id: String,
    pub split_position: i64,
}

#[derive(Debug, Serialize)]
pub struct SplitClipResult {
    pub first_clip_id: String,
    pub second_clip_id: String,
}

pub fn prepare_app_runtime(app: &tauri::AppHandle) -> Result<(), String> {
    let db_path = crate::app_paths::app_db_path(app)?;
    ensure_project_schema(&db_path, app)
}

fn default_settings_json() -> Value {
    serde_json::json!({
        "text": {
            "apiKey": "",
            "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
            "model": "doubao-pro-32k-241215",
            "maxTokens": 4096,
            "temperature": 0.7,
            "timeoutMs": 60000
        },
        "image": {
            "apiKey": "",
            "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
            "model": "doubao-seedream-4-5-251128",
            "timeoutMs": 120000
        },
        "voice": {
            "apiKey": "",
            "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
            "model": "doubao-tts",
            "speed": 1.0,
            "timeoutMs": 60000
        }
    })
}

fn sanitize_settings(input: Value) -> Value {
    let mut root = Map::new();
    let source = input.as_object();

    root.insert(
        "text".to_string(),
        sanitize_section(
            source.and_then(|obj| obj.get("text")),
            &[
                ("apiKey", Value::String(String::new())),
                (
                    "baseUrl",
                    Value::String("https://ark.cn-beijing.volces.com/api/v3".to_string()),
                ),
                ("model", Value::String("doubao-pro-32k-241215".to_string())),
                ("maxTokens", Value::from(4096)),
                ("temperature", Value::from(0.7)),
                ("timeoutMs", Value::from(60000)),
            ],
        ),
    );

    root.insert(
        "image".to_string(),
        sanitize_section(
            source.and_then(|obj| obj.get("image")),
            &[
                ("apiKey", Value::String(String::new())),
                (
                    "baseUrl",
                    Value::String("https://ark.cn-beijing.volces.com/api/v3".to_string()),
                ),
                (
                    "model",
                    Value::String("doubao-seedream-4-5-251128".to_string()),
                ),
                ("timeoutMs", Value::from(120000)),
            ],
        ),
    );

    root.insert(
        "voice".to_string(),
        sanitize_section(
            source.and_then(|obj| obj.get("voice")),
            &[
                ("apiKey", Value::String(String::new())),
                (
                    "baseUrl",
                    Value::String("https://ark.cn-beijing.volces.com/api/v3".to_string()),
                ),
                ("model", Value::String("doubao-tts".to_string())),
                ("speed", Value::from(1.0)),
                ("timeoutMs", Value::from(60000)),
            ],
        ),
    );

    Value::Object(root)
}

fn sanitize_section(source: Option<&Value>, fields: &[(&str, Value)]) -> Value {
    let source_obj = source.and_then(Value::as_object);
    let mut section = Map::new();

    for (key, default) in fields {
        let value = source_obj
            .and_then(|obj| obj.get(*key))
            .cloned()
            .unwrap_or_else(|| default.clone());
        section.insert((*key).to_string(), value);
    }

    Value::Object(section)
}

#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn create_project(
    input: CreateProjectInput,
    app: tauri::AppHandle,
) -> Result<ProjectInfo, String> {
    let project_id = uuid::Uuid::new_v4().to_string();
    let input_mode = input.input_mode.unwrap_or_else(|| "empty".to_string());
    let style_mode = input.style_mode.unwrap_or_else(|| "国漫".to_string());
    let workspace = resolve_workspace_path(&input.workspace_path, &input.name, &project_id);

    let dirs = [
        "source/scripts",
        "clips",
        "assets/characters/thumbs",
        "assets/scenes/thumbs",
        "assets/items/thumbs",
        "storyboards/draft",
        "storyboards/final",
        "audio",
        "video",
        "exports",
        "cache",
    ];
    for dir in &dirs {
        std::fs::create_dir_all(workspace.join(dir))
            .map_err(|e| format!("Failed to create directory {}: {}", dir, e))?;
    }

    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    crate::project_log::append_log(
        &log_path,
        "项目",
        "INFO",
        &format!("创建项目 name={} mode={} style={}", input.name, input_mode, style_mode),
    );

    let now = chrono::Utc::now().to_rfc3339();
    let conn = open_app_conn(&app)?;
    conn.execute(
        "INSERT INTO projects (id, name, description, workspace_path, input_mode, style_mode, status, current_step, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 'project', ?7, ?7)",
        rusqlite::params![
            &project_id,
            &input.name,
            input.description.as_deref().unwrap_or(""),
            workspace.to_string_lossy().to_string(),
            &input_mode,
            &style_mode,
            &now,
        ],
    )
    .map_err(|e| e.to_string())?;

    let manifest = serde_json::json!({
        "projectId": &project_id,
        "projectName": &input.name,
        "workspaceVersion": 1,
        "schemaVersion": 1,
        "createdAt": &now,
        "updatedAt": &now,
        "defaultInputMode": &input_mode,
        "defaultStyleMode": &style_mode
    });
    let manifest_path = workspace.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("Failed to write manifest.json: {}", e))?;

    log::info!("项目创建成功：{} at {}", project_id, workspace.display());
    crate::project_log::append_log(
        &log_path,
        "项目",
        "INFO",
        &format!("项目已创建 projectId={}", project_id),
    );

    Ok(ProjectInfo {
        id: project_id,
        name: input.name,
        description: input.description.unwrap_or_default(),
        workspace_path: workspace.to_string_lossy().to_string(),
        status: "active".to_string(),
        current_step: "project".to_string(),
        style_mode,
        created_at: now,
    })
}

#[tauri::command]
pub fn get_project(project_id: String, app: tauri::AppHandle) -> Result<ProjectInfo, String> {
    let conn = open_app_conn(&app)?;
    conn.query_row(
        "SELECT id, name, description, workspace_path, status, current_step, style_mode, created_at
         FROM projects WHERE id = ?1",
        rusqlite::params![&project_id],
        |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                workspace_path: row.get(3)?,
                status: row.get(4)?,
                current_step: row.get(5)?,
                style_mode: row.get(6)?,
                created_at: row.get(7)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let conn = open_app_conn(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, workspace_path, status, current_step, style_mode, created_at
             FROM projects ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                workspace_path: row.get(3)?,
                status: row.get(4)?,
                current_step: row.get(5)?,
                style_mode: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

#[tauri::command]
pub fn start_worker(
    state: tauri::State<'_, SharedSidecarManager>,
    app: tauri::AppHandle,
    project_id: Option<String>,
) -> Result<String, String> {
    let project_id = project_id.ok_or_else(|| "project_id is required".to_string())?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let config_path = app_data_dir.join("settings.json").to_string_lossy().to_string();
    let db_path = crate::app_paths::app_db_path(&app)?.to_string_lossy().to_string();
    let workspace_path = get_project_workspace_path(&app, &project_id)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    crate::project_log::append_log(
        &log_path,
        "项目",
        "INFO",
        &format!("启动 Worker projectId={}", project_id),
    );

    let mut manager = state.lock().map_err(|e| e.to_string())?;
    let log_path_str = log_path.to_string_lossy().to_string();
    if manager.matches_runtime(&db_path, &workspace_path, &config_path, &log_path_str) {
        return Ok(manager.worker_id().to_string());
    }
    if manager.is_running() {
        manager.shutdown(5000).map_err(|e| e.to_string())?;
    }
    manager
        .start(&db_path, &workspace_path, &config_path, &log_path.to_string_lossy())
        .map_err(|e| e.to_string())?;
    Ok(manager.worker_id().to_string())
}

#[tauri::command]
pub fn stop_worker(state: tauri::State<'_, SharedSidecarManager>) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.shutdown(30000).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_project(
    project_id: String,
    delete_files: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    // 先查出 workspace_path（删文件要用）
    let workspace_path = get_project_workspace_path(&app, &project_id)?;

    let mut conn = open_app_conn(&app)?;

    // ── 按外键依赖顺序删除关联记录 ──────────────────────────────
    // 依赖关系图（箭头表示 "被引用"）：
    //   task_locks ──► tasks ──► projects
    //   storyboard_assets ──► storyboards ──► projects
    //   assets ──► projects
    //   clip_scripts ──► clips ──► projects
    //   script_sources ──► projects
    //   exports ──► projects
    //
    // 新增表时请同步更新此列表，或考虑迁移到 ON DELETE CASCADE。
    // ───────────────────────────────────────────────────────────
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 1. task_locks（依赖 tasks.lock_key）
    tx.execute(
        "DELETE FROM task_locks WHERE lock_key IN (SELECT lock_key FROM tasks WHERE project_id = ?1)",
        rusqlite::params![&project_id],
    ).map_err(|e| e.to_string())?;

    // 2. tasks
    tx.execute("DELETE FROM tasks WHERE project_id = ?1", rusqlite::params![&project_id])
        .map_err(|e| e.to_string())?;

    // 3. storyboard_assets（依赖 storyboards.id）
    tx.execute(
        "DELETE FROM storyboard_assets WHERE storyboard_id IN (SELECT id FROM storyboards WHERE project_id = ?1)",
        rusqlite::params![&project_id],
    ).map_err(|e| e.to_string())?;

    // 4. storyboards
    tx.execute("DELETE FROM storyboards WHERE project_id = ?1", rusqlite::params![&project_id])
        .map_err(|e| e.to_string())?;

    // 5. assets
    tx.execute("DELETE FROM assets WHERE project_id = ?1", rusqlite::params![&project_id])
        .map_err(|e| e.to_string())?;

    // 6. clip_scripts（依赖 clips.id）
    tx.execute("DELETE FROM clip_scripts WHERE project_id = ?1", rusqlite::params![&project_id])
        .map_err(|e| e.to_string())?;

    // 7. clips
    tx.execute("DELETE FROM clips WHERE project_id = ?1", rusqlite::params![&project_id])
        .map_err(|e| e.to_string())?;

    // 8. script_sources
    tx.execute("DELETE FROM script_sources WHERE project_id = ?1", rusqlite::params![&project_id])
        .map_err(|e| e.to_string())?;

    // 9. exports
    tx.execute("DELETE FROM exports WHERE project_id = ?1", rusqlite::params![&project_id])
        .map_err(|e| e.to_string())?;

    // 10. projects（根表，最后删除）
    tx.execute("DELETE FROM projects WHERE id = ?1", rusqlite::params![&project_id])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    crate::project_log::append_log(
        &log_path,
        "项目",
        "INFO",
        &format!("项目已删除：projectId={} deleteFiles={}", project_id, delete_files),
    );

    // 可选：删除工作区文件
    if delete_files {
        let ws = std::path::Path::new(&workspace_path);
        if ws.exists() {
            std::fs::remove_dir_all(ws).map_err(|e| {
                let msg = format!("删除工作区失败：{}", e);
                crate::project_log::append_log(&log_path, "项目", "ERROR", &msg);
                msg
            })?;
            crate::project_log::append_log(
                &log_path,
                "项目",
                "INFO",
                &format!("工作区已删除：{}", workspace_path),
            );
        }
    }

    log::info!("项目已删除：{} (files={})", project_id, delete_files);
    Ok(())
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Value, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let settings_path = app_data_dir.join("settings.json");

    if !settings_path.exists() {
        return Ok(default_settings_json());
    }

    let content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(sanitize_settings(parsed))
}

#[tauri::command]
pub fn save_settings(
    settings: Value,
    state: tauri::State<'_, SharedSidecarManager>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let settings_path = app_data_dir.join("settings.json");
    let normalized_settings = sanitize_settings(settings);

    let content = serde_json::to_string_pretty(&normalized_settings).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, content).map_err(|e| e.to_string())?;
    log::info!("配置已保存到 {:?}", settings_path);

    let mut manager = state.lock().map_err(|e| e.to_string())?;
    if manager.is_running() {
        manager.send_reload_config().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn import_script(
    input: ImportScriptInput,
    app: tauri::AppHandle,
) -> Result<ImportScriptResult, String> {
    let mut conn = open_app_conn(&app)?;
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);

    let raw_content = match (input.content, input.file_path) {
        (Some(c), _) => c,
        (None, Some(path)) => {
            std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?
        }
        (None, None) => return Err("content or file_path is required".to_string()),
    };

    let normalized = normalize_text(&raw_content);

    let source_id = uuid::Uuid::new_v4().to_string();
    let task_id = uuid::Uuid::new_v4().to_string();
    let lock_key = format!("split_script:{}", source_id);
    let input_json = serde_json::json!({
        "projectId": &input.project_id,
        "sourceId": &source_id,
        "forceAi": false
    })
    .to_string();

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO script_sources (id, project_id, source_type, file_name, raw_content, normalized_content, split_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
        rusqlite::params![
            &source_id,
            &input.project_id,
            &input.source_type,
            Option::<String>::None,
            &raw_content,
            &normalized,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO tasks (id, project_id, type, status, lock_key, input_json, max_retry)
         VALUES (?1, ?2, 'split_script', 'pending', ?3, ?4, 3)",
        rusqlite::params![&task_id, &input.project_id, &lock_key, &input_json],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    log::info!("剧本已导入：source_id={}, task_id={}", source_id, task_id);
    crate::project_log::append_log(
        &log_path,
        "剧本",
        "INFO",
        &format!(
            "剧本已入队 sourceId={} taskId={} sourceType={}",
            source_id, task_id, input.source_type
        ),
    );
    Ok(ImportScriptResult { source_id })
}

#[tauri::command]
pub fn list_clips(project_id: String, app: tauri::AppHandle) -> Result<Vec<ClipInfo>, String> {
    let conn = open_app_conn(&app)?;
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

#[tauri::command]
pub fn get_script_source(
    project_id: String,
    app: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    let conn = open_app_conn(&app)?;
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

fn resolve_workspace_path(
    workspace_path: &str,
    project_name: &str,
    project_id: &str,
) -> std::path::PathBuf {
    if !workspace_path.trim().is_empty() {
        return std::path::PathBuf::from(workspace_path);
    }

    let slug = crate::app_paths::sanitize_project_dir_name(project_name);
    let short_id: String = project_id.chars().take(8).collect();
    let dir_name = format!("{}-{}", slug, short_id);

    crate::app_paths::default_projects_root().join(dir_name)
}

fn ensure_project_schema(
    db_path: &std::path::Path,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let conn = crate::db::init_db(db_path).map_err(|e| e.to_string())?;
    let migrations_dir = resolve_migrations_dir(app)?;
    crate::db::run_migrations(&conn, &migrations_dir).map_err(|e| e.to_string())?;
    Ok(())
}

fn open_app_conn(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let db_path = crate::app_paths::app_db_path(app)?;
    crate::db::init_db(&db_path).map_err(|e| e.to_string())
}

fn get_project_workspace_path(app: &tauri::AppHandle, project_id: &str) -> Result<String, String> {
    let conn = open_app_conn(app)?;
    conn.query_row(
        "SELECT workspace_path FROM projects WHERE id = ?1",
        rusqlite::params![project_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|e| e.to_string())
}

fn resolve_migrations_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let cwd = std::env::current_dir().unwrap_or_default();
    let candidates = [
        app_data_dir.join("migrations"),
        cwd.join("migrations"),
        cwd.join("..").join("migrations"),
    ];

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "Migrations directory not found".to_string())
}

fn normalize_text(text: &str) -> String {
    let text = text.trim_start_matches('\u{FEFF}');
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text: String = text
        .chars()
        .filter(|&c| c != '\u{200B}' && c != '\u{200C}' && c != '\u{200D}' && c != '\u{FEFF}')
        .collect();
    text.trim().to_string()
}

/**
 * 批量软删除片段
 * @author yt @date 20260702
 */
#[tauri::command]
pub fn delete_clips(input: DeleteClipsInput, app: tauri::AppHandle) -> Result<(), String> {
    if input.clip_ids.is_empty() {
        return Ok(());
    }
    let mut conn = open_app_conn(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for id in &input.clip_ids {
        tx.execute(
            "UPDATE clips
             SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    log::info!("片段已软删除：{} 条", input.clip_ids.len());
    Ok(())
}

/**
 * 更新片段的标题/摘要/正文
 * @author yt @date 20260702
 */
#[tauri::command]
pub fn update_clip(input: UpdateClipInput, app: tauri::AppHandle) -> Result<ClipInfo, String> {
    let mut conn = open_app_conn(&app)?;
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

    // 动态拼接 SET 子句
    let mut sets: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(t) = &input.title {
        sets.push("title = ?".to_string());
        params.push(Box::new(t.clone()));
    }
    if let Some(s) = &input.summary {
        sets.push("summary = ?".to_string());
        params.push(Box::new(s.clone()));
    }
    let source_changed = input.source_text.is_some();
    if let Some(st) = &input.source_text {
        sets.push("source_text = ?".to_string());
        params.push(Box::new(st.clone()));
    }
    // 正文变更触发下游失效：状态重置
    if source_changed {
        sets.push("status = 'pending'".to_string());
        sets.push("current_step = 'project'".to_string());
    }
    sets.push("updated_at = datetime('now')".to_string());

    let placeholders = sets.join(", ");
    let sql = format!("UPDATE clips SET {} WHERE id = ?", placeholders);
    params.push(Box::new(input.clip_id.clone()));

    // rusqlite 需 &[&dyn ToSql]
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    tx.execute(&sql, param_refs.as_slice())
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
    Ok(clip)
}

/**
 * 在指定字符位置把一个片段拆成两个
 * @author yt @date 20260702
 */
#[tauri::command]
pub fn split_clip(
    input: SplitClipInput,
    app: tauri::AppHandle,
) -> Result<SplitClipResult, String> {
    let mut conn = open_app_conn(&app)?;

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
    let first_text: String = source_text.chars().take(pos).collect::<String>().trim().to_string();
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

    log::info!(
        "Clip split: origin={} -> first={}, second={}, pos={}",
        input.clip_id,
        input.clip_id,
        second_id,
        input.split_position
    );

    Ok(SplitClipResult {
        first_clip_id: input.clip_id,
        second_clip_id: second_id,
    })
}

// ─── 片段拆解 ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct GenerateClipScriptInput {
    pub clip_id: String,
}

#[tauri::command]
pub fn generate_clip_script(input: GenerateClipScriptInput, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let mut conn = open_app_conn(&app)?;

    // 查询片段所属项目和原文
    let row = conn.query_row(
        "SELECT project_id, source_text FROM clips WHERE id = ?1 AND deleted_at IS NULL",
        rusqlite::params![&input.clip_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ).map_err(|e| format!("片段查询失败：{}", e))?;

    let (project_id, source_text) = row;
    if source_text.trim().is_empty() {
        return Err("片段原文为空，无法拆解".to_string());
    }

    let task_id = uuid::Uuid::new_v4().to_string();
    let lock_key = format!("generate_clip_script:{}", input.clip_id);
    let input_json = serde_json::json!({
        "projectId": &project_id,
        "clipId": input.clip_id,
        "sourceText": &source_text,
    }).to_string();

    // 事务：创建 clip_script 记录 + 插入任务 + 更新片段状态
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 先删旧的拆解记录（重拆）
    tx.execute(
        "DELETE FROM clip_scripts WHERE clip_id = ?1",
        rusqlite::params![&input.clip_id],
    ).map_err(|e| e.to_string())?;

    let script_id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO clip_scripts (id, project_id, clip_id, source_text, status)
         VALUES (?1, ?2, ?3, ?4, 'pending')",
        rusqlite::params![&script_id, &project_id, &input.clip_id, &source_text],
    ).map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO tasks (id, project_id, type, status, lock_key, input_json, max_retry)
         VALUES (?1, ?2, 'generate_clip_script', 'pending', ?3, ?4, 3)",
        rusqlite::params![&task_id, &project_id, &lock_key, &input_json],
    ).map_err(|e| e.to_string())?;

    // 标记片段拆解中
    tx.execute(
        "UPDATE clips SET status = 'running', updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![&input.clip_id],
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    log::info!("片段拆解已入队：clip_id={}, task_id={}", input.clip_id, task_id);
    crate::project_log::append_log(
        &log_path,
        "拆解",
        "INFO",
        &format!("拆解已入队 clipId={} taskId={} 原文={}字符", input.clip_id, task_id, source_text.len()),
    );

    Ok(serde_json::json!({ "task_id": task_id }))
}

#[derive(Debug, Serialize)]
pub struct ClipScriptInfo {
    pub id: String,
    pub clip_id: String,
    pub script_summary: String,
    pub extracted_resources_json: String,
    pub status: String,
}

#[tauri::command]
pub fn get_clip_scripts(project_id: String, app: tauri::AppHandle) -> Result<Vec<ClipScriptInfo>, String> {
    let conn = open_app_conn(&app)?;
    let mut stmt = conn.prepare(
        "SELECT cs.id, cs.clip_id, cs.script_summary, cs.extracted_resources_json, cs.status
         FROM clip_scripts cs
         JOIN clips c ON c.id = cs.clip_id
         WHERE c.project_id = ?1 AND c.deleted_at IS NULL
         ORDER BY cs.created_at DESC",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(rusqlite::params![&project_id], |row| {
        Ok(ClipScriptInfo {
            id: row.get(0)?,
            clip_id: row.get(1)?,
            script_summary: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            extracted_resources_json: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            status: row.get(4)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}
