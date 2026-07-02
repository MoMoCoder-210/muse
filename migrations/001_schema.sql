-- ============================================================================
-- Muse 数据库建表脚本
-- 版本: 1
-- 描述: 全量建表，包含 10 张业务表。IF NOT EXISTS 保证可重复执行
-- ============================================================================

-- ============================================================================
-- 1. projects — 项目主表
-- ============================================================================

CREATE TABLE IF NOT EXISTS projects (
    id                        TEXT PRIMARY KEY,
    name                      TEXT NOT NULL,
    description               TEXT NOT NULL DEFAULT '',
    workspace_path            TEXT NOT NULL,
    -- empty | script | manual
    input_mode                TEXT NOT NULL DEFAULT 'empty',
    -- 国漫 | 动漫 | 日漫 | 韩漫 | 二次元 | 真人
    style_mode                TEXT NOT NULL DEFAULT '国漫',
    -- active | archived | failed
    status                    TEXT NOT NULL DEFAULT 'active',
    -- 聚合值（所有片段中最慢的步骤）
    current_step              TEXT NOT NULL DEFAULT 'project',
    -- asset | storyboard | voice | video | export
    stop_step                 TEXT,
    auto_continue             INTEGER NOT NULL DEFAULT 0,
    cover_path                TEXT,
    default_image_param_json  TEXT,
    default_video_param_json  TEXT,
    default_voice_param_json  TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ============================================================================
-- 2. script_sources — 剧本来源
-- ============================================================================

CREATE TABLE IF NOT EXISTS script_sources (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects(id),
    -- paste | txt | docx
    source_type        TEXT NOT NULL,
    file_name          TEXT,
    raw_content        TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    -- pending | running | success | failed
    split_status       TEXT NOT NULL DEFAULT 'pending',
    error_message      TEXT,
    retry_count        INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_script_sources_project
    ON script_sources(project_id);


-- ============================================================================
-- 3. clips — 片段
-- ============================================================================

CREATE TABLE IF NOT EXISTS clips (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects(id),
    source_id          TEXT REFERENCES script_sources(id),
    sort_index         INTEGER NOT NULL,
    title              TEXT NOT NULL,
    summary            TEXT NOT NULL DEFAULT '',
    source_text        TEXT NOT NULL,
    estimated_duration REAL,
    -- pending | script_ready | asset_ready | storyboard_ready | media_ready | done | failed
    status             TEXT NOT NULL DEFAULT 'pending',
    -- project | split | script | asset | storyboard | voice | video | export
    current_step       TEXT NOT NULL DEFAULT 'project',
    -- 软删除标记（NULL = 未删除）
    deleted_at         TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clips_project_sort
    ON clips(project_id, sort_index);

-- 部分索引：仅覆盖未删除片段
CREATE INDEX IF NOT EXISTS idx_clips_project_alive
    ON clips(project_id, sort_index)
    WHERE deleted_at IS NULL;


-- ============================================================================
-- 4. clip_scripts — 片段剧本（模型分析结果）
-- ============================================================================

CREATE TABLE IF NOT EXISTS clip_scripts (
    id                       TEXT PRIMARY KEY,
    project_id               TEXT NOT NULL REFERENCES projects(id),
    clip_id                  TEXT NOT NULL REFERENCES clips(id),
    source_text              TEXT NOT NULL,
    optimized_text           TEXT,
    script_summary           TEXT,
    raw_model_output         TEXT,
    -- 模型抽取的候选资源 JSON（角色 / 场景 / 道具）
    extracted_resources_json TEXT,
    -- RS | TS | ZH
    mode                     TEXT,
    -- asset | storyboard | voice | video | export
    stop_step                TEXT,
    -- pending | running | success | failed
    status                   TEXT NOT NULL DEFAULT 'pending',
    error_message            TEXT,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clip_scripts_clip
    ON clip_scripts(clip_id);


-- ============================================================================
-- 5. assets — 资产（角色 / 场景 / 道具）
-- ============================================================================

CREATE TABLE IF NOT EXISTS assets (
    id                         TEXT PRIMARY KEY,
    project_id                 TEXT NOT NULL REFERENCES projects(id),
    clip_id                    TEXT REFERENCES clips(id),
    -- character | scene | item
    type                       TEXT NOT NULL,
    name                       TEXT NOT NULL,
    description                TEXT NOT NULL DEFAULT '',
    prompt                     TEXT NOT NULL DEFAULT '',
    reference_image_path       TEXT,
    generated_image_path       TEXT,
    generated_image_thumb_path TEXT,
    -- model | manual | imported
    source                     TEXT NOT NULL DEFAULT 'model',
    -- draft | confirmed | image_pending | image_ready | failed
    status                     TEXT NOT NULL DEFAULT 'draft',
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_project_type_name
    ON assets(project_id, type, name);

CREATE INDEX IF NOT EXISTS idx_assets_clip
    ON assets(clip_id);


-- ============================================================================
-- 6. storyboards — 分镜
-- ============================================================================

CREATE TABLE IF NOT EXISTS storyboards (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects(id),
    clip_id            TEXT NOT NULL REFERENCES clips(id),
    seq_num            INTEGER NOT NULL,
    source_text        TEXT,
    summary            TEXT,
    dialogue           TEXT,
    visual_description TEXT NOT NULL DEFAULT '',
    image_prompt       TEXT NOT NULL DEFAULT '',
    video_prompt       TEXT NOT NULL DEFAULT '',
    character_ids_json TEXT NOT NULL DEFAULT '[]',
    scene_ids_json     TEXT NOT NULL DEFAULT '[]',
    item_ids_json      TEXT NOT NULL DEFAULT '[]',
    image_param_json   TEXT,
    video_param_json   TEXT,
    voice_param_json   TEXT,
    -- pending | running | ready | failed | invalidated
    image_state        TEXT NOT NULL DEFAULT 'pending',
    voice_state        TEXT NOT NULL DEFAULT 'pending',
    video_state        TEXT NOT NULL DEFAULT 'pending',
    fused_image_path   TEXT,
    voice_path         TEXT,
    voice_duration     REAL,
    video_path         TEXT,
    video_duration     REAL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_storyboards_clip_seq
    ON storyboards(clip_id, seq_num);

CREATE INDEX IF NOT EXISTS idx_storyboards_project
    ON storyboards(project_id);


-- ============================================================================
-- 7. storyboard_assets — 分镜-资产关联
-- ============================================================================

CREATE TABLE IF NOT EXISTS storyboard_assets (
    id            TEXT PRIMARY KEY,
    storyboard_id TEXT NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
    asset_id      TEXT NOT NULL REFERENCES assets(id),
    -- character | scene | item
    asset_type    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sa_asset
    ON storyboard_assets(asset_id);

CREATE INDEX IF NOT EXISTS idx_sa_storyboard
    ON storyboard_assets(storyboard_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sa_unique
    ON storyboard_assets(storyboard_id, asset_id);


-- ============================================================================
-- 8. tasks — 异步任务
-- ============================================================================

CREATE TABLE IF NOT EXISTS tasks (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id),
    clip_id        TEXT REFERENCES clips(id),
    batch_id       TEXT,
    storyboard_id  TEXT REFERENCES storyboards(id),
    asset_id       TEXT REFERENCES assets(id),
    -- split_script | generate_script | generate_asset_image | ...
    type           TEXT NOT NULL,
    -- pending | running | waiting_remote | downloading | success | failed | invalidated
    status         TEXT NOT NULL DEFAULT 'pending',
    lock_key       TEXT NOT NULL,
    input_json     TEXT NOT NULL,
    output_json    TEXT,
    remote_task_id TEXT,
    error_message  TEXT,
    retry_count    INTEGER NOT NULL DEFAULT 0,
    max_retry      INTEGER NOT NULL DEFAULT 3,
    started_at     TEXT,
    finished_at    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_type
    ON tasks(status, type);

CREATE INDEX IF NOT EXISTS idx_tasks_project
    ON tasks(project_id);

CREATE INDEX IF NOT EXISTS idx_tasks_lock_key
    ON tasks(lock_key);

CREATE INDEX IF NOT EXISTS idx_tasks_batch
    ON tasks(batch_id);


-- ============================================================================
-- 9. task_locks — 任务逻辑锁
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_locks (
    lock_key  TEXT PRIMARY KEY,
    -- 持有锁的 task_id
    locked_by TEXT NOT NULL,
    locked_at TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ============================================================================
-- 10. exports — 导出记录
-- ============================================================================

CREATE TABLE IF NOT EXISTS exports (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id),
    output_path   TEXT NOT NULL,
    format        TEXT NOT NULL DEFAULT 'mp4',
    resolution    TEXT NOT NULL DEFAULT '1080p',
    fps           INTEGER NOT NULL DEFAULT 30,
    with_subtitle INTEGER NOT NULL DEFAULT 0,
    with_bgm      INTEGER NOT NULL DEFAULT 0,
    -- pending | running | success | failed
    status        TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_exports_project
    ON exports(project_id);
