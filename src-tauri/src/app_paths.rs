//! 应用路径工具模块

use std::path::{Path, PathBuf};
use tauri::{Manager, Runtime};

/// 解析应用数据目录
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

/// 获取应用数据库文件路径
pub fn app_db_path<R: Runtime, M: Manager<R>>(app: &M) -> Result<PathBuf, String> {
    Ok(resolve_app_data_dir(app)?.join("app.sqlite"))
}

/// 获取默认项目根目录
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

/// 清理项目目录名称
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

/// 解析 FFmpeg 目录路径。
///
/// 查找顺序：
/// 1. Tauri resource_dir/ffmpeg（生产包）
/// 2. cwd/ffmpeg（开发模式，cwd 可能是 src-tauri/）
/// 3. cwd/../ffmpeg（开发模式回退）
pub fn resolve_ffmpeg_dir<R: Runtime, M: Manager<R>>(app: &M) -> Option<PathBuf> {
    // 1. Tauri resource_dir/ffmpeg
    if let Ok(res_dir) = app.path().resource_dir() {
        let ffmpeg_dir = res_dir.join("ffmpeg");
        if ffmpeg_dir.exists() {
            return Some(ffmpeg_dir);
        }
    }

    // 2. cwd/ffmpeg
    let cwd = std::env::current_dir().ok()?;
    let ffmpeg_dir = cwd.join("ffmpeg");
    if ffmpeg_dir.exists() {
        return Some(ffmpeg_dir);
    }

    // 3. cwd/../ffmpeg (dev 模式下 cwd = src-tauri/)
    let ffmpeg_dir = cwd.parent()?.join("ffmpeg");
    if ffmpeg_dir.exists() {
        return Some(ffmpeg_dir);
    }

    None
}

/// 获取 ffmpeg 可执行文件路径
pub fn ffmpeg_path<R: Runtime, M: Manager<R>>(app: &M) -> Option<PathBuf> {
    resolve_ffmpeg_dir(app).map(|d| d.join("ffmpeg.exe"))
}

/// 获取 ffprobe 可执行文件路径
pub fn ffprobe_path<R: Runtime, M: Manager<R>>(app: &M) -> Option<PathBuf> {
    resolve_ffmpeg_dir(app).map(|d| d.join("ffprobe.exe"))
}

/// 解析捆绑的 Node.js 可执行文件路径。
///
/// 查找顺序：
/// 1. Tauri resource_dir/node/node.exe（生产包）
/// 2. cwd/node/node.exe（开发模式，cwd 可能是 src-tauri/）
/// 3. cwd/../node/node.exe（开发模式回退）
/// 4. 系统 PATH 中的 "node"（兜底）
pub fn resolve_node_binary<R: Runtime, M: Manager<R>>(app: &M) -> PathBuf {
    let exe_name = if cfg!(windows) { "node.exe" } else { "node" };

    // 1. Tauri resource_dir/node/
    if let Ok(res_dir) = app.path().resource_dir() {
        let node_bin = res_dir.join("node").join(exe_name);
        if node_bin.exists() {
            return node_bin;
        }
    }

    // 2. cwd/node/
    if let Ok(cwd) = std::env::current_dir() {
        let node_bin = cwd.join("node").join(exe_name);
        if node_bin.exists() {
            return node_bin;
        }

        // 3. cwd/../node/ (dev 模式下 cwd = src-tauri/)
        if let Some(parent) = cwd.parent() {
            let node_bin = parent.join("node").join(exe_name);
            if node_bin.exists() {
                return node_bin;
            }
        }
    }

    // 4. 兜底：使用系统 PATH 中的 node
    PathBuf::from("node")
}
