use std::path::{Path, PathBuf};
use tauri::{Manager, Runtime};

pub fn resolve_app_data_dir<R: Runtime, M: Manager<R>>(app: &M) -> Result<PathBuf, String> {
    let app_name = app.package_info().name.clone();

    if let Some(base_dir) = dirs::data_dir() {
        let dir = base_dir.join(&app_name);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(dir);
    }

    if let Ok(dir) = app.path().app_data_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(dir);
    }

    let fallback = dirs::home_dir()
        .unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?)
        .join(format!(".{}", app_name));
    std::fs::create_dir_all(&fallback).map_err(|e| e.to_string())?;
    Ok(fallback)
}

pub fn app_db_path<R: Runtime, M: Manager<R>>(app: &M) -> Result<PathBuf, String> {
    Ok(resolve_app_data_dir(app)?.join("app.sqlite"))
}

pub fn default_projects_root() -> PathBuf {
    let drive_d = Path::new(r"D:\");
    if drive_d.exists() {
        return drive_d.join("projects");
    }

    dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("projects")
}

pub fn sanitize_project_dir_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric()
                || matches!(ch, '-' | '_')
                || ('\u{4e00}'..='\u{9fff}').contains(&ch)
            {
                ch
            } else if ch.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect();

    let trimmed = sanitized.trim_matches(['-', '_', ' ']);
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed.to_string()
    }
}
