use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum DbError {
    #[error("database connection failed: {0}")]
    Connection(String),
    #[error("migration failed: {0}")]
    Migration(String),
    #[error("query failed: {0}")]
    Query(String),
}

/// 初始化 SQLite 数据库连接。
///
/// 必须设置 WAL 模式和 busy_timeout，以支持 Tauri Rust 层和 Node worker 的多进程并发访问。
pub fn init_db(db_path: &Path) -> Result<Connection, DbError> {
    let conn = Connection::open(db_path)
        .map_err(|e| DbError::Connection(e.to_string()))?;

    // 启用 WAL 模式
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| DbError::Connection(e.to_string()))?;

    // 设置 busy_timeout 为 5 秒
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| DbError::Connection(e.to_string()))?;

    // WAL checkpoint 策略
    conn.pragma_update(None, "wal_autocheckpoint", 1000)
        .map_err(|e| DbError::Connection(e.to_string()))?;

    // 启用外键约束
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| DbError::Connection(e.to_string()))?;

    Ok(conn)
}

/// 执行数据库建表。
///
/// 读取 migrations 目录下所有 .sql 文件，逐文件执行。
/// 所有建表语句均使用 CREATE TABLE IF NOT EXISTS，可安全重复执行。
pub fn run_migrations(conn: &Connection, migrations_dir: &Path) -> Result<(), DbError> {
    if !migrations_dir.exists() {
        log::warn!("Migrations directory not found: {:?}", migrations_dir);
        return Ok(());
    }

    let mut files: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(migrations_dir)
        .map_err(|e| DbError::Migration(e.to_string()))?
    {
        let entry = entry.map_err(|e| DbError::Migration(e.to_string()))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.ends_with(".sql") {
            files.push(file_name);
        }
    }

    files.sort();

    for file_name in &files {
        let file_path = migrations_dir.join(file_name);
        let sql = std::fs::read_to_string(&file_path)
            .map_err(|e| DbError::Migration(format!("读取 {} 失败: {}", file_name, e)))?;

        log::info!("执行建表脚本: {}", file_name);
        conn.execute_batch(&sql)
            .map_err(|e| DbError::Migration(format!("{} 执行失败: {}", file_name, e)))?;
    }

    Ok(())
}

/// 获取应用数据目录中的数据库路径
#[allow(dead_code)]
pub fn get_db_path(app_data_dir: &Path, project_id: &str) -> std::path::PathBuf {
    app_data_dir.join("projects").join(project_id).join("project.sqlite")
}
