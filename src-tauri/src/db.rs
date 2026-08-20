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
