//! 数据库模块 — 连接初始化、Schema 自检同步。

use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;

/// 数据库错误类型
#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum DbError {
    #[error("database connection failed: {0}")]
    Connection(String),
    #[error("schema sync failed: {0}")]
    Sync(String),
    #[error("query failed: {0}")]
    Query(String),
}

/// 初始化 SQLite 数据库连接。
pub fn init_db(db_path: &Path) -> Result<Connection, DbError> {
    let conn = Connection::open(db_path).map_err(|e| DbError::Connection(e.to_string()))?;

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

// ── Schema 结构定义 ──────────────────────────────────

/// 解析后的列定义（名 + 完整定义文本）
#[derive(Debug)]
struct ColumnDef {
    name: String,
    /// 不含尾部逗号的列定义，例如 `"description TEXT NOT NULL DEFAULT ''"`
    definition: String,
}

/// 解析后的表定义
#[derive(Debug)]
struct TableDef {
    name: String,
    /// 完整 CREATE TABLE IF NOT EXISTS ... 语句（用于创建新表）
    create_sql: String,
    columns: Vec<ColumnDef>,
}

/// 解析后的索引定义
#[derive(Debug)]
struct IndexDef {
    /// 索引名
    name: String,
    /// 完整 CREATE INDEX IF NOT EXISTS ... 语句（含分号）
    sql: String,
}

// ── Schema 解析 ──────────────────────────────────────

/// 解析 schema.sql，提取所有表定义和索引定义。
fn parse_schema(sql: &str) -> Result<(Vec<TableDef>, Vec<IndexDef>), String> {
    let mut tables = Vec::new();
    let mut indexes = Vec::new();

    // 按行分组：每个 CREATE 语句块以"行首 CREATE"开始，下一个 CREATE 或文件尾结束
    let lines: Vec<&str> = sql.lines().collect();
    let mut block_start: Option<usize> = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();

        // 检测新块开始
        let is_table = trimmed.starts_with("CREATE TABLE");
        let is_index =
            trimmed.starts_with("CREATE INDEX") || trimmed.starts_with("CREATE UNIQUE INDEX");

        if (is_table || is_index) && block_start.is_none() {
            block_start = Some(i);
        } else if (is_table || is_index) && block_start.is_some() {
            // 遇到下一个 CREATE，结束上一个块
            let start = block_start.take().unwrap();
            let block_lines = &lines[start..i];
            process_block(block_lines, &mut tables, &mut indexes)?;
            block_start = Some(i);
        }
    }

    // 最后一个块
    if let Some(start) = block_start {
        let block_lines = &lines[start..];
        process_block(block_lines, &mut tables, &mut indexes)?;
    }

    Ok((tables, indexes))
}

/// 处理单个 CREATE 语句块
fn process_block(
    block_lines: &[&str],
    tables: &mut Vec<TableDef>,
    indexes: &mut Vec<IndexDef>,
) -> Result<(), String> {
    let joined = block_lines.join("\n");
    let trimmed = joined.trim();

    if trimmed.starts_with("CREATE TABLE") {
        let table = parse_table_block(block_lines, &joined)?;
        tables.push(table);
    } else {
        // Index
        let index = parse_index_block(&joined)?;
        indexes.push(index);
    }

    Ok(())
}

/// 解析 CREATE TABLE 块：提取表名、列定义、完整建表 SQL
fn parse_table_block(lines: &[&str], full: &str) -> Result<TableDef, String> {
    let first = lines[0].trim();

    // 提取表名："CREATE TABLE IF NOT EXISTS tablename ("
    let after_kw = first
        .strip_prefix("CREATE TABLE IF NOT EXISTS ")
        .ok_or_else(|| "无效的 CREATE TABLE 语句".to_string())?;
    let name = after_kw
        .split('(')
        .next()
        .ok_or_else(|| format!("无法解析表名：{}", first))?
        .trim()
        .to_string();

    // 提取列定义：找到 ( 和 ) 之间的内容
    // 在整个 block 中找到列体
    let full = full.trim_end_matches(';').trim();
    let paren_open = full.find('(').ok_or("找不到 '('".to_string())?;

    // 从 '(' 后到最后一个 ')' 之间
    let after_paren = &full[paren_open + 1..];
    let paren_close = after_paren.rfind(')').ok_or("找不到 ')'".to_string())?;
    let body = &after_paren[..paren_close];

    // 逐行解析列
    let mut columns = Vec::new();
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("--") {
            continue;
        }
        // 去掉尾部逗号
        let def = t.trim_end_matches(',');
        if let Some(col_name) = def.split_whitespace().next() {
            columns.push(ColumnDef {
                name: col_name.to_string(),
                definition: def.to_string(),
            });
        }
    }

    if columns.is_empty() {
        return Err(format!("表 {} 未解析到任何列", name));
    }

    // 完整建表语句（保留原样用于创建新表）
    let create_sql = full.to_string() + ";";

    Ok(TableDef {
        name,
        create_sql,
        columns,
    })
}

/// 解析 CREATE INDEX 块
fn parse_index_block(full: &str) -> Result<IndexDef, String> {
    let trimmed = full.trim();

    // 索引名：在 "INDEX IF NOT EXISTS " 和随后的 " ON" 或 "(" 之间
    let after_kw = if trimmed.starts_with("CREATE UNIQUE INDEX IF NOT EXISTS ") {
        trimmed
            .strip_prefix("CREATE UNIQUE INDEX IF NOT EXISTS ")
            .unwrap()
    } else {
        trimmed
            .strip_prefix("CREATE INDEX IF NOT EXISTS ")
            .unwrap_or("")
    };

    let name = after_kw
        .split_whitespace()
        .next()
        .ok_or_else(|| format!("无法解析索引名：{}", trimmed))?
        .to_string();

    let sql = if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{};", trimmed)
    };

    Ok(IndexDef { name, sql })
}

// ── Schema 同步 ──────────────────────────────────────

/// 自检同步：将 schema.sql 定义与数据库实际结构对比，自动补全缺失的表/列/索引。
pub fn sync_schema(conn: &Connection, schema_path: &Path) -> Result<(), DbError> {
    if !schema_path.exists() {
        return Err(DbError::Sync(format!(
            "Schema 文件不存在：{}",
            schema_path.display()
        )));
    }

    let sql = std::fs::read_to_string(schema_path)
        .map_err(|e| DbError::Sync(format!("读取 schema 失败：{}", e)))?;

    let (tables, indexes) =
        parse_schema(&sql).map_err(|e| DbError::Sync(format!("解析 schema 失败：{}", e)))?;

    // ── 同步表 ──
    for table in &tables {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                rusqlite::params![&table.name],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        if exists {
            // 对比列 —— 缺失则 ALTER TABLE ADD COLUMN
            let stmt_str = format!("PRAGMA table_info({})", table.name);
            let mut stmt = conn
                .prepare(&stmt_str)
                .map_err(|e| DbError::Sync(format!("查询表 {} 结构失败：{}", table.name, e)))?;
            let existing: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| DbError::Sync(format!("读取 {} 列信息失败：{}", table.name, e)))?
                .filter_map(|r| r.ok())
                .collect();

            for col in &table.columns {
                if !existing.contains(&col.name) {
                    let alter = format!("ALTER TABLE {} ADD COLUMN {}", table.name, col.definition);
                    conn.execute(&alter, []).map_err(|e| {
                        DbError::Sync(format!("添加列 {}.{} 失败：{}", table.name, col.name, e))
                    })?;
                    log::info!("[schema] 已添加列 {}.{}", table.name, col.name);
                }
            }
        } else {
            // 表不存在 → 直接建表
            log::info!("[schema] 创建表 {}", table.name);
            conn.execute_batch(&table.create_sql)
                .map_err(|e| DbError::Sync(format!("建表 {} 失败：{}", table.name, e)))?;
        }
    }

    // ── 同步索引 ──
    for index in &indexes {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                rusqlite::params![&index.name],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        if !exists {
            log::info!("[schema] 创建索引 {}", index.name);
            conn.execute_batch(&index.sql)
                .map_err(|e| DbError::Sync(format!("创建索引 {} 失败：{}", index.name, e)))?;
        }
    }

    log::info!(
        "[schema] 自检同步完成（{} 表 / {} 索引）",
        tables.len(),
        indexes.len()
    );
    Ok(())
}

/// 获取应用数据目录中的数据库路径
#[allow(dead_code)]
pub fn get_db_path(app_data_dir: &Path, project_id: &str) -> std::path::PathBuf {
    app_data_dir
        .join("projects")
        .join(project_id)
        .join("project.sqlite")
}
