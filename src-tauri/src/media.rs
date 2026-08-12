use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{Manager, Runtime};

const THUMBNAIL_SIZE: &str = "320:320";

/// 返回图片对应的缩略图路径。
///
/// 缩略图统一放在原图所在目录的 thumbnails 子目录中，
/// 原始文件名作为缩略图文件名的一部分，避免不同扩展名发生冲突。
pub fn image_thumbnail_path(image_path: &Path) -> Result<PathBuf, String> {
    let parent = image_path
        .parent()
        .ok_or_else(|| format!("图片路径没有父目录：{}", image_path.display()))?;
    let file_name = image_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("图片路径文件名无效：{}", image_path.display()))?;

    Ok(parent
        .join("thumbnails")
        .join(format!("{}.jpg", file_name)))
}

/// 使用应用内置 FFmpeg 生成图片缩略图。
///
/// 先输出到同目录临时文件，成功后再原子替换正式文件，避免数据库记录到不完整文件。
pub fn generate_image_thumbnail<R: Runtime, M: Manager<R>>(
    app: &M,
    image_path: &Path,
) -> Result<PathBuf, String> {
    if !image_path.is_file() {
        return Err(format!("源图片不存在：{}", image_path.display()));
    }

    let ffmpeg_path = crate::app_paths::ffmpeg_path(app)
        .ok_or_else(|| "未找到内置 FFmpeg，无法生成图片缩略图".to_string())?;
    if !ffmpeg_path.is_file() {
        return Err(format!("FFmpeg 不存在：{}", ffmpeg_path.display()));
    }

    let thumbnail_path = image_thumbnail_path(image_path)?;
    let thumbnail_dir = thumbnail_path
        .parent()
        .ok_or_else(|| format!("缩略图路径没有父目录：{}", thumbnail_path.display()))?;
    fs::create_dir_all(thumbnail_dir)
        .map_err(|error| format!("创建缩略图目录失败：{}", error))?;

    let temporary_path = thumbnail_dir.join(format!(
        ".{}.tmp-{}.jpg",
        thumbnail_path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("thumbnail"),
        uuid::Uuid::new_v4()
    ));

    let output = Command::new(&ffmpeg_path)
        .args([
            "-y",
            "-loglevel",
            "error",
            "-i",
            image_path.to_string_lossy().as_ref(),
            "-vf",
            &format!("scale={}:force_original_aspect_ratio=decrease", THUMBNAIL_SIZE),
            "-frames:v",
            "1",
            "-q:v",
            "4",
            "-map_metadata",
            "-1",
            temporary_path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|error| format!("启动 FFmpeg 生成缩略图失败：{}", error))?;

    if !output.status.success() {
        let _ = fs::remove_file(&temporary_path);
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "FFmpeg 生成缩略图失败（exit={}）：{}",
            output.status.code().unwrap_or(-1),
            if detail.is_empty() { "未知错误" } else { &detail }
        ));
    }

    if !temporary_path.is_file() {
        return Err("FFmpeg 未生成缩略图文件".to_string());
    }

    // Windows 下 rename 覆盖已有文件可能失败，先删除旧文件再替换。
    let _ = fs::remove_file(&thumbnail_path);
    fs::rename(&temporary_path, &thumbnail_path)
        .map_err(|error| format!("保存缩略图失败：{}", error))?;

    Ok(thumbnail_path)
}
