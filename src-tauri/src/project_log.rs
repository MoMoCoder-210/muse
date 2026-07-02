use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const LOG_FILE_NAME: &str = "muse.log";
// 与 worker/src/logger.ts 中的 LOG_MAX_BYTES / LOG_KEEP_BYTES 保持一致
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const LOG_KEEP_BYTES: usize = 2 * 1024 * 1024;

pub fn log_path_for_app_data(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("logs").join(LOG_FILE_NAME)
}

pub fn append_log(log_path: &Path, source: &str, level: &str, message: &str) {
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    rotate_if_needed(log_path);

    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "[{}] [{}] [{}] {}", timestamp, level, source, message);
    }
}

fn rotate_if_needed(log_path: &Path) {
    let Ok(metadata) = fs::metadata(log_path) else {
        return;
    };
    if metadata.len() <= LOG_MAX_BYTES {
        return;
    }

    let Ok(content) = fs::read(log_path) else {
        return;
    };

    let keep_from = content.len().saturating_sub(LOG_KEEP_BYTES);
    let trimmed = &content[keep_from..];
    let _ = fs::write(log_path, trimmed);
}
