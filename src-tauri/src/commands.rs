use crate::sidecar::SharedSidecarManager;
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
    pub workspace_path: String,
    pub status: String,
    pub current_step: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ProjectRegistryEntry {
    id: String,
    workspace_path: String,
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
pub fn start_worker(state: tauri::State<'_, SharedSidecarManager>) -> Result<String, String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.start().map_err(|e| e.to_string())?;
    Ok(manager.worker_id().to_string())
}

#[tauri::command]
pub fn stop_worker(state: tauri::State<'_, SharedSidecarManager>) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.shutdown(30000).map_err(|e| e.to_string())?;
    Ok(())
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
