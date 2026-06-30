-- 001_initial.sql
-- 初始建表脚本 - 基于模块 09 数据存储与本地文件布局
-- 包含 9 张业务表 + schema_version 表 + 索引

-- schema_version 表（Migration 机制）
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 1. projects 项目表
CREATE TABLE IF NOT EXISTS projects (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  description               TEXT DEFAULT '',
  workspace_path            TEXT NOT NULL,
  input_mode                TEXT NOT NULL DEFAULT 'empty',      -- empty | script
  style_mode                TEXT NOT NULL DEFAULT 'RS',          -- RS | TS | ZH
  status                    TEXT NOT NULL DEFAULT 'active',      -- active | archived | failed
  current_step              TEXT NOT NULL DEFAULT 'project',     -- 聚合值（取所有片段中最慢的步骤）
  stop_step                 TEXT,                                -- asset | storyboard | voice | video | export
  auto_continue             INTEGER NOT NULL DEFAULT 0,
  cover_path                TEXT,
  default_image_param_json  TEXT,
  default_video_param_json  TEXT,
  default_voice_param_json  TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. script_sources 剧本来源表
CREATE TABLE IF NOT EXISTS script_sources (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id),
  source_type          TEXT NOT NULL,            -- paste | txt | docx
  file_name            TEXT,
  raw_content          TEXT NOT NULL,
  normalized_content   TEXT NOT NULL,
  split_status         TEXT NOT NULL DEFAULT 'pending',  -- pending | running | success | failed
  error_message        TEXT,
  retry_count          INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_script_sources_project ON script_sources(project_id);

-- 3. clips 片段表
CREATE TABLE IF NOT EXISTS clips (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  source_id           TEXT REFERENCES script_sources(id),
  sort_index          INTEGER NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT DEFAULT '',
  source_text         TEXT NOT NULL,
  estimated_duration  REAL,
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | script_ready | asset_ready | storyboard_ready | media_ready | done | failed
  current_step        TEXT NOT NULL DEFAULT 'project',  -- project | split | script | asset | storyboard | voice | video | export
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clips_project_sort ON clips(project_id, sort_index);

-- 4. clip_scripts 片段剧本表
CREATE TABLE IF NOT EXISTS clip_scripts (
  id                        TEXT PRIMARY KEY,
  project_id                TEXT NOT NULL REFERENCES projects(id),
  clip_id                   TEXT NOT NULL REFERENCES clips(id),
  source_text               TEXT NOT NULL,
  optimized_text            TEXT,
  script_summary            TEXT,
  raw_model_output          TEXT,
  extracted_resources_json  TEXT,                -- 模型抽取的候选资源（角色/场景/道具）
  mode                      TEXT,                -- RS | TS | ZH
  stop_step                 TEXT,                -- asset | storyboard | voice | video | export
  status                    TEXT NOT NULL DEFAULT 'pending',  -- pending | running | success | failed
  error_message             TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clip_scripts_clip ON clip_scripts(clip_id);

-- 5. assets 资产表
CREATE TABLE IF NOT EXISTS assets (
  id                         TEXT PRIMARY KEY,
  project_id                 TEXT NOT NULL REFERENCES projects(id),
  clip_id                    TEXT REFERENCES clips(id),
  type                       TEXT NOT NULL,    -- character | scene | item
  name                       TEXT NOT NULL,
  description                TEXT DEFAULT '',
  prompt                     TEXT DEFAULT '',
  reference_image_path       TEXT,
  generated_image_path       TEXT,
  generated_image_thumb_path TEXT,
  source                     TEXT NOT NULL DEFAULT 'model',  -- model | manual | imported
  status                     TEXT NOT NULL DEFAULT 'draft',  -- draft | confirmed | image_pending | image_ready | failed
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_project_type_name ON assets(project_id, type, name);
CREATE INDEX IF NOT EXISTS idx_assets_clip ON assets(clip_id);

-- 6. storyboards 分镜表
CREATE TABLE IF NOT EXISTS storyboards (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  clip_id               TEXT NOT NULL REFERENCES clips(id),
  seq_num               INTEGER NOT NULL,
  source_text           TEXT,
  summary               TEXT,
  dialogue              TEXT,
  visual_description    TEXT NOT NULL DEFAULT '',
  image_prompt          TEXT DEFAULT '',
  video_prompt          TEXT DEFAULT '',
  character_ids_json    TEXT NOT NULL DEFAULT '[]',
  scene_ids_json        TEXT NOT NULL DEFAULT '[]',
  item_ids_json         TEXT NOT NULL DEFAULT '[]',
  image_param_json      TEXT,
  video_param_json      TEXT,
  voice_param_json      TEXT,
  image_state           TEXT NOT NULL DEFAULT 'pending',  -- pending | running | ready | failed | invalidated
  voice_state           TEXT NOT NULL DEFAULT 'pending',
  video_state           TEXT NOT NULL DEFAULT 'pending',
  fused_image_path      TEXT,
  voice_path            TEXT,
  voice_duration        REAL,
  video_path            TEXT,
  video_duration        REAL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_storyboards_clip_seq ON storyboards(clip_id, seq_num);
CREATE INDEX IF NOT EXISTS idx_storyboards_project ON storyboards(project_id);

-- 7. storyboard_assets 分镜-资产关联表
CREATE TABLE IF NOT EXISTS storyboard_assets (
  id            TEXT PRIMARY KEY,
  storyboard_id TEXT NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  asset_type    TEXT NOT NULL,               -- character | scene | item
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sa_asset ON storyboard_assets(asset_id);
CREATE INDEX IF NOT EXISTS idx_sa_storyboard ON storyboard_assets(storyboard_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sa_unique ON storyboard_assets(storyboard_id, asset_id);

-- 8. tasks 任务表
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  clip_id         TEXT REFERENCES clips(id),
  batch_id        TEXT,
  storyboard_id   TEXT REFERENCES storyboards(id),
  asset_id        TEXT REFERENCES assets(id),
  type            TEXT NOT NULL,               -- split_script | generate_script | generate_asset_image | ...
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | running | waiting_remote | downloading | success | failed | invalidated
  lock_key        TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  output_json     TEXT,
  remote_task_id  TEXT,
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retry       INTEGER NOT NULL DEFAULT 3,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_type ON tasks(status, type);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_lock_key ON tasks(lock_key);
CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id);

-- 9. task_locks 逻辑锁表
CREATE TABLE IF NOT EXISTS task_locks (
  lock_key   TEXT PRIMARY KEY,
  locked_by  TEXT NOT NULL,                   -- 持有锁的 taskId
  locked_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 10. exports 导出记录表
CREATE TABLE IF NOT EXISTS exports (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  output_path   TEXT NOT NULL,
  format        TEXT NOT NULL DEFAULT 'mp4',
  resolution    TEXT NOT NULL DEFAULT '1080p',
  fps           INTEGER NOT NULL DEFAULT 30,
  with_subtitle INTEGER NOT NULL DEFAULT 0,
  with_bgm      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | running | success | failed
  error_message TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_exports_project ON exports(project_id);

-- 记录 migration 版本
INSERT INTO schema_version (version) VALUES (1);
