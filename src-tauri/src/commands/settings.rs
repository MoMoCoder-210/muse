//! 设置相关命令

use crate::commands::util;
use crate::sidecar::SharedSidecarManager;
use serde::Serialize;
use serde_json::Value;

/// 获取应用版本号
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 打开应用数据目录（settings.json / workspace / logs 等）
#[tauri::command]
pub fn open_app_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| format!("创建目录失败：{}", e))?;
    open_path_in_explorer(&app_data_dir)
}

/// 打开应用日志文件所在目录
#[tauri::command]
pub fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let log_dir = app_data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("创建目录失败：{}", e))?;
    open_path_in_explorer(&log_dir)
}

fn open_path_in_explorer(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开目录失败：{}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开目录失败：{}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开目录失败：{}", e))?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("当前平台不支持自动打开目录".to_string())
}

/// 获取应用设置
#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Value, String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let settings_path = app_data_dir.join("settings.json");

    if !settings_path.exists() {
        return Ok(util::default_settings_json());
    }

    let content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(util::sanitize_settings(parsed))
}

/// 保存应用设置
#[tauri::command]
pub fn save_settings(
    settings: Value,
    state: tauri::State<'_, SharedSidecarManager>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app)?;
    let settings_path = app_data_dir.join("settings.json");
    let normalized_settings = util::sanitize_settings(settings);

    let content = serde_json::to_string_pretty(&normalized_settings).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, content).map_err(|e| e.to_string())?;
    let log_path = crate::project_log::log_path_for_app_data(&app_data_dir);
    crate::project_log::append_log(
        &log_path,
        "设置",
        "INFO",
        &format!("配置已保存到 {:?}", settings_path),
    );

    let mut manager = state.lock().map_err(|e| e.to_string())?;
    if manager.is_running() {
        // Worker 在运行：热重载配置，立即生效，无需重启应用
        if let Err(e) = manager.send_reload_config() {
            crate::project_log::append_log(
                &log_path,
                "设置",
                "WARN",
                &format!(
                    "配置热重载发送失败（配置已保存，Worker 下次启动生效）：{}",
                    e
                ),
            );
        }
    } else {
        // Worker 未运行（可能因故停止）：用已保存的启动参数重新拉起，让新配置生效
        match manager.force_restart() {
            Ok(_) => {
                crate::project_log::append_log(
                    &log_path,
                    "设置",
                    "INFO",
                    "配置已保存，Worker 已重新拉起以加载新配置（无需重启应用）",
                );
            }
            Err(e) => {
                crate::project_log::append_log(
                    &log_path,
                    "设置",
                    "WARN",
                    &format!(
                        "Worker 未运行且无法自动拉起（配置已保存，请重启应用生效）：{}",
                        e
                    ),
                );
            }
        }
    }

    Ok(())
}

/// FFmpeg 检测结果
#[derive(Serialize)]
pub struct FFmpegStatus {
    pub available: bool,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub ffmpeg_exists: bool,
    pub ffprobe_exists: bool,
}

/// 检测 FFmpeg/FFprobe 是否可用。
///
/// 检查内置 ffmpeg 目录下的可执行文件是否存在。
/// 版本号由 Worker 启动时检测，此命令仅做路径存在性检查。
///
#[tauri::command]
pub fn detect_ffmpeg(app: tauri::AppHandle) -> FFmpegStatus {
    let ffmpeg_path = crate::app_paths::ffmpeg_path(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let ffprobe_path = crate::app_paths::ffprobe_path(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let ffmpeg_exists = !ffmpeg_path.is_empty() && std::path::Path::new(&ffmpeg_path).exists();
    let ffprobe_exists = !ffprobe_path.is_empty() && std::path::Path::new(&ffprobe_path).exists();

    FFmpegStatus {
        available: ffmpeg_exists && ffprobe_exists,
        ffmpeg_path,
        ffprobe_path,
        ffmpeg_exists,
        ffprobe_exists,
    }
}
