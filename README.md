# Desktop Lite - 桌面端轻量版视频创作工具

## 技术栈

- **框架**: Tauri 2 (Rust 后端 + React 前端)
- **前端**: React 18 + TypeScript + Vite + TanStack Query v5 + Zustand
- **后端**: Rust (Tauri 2) + Node.js sidecar worker
- **数据库**: SQLite (WAL 模式, rusqlite + better-sqlite3)
- **媒体处理**: FFmpeg / FFprobe
- **AI 服务**: 火山引擎 API (豆包文本模型、图像生成、视频生成、语音 TTS)

## 项目结构

```
desktop-lite/
├── docs/                    # 架构设计文档（11 个模块）
│   ├── README.md
│   └── modules/
├── src/                     # React 前端
│   ├── App.tsx
│   ├── main.tsx
│   ├── components/
│   ├── stores/
│   ├── hooks/
│   ├── types/
│   └── styles.css
├── src-tauri/               # Tauri 2 Rust 后端
│   ├── src/
│   │   ├── main.rs          # 入口
│   │   ├── lib.rs           # 应用配置
│   │   ├── sidecar.rs       # SidecarManager (生命周期管理)
│   │   ├── db.rs            # SQLite 初始化与迁移
│   │   └── commands.rs      # Tauri IPC 命令
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   └── capabilities/
├── worker/                  # Node sidecar worker
│   ├── src/
│   │   ├── index.ts         # 入口，stdio 通信
│   │   ├── task-runner.ts   # 任务执行核心循环
│   │   ├── rate-limiter.ts  # API 限流器 (Token Bucket)
│   │   ├── db.ts            # SQLite 操作
│   │   └── types.ts         # 共享类型定义
│   ├── package.json
│   └── tsconfig.json
├── migrations/              # SQLite 迁移文件
│   └── 001_initial.sql
├── package.json
├── vite.config.ts
├── tsconfig.json
└── .gitignore
```

## 开发环境要求

- Node.js 18+ (推荐 24+)
- npm 10+
- Rust 1.77+ (含 MSVC 工具链)
- Visual Studio C++ Build Tools (Windows)
- FFmpeg / FFprobe (需在 PATH 中)

## 快速开始

```bash
# 安装前端依赖
npm install

# 安装 worker 依赖
npm install -w worker

# 构建 worker
npm run worker:build

# 开发模式（启动 Vite + Tauri）
npm run tauri:dev

# 构建生产版本
npm run tauri:build
```

## 架构概览

```
前端 (React)
  │
  ├── Tauri IPC 命令 ──→ Rust 服务层
  │                        ├── 校验输入
  │                        ├── SQLite 事务
  │                        └── 通知 worker
  │
  ├── 事件流订阅 ←────── Node sidecar worker
  │                        ├── 轮询 pending 任务
  │                        ├── 获取逻辑锁
  │                        ├── 调用火山引擎 API
  │                        ├── 限流控制 (RateLimiter)
  │                        └── 推送事件
  │
  └── TanStack Query 轮询业务状态（兜底）
```

## 核心设计

- **统一生成任务模板**: 校验 → 持久化事务 → 远端请求 → 轮询 → 回写 → 补偿
- **先记录后异步**: UI 提交后只做校验和落库，立即返回
- **防重复执行**: SQLite 逻辑锁 (task_locks 表)
- **Sidecar 生命周期**: 启动握手 → 心跳监控 → 崩溃恢复 → 优雅退出
- **API 限流**: Token Bucket (按 API 类型独立限流) + 429 指数退避 + 配额暂停
- **多进程 SQLite**: WAL 模式 + busy_timeout 5s

详见 `docs/modules/` 下的架构文档。
