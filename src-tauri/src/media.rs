use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{Manager, Runtime};

const THUMBNAIL_SIZE: &str = "320:320";

#[cfg(not(windows))]
fn replace_media_file(temporary_path: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temporary_path, destination).map_err(|error| {
        let _ = fs::remove_file(temporary_path);
        format!("替换媒体文件失败：{}", error)
    })
}

/// Windows 无法直接 rename 覆盖已存在文件：先将旧文件移到同目录备份，
/// 新文件落位失败时恢复旧文件，避免替换失败导致原封面丢失。
#[cfg(windows)]
fn replace_media_file(temporary_path: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("媒体文件没有父目录：{}", destination.display()))?;
    let backup_path = parent.join(format!(".media-backup-{}.tmp", uuid::Uuid::new_v4()));
    let had_existing = destination.exists();

    if had_existing {
        fs::rename(destination, &backup_path)
            .map_err(|error| format!("暂存旧媒体文件失败：{}", error))?;
    }

    if let Err(error) = fs::rename(temporary_path, destination) {
        let _ = fs::remove_file(temporary_path);
        if had_existing {
            if let Err(restore_error) = fs::rename(&backup_path, destination) {
                return Err(format!(
                    "替换媒体文件失败：{}；恢复旧文件也失败：{}",
                    error, restore_error
                ));
            }
        }
        return Err(format!("替换媒体文件失败：{}", error));
    }

    if had_existing {
        let _ = fs::remove_file(&backup_path);
    }
    Ok(())
}

/// 返回视频对应的封面路径。
///
/// 封面统一放在源视频同目录的 covers 子目录，文件名保留源文件名并追加 .jpg，
/// 从而不会覆盖视频，也能区分同名不同扩展名的源文件。
pub fn video_cover_path(video_path: &Path) -> Result<PathBuf, String> {
    let parent = video_path
        .parent()
        .ok_or_else(|| format!("视频路径没有父目录：{}", video_path.display()))?;
    let file_name = video_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("视频路径文件名无效：{}", video_path.display()))?;

    Ok(parent.join("covers").join(format!("{}.jpg", file_name)))
}

/// 使用应用内置 FFmpeg 抽取视频首帧并生成封面。
///
/// 先写临时文件，成功后再替换正式文件，避免数据库记录到不完整封面。
pub fn generate_video_cover<R: Runtime, M: Manager<R>>(
    app: &M,
    video_path: &Path,
) -> Result<PathBuf, String> {
    if !video_path.is_file() {
        return Err(format!("源视频不存在：{}", video_path.display()));
    }

    let ffmpeg_path = crate::app_paths::ffmpeg_path(app)
        .ok_or_else(|| "未找到内置 FFmpeg，无法生成视频封面".to_string())?;
    if !ffmpeg_path.is_file() {
        return Err(format!("FFmpeg 不存在：{}", ffmpeg_path.display()));
    }

    let cover_path = video_cover_path(video_path)?;
    let cover_dir = cover_path
        .parent()
        .ok_or_else(|| format!("封面路径没有父目录：{}", cover_path.display()))?;
    fs::create_dir_all(cover_dir).map_err(|error| format!("创建封面目录失败：{}", error))?;
    let temporary_path = cover_dir.join(format!(".cover-tmp-{}.jpg", uuid::Uuid::new_v4()));

    let output = Command::new(&ffmpeg_path)
        .args([
            "-y",
            "-loglevel",
            "error",
            "-i",
            video_path.to_string_lossy().as_ref(),
            "-vf",
            &format!(
                "scale={}:force_original_aspect_ratio=decrease",
                THUMBNAIL_SIZE
            ),
            "-frames:v",
            "1",
            "-q:v",
            "4",
            "-an",
            "-map_metadata",
            "-1",
            temporary_path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|error| format!("启动 FFmpeg 生成视频封面失败：{}", error))?;

    if !output.status.success() {
        let _ = fs::remove_file(&temporary_path);
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "FFmpeg 生成视频封面失败（exit={}）：{}",
            output.status.code().unwrap_or(-1),
            if detail.is_empty() {
                "未知错误"
            } else {
                &detail
            }
        ));
    }
    if !temporary_path.is_file() {
        let _ = fs::remove_file(&temporary_path);
        return Err("FFmpeg 未生成视频封面文件".to_string());
    }
    let metadata = match fs::metadata(&temporary_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            return Err(format!("读取视频封面文件失败：{}", error));
        }
    };
    if metadata.len() == 0 {
        let _ = fs::remove_file(&temporary_path);
        return Err("FFmpeg 生成了空的视频封面文件".to_string());
    }

    replace_media_file(&temporary_path, &cover_path)
        .map_err(|error| format!("保存视频封面失败：{}", error))?;
    Ok(cover_path)
}

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

    Ok(parent.join("thumbnails").join(format!("{}.jpg", file_name)))
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
    fs::create_dir_all(thumbnail_dir).map_err(|error| format!("创建缩略图目录失败：{}", error))?;

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
            &format!(
                "scale={}:force_original_aspect_ratio=decrease",
                THUMBNAIL_SIZE
            ),
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
            if detail.is_empty() {
                "未知错误"
            } else {
                &detail
            }
        ));
    }

    if !temporary_path.is_file() {
        let _ = fs::remove_file(&temporary_path);
        return Err("FFmpeg 未生成缩略图文件".to_string());
    }
    let metadata = match fs::metadata(&temporary_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            return Err(format!("读取缩略图文件失败：{}", error));
        }
    };
    if metadata.len() == 0 {
        let _ = fs::remove_file(&temporary_path);
        return Err("FFmpeg 生成了空的缩略图文件".to_string());
    }

    replace_media_file(&temporary_path, &thumbnail_path)
        .map_err(|error| format!("保存缩略图失败：{}", error))?;

    Ok(thumbnail_path)
}
