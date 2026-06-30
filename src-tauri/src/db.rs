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

/// 执行数据库迁移。
///
/// 读取 migrations 目录下的 SQL 文件，按版本号顺序执行。
pub fn run_migrations(conn: &Connection, migrations_dir: &Path) -> Result<(), DbError> {
    // 创建 schema_version 表（如果不存在）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version    INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
        [],
    )
    .map_err(|e| DbError::Migration(e.to_string()))?;

    // 获取当前版本
    let current_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // 读取迁移文件
    if !migrations_dir.exists() {
        log::warn!("Migrations directory not found: {:?}", migrations_dir);
        return Ok(());
    }

    let mut migrations: Vec<(i64, String)> = Vec::new();
    for entry in std::fs::read_dir(migrations_dir)
        .map_err(|e| DbError::Migration(e.to_string()))?
    {
        let entry = entry.map_err(|e| DbError::Migration(e.to_string()))?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        // 解析文件名中的版本号 (如 001_initial.sql -> 1)
        if let Some(version_str) = file_name.split('_').next() {
            if let Ok(version) = version_str.parse::<i64>() {
                if version > current_version {
                    let sql = std::fs::read_to_string(entry.path())
                        .map_err(|e| DbError::Migration(e.to_string()))?;
                    migrations.push((version, sql));
                }
            }
        }
    }

    migrations.sort_by_key(|(v, _)| *v);

    for (version, sql) in migrations {
        log::info!("Applying migration {}", version);
        conn.execute_batch(&sql)
            .map_err(|e| DbError::Migration(format!("migration {} failed: {}", version, e)))?;
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            rusqlite::params![version],
        )
        .map_err(|e| DbError::Migration(e.to_string()))?;
    }

    Ok(())
}

/// 获取应用数据目录中的数据库路径
#[allow(dead_code)]
pub fn get_db_path(app_data_dir: &Path, project_id: &str) -> std::path::PathBuf {
    app_data_dir.join("projects").join(project_id).join("project.sqlite")
}
