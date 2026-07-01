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
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportScriptInput {
    pub project_id: String,
    pub source_type: String, // "paste" | "txt"
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

#[derive(Debug, Serialize, Deserialize)]
struct ProjectRegistryEntry {
    id: String,
    workspace_path: String,
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
                (
                    "model",
                    Value::String("doubao-pro-32k-241215".to_string()),
                ),
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
    let style_mode = input.style_mode.unwrap_or_else(|| "RS".to_string());
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
        "logs/tasks",
        "cache",
    ];
    for dir in &dirs {
        std::fs::create_dir_all(workspace.join(dir))
            .map_err(|e| format!("Failed to create directory {}: {}", dir, e))?;
    }

    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let db_path = workspace.join("project.sqlite");
    let conn = crate::db::init_db(&db_path).map_err(|e| e.to_string())?;

    let migrations_dir = app_data_dir.join("migrations");
    let resource_migrations = std::env::current_dir()
        .unwrap_or_default()
        .join("migrations");
    let migrations_dir = if migrations_dir.exists() {
        migrations_dir
    } else {
        resource_migrations
    };
    crate::db::run_migrations(&conn, &migrations_dir).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO projects (id, name, description, workspace_path, input_mode, style_mode, status, current_step)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 'project')",
        rusqlite::params![
            &project_id,
            &input.name,
            input.description.as_deref().unwrap_or(""),
            workspace.to_string_lossy().to_string(),
            &input_mode,
            &style_mode,
        ],
    )
    .map_err(|e| e.to_string())?;

    upsert_project_registry(
        &app_data_dir,
        ProjectRegistryEntry {
            id: project_id.clone(),
            workspace_path: workspace.to_string_lossy().to_string(),
        },
    )?;

    let now = chrono::Utc::now().to_rfc3339();
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

    log::info!("Project created: {} at {}", project_id, workspace.display());

    Ok(ProjectInfo {
        id: project_id,
        name: input.name,
        description: input.description.unwrap_or_default(),
        workspace_path: workspace.to_string_lossy().to_string(),
        status: "active".to_string(),
        current_step: "project".to_string(),
        created_at: now,
    })
}

#[tauri::command]
pub fn get_project(project_id: String, app: tauri::AppHandle) -> Result<ProjectInfo, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let registry = load_project_registry(&app_data_dir)?;
    let workspace_path = registry
        .into_iter()
        .find(|entry| entry.id == project_id)
        .map(|entry| entry.workspace_path)
        .ok_or_else(|| "Project not found in registry".to_string())?;
    let db_path = std::path::PathBuf::from(workspace_path).join("project.sqlite");
    let conn = crate::db::init_db(&db_path).map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, name, description, workspace_path, status, current_step, created_at FROM projects WHERE id = ?1",
        rusqlite::params![&project_id],
        |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                workspace_path: row.get(3)?,
                status: row.get(4)?,
                current_step: row.get(5)?,
                created_at: row.get(6)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let registry = load_project_registry(&app_data_dir)?;
    let mut projects = Vec::new();

    for entry in registry {
        let db_path = std::path::PathBuf::from(&entry.workspace_path).join("project.sqlite");
        if !db_path.exists() {
            continue;
        }

        if let Ok(conn) = crate::db::init_db(&db_path) {
            if let Ok(info) = conn.query_row(
                "SELECT id, name, description, workspace_path, status, current_step, created_at FROM projects LIMIT 1",
                [],
                |row| {
                    Ok(ProjectInfo {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        workspace_path: row.get(3)?,
                        status: row.get(4)?,
                        current_step: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            ) {
                projects.push(info);
            }
        }
    }

    Ok(projects)
}

#[tauri::command]
pub fn start_worker(state: tauri::State<'_, SharedSidecarManager>, app: tauri::AppHandle) -> Result<String, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let config_path = app_data_dir.join("settings.json").to_string_lossy().to_string();
    // db_path 和 workspace_path 此处传空字符串，由前端在 enqueue 时携带项目信息
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.start("", "", &config_path).map_err(|e| e.to_string())?;
    Ok(manager.worker_id().to_string())
}

#[tauri::command]
pub fn stop_worker(state: tauri::State<'_, SharedSidecarManager>) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.shutdown(30000).map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取当前应用配置（settings.json）。
/// 如果文件不存在，返回内置默认值。
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

/// 保存配置到 settings.json，并通知 worker 热更新。
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
    log::info!("Settings saved to {:?}", settings_path);

    // 通知 worker 热更新（worker 运行中才发送）
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    if manager.is_running() {
        manager.send_reload_config().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// 导入剧本：规范化文本，写入 script_sources，创建 split_script 任务。
#[tauri::command]
pub fn import_script(
    input: ImportScriptInput,
    app: tauri::AppHandle,
) -> Result<ImportScriptResult, String> {
    let db_path = get_project_db_path(&input.project_id, &app)?;
    let mut conn = crate::db::init_db(&db_path).map_err(|e| e.to_string())?;

    // 读取原始内容
    let raw_content = match (input.content, input.file_path) {
        (Some(c), _) => c,
        (None, Some(path)) => std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read file: {}", e))?,
        (None, None) => return Err("content or file_path is required".to_string()),
    };

    // 简单规范化：统一换行符、去除 BOM
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

    // 在同一事务内写入 script_source + task，任一失败自动回滚
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

    log::info!("Script imported: source_id={}, task_id={}", source_id, task_id);
    Ok(ImportScriptResult { source_id })
}

/// 获取项目的片段列表。
#[tauri::command]
pub fn list_clips(project_id: String, app: tauri::AppHandle) -> Result<Vec<ClipInfo>, String> {
    let db_path = get_project_db_path(&project_id, &app)?;
    let conn = crate::db::init_db(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, source_id, sort_index, title, summary, source_text,
                    estimated_duration, status, current_step, created_at, updated_at
             FROM clips WHERE project_id = ?1 ORDER BY sort_index ASC",
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

/// 获取项目的剧本来源（最新一条）。
#[tauri::command]
pub fn get_script_source(project_id: String, app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let db_path = get_project_db_path(&project_id, &app)?;
    let conn = crate::db::init_db(&db_path).map_err(|e| e.to_string())?;

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
    crate::app_paths::default_projects_root().join(format!("{}-{}", slug, short_id))
}

fn project_registry_path(app_data_dir: &std::path::Path) -> std::path::PathBuf {
    app_data_dir.join("project-registry.json")
}

fn load_project_registry(app_data_dir: &std::path::Path) -> Result<Vec<ProjectRegistryEntry>, String> {
    let path = project_registry_path(app_data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn upsert_project_registry(
    app_data_dir: &std::path::Path,
    entry: ProjectRegistryEntry,
) -> Result<(), String> {
    let mut registry = load_project_registry(app_data_dir)?;
    if let Some(existing) = registry.iter_mut().find(|item| item.id == entry.id) {
        *existing = entry;
    } else {
        registry.push(entry);
    }

    let path = project_registry_path(app_data_dir);
    let content = serde_json::to_string_pretty(&registry).map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())
}

/// 通过注册表找到项目工作区，返回其数据库路径。
fn get_project_db_path(project_id: &str, app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let registry = load_project_registry(&app_data_dir)?;
    let workspace_path = registry
        .into_iter()
        .find(|e| e.id == project_id)
        .map(|e| e.workspace_path)
        .ok_or_else(|| format!("Project not found: {}", project_id))?;
    Ok(std::path::PathBuf::from(workspace_path).join("project.sqlite"))
}

/// 文本规范化：统一换行符、去除 BOM 和零宽字符。
fn normalize_text(text: &str) -> String {
    // 去除 BOM
    let text = text.trim_start_matches('\u{FEFF}');
    // 统一换行符
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    // 去除零宽字符
    let text: String = text
        .chars()
        .filter(|&c| c != '\u{200B}' && c != '\u{200C}' && c != '\u{200D}' && c != '\u{FEFF}')
        .collect();
    text.trim().to_string()
}
