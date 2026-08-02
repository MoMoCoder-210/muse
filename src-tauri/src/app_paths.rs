//! 应用路径工具模块

use std::path::{Path, PathBuf};
use tauri::{Manager, Runtime};

/// 解析应用数据目录（统一使用 ~/.muse）
/// - Windows: C:\Users\<用户名>\.muse
/// - macOS:   /Users/<用户名>/.muse
/// - Linux:   /home/<用户名>/.muse
pub fn resolve_app_data_dir<R: Runtime, M: Manager<R>>(_app: &M) -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .or_else(|| std::env::current_dir().ok())
        .ok_or("无法获取用户主目录".to_string())?;
    let dir = home.join(".muse");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 获取应用数据库文件路径
pub fn app_db_path<R: Runtime, M: Manager<R>>(app: &M) -> Result<PathBuf, String> {
    Ok(resolve_app_data_dir(app)?.join("app.sqlite"))
}

/// 获取默认作品根目录
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

/// 清理作品目录名称
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

/// 解析超分引擎目录（ncnn-vulkan 方案，upscaler 资源目录）。
///
/// 查找顺序：
/// 1. Tauri resource_dir/upscaler（生产包）
/// 2. 项目根目录下的 upscaler/（开发模式优先）
/// 3. resource_dir 所在目录向上逐级找 upscaler（开发模式，resource_dir=target/debug）
/// 4. cwd 向上逐级找 upscaler（兜底）
///
/// 目录判定条件：包含 realesrgan.exe（ncnn-vulkan 引擎）。
pub fn resolve_upscaler_dir<R: Runtime, M: Manager<R>>(app: &M) -> Option<PathBuf> {
    // 1. Tauri resource_dir/upscaler（生产包）
    if let Ok(res_dir) = app.path().resource_dir() {
        let upscaler_dir = res_dir.join("upscaler");
        if is_upscaler_dir(&upscaler_dir) {
            return Some(upscaler_dir);
        }
        // 兼容 resource_dir 下嵌套版本目录
        if let Some(found) = find_upscaler_subdir(&upscaler_dir) {
            return Some(found);
        }

        // 2. 项目根目录下的 upscaler/（干净目录，开发模式优先）
        let mut dir: &Path = res_dir.as_path();
        let mut hops = 0;
        while hops < 6 {
            let candidate = dir.join("upscaler");
            if is_upscaler_dir(&candidate) {
                return Some(candidate);
            }
            dir = match dir.parent() {
                Some(p) => p,
                None => break,
            };
            hops += 1;
        }
    }

    // 3. cwd 向上逐级找 upscaler/（兜底）
    let cwd = std::env::current_dir().ok()?;
    let mut dir: &Path = cwd.as_path();
    let mut hops = 0;
    while hops < 6 {
        let candidate = dir.join("upscaler");
        if is_upscaler_dir(&candidate) {
            return Some(candidate);
        }
        dir = match dir.parent() {
            Some(p) => p,
            None => break,
        };
        hops += 1;
    }

    None
}

/// 判断目录是否为 ncnn 超分引擎目录（包含 realesrgan.exe）。
fn is_upscaler_dir(dir: &Path) -> bool {
    dir.join("realesrgan.exe").exists()
}

/// 在给定目录下查找含 realesrgan.exe 的子目录（含目录本身）。
fn find_upscaler_subdir(dir: &Path) -> Option<PathBuf> {
    if is_upscaler_dir(dir) {
        return Some(dir.to_path_buf());
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && is_upscaler_dir(&path) {
            return Some(path);
        }
    }
    None
}

/// 获取 ncnn-vulkan realesrgan.exe 路径（唯一超分引擎）。
pub fn ncnn_realesrgan_exe<R: Runtime, M: Manager<R>>(app: &M) -> Option<PathBuf> {
    resolve_upscaler_dir(app).map(|d| d.join("realesrgan.exe"))
}

/// 获取 ncnn 超分模型目录（upscaler/models）。
pub fn ncnn_models_dir<R: Runtime, M: Manager<R>>(app: &M) -> Option<PathBuf> {
    Some(resolve_upscaler_dir(app)?.join("models"))
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
