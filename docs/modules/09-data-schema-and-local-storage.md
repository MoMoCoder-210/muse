# 模块 09：数据存储与本地文件布局

## 1. 模块职责

这个模块定义桌面端的 SQLite 表结构、JSON 字段规范、文件目录布局和路径管理规则。它的目标是让任何一份生成结果都能被数据库准确反查，让任何一条任务记录都能完整回放。

## 2. 设计原则

1. 数据库记录业务关系和任务状态，不保存二进制内容
2. 文件系统保存二进制媒体（图片、音频、视频），数据库只保存相对路径
3. 所有媒体路径统一保存工作区相对路径，运行时拼接为绝对路径
4. 所有任务的输入参数和输出结果都必须序列化为 JSON 落库
5. JSON 字段保存结构化参数，不混存自由文本

## 3. SQLite 表结构

数据库连接建立后、执行任何 CREATE TABLE 之前，必须先设置以下 PRAGMA：

```sql
-- 启用 WAL 模式，支持多进程并发读写（Tauri Rust 层和 Node worker 同时访问）
PRAGMA journal_mode = WAL;
-- 设置忙等待超时为 5 秒，减少 "database is locked" 错误
PRAGMA busy_timeout = 5000;
-- WAL checkpoint 策略：在每次事务提交后自动 checkpoint
PRAGMA wal_autocheckpoint = 1000;
```

### 3.1 `projects`

```sql
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  workspace_path  TEXT NOT NULL,
  input_mode      TEXT NOT NULL DEFAULT 'empty',      -- empty | script
  style_mode      TEXT NOT NULL DEFAULT 'RS',          -- RS | TS | ZH
  status          TEXT NOT NULL DEFAULT 'active',      -- active | archived | failed
  current_step    TEXT NOT NULL DEFAULT 'project',     -- 聚合值（取所有片段中最慢的步骤），实际步骤推进在 clips.current_step
  stop_step       TEXT,                                 -- asset | storyboard | voice | video | export（null 表示不停）
  auto_continue   INTEGER NOT NULL DEFAULT 0,
  cover_path      TEXT,
  default_image_param_json  TEXT,
  default_video_param_json  TEXT,
  default_voice_param_json  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.2 `script_sources`

```sql
CREATE TABLE script_sources (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  source_type        TEXT NOT NULL,            -- paste | txt | docx
  file_name          TEXT,
  raw_content        TEXT NOT NULL,
  normalized_content TEXT NOT NULL,
  split_status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | success | failed
  error_message      TEXT,
  retry_count        INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_script_sources_project ON script_sources(project_id);
```

### 3.3 `clips`

```sql
CREATE TABLE clips (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  source_id           TEXT REFERENCES script_sources(id),
  sort_index          INTEGER NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT DEFAULT '',
  source_text         TEXT NOT NULL,
  estimated_duration  REAL,                     -- 预估时长（秒）
  status              TEXT NOT NULL DEFAULT 'pending',
    -- pending | script_ready | asset_ready | storyboard_ready | media_ready | done | failed
  current_step        TEXT NOT NULL DEFAULT 'project',  -- 片段当前步骤：project | split | script | asset | storyboard | voice | video | export
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_clips_project_sort ON clips(project_id, sort_index);
```

### 3.4 `clip_scripts`

```sql
CREATE TABLE clip_scripts (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  clip_id          TEXT NOT NULL REFERENCES clips(id),
  source_text      TEXT NOT NULL,
  optimized_text   TEXT,
  script_summary   TEXT,
  raw_model_output TEXT,                       -- 模型原始响应，用于诊断
  extracted_resources_json TEXT,                     -- 模型抽取的候选资源（角色/场景/道具），JSON 格式，用户确认后转为 assets 表记录
  mode             TEXT,                        -- RS | TS | ZH
  stop_step        TEXT,                        -- asset | storyboard | voice | video | export
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | running | success | failed
  error_message    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_clip_scripts_clip ON clip_scripts(clip_id);
```

### 3.5 `assets`

```sql
CREATE TABLE assets (
  id                        TEXT PRIMARY KEY,
  project_id                TEXT NOT NULL REFERENCES projects(id),
  clip_id                   TEXT REFERENCES clips(id),
  type                      TEXT NOT NULL,    -- character | scene | item
  name                      TEXT NOT NULL,
  description               TEXT DEFAULT '',
  prompt                    TEXT DEFAULT '',
  reference_image_path      TEXT,
  generated_image_path      TEXT,
  generated_image_thumb_path TEXT,
  source                    TEXT NOT NULL DEFAULT 'model',  -- model | manual | imported
  status                    TEXT NOT NULL DEFAULT 'draft',
    -- draft | confirmed | image_pending | image_ready | failed
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_assets_project_type_name ON assets(project_id, type, name);
CREATE INDEX idx_assets_clip ON assets(clip_id);
```

### 3.6 `storyboards`

```sql
CREATE TABLE storyboards (
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
  character_ids_json    TEXT NOT NULL DEFAULT '[]',   -- JSON 数组（冗余字段，便于正向读取；反向查询走 storyboard_assets 关联表）
  scene_ids_json        TEXT NOT NULL DEFAULT '[]',   -- JSON 数组（冗余字段，便于正向读取；反向查询走 storyboard_assets 关联表）
  item_ids_json         TEXT NOT NULL DEFAULT '[]',   -- JSON 数组（冗余字段，便于正向读取；反向查询走 storyboard_assets 关联表）
  image_param_json      TEXT,
  video_param_json      TEXT,
  voice_param_json      TEXT,
  image_state           TEXT NOT NULL DEFAULT 'pending',  -- pending | running | ready | failed | invalidated
  voice_state           TEXT NOT NULL DEFAULT 'pending',
  video_state           TEXT NOT NULL DEFAULT 'pending',
  fused_image_path      TEXT,
  voice_path            TEXT,
  voice_duration        REAL,                     -- 语音时长（秒），用于视频和导出
  video_path            TEXT,
  video_duration        REAL,                     -- 视频时长（秒）
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_storyboards_clip_seq ON storyboards(clip_id, seq_num);
CREATE INDEX idx_storyboards_project ON storyboards(project_id);
```

### 3.10 `storyboard_assets`

```sql
-- 3.10 storyboard_assets（分镜-资产关联表）
-- 替代 storyboards 表中的 character_ids_json / scene_ids_json / item_ids_json 的反向查询
-- JSON 数组仍保留在 storyboards 表中作为冗余字段（便于正向读取），但反向查询走关联表
CREATE TABLE storyboard_assets (
  id            TEXT PRIMARY KEY,
  storyboard_id TEXT NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  asset_type    TEXT NOT NULL,               -- character | scene | item
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sa_asset ON storyboard_assets(asset_id);
CREATE INDEX idx_sa_storyboard ON storyboard_assets(storyboard_id);
CREATE UNIQUE INDEX idx_sa_unique ON storyboard_assets(storyboard_id, asset_id);
```

### 3.7 `tasks`

```sql
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  clip_id         TEXT REFERENCES clips(id),
  batch_id        TEXT,                        -- 批次 ID，批量操作时同一批次的所有任务共享此 ID
  storyboard_id   TEXT REFERENCES storyboards(id),
  asset_id        TEXT REFERENCES assets(id),
  type            TEXT NOT NULL,               -- 见模块 08 的 TaskType
  status          TEXT NOT NULL DEFAULT 'pending',  -- 见模块 08 的 TaskStatus
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

CREATE INDEX idx_tasks_status_type ON tasks(status, type);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_lock_key ON tasks(lock_key);
CREATE INDEX idx_tasks_batch ON tasks(batch_id);
```

### 3.8 `task_locks`

```sql
CREATE TABLE task_locks (
  lock_key   TEXT PRIMARY KEY,
  locked_by  TEXT NOT NULL,                   -- 持有锁的 taskId
  locked_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.9 `exports`

```sql
CREATE TABLE exports (
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

CREATE INDEX idx_exports_project ON exports(project_id);
```

### 3.11 SQLite 多进程访问规范

本应用存在两个进程同时访问同一个 SQLite 数据库文件的场景：

- **Tauri Rust 层**（前端 IPC 命令）：通过 rusqlite 访问 `project.sqlite`
- **Node worker**（任务执行）：通过 better-sqlite3 访问 `project.sqlite`

多进程并发访问规范：

1. **必须启用 WAL 模式**：WAL（Write-Ahead Logging）模式允许多读单写并发，是 SQLite 多进程访问的前提条件。两个进程连接数据库时都必须执行 `PRAGMA journal_mode = WAL;`。
2. **busy_timeout 设置为 5000ms**：当写冲突发生时，SQLite 会自动重试最多 5 秒，而非立即返回 "database is locked" 错误。两个进程都必须设置 `PRAGMA busy_timeout = 5000;`。
3. **Node worker（better-sqlite3）**：连接数据库时必须执行：
   ```js
   db.pragma('journal_mode = WAL');
   db.pragma('busy_timeout = 5000');
   ```
4. **Tauri Rust 层（rusqlite）**：连接数据库时必须执行：
   ```rust
   conn.pragma_update(None, "journal_mode", "WAL")?;
   conn.busy_timeout(Duration::from_secs(5))?;
   ```
5. **写操作应尽量短小**：长事务会阻塞其他进程的写入操作，导致 busy_timeout 超时。避免在事务中执行耗时的网络请求或文件 I/O。
6. **task_locks 表的逻辑锁是应用层防重**：`task_locks` 表用于防止同一任务被重复提交，是应用层的防重机制，不替代 WAL 模式在数据库层提供的并发控制。两者分工不同，缺一不可。

## 4. JSON 字段规范

JSON 字段统一保存结构化参数，不要混存自由文本。所有 JSON 字段在写入前必须校验 schema。

### 4.1 `image_param_json`

```ts
type ImageParam = {
  model: string;           // 火山引擎图像模型标识
  resolution: string;      // 如 "1024x1024"
  quality: string;         // 如 "2K" | "4K"
  amount: number;          // 生成数量
  seed?: number;           // 随机种子
  aspectRatio?: string;    // 如 "16:9" | "9:16" | "1:1"
};
```

### 4.2 `video_param_json`

```ts
type VideoParam = {
  model: string;           // 火山引擎视频模型标识
  duration: number;        // 视频时长（秒）
  resolution: string;      // 如 "1080p"
  aspectRatio: string;     // 如 "16:9" | "9:16"
  fps?: number;            // 帧率，默认 30
  amount?: number;         // 生成数量，默认 1
  mode: 'image_to_video' | 'reference_image_to_video';
};
```

### 4.3 `voice_param_json`

```ts
type VoiceParam = {
  provider: 'volcano';
  voiceId: string;         // 火山引擎语音角色 ID
  speedRate?: number;      // 语速，默认 1.0
  volume?: number;         // 音量，默认 100
  pitch?: number;          // 音调，默认 100
  emotion?: string;        // 情感标签
  language?: string;       // 语言代码
};
```

### 4.4 `character_ids_json` / `scene_ids_json` / `item_ids_json`

```ts
// 存储格式：JSON 数组，每个元素是 Asset.id
// 示例：["asset-001", "asset-002"]
type AssetIds = string[];
```

### 4.5 `task.input_json` 和 `task.output_json`

根据 `task.type` 不同，内容结构不同。每种任务类型的输入输出 schema 在对应模块文档中定义。

## 5. 文件路径规则

### 5.1 路径存储

数据库里统一保存工作区相对路径，运行时通过 path helper 拼接为绝对路径。

相对路径示例：

```text
assets/characters/asset-001-main.png
assets/characters/thumbs/asset-001.jpg
assets/scenes/asset-002-city.png
assets/items/asset-003-sword.png
storyboards/final/sb-001.png
storyboards/draft/sb-001-draft.png
audio/sb-001.mp3
video/sb-001.mp4
exports/final-20260629.mp4
source/scripts/input.txt
```

### 5.2 文件命名规则

```text
assets/{type}/{assetId}-{slug}.png        # 原图
assets/{type}/thumbs/{assetId}.jpg        # 缩略图
storyboards/final/{storyboardId}.png      # 融合图
audio/{storyboardId}.mp3                  # 语音
video/{storyboardId}.mp4                  # 视频
exports/{projectName}-{yyyyMMdd}.mp4      # 导出成片
```

`slug` 是资产名称的 URL 友好格式（小写、连字符分隔、限 20 字符）。

### 5.3 path helper 接口

```ts
interface PathHelper {
  // 获取工作区根路径
  getWorkspacePath(projectId: string): string;

  // 相对路径 → 绝对路径
  toAbsolute(projectId: string, relativePath: string): string;

  // 绝对路径 → 相对路径
  toRelative(projectId: string, absolutePath: string): string;

  // 获取各类资源目录
  getAssetsDir(projectId: string, type: 'characters' | 'scenes' | 'items'): string;
  getStoryboardsDir(projectId: string, sub: 'draft' | 'final'): string;
  getAudioDir(projectId: string): string;
  getVideoDir(projectId: string): string;
  getExportsDir(projectId: string): string;
  getSourceDir(projectId: string): string;
  getLogsDir(projectId: string): string;
  getCacheDir(projectId: string): string;

  // 确保目录存在
  ensureDir(path: string): Promise<void>;

  // 检查文件是否存在
  exists(path: string): Promise<boolean>;
}
```

### 5.4 文件存在性检查

在以下场景必须检查文件存在性：

- 读取分镜融合图、语音、视频前
- 导出前检查所有分镜视频文件
- 资产编辑时检查参考图
- 项目恢复时检查所有媒体文件

```ts
interface FileChecker {
  // 检查单个文件
  checkFile(relativePath: string): Promise<boolean>;

  // 批量检查分镜所需文件
  checkStoryboardAssets(storyboardId: string): Promise<{
    fusedImage: boolean;
    voice: boolean;
    video: boolean;
  }>;

  // 批量检查项目导出所需文件
  checkProjectExportReadiness(projectId: string): Promise<{
    ready: boolean;
    missing: Array<{ storyboardId: string; missingType: 'video' | 'voice' | 'image' }>;
  }>;
}
```

## 6. Migration 机制

### 6.1 版本管理

SQLite 数据库文件包含一个 `schema_version` 表：

```sql
CREATE TABLE schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 6.2 Migration 文件

每个 migration 是一个 SQL 文件，放在应用的 resources 目录：

```text
migrations/
  001_initial.sql       # 初始建表
  002_add_stop_step.sql # 新增 stop_step 字段
  003_add_voice_duration.sql
  ...
```

### 6.3 执行逻辑

应用启动时：

```ts
async function runMigrations(db: Database): Promise<void> {
  const currentVersion = await getSchemaVersion(db);

  // 读取 migrations 目录，按版本号排序
  const migrations = readMigrationFiles().sort((a, b) => a.version - b.version);

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_version (version) VALUES (?)', migration.version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
```

## 7. 索引建议

除前文各表已定义的索引外，建议补充以下索引：

```sql
-- 按项目查询所有分镜
CREATE INDEX idx_storyboards_project ON storyboards(project_id);

-- 按状态查询待处理任务
CREATE INDEX idx_tasks_status_type ON tasks(status, type);

-- 按资产查询关联分镜（用于失效标记）
-- 已通过 storyboard_assets 关联表实现高效反向查询，无需全表扫描 JSON 数组。
CREATE INDEX idx_assets_project_type ON assets(project_id, type);

-- 按项目查询导出记录
CREATE INDEX idx_exports_project ON exports(project_id);

-- 按锁键查询（防重复执行）
CREATE INDEX idx_tasks_lock_key ON tasks(lock_key);
```

## 8. 工作区目录结构

项目创建时必须立刻创建以下目录：

```text
workspace/
  project.sqlite              # SQLite 数据库文件
  manifest.json               # 项目清单
  source/
    scripts/                  # 原始剧本文件
  clips/                      # 片段相关临时文件
  assets/
    characters/               # 角色资产图
      thumbs/                 # 角色缩略图
    scenes/                   # 场景资产图
      thumbs/
    items/                    # 物品资产图
      thumbs/
  storyboards/
    draft/                    # 分镜草稿图
    final/                    # 分镜融合图
  audio/                      # 语音文件
  video/                      # 视频片段
  exports/                    # 导出成片
  logs/
    tasks/                    # 任务日志 {taskId}.log
  cache/                      # 临时缓存（下载中转等）
```

### manifest.json 结构

```json
{
  "projectId": "uuid",
  "projectName": "项目名称",
  "workspaceVersion": 1,
  "schemaVersion": 1,
  "createdAt": "2026-06-29T10:00:00",
  "updatedAt": "2026-06-29T10:00:00",
  "defaultInputMode": "script",
  "defaultStyleMode": "RS"
}
```

**manifest.json 的角色定位：**

manifest.json 是引导元数据（bootstrap metadata），仅用于：
1. 应用启动时发现工作区目录（扫描子目录中的 manifest.json）
2. 记录 workspaceVersion 和 schemaVersion 用于版本兼容性检查
3. 记录 projectId 用于关联 project.sqlite

manifest.json 不是运行时数据的权威来源。所有运行时元数据（项目名称、步骤、参数等）以 project.sqlite 的 projects 表为准。如果 manifest.json 与 project.sqlite 不一致，以 project.sqlite 为准。

更新项目设置时（updateProjectSettings），只更新 project.sqlite，不同步 manifest.json。manifest.json 在项目创建时写入后不再修改（除 schemaVersion 升级外）。

## 9. 最低落地清单

1. 全部 SQLite DDL（9 张表 + 索引）
2. `schema_version` 表和 migration 执行逻辑
3. `PathHelper` 接口实现
4. JSON 参数序列化器（写入前校验 schema）
5. `FileChecker` 接口实现
6. 工作区目录创建逻辑
7. `manifest.json` 读写逻辑
