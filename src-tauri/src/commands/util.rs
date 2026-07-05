//! 共享工具函数
//!
//! @author yt @date 20260703

use crate::sidecar::SharedSidecarManager;
use serde_json::{Map, Value};

/// 返回默认设置 JSON，包含 text / image / voice 三个大模型的默认配置。
///
/// baseUrl 和 model 默认为空，用户需在设置页填入 OpenAI 兼容端点信息。
///
/// @author yt @date 20260703
pub(crate) fn default_settings_json() -> Value {
    serde_json::json!({
        "text": {
            "apiKey": "",
            "baseUrl": "",
            "model": "",
            "maxTokens": 131072,
            "temperature": 0.7,
            "timeoutMs": 300000
        },
        "image": {
            "apiKey": "",
            "baseUrl": "",
            "model": "",
            "timeoutMs": 300000
        },
        "voice": {
            "apiKey": "",
            "baseUrl": "",
            "model": "",
            "speed": 1.0,
            "timeoutMs": 300000
        }
    })
}

/// 清洗并补全设置 JSON，确保必要字段存在
pub(crate) fn sanitize_settings(input: Value) -> Value {
    let mut root = Map::new();
    let source = input.as_object();

    root.insert(
        "text".to_string(),
        sanitize_section(
            source.and_then(|obj| obj.get("text")),
            &[
                ("apiKey", Value::String(String::new())),
                ("baseUrl", Value::String(String::new())),
                ("model", Value::String(String::new())),
                ("maxTokens", Value::from(131072)),
                ("temperature", Value::from(0.7)),
                ("timeoutMs", Value::from(300000)),
            ],
        ),
    );

    root.insert(
        "image".to_string(),
        sanitize_section(
            source.and_then(|obj| obj.get("image")),
            &[
                ("apiKey", Value::String(String::new())),
                ("baseUrl", Value::String(String::new())),
                ("model", Value::String(String::new())),
                ("timeoutMs", Value::from(300000)),
            ],
        ),
    );

    root.insert(
        "voice".to_string(),
        sanitize_section(
            source.and_then(|obj| obj.get("voice")),
            &[
                ("apiKey", Value::String(String::new())),
                ("baseUrl", Value::String(String::new())),
                ("model", Value::String(String::new())),
                ("speed", Value::from(1.0)),
                ("timeoutMs", Value::from(300000)),
            ],
        ),
    );

    Value::Object(root)
}

/// 按默认值补全单个配置节字段
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

/// 解析工作区路径
/// 始终为项目创建独立子目录，避免多个项目文件混在同一目录下。
pub(crate) fn resolve_workspace_path(
    workspace_path: &str,
    project_name: &str,
    project_id: &str,
) -> std::path::PathBuf {
    let slug = crate::app_paths::sanitize_project_dir_name(project_name);
    let short_id: String = project_id.chars().take(8).collect();
    let dir_name = format!("{}-{}", slug, short_id);

    if !workspace_path.trim().is_empty() {
        return std::path::PathBuf::from(workspace_path).join(dir_name);
    }

    crate::app_paths::default_projects_root().join(dir_name)
}

/// 初始化数据库 Schema 并运行迁移
pub(crate) fn ensure_project_schema(
    db_path: &std::path::Path,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let conn = crate::db::init_db(db_path).map_err(|e| e.to_string())?;
    let migrations_dir = resolve_migrations_dir(app)?;
    crate::db::run_migrations(&conn, &migrations_dir).map_err(|e| e.to_string())?;
    Ok(())
}

/// 打开应用数据库连接
pub(crate) fn open_app_conn(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let db_path = crate::app_paths::app_db_path(app)?;
    crate::db::init_db(&db_path).map_err(|e| e.to_string())
}

/// 查询指定项目的工作区路径。
///
/// @author yt @date 20260703
pub(crate) fn get_project_workspace_path(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<String, String> {
    let conn = open_app_conn(app)?;
    conn.query_row(
        "SELECT workspace_path FROM projects WHERE id = ?1",
        rusqlite::params![project_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|e| e.to_string())
}

/// 解析迁移脚本目录
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

/// 规范化文本内容
pub(crate) fn normalize_text(text: &str) -> String {
    let text = text.trim_start_matches('\u{FEFF}');
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text: String = text
        .chars()
        .filter(|&c| c != '\u{200B}' && c != '\u{200C}' && c != '\u{200D}' && c != '\u{FEFF}')
        .collect();
    text.trim().to_string()
}

/// 确保 Worker 进程在线：已运行则跳过，否则启动。
///
/// Worker 随应用启动后全局唯一，通过全局 db 访问所有项目数据，
/// 不再按项目 workspace_path 区分。切换项目不会导致 Worker 重启。
///
/// @author yt @date 20260703
pub(crate) fn ensure_worker_running(
    state: &SharedSidecarManager,
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
    let config_path = app_data_dir.join("settings.json").to_string_lossy().to_string();
    let db_path = crate::app_paths::app_db_path(app)?.to_string_lossy().to_string();
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    let log_path_str = log_path.to_string_lossy().to_string();

    let mut manager = state.lock().map_err(|e| e.to_string())?;

    // Worker 已运行 → 无需操作（全局唯一 Worker，不按项目区分）
    if manager.is_running() {
        return Ok(());
    }

    // Worker 未运行 → 启动（使用全局默认 workspace）
    crate::project_log::append_log(
        &log_path, "项目", "INFO",
        &format!("Worker 未运行，启动中（由 projectId={} 触发）", project_id),
    );

    let default_workspace = app_data_dir
        .join("workspace")
        .to_string_lossy()
        .to_string();
    std::fs::create_dir_all(&default_workspace).map_err(|e| e.to_string())?;

    manager
        .start(&db_path, &default_workspace, &config_path, &log_path_str)
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 向 Worker 发送 enqueue 命令，触发立即调度。
///
/// @author yt @date 20260703
pub(crate) fn send_enqueue_to_worker(
    state: &SharedSidecarManager,
    task_id: &str,
    task_type: &str,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager
        .send_enqueue(task_id, task_type)
        .map_err(|e| e.to_string())
}

/// 向 Worker 发送 cancel 命令，中止指定任务。
///
/// @author yt @date 20260703
pub(crate) fn send_cancel_to_worker(
    state: &SharedSidecarManager,
    task_id: &str,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.send_cancel(task_id).map_err(|e| e.to_string())
}
