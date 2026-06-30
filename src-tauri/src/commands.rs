use crate::sidecar::{SharedSidecarManager, SidecarManager};
use serde::{Deserialize, Serialize};

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
    pub status: String,
    pub current_step: String,
    pub created_at: String,
}

/// 获取应用版本
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 创建新项目
#[tauri::command]
pub fn create_project(
    input: CreateProjectInput,
    app: tauri::AppHandle,
) -> Result<ProjectInfo, String> {
    let project_id = uuid::Uuid::new_v4().to_string();
    let input_mode = input.input_mode.unwrap_or_else(|| "empty".to_string());
    let style_mode = input.style_mode.unwrap_or_else(|| "RS".to_string());

    // 创建工作区目录结构
    let workspace = std::path::PathBuf::from(&input.workspace_path);
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

    // 初始化数据库
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = workspace.join("project.sqlite");
    let conn = crate::db::init_db(&db_path).map_err(|e| e.to_string())?;

    // 执行迁移
    let migrations_dir = app_data_dir.join("migrations");
    // 尝试从 resources 目录读取迁移文件
    let resource_migrations = std::env::current_dir()
        .unwrap_or_default()
        .join("migrations");
    let migrations_dir = if migrations_dir.exists() {
        migrations_dir
    } else {
        resource_migrations
    };
    crate::db::run_migrations(&conn, &migrations_dir).map_err(|e| e.to_string())?;

    // 写入项目记录
    conn.execute(
        "INSERT INTO projects (id, name, description, workspace_path, input_mode, style_mode, status, current_step)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 'project')",
        rusqlite::params![
            &project_id,
            &input.name,
            input.description.as_deref().unwrap_or(""),
            &input.workspace_path,
            &input_mode,
            &style_mode,
        ],
    )
    .map_err(|e| e.to_string())?;

    // 写入 manifest.json
    let manifest = serde_json::json!({
        "projectId": &project_id,
        "projectName": &input.name,
        "workspaceVersion": 1,
        "schemaVersion": 1,
        "createdAt": chrono::Utc::now().to_rfc3339(),
        "updatedAt": chrono::Utc::now().to_rfc3339(),
        "defaultInputMode": &input_mode,
        "defaultStyleMode": &style_mode
    });
    let manifest_path = workspace.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("Failed to write manifest.json: {}", e))?;

    log::info!("Project created: {} at {}", project_id, input.workspace_path);

    Ok(ProjectInfo {
        id: project_id,
        name: input.name,
        description: input.description.unwrap_or_default(),
        status: "active".to_string(),
        current_step: "project".to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// 获取项目信息
#[tauri::command]
pub fn get_project(project_id: String, app: tauri::AppHandle) -> Result<ProjectInfo, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = crate::db::get_db_path(&app_data_dir, &project_id);
    let conn = crate::db::init_db(&db_path).map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, name, description, status, current_step, created_at FROM projects WHERE id = ?1",
        rusqlite::params![&project_id],
        |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                current_step: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// 列出所有项目
#[tauri::command]
pub fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let projects_dir = app_data_dir.join("projects");

    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();

    for entry in std::fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let db_path = entry.path().join("project.sqlite");
        if !db_path.exists() {
            continue;
        }

        if let Ok(conn) = crate::db::init_db(&db_path) {
            if let Ok(info) = conn.query_row(
                "SELECT id, name, description, status, current_step, created_at FROM projects LIMIT 1",
                [],
                |row| {
                    Ok(ProjectInfo {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        status: row.get(3)?,
                        current_step: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                },
            ) {
                projects.push(info);
            }
        }
    }

    Ok(projects)
}

/// 启动 Node sidecar worker
#[tauri::command]
pub fn start_worker(
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<String, String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.start().map_err(|e| e.to_string())?;
    Ok(manager.worker_id().to_string())
}

/// 停止 Node sidecar worker
#[tauri::command]
pub fn stop_worker(
    state: tauri::State<'_, SharedSidecarManager>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.shutdown(30000).map_err(|e| e.to_string())?;
    Ok(())
}
