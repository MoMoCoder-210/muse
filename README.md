# Muse

本地优先的桌面视频创作工具。从剧本导入到完整视频产出，保留完整主链路，模型能力只接入火山引擎系。

基于 `Tauri 2 + React 18 + Rust + SQLite + Node.js sidecar` 构建。

---

## 目录

- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [运行与构建](#运行与构建)
- [当前实现状态](#当前实现状态)
- [项目规范](#项目规范)

---

## 技术栈

| 层次 | 技术 | 版本 | 说明 |
|---|---|---|---|
| 桌面壳 | Tauri | 2.x | 跨平台桌面框架，负责窗口、IPC、原生 API |
| 前端 | React + TypeScript + Vite | 18 / 5.7 / 6.x | UI 渲染，通过 `@tauri-apps/api` 调用后端命令 |
| 后端 | Rust | edition 2021 / msrv 1.77 | 处理文件系统、数据库初始化、进程管理 |
| 本地数据库 | SQLite (rusqlite bundled) | 0.32 | WAL 模式，支持 Rust 层和 Node worker 多进程并发访问 |
| 后台任务 | Node.js sidecar | 22.x | 独立进程，通过 stdio JSON line 协议与 Rust 层通信，负责所有 API 调用和任务调度 |
| 状态管理 | Zustand + TanStack Query | 5.x | 本地 UI 状态 + 服务端数据缓存 |

---

## 项目结构

```
Muse/
├── src/                        # React 前端
│   ├── App.tsx                 # 应用根组件，包含所有页面和弹窗逻辑
│   ├── main.tsx                # 入口文件，初始化 React 和主题
│   ├── styles.css              # 全局样式，所有视觉参数通过 CSS 变量引用
│   ├── vite-env.d.ts           # Vite 环境类型声明
│   └── config/
│       ├── muse.ts             # 业务配置常量（应用名、创建模式、创作风格、工作流步骤）
│       └── theme.ts            # 主题配置中心，定义所有设计 token，支持多主题切换
│
├── src-tauri/                  # Tauri + Rust 后端
│   ├── src/
│   │   ├── main.rs             # 二进制入口，仅调用 lib.rs 的 run()
│   │   ├── lib.rs              # Tauri 应用初始化，注册插件、命令和状态
│   │   ├── commands.rs         # 所有 Tauri command 实现（项目 CRUD、worker 控制）
│   │   ├── db.rs               # SQLite 连接初始化、WAL 配置、迁移执行
│   │   ├── sidecar.rs          # Node worker 进程生命周期管理（启动、心跳、重启、关闭）
│   │   └── app_paths.rs        # 应用数据目录解析、项目目录默认路径、目录名净化
│   ├── capabilities/
│   │   └── default.json        # Tauri 权限配置，声明前端可调用的 API 范围
│   ├── icons/                  # 各平台应用图标（Windows / macOS / iOS / Android）
│   ├── gen/schemas/            # Tauri CLI 自动生成的 ACL schema，不手动修改
│   ├── Cargo.toml              # Rust 依赖声明
│   ├── Cargo.lock              # Rust 依赖锁定文件，提交到版本控制
│   ├── build.rs                # Tauri 构建脚本
│   └── tauri.conf.json         # Tauri 应用配置（窗口、CSP、打包资源、图标）
│
├── worker/                     # Node.js sidecar（独立 npm workspace）
│   ├── src/
│   │   ├── index.ts            # Worker 入口，stdio 通信主循环，心跳定时器，命令分发
│   │   ├── task-runner.ts      # 任务执行核心循环（pending 轮询、锁竞争、handler 分发）
│   │   ├── db.ts               # SQLite 操作函数集（任务状态流转、逻辑锁、崩溃恢复）
│   │   ├── rate-limiter.ts     # Token Bucket 限流器（按 API 类型独立维护，支持退避和暂停）
│   │   └── types.ts            # 共享类型定义（TaskType、TaskStatus、ApiType、通信协议）
│   ├── dist/                   # TypeScript 编译输出，被 Tauri 打包进应用
│   ├── package.json            # Worker 依赖（better-sqlite3、zod）
│   └── tsconfig.json           # Worker TypeScript 配置
│
├── migrations/
│   └── 001_initial.sql         # 初始建表脚本，包含 10 张业务表 + 索引
│
├── docs/
│   ├── README.md               # 文档总入口，说明当前实现状态和架构
│   └── modules/                # 各功能模块的详细设计文档
│       ├── README.md           # 模块索引
│       ├── 01-project-and-workspace.md
│       ├── 02-script-import-and-clip-splitting.md
│       ├── 03-script-generation-and-resource-extraction.md
│       ├── 04-asset-management-and-image-generation.md
│       ├── 05-storyboard-generation-and-editing.md
│       ├── 06-voice-generation.md
│       ├── 07-video-generation-and-export.md
│       ├── 08-task-runtime-state-and-recovery.md
│       ├── 09-data-schema-and-local-storage.md
│       └── 10-desktop-ui-workbench.md
│
├── dist/                       # Vite 前端构建输出，不提交到版本控制
├── index.html                  # Vite 入口 HTML
├── vite.config.ts              # Vite 配置（路径别名、开发服务器端口、构建目标）
├── tsconfig.json               # 前端 TypeScript 配置（src/）
├── tsconfig.node.json          # Vite 配置文件的 TypeScript 配置
├── package.json                # 根 package，定义 npm workspace 和所有常用脚本
├── package-lock.json           # 依赖锁定文件，提交到版本控制
├── app-icon.png                # 应用图标源文件
└── .gitignore
```

### 数据目录（运行时生成，不在仓库中）

```
%APPDATA%\muse\                 # 应用级数据目录（Windows）
├── project-registry.json       # 项目注册表，记录所有项目 ID 和工作区路径
└── migrations/                 # 可选的运行时迁移文件覆盖目录

D:\projects\<项目名>-<短ID>\    # 项目工作区（默认路径，可在创建时修改）
├── project.sqlite              # 项目数据库
├── manifest.json               # 项目元信息（ID、版本、创建时间、默认参数）
├── source/scripts/             # 原始剧本文件
├── clips/                      # 片段相关文件
├── assets/
│   ├── characters/thumbs/      # 角色图缩略图
│   ├── scenes/thumbs/          # 场景图缩略图
│   └── items/thumbs/           # 道具图缩略图
├── storyboards/
│   ├── draft/                  # 分镜草稿
│   └── final/                  # 最终分镜
├── audio/                      # 语音文件
├── video/                      # 视频片段
├── exports/                    # 导出成片
├── logs/tasks/                 # 任务日志
└── cache/                      # 临时缓存
```

---

## 运行与构建

### 环境要求

- Node.js 22+
- Rust 1.77+（通过 `rustup` 安装）
- Tauri CLI（通过 `npm` 安装，见下方步骤）

### 首次启动

```bash
# 安装前端依赖
npm install

# 安装 worker 依赖
npm install -w worker

# 编译 worker（Tauri 打包时需要 worker/dist 存在）
npm run worker:build

# 启动开发模式
npm run tauri:dev
```

### 常用命令

| 命令 | 说明 |
|---|---|
| `npm run tauri:dev` | 启动完整开发环境（同时启动 Vite dev server 和 Tauri） |
| `npm run tauri:build` | 构建生产包 |
| `npm run dev` | 仅启动 Vite dev server（不启动 Tauri 壳） |
| `npm run build` | 仅构建前端 |
| `npm run worker:dev` | Worker 开发模式（tsx watch，热重载） |
| `npm run worker:build` | 编译 Worker TypeScript → dist/ |

### 开发服务器

Vite dev server 固定运行在 `http://127.0.0.1:1420`，Tauri 的 `devUrl` 指向此地址。端口不可更改（`strictPort: true`），若被占用需手动释放。

---

## 当前实现状态

### 已完成

- Tauri 应用启动，窗口标题 `Muse`，尺寸 1280×800，最小 900×600
- 首页：动态粒子背景、品牌展示、快捷入口
- 项目管理页：左侧项目列表、右侧工作区预览、工作流步骤看板
- 创建项目弹窗：项目名、工作区目录（含文件夹选择器）、创建模式、创作风格
- 项目创建完整流程：生成 UUID、创建工作区目录树、初始化数据库、执行迁移、写入项目注册表、生成 manifest.json
- 项目列表读取与展示
- Node worker 通信框架：启动/关闭、stdio 协议、心跳监控
- 限流器框架：Token Bucket，按 API 类型独立配置
- 任务状态机框架：pending → running → success/failed/waiting_remote

### 当前暴露的 Tauri Command

| Command | 说明 |
|---|---|
| `get_app_version` | 返回应用版本号 |
| `create_project` | 创建项目，初始化工作区和数据库 |
| `get_project` | 按 ID 查询单个项目信息 |
| `list_projects` | 读取注册表并返回所有项目列表 |
| `start_worker` | 启动 Node sidecar worker |
| `stop_worker` | 优雅关闭 worker（30s 超时） |

### 未实现（设计文档已完备）

剧本导入、片段拆分、资产提取与生图、分镜生成与编辑、融合图生成、语音生成、视频生成、导出链路、任务事件 UI、火山引擎 API 接入。

---

## 项目规范

### 通用原则

- **本地优先**：所有数据默认存储在用户本机，不依赖云端服务器。模型 API 调用由 Node worker 发出，结果落地到本地数据库和文件系统。
- **单一数据源**：每个项目有且只有一个 `project.sqlite`，所有业务数据（剧本、片段、分镜、任务）都在其中，不使用多个数据库文件分散存储。
- **任务驱动**：所有耗时操作（生图、生语音、生视频等）必须通过 `tasks` 表走任务队列，不直接在 Tauri command 或 React 中执行异步 API 调用。

---

### 目录与文件规范

**前端（`src/`）**

- 页面级组件放在 `src/` 根目录，细粒度可复用组件后续放 `src/components/`。
- 业务配置常量放 `src/config/muse.ts`，主题设计 token 放 `src/config/theme.ts`，不在组件内硬编码颜色、字号或间距。
- 路径别名：`@/` 指向 `src/`，在导入中优先使用别名而非相对路径。
- 样式全部写在 `src/styles.css`，CSS 变量在 `:root` 中声明，组件内不写内联 `style`（canvas 动画除外）。

**Rust（`src-tauri/src/`）**

- 每个 `.rs` 文件职责单一，不跨职责混写（commands 只写命令，db 只写数据库，sidecar 只写进程管理）。
- 所有 Tauri command 返回 `Result<T, String>`，错误统一用 `.map_err(|e| e.to_string())` 转换。
- 不在 command 层直接 `unwrap()`，所有可能失败的操作必须传播错误。
- 数据库连接用完即关，不在全局状态中持久化单个项目的连接。

**Node Worker（`worker/src/`）**

- Worker 与 Tauri 主进程只通过 **stdio JSON line 协议**通信，格式见 `types.ts` 中的 `WorkerCommand` / `WorkerMessage`。
- 所有输出通过 `sendMessage()` 发往 stdout，禁止直接 `console.log()`（会污染协议通道）。
- 数据库操作统一通过 `db.ts` 中的函数访问，不在 `task-runner.ts` 或 `index.ts` 中内联 SQL。
- 任务 handler 注册到 `TaskRunner`，通过 `registerHandler(taskType, handler)` 接入，不修改核心循环逻辑。

**数据库迁移（`migrations/`）**

- 迁移文件命名：`<三位序号>_<描述>.sql`，例如 `002_add_clips_index.sql`。
- 每个迁移文件幂等（使用 `CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`）。
- 迁移只增不改：不修改已上线的迁移文件，需要变更表结构时新增迁移文件。

---

### 通信协议规范

Worker 与 Rust 层通过 stdin/stdout 交换 JSON line（每条消息一行，`\n` 结尾）。

**协议版本**：当前为 `1`，所有消息必须携带 `"version": 1` 字段。版本不匹配时 worker 记录错误日志并丢弃该消息。

**Rust → Worker（stdin）**

```jsonc
{ "version": 1, "cmd": "enqueue",  "taskId": "uuid" }
{ "version": 1, "cmd": "cancel",   "taskId": "uuid" }
{ "version": 1, "cmd": "shutdown", "timeoutMs": 30000 }
{ "version": 1, "cmd": "ping" }
```

**Worker → Rust（stdout）**

```jsonc
{ "version": 1, "msg": "ready",        "workerId": "uuid", "protocolVersion": 1 }
{ "version": 1, "msg": "heartbeat",    "workerId": "uuid", "activeTasks": 2 }
{ "version": 1, "msg": "task_event",   "event": { "type": "task_started", ... } }
{ "version": 1, "msg": "shutting_down","pendingTasks": 0 }
{ "version": 1, "msg": "log",          "level": "info", "message": "..." }
{ "version": 1, "msg": "error",        "message": "...", "stack": "..." }
```

---

### 数据库规范

- **WAL 模式**：所有数据库连接必须启用 `journal_mode = WAL`，`busy_timeout = 5000ms`，`foreign_keys = ON`。
- **逻辑锁**：任务执行前必须通过 `task_locks` 表获取逻辑锁（`INSERT OR FAIL`），执行完成后立即释放。worker 崩溃重启时清理本 worker 持有的全部锁。
- **任务状态流转**：`pending → running → success | failed | waiting_remote`。running 中 crash 的任务在重启恢复时：有 `remote_task_id` 的回退到 `waiting_remote`，无的回退到 `pending`。
- **不直接写 `projects` 表**：前端通过 Tauri command 操作，command 内通过 Rust 写库，不暴露直接执行 SQL 的 command。

---

### 主题与样式规范

- 所有颜色、字号、行高、字重、阴影等视觉参数统一在 `src/config/theme.ts` 的 `ThemeTokens` 接口中定义，在 `darkTheme` 对象中赋值。
- CSS 变量由 `applyTheme()` 在应用启动时注入到 `document.documentElement`，`styles.css` 的规则层全部使用 `var(--xxx)` 引用，不硬编码任何视觉参数。
- Canvas 动画颜色通过 `getCssVar(key)` 运行时读取，保证主题切换时动画同步更新。
- 新增主题：在 `theme.ts` 中添加实现了 `ThemeTokens` 接口的主题对象并注册到 `themes`，调用 `applyTheme('新主题名')` 即可切换。

---

### Git 规范

- **分支**：`main` 为稳定分支，功能开发在 `feat/<功能名>` 分支进行，修复在 `fix/<问题描述>` 分支进行。
- **提交信息**：使用约定式提交格式（Conventional Commits）：`<type>(<scope>): <描述>`。
  - 常用 type：`feat`、`fix`、`refactor`、`docs`、`chore`、`style`
  - 示例：`feat(project): add create project command`、`fix(worker): cleanup locks on crash`
- **不提交**：`node_modules/`、`dist/`、`src-tauri/target/`、`*.sqlite`、`.env*`、系统文件（`.DS_Store`、`Thumbs.db`）。
- **必须提交**：`package-lock.json`、`Cargo.lock`（锁定依赖版本，保证构建可复现）。

---

## 文档入口

- [总体设计文档](./docs/README.md)
- [模块索引](./docs/modules/README.md)
- [模块 01：项目与工作区](./docs/modules/01-project-and-workspace.md)
- [模块 08：任务运行时与状态恢复](./docs/modules/08-task-runtime-state-and-recovery.md)
- [模块 09：数据 Schema 与本地存储](./docs/modules/09-data-schema-and-local-storage.md)
- [模块 10：桌面端页面与工作台](./docs/modules/10-desktop-ui-workbench.md)

其余模块文档（02–07）保留为后续完整链路开发的设计依据。
