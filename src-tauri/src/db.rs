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
        // 表级约束不是列定义；否则同步器会误把 CHECK/UNIQUE/FOREIGN KEY
        // 当作字段并尝试 ALTER TABLE ADD COLUMN。
        if t.is_empty()
            || t.starts_with("--")
            || t.starts_with("CHECK")
            || t.starts_with("CONSTRAINT")
            || t.starts_with("FOREIGN KEY")
            || t.starts_with("UNIQUE")
            || t.starts_with("PRIMARY KEY")
        {
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

/// 强制同步：将 schema.sql 定义与数据库实际结构对齐。
///
/// 已有表会删除 schema 未声明的多余列，并添加 schema 中缺失的列；
/// 因此 schema.sql 是数据库结构的唯一事实来源。
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
            // 强制对齐列：先删除 schema 未声明的历史列，再添加缺失列。
            let stmt_str = format!("PRAGMA table_info({})", table.name);
            let mut stmt = conn
                .prepare(&stmt_str)
                .map_err(|e| DbError::Sync(format!("查询表 {} 结构失败：{}", table.name, e)))?;
            let existing: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| DbError::Sync(format!("读取 {} 列信息失败：{}", table.name, e)))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| DbError::Sync(format!("读取 {} 列信息失败：{}", table.name, e)))?;

            for col in existing
                .iter()
                .filter(|name| !table.columns.iter().any(|expected| expected.name == **name))
            {
                let drop_sql = format!("ALTER TABLE {} DROP COLUMN {}", table.name, col);
                conn.execute(&drop_sql, []).map_err(|e| {
                    DbError::Sync(format!("删除多余列 {}.{} 失败：{}", table.name, col, e))
                })?;
                log::info!("[schema] 已删除多余列 {}.{}", table.name, col);
            }

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
        "[schema] 强制同步完成（{} 表 / {} 索引）",
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

/// 显式重建旧版 `upscale_jobs`，将图片任务从空视频外键迁移为真实来源外键。
/// 无法确认来源归属的历史记录保留为 `legacy/failed`，绝不伪造父键。
pub fn migrate_upscale_jobs(conn: &mut Connection) -> Result<(), DbError> {
    let exists = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='upscale_jobs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| DbError::Query(e.to_string()))?
        > 0;
    if !exists {
        return Ok(());
    }

    let has_new_columns = {
        let mut statement = conn
            .prepare("PRAGMA table_info(upscale_jobs)")
            .map_err(|e| DbError::Query(e.to_string()))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| DbError::Query(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| DbError::Query(e.to_string()))?;
        columns.iter().any(|name| name == "source_asset_id")
    };
    if has_new_columns {
        return Ok(());
    }

    // 表重建期间临时关闭 FK；只允许本受控迁移使用，完成前会执行专表检查。
    conn.pragma_update(None, "foreign_keys", "OFF")
        .map_err(|e| DbError::Sync(format!("关闭迁移外键失败：{}", e)))?;
    let migration = (|| -> Result<(), DbError> {
        let tx = conn
            .transaction()
            .map_err(|e| DbError::Sync(format!("开启超分迁移事务失败：{}", e)))?;
        tx.execute_batch(
            "CREATE TABLE upscale_jobs_v2 (
                id                    TEXT PRIMARY KEY,
                storyboard_id         TEXT REFERENCES storyboards(id),
                video_id              TEXT REFERENCES storyboard_videos(id),
                source_clip_id        TEXT REFERENCES clips(id),
                source_asset_id       TEXT REFERENCES assets(id),
                source_asset_image_id TEXT REFERENCES asset_images(id),
                input_path            TEXT NOT NULL,
                output_path           TEXT NOT NULL,
                model                 TEXT NOT NULL DEFAULT 'anime',
                scale                 INTEGER NOT NULL DEFAULT 4,
                status                TEXT NOT NULL DEFAULT 'queued',
                error_message         TEXT,
                task_type             TEXT NOT NULL DEFAULT 'video',
                attempt_count         INTEGER NOT NULL DEFAULT 0,
                cancelled_at          TEXT,
                cancel_reason         TEXT,
                created_at            TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
                CHECK ((task_type = 'video' AND storyboard_id IS NOT NULL AND video_id IS NOT NULL AND source_clip_id IS NULL AND source_asset_id IS NULL AND source_asset_image_id IS NULL) OR (task_type = 'image' AND storyboard_id IS NULL AND video_id IS NULL AND source_clip_id IS NOT NULL AND source_asset_id IS NOT NULL AND source_asset_image_id IS NOT NULL) OR (task_type = 'legacy' AND status = 'failed'))
            );",
        )
        .map_err(|e| DbError::Sync(format!("创建新版超分表失败：{}", e)))?;

        // 旧图片作业必须同时能找到源图、素材及该分集的素材池关联，才允许成为 image。
        // 其他记录转为 legacy/failed，保留原 ID、路径和错误文本供排查。
        tx.execute_batch(
            "INSERT INTO upscale_jobs_v2 (
                id, storyboard_id, video_id, source_clip_id, source_asset_id,
                source_asset_image_id, input_path, output_path, model, scale, status,
                error_message, task_type, created_at, updated_at
             )
             SELECT
                j.id,
                CASE WHEN j.task_type <> 'image' AND EXISTS (
                    SELECT 1 FROM storyboard_videos sv
                    WHERE sv.id = j.video_id AND sv.storyboard_id = j.storyboard_id
                ) THEN j.storyboard_id END,
                CASE WHEN j.task_type <> 'image' AND EXISTS (
                    SELECT 1 FROM storyboard_videos sv
                    WHERE sv.id = j.video_id AND sv.storyboard_id = j.storyboard_id
                ) THEN j.video_id END,
                CASE WHEN j.task_type = 'image' AND EXISTS (
                    SELECT 1 FROM asset_images ai
                    JOIN clip_assets ca ON ca.asset_id = ai.asset_id
                    JOIN clips c ON c.id = ca.clip_id
                    WHERE ai.id = j.asset_image_id AND ca.clip_id = j.asset_clip_id
                      AND c.deleted_at IS NULL
                ) THEN j.asset_clip_id END,
                CASE WHEN j.task_type = 'image' AND EXISTS (
                    SELECT 1 FROM asset_images ai
                    JOIN clip_assets ca ON ca.asset_id = ai.asset_id
                    JOIN clips c ON c.id = ca.clip_id
                    WHERE ai.id = j.asset_image_id AND ca.clip_id = j.asset_clip_id
                      AND c.deleted_at IS NULL
                ) THEN (SELECT asset_id FROM asset_images WHERE id = j.asset_image_id) END,
                CASE WHEN j.task_type = 'image' AND EXISTS (
                    SELECT 1 FROM asset_images ai
                    JOIN clip_assets ca ON ca.asset_id = ai.asset_id
                    JOIN clips c ON c.id = ca.clip_id
                    WHERE ai.id = j.asset_image_id AND ca.clip_id = j.asset_clip_id
                      AND c.deleted_at IS NULL
                ) THEN j.asset_image_id END,
                j.input_path, j.output_path, j.model, j.scale,
                CASE WHEN (j.task_type <> 'image' AND EXISTS (
                    SELECT 1 FROM storyboard_videos sv WHERE sv.id = j.video_id AND sv.storyboard_id = j.storyboard_id
                )) OR (j.task_type = 'image' AND EXISTS (
                    SELECT 1 FROM asset_images ai JOIN clip_assets ca ON ca.asset_id = ai.asset_id JOIN clips c ON c.id = ca.clip_id
                    WHERE ai.id = j.asset_image_id AND ca.clip_id = j.asset_clip_id AND c.deleted_at IS NULL
                )) THEN CASE WHEN j.status IN ('queued','running','done','failed','cancelled') THEN j.status ELSE 'failed' END ELSE 'failed' END,
                CASE WHEN (j.task_type <> 'image' AND EXISTS (
                    SELECT 1 FROM storyboard_videos sv WHERE sv.id = j.video_id AND sv.storyboard_id = j.storyboard_id
                )) OR (j.task_type = 'image' AND EXISTS (
                    SELECT 1 FROM asset_images ai JOIN clip_assets ca ON ca.asset_id = ai.asset_id JOIN clips c ON c.id = ca.clip_id
                    WHERE ai.id = j.asset_image_id AND ca.clip_id = j.asset_clip_id AND c.deleted_at IS NULL
                )) THEN j.error_message ELSE COALESCE(j.error_message, '') || ' [legacy upscale target cannot be resolved]' END,
                CASE WHEN j.task_type <> 'image' AND EXISTS (
                    SELECT 1 FROM storyboard_videos sv WHERE sv.id = j.video_id AND sv.storyboard_id = j.storyboard_id
                ) THEN 'video' WHEN j.task_type = 'image' AND EXISTS (
                    SELECT 1 FROM asset_images ai JOIN clip_assets ca ON ca.asset_id = ai.asset_id JOIN clips c ON c.id = ca.clip_id
                    WHERE ai.id = j.asset_image_id AND ca.clip_id = j.asset_clip_id AND c.deleted_at IS NULL
                ) THEN 'image' ELSE 'legacy' END,
                j.created_at, j.updated_at
             FROM upscale_jobs j;
             DROP TABLE upscale_jobs;
             ALTER TABLE upscale_jobs_v2 RENAME TO upscale_jobs;",
        )
        .map_err(|e| DbError::Sync(format!("回填新版超分表失败：{}", e)))?;

        {
            let mut check = tx
                .prepare("PRAGMA foreign_key_check('upscale_jobs')")
                .map_err(|e| DbError::Query(e.to_string()))?;
            let mut rows = check.query([]).map_err(|e| DbError::Query(e.to_string()))?;
            if rows
                .next()
                .map_err(|e| DbError::Query(e.to_string()))?
                .is_some()
            {
                return Err(DbError::Sync("超分迁移后存在外键错误".to_string()));
            }
        }
        tx.commit()
            .map_err(|e| DbError::Sync(format!("提交超分迁移失败：{}", e)))?;
        Ok(())
    })();
    let reenable = conn
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| DbError::Sync(format!("恢复迁移外键失败：{}", e)));
    migration?;
    reenable?;
    conn.pragma_update(None, "user_version", 2)
        .map_err(|e| DbError::Sync(format!("写入 schema 版本失败：{}", e)))?;
    log::info!("[schema] 已完成 upscale_jobs v2 迁移");
    Ok(())
}

/// 在删除旧 `assets.clip_id` 前回填新的分集素材池关系。
/// 该步骤必须先于 upscale 迁移，因为旧图片超分作业依赖分集归属验证。
pub fn migrate_legacy_clip_assets(conn: &mut Connection) -> Result<(), DbError> {
    let has_legacy_clip_id = {
        let mut statement = conn
            .prepare("PRAGMA table_info(assets)")
            .map_err(|e| DbError::Query(e.to_string()))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| DbError::Query(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| DbError::Query(e.to_string()))?;
        columns.iter().any(|name| name == "clip_id")
    };
    if !has_legacy_clip_id {
        return Ok(());
    }

    let tx = conn
        .transaction()
        .map_err(|e| DbError::Sync(format!("开启素材池迁移事务失败：{}", e)))?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS clip_assets (
            id TEXT PRIMARY KEY,
            clip_id TEXT NOT NULL REFERENCES clips(id),
            asset_id TEXT NOT NULL REFERENCES assets(id),
            source TEXT NOT NULL DEFAULT 'generated',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_clip_assets_unique ON clip_assets(clip_id, asset_id);",
    )
    .map_err(|e| DbError::Sync(format!("创建素材池迁移表失败：{}", e)))?;
    tx.execute(
        "INSERT OR IGNORE INTO clip_assets (id, clip_id, asset_id, source)
         SELECT lower(hex(randomblob(16))), a.clip_id, a.id, 'generated'
         FROM assets a JOIN clips c ON c.id = a.clip_id
         WHERE a.clip_id IS NOT NULL AND TRIM(a.clip_id) <> ''",
        [],
    )
    .map_err(|e| DbError::Sync(format!("回填素材池失败：{}", e)))?;
    // SQLite 不允许删除仍被索引引用的列；同步器不会清理废弃索引。
    tx.execute_batch("DROP INDEX IF EXISTS idx_assets_clip;")
        .map_err(|e| DbError::Sync(format!("清理旧素材索引失败：{}", e)))?;
    tx.commit()
        .map_err(|e| DbError::Sync(format!("提交素材池迁移失败：{}", e)))?;
    Ok(())
}

/// 重建旧版 `clip_scripts`，为每条历史拆解记录补齐任务所有权和原文版本。
///
/// SQLite 不能通过 `ALTER TABLE ADD COLUMN` 添加 `NOT NULL UNIQUE` 列；本迁移在
/// 通用 schema 同步前重建表。历史记录不会被重新调度：它们关联的任务一律使用
/// 终态，只有原本成功的拆解记录映射为成功任务，其余映射为失败任务。
pub fn migrate_clip_scripts_task_ownership(conn: &mut Connection) -> Result<(), DbError> {
    let clip_scripts_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'clip_scripts'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| DbError::Query(e.to_string()))?
        > 0;
    if !clip_scripts_exists {
        return Ok(());
    }

    let columns = {
        let mut statement = conn
            .prepare("PRAGMA table_info(clip_scripts)")
            .map_err(|e| DbError::Query(e.to_string()))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| DbError::Query(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| DbError::Query(e.to_string()))?
    };
    let has_column = |name: &str| columns.iter().any(|column| column == name);
    if has_column("task_id") && has_column("source_revision") {
        return Ok(());
    }

    // 静态列名仅来自本迁移维护的已知历史字段，不接收外部输入。
    let value = |name: &str, fallback: &str| -> String {
        if has_column(name) {
            format!("cs.{name}")
        } else {
            fallback.to_string()
        }
    };
    let source_text = if has_column("source_text") {
        "COALESCE(cs.source_text, '')".to_string()
    } else {
        "''".to_string()
    };
    let status = if has_column("status") {
        "CASE WHEN cs.status = 'success' THEN 'success' WHEN cs.status = 'cancelled' THEN 'cancelled' ELSE 'failed' END".to_string()
    } else {
        "'success'".to_string()
    };
    let task_status = if has_column("status") {
        "CASE WHEN cs.status = 'success' THEN 'success' ELSE 'failed' END".to_string()
    } else {
        "'success'".to_string()
    };
    let error_message = if has_column("status") {
        let existing_error = value("error_message", "NULL");
        format!(
            "CASE WHEN cs.status = 'success' THEN NULL \
             WHEN cs.status = 'cancelled' THEN COALESCE({existing_error}, '历史拆解任务已取消') \
             ELSE COALESCE({existing_error}, '历史拆解任务在数据库升级时未完成，已标记失败') END"
        )
    } else {
        "NULL".to_string()
    };
    let created_at = if has_column("created_at") {
        "COALESCE(cs.created_at, datetime('now'))".to_string()
    } else {
        "datetime('now')".to_string()
    };
    let updated_at = if has_column("updated_at") {
        "COALESCE(cs.updated_at, datetime('now'))".to_string()
    } else {
        "datetime('now')".to_string()
    };

    let tx = conn
        .transaction()
        .map_err(|e| DbError::Sync(format!("开启分集拆解迁移事务失败：{e}")))?;

    // 先检查关联完整性。无法证明归属的旧记录不应被静默丢弃或伪造外键。
    let orphan_count: i64 = tx
        .query_row(
            "SELECT COUNT(*)
             FROM clip_scripts cs
             LEFT JOIN projects p ON p.id = cs.project_id
             LEFT JOIN clips c ON c.id = cs.clip_id AND c.project_id = cs.project_id
             WHERE p.id IS NULL OR c.id IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| DbError::Query(format!("检查历史拆解记录归属失败：{e}")))?;
    if orphan_count > 0 {
        return Err(DbError::Sync(format!(
            "无法迁移 {orphan_count} 条缺少作品或分集归属的历史拆解记录；请先备份数据库并清理孤立记录"
        )));
    }

    tx.execute_batch(
        "CREATE TABLE clip_scripts_v2 (
            id                       TEXT PRIMARY KEY,
            project_id               TEXT NOT NULL REFERENCES projects(id),
            clip_id                  TEXT NOT NULL REFERENCES clips(id),
            task_id                  TEXT NOT NULL UNIQUE REFERENCES tasks(id),
            source_revision          INTEGER NOT NULL,
            source_text              TEXT NOT NULL,
            optimized_text           TEXT,
            script_summary           TEXT,
            raw_model_output         TEXT,
            assets_raw_model_output  TEXT,
            mode                     TEXT,
            stop_step                TEXT,
            status                   TEXT NOT NULL DEFAULT 'pending',
            error_message            TEXT,
            created_at               TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )
    .map_err(|e| DbError::Sync(format!("创建新版分集拆解表失败：{e}")))?;

    let legacy_task_id = "'legacy:clip-script:' || cs.id";
    let insert_tasks = format!(
        "INSERT INTO tasks (id, project_id, clip_id, type, status, lock_key, input_json)
         SELECT {legacy_task_id}, cs.project_id, cs.clip_id, 'legacy_clip_script', {task_status},
                'legacy:clip-script:' || cs.id, '{{\"legacy\":true}}'
         FROM clip_scripts cs;"
    );
    tx.execute_batch(&insert_tasks)
        .map_err(|e| DbError::Sync(format!("回填历史拆解任务失败：{e}")))?;

    let insert_scripts = format!(
        "INSERT INTO clip_scripts_v2 (
            id, project_id, clip_id, task_id, source_revision, source_text,
            optimized_text, script_summary, raw_model_output, assets_raw_model_output,
            mode, stop_step, status, error_message, created_at, updated_at
         )
         SELECT
            cs.id, cs.project_id, cs.clip_id, {legacy_task_id}, 1, {source_text},
            {optimized_text}, {script_summary}, {raw_model_output}, NULL,
            {mode}, {stop_step}, {status}, {error_message}, {created_at}, {updated_at}
         FROM clip_scripts cs;
         DROP TABLE clip_scripts;
         ALTER TABLE clip_scripts_v2 RENAME TO clip_scripts;",
        optimized_text = value("optimized_text", "NULL"),
        script_summary = value("script_summary", "NULL"),
        raw_model_output = value("raw_model_output", "NULL"),
        mode = value("mode", "NULL"),
        stop_step = value("stop_step", "NULL"),
    );
    tx.execute_batch(&insert_scripts)
        .map_err(|e| DbError::Sync(format!("回填新版分集拆解表失败：{e}")))?;

    {
        let mut check = tx
            .prepare("PRAGMA foreign_key_check('clip_scripts')")
            .map_err(|e| DbError::Query(e.to_string()))?;
        let mut rows = check.query([]).map_err(|e| DbError::Query(e.to_string()))?;
        if rows
            .next()
            .map_err(|e| DbError::Query(e.to_string()))?
            .is_some()
        {
            return Err(DbError::Sync("分集拆解迁移后存在外键错误".to_string()));
        }
    }

    tx.commit()
        .map_err(|e| DbError::Sync(format!("提交分集拆解迁移失败：{e}")))?;
    log::info!("[schema] 已完成 clip_scripts 任务所有权迁移");
    Ok(())
}

/// 将旧的同名非唯一素材索引升级为当前唯一约束。
///
/// 若已有重复 `(project_id, type, name)`，安全终止而不删除任何素材；调用方可据此
/// 先处理重复数据，避免自动选择错误素材作为复用目标。
pub fn migrate_assets_unique_name_index(conn: &mut Connection) -> Result<(), DbError> {
    let assets_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'assets'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| DbError::Query(e.to_string()))?
        > 0;
    if !assets_exists {
        return Ok(());
    }

    // 不论旧索引是否存在，先检查目标唯一键。否则缺少旧索引的库会在
    // sync_schema 尝试创建唯一索引时再次以不带上下文的错误启动失败。
    let duplicate: Option<(String, String, String, i64)> = conn
        .query_row(
            "SELECT project_id, type, name, COUNT(*)
             FROM assets
             GROUP BY project_id, type, name
             HAVING COUNT(*) > 1
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok();
    if let Some((project_id, asset_type, name, count)) = duplicate {
        return Err(DbError::Sync(format!(
            "无法升级素材唯一索引：作品 {project_id} 的 {asset_type}/「{name}」存在 {count} 条重复素材；请先合并重复记录"
        )));
    }

    let index_definition = {
        let mut statement = conn
            .prepare("PRAGMA index_list(assets)")
            .map_err(|e| DbError::Query(e.to_string()))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| DbError::Query(e.to_string()))?;
        let indexes = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| DbError::Query(e.to_string()))?;
        indexes
            .into_iter()
            .find(|(name, _, _)| name == "idx_assets_project_type_name")
    };

    let is_current = if let Some((_, unique, partial)) = &index_definition {
        if *unique == 0 || *partial != 0 {
            false
        } else {
            let mut statement = conn
                .prepare("PRAGMA index_xinfo(idx_assets_project_type_name)")
                .map_err(|e| DbError::Query(e.to_string()))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })
                .map_err(|e| DbError::Query(e.to_string()))?;
            let key_columns = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| DbError::Query(e.to_string()))?
                .into_iter()
                .filter(|(_, _, _, is_key)| *is_key != 0)
                .collect::<Vec<_>>();
            key_columns
                == [
                    (Some("project_id".to_string()), 0, "BINARY".to_string(), 1),
                    (Some("type".to_string()), 0, "BINARY".to_string(), 1),
                    (Some("name".to_string()), 0, "BINARY".to_string(), 1),
                ]
        }
    } else {
        false
    };
    if is_current {
        return Ok(());
    }

    let tx = conn
        .transaction()
        .map_err(|e| DbError::Sync(format!("开启素材唯一索引迁移事务失败：{e}")))?;
    if index_definition.is_some() {
        tx.execute_batch("DROP INDEX idx_assets_project_type_name;")
            .map_err(|e| DbError::Sync(format!("删除旧素材名称索引失败：{e}")))?;
    }
    tx.execute_batch(
        "CREATE UNIQUE INDEX idx_assets_project_type_name ON assets(project_id, type, name);",
    )
    .map_err(|e| DbError::Sync(format!("升级素材唯一索引失败：{e}")))?;
    tx.commit()
        .map_err(|e| DbError::Sync(format!("提交素材唯一索引迁移失败：{e}")))?;
    log::info!("[schema] 已升级素材名称唯一索引");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{migrate_assets_unique_name_index, migrate_clip_scripts_task_ownership};
    use rusqlite::Connection;

    fn legacy_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory SQLite");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE projects (id TEXT PRIMARY KEY);
             CREATE TABLE clips (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL REFERENCES projects(id)
             );
             CREATE TABLE tasks (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL REFERENCES projects(id),
               clip_id TEXT REFERENCES clips(id),
               type TEXT NOT NULL,
               status TEXT NOT NULL,
               lock_key TEXT NOT NULL,
               input_json TEXT NOT NULL,
               max_retry INTEGER NOT NULL DEFAULT 3,
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now')),
               finished_at TEXT
             );
             CREATE TABLE clip_scripts (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL REFERENCES projects(id),
               clip_id TEXT NOT NULL REFERENCES clips(id),
               source_text TEXT NOT NULL,
               optimized_text TEXT,
               script_summary TEXT,
               raw_model_output TEXT,
               mode TEXT,
               stop_step TEXT,
               status TEXT NOT NULL DEFAULT 'pending',
               error_message TEXT,
               created_at TEXT NOT NULL DEFAULT (datetime('now')),
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO projects (id) VALUES ('project-1');
             INSERT INTO clips (id, project_id) VALUES ('clip-1', 'project-1');",
        )
        .expect("create legacy schema");
        conn
    }

    #[test]
    fn migrates_legacy_clip_scripts_to_terminal_tasks_without_losing_records() {
        let mut conn = legacy_connection();
        for (id, status) in [
            ("script-success", "success"),
            ("script-pending", "pending"),
            ("script-running", "running"),
            ("script-cancelled", "cancelled"),
        ] {
            conn.execute(
                "INSERT INTO clip_scripts (id, project_id, clip_id, source_text, status)
                 VALUES (?1, 'project-1', 'clip-1', '历史原文', ?2)",
                [id, status],
            )
            .expect("insert legacy clip script");
        }
        conn.execute(
            "UPDATE clip_scripts
             SET source_text = '保留原文', optimized_text = '保留优化稿',
                 script_summary = '保留摘要', raw_model_output = '保留模型输出',
                 mode = 'chapter', stop_step = 'assets',
                 created_at = '2026-01-02 03:04:05', updated_at = '2026-01-03 04:05:06'
             WHERE id = 'script-success'",
            [],
        )
        .expect("populate legacy content");

        migrate_clip_scripts_task_ownership(&mut conn).expect("migrate legacy clip scripts");

        let migrated: Vec<(String, String, i64, Option<String>, String)> = {
            let mut statement = conn
                .prepare(
                    "SELECT cs.id, cs.status, cs.source_revision, cs.error_message, t.status
                     FROM clip_scripts cs JOIN tasks t ON t.id = cs.task_id
                     ORDER BY cs.id",
                )
                .expect("prepare migrated query");
            statement
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })
                .expect("query migrated clip scripts")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect migrated clip scripts")
        };
        assert_eq!(
            migrated,
            vec![
                (
                    "script-cancelled".to_string(),
                    "cancelled".to_string(),
                    1,
                    Some("历史拆解任务已取消".to_string()),
                    "failed".to_string(),
                ),
                (
                    "script-pending".to_string(),
                    "failed".to_string(),
                    1,
                    Some("历史拆解任务在数据库升级时未完成，已标记失败".to_string()),
                    "failed".to_string(),
                ),
                (
                    "script-running".to_string(),
                    "failed".to_string(),
                    1,
                    Some("历史拆解任务在数据库升级时未完成，已标记失败".to_string()),
                    "failed".to_string(),
                ),
                (
                    "script-success".to_string(),
                    "success".to_string(),
                    1,
                    None,
                    "success".to_string(),
                ),
            ],
        );
        let preserved_content: (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, String) = conn
            .query_row(
                "SELECT source_text, optimized_text, script_summary, raw_model_output, mode, stop_step,
                        created_at, updated_at
                 FROM clip_scripts WHERE id = 'script-success'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .expect("read preserved legacy content");
        assert_eq!(
            preserved_content,
            (
                "保留原文".to_string(),
                Some("保留优化稿".to_string()),
                Some("保留摘要".to_string()),
                Some("保留模型输出".to_string()),
                Some("chapter".to_string()),
                Some("assets".to_string()),
                "2026-01-02 03:04:05".to_string(),
                "2026-01-03 04:05:06".to_string(),
            ),
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("foreign key check"),
            0,
        );
        migrate_clip_scripts_task_ownership(&mut conn).expect("idempotent migration");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM clip_scripts", [], |row| row
                .get::<_, i64>(0))
                .expect("count migrated clip scripts"),
            4,
        );
    }

    #[test]
    fn upgrades_partial_asset_name_index_to_full_binary_unique_index() {
        let mut conn = Connection::open_in_memory().expect("open in-memory SQLite");
        conn.execute_batch(
            "CREATE TABLE assets (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               type TEXT NOT NULL,
               name TEXT NOT NULL,
               status TEXT NOT NULL
             );
             CREATE UNIQUE INDEX idx_assets_project_type_name
             ON assets(project_id, type, name) WHERE status = 'confirmed';
             INSERT INTO assets VALUES ('asset-1', 'project-1', 'character', '沈青', 'draft');",
        )
        .expect("create partial asset index");

        migrate_assets_unique_name_index(&mut conn).expect("upgrade partial asset index");
        assert!(
            conn.execute(
                "INSERT INTO assets VALUES ('asset-2', 'project-1', 'character', '沈青', 'draft')",
                [],
            )
            .is_err(),
            "recreated index must reject duplicate rows regardless of status",
        );
        let partial: i64 = conn
            .query_row(
                "SELECT partial FROM pragma_index_list('assets')
                 WHERE name = 'idx_assets_project_type_name'",
                [],
                |row| row.get(0),
            )
            .expect("read rebuilt index metadata");
        assert_eq!(partial, 0);
    }

    #[test]
    fn rejects_duplicate_assets_even_when_legacy_index_is_missing() {
        let mut conn = Connection::open_in_memory().expect("open in-memory SQLite");
        conn.execute_batch(
            "CREATE TABLE assets (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               type TEXT NOT NULL,
               name TEXT NOT NULL
             );
             INSERT INTO assets VALUES ('asset-1', 'project-1', 'character', '沈青');
             INSERT INTO assets VALUES ('asset-2', 'project-1', 'character', '沈青');",
        )
        .expect("create duplicate legacy assets");

        let error = migrate_assets_unique_name_index(&mut conn)
            .expect_err("duplicate legacy assets must be diagnosed before schema sync");
        assert!(error.to_string().contains("存在 2 条重复素材"));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM assets", [], |row| row
                .get::<_, i64>(0))
                .expect("count original duplicate assets"),
            2,
        );
    }

    #[test]
    fn upgrades_non_unique_wrong_order_and_nocase_asset_indexes() {
        for (label, index_sql) in [
            (
                "non-unique",
                "CREATE INDEX idx_assets_project_type_name ON assets(project_id, type, name);",
            ),
            (
                "wrong-column-order",
                "CREATE UNIQUE INDEX idx_assets_project_type_name ON assets(name, type, project_id);",
            ),
            (
                "nocase",
                "CREATE UNIQUE INDEX idx_assets_project_type_name ON assets(project_id, type, name COLLATE NOCASE);",
            ),
        ] {
            let mut conn = Connection::open_in_memory().expect("open in-memory SQLite");
            conn.execute_batch(&format!(
                "CREATE TABLE assets (
                   id TEXT PRIMARY KEY,
                   project_id TEXT NOT NULL,
                   type TEXT NOT NULL,
                   name TEXT NOT NULL
                 );
                 {index_sql}
                 INSERT INTO assets VALUES ('asset-1', 'project-1', 'character', 'Hero');"
            ))
            .unwrap_or_else(|error| panic!("create {label} asset index: {error}"));

            migrate_assets_unique_name_index(&mut conn)
                .unwrap_or_else(|error| panic!("upgrade {label} asset index: {error}"));
            let key_columns: Vec<(Option<String>, i64, String)> = {
                let mut statement = conn
                    .prepare("PRAGMA index_xinfo(idx_assets_project_type_name)")
                    .expect("prepare rebuilt index metadata");
                statement
                    .query_map([], |row| Ok((row.get(2)?, row.get(3)?, row.get(4)?, row.get::<_, i64>(5)?)))
                    .expect("query rebuilt index metadata")
                    .collect::<Result<Vec<(Option<String>, i64, String, i64)>, _>>()
                    .expect("collect rebuilt index metadata")
                    .into_iter()
                    .filter(|(_, _, _, is_key)| *is_key != 0)
                    .map(|(name, desc, coll, _)| (name, desc, coll))
                    .collect()
            };
            assert_eq!(
                key_columns,
                vec![
                    (Some("project_id".to_string()), 0, "BINARY".to_string()),
                    (Some("type".to_string()), 0, "BINARY".to_string()),
                    (Some("name".to_string()), 0, "BINARY".to_string()),
                ],
                "{label} index must be rebuilt with the target key definition",
            );
            assert!(
                conn.execute(
                    "INSERT INTO assets VALUES ('asset-2', 'project-1', 'character', 'Hero')",
                    [],
                )
                .is_err(),
                "{label} index must reject an exact duplicate after migration",
            );
            if label == "nocase" {
                conn.execute(
                    "INSERT INTO assets VALUES ('asset-3', 'project-1', 'character', 'hero')",
                    [],
                )
                .expect("BINARY index must permit a case-distinct asset name");
            }
        }
    }
}
