<div align="center">

  <img src="app-icon.png" alt="Muse" width="96" />

  # Muse

  **AI 视频创作桌面工具**

  <span class="zh">从剧本导入到完整视频产出，全链路 AI 辅助创作</span>
  <span class="en" style="display:none">From script import to full video output — AI-assisted end-to-end creation</span>

  <br/>

  <button class="lang-btn active" onclick="switchLang('zh')">中</button>
  <button class="lang-btn" onclick="switchLang('en')">EN</button>

</div>

---

<div class="zh">

## 简介

Muse 是一款本地优先的桌面 AI 视频创作工具。基于剧本导入 → 片段拆解 → 资产管理 → 分镜生成 → 视频合成的主链路，将 AI 模型能力深度融入创作流程，帮助你快速将文本剧本转化为完整视频。

所有数据默认存储在本地，无需云端依赖，保障创作隐私与数据安全。

</div>

<div class="en" style="display:none">

## Introduction

Muse is a local-first desktop AI video creation tool. It follows a main pipeline — script import → clip decomposition → asset management → storyboard generation → video synthesis — deeply integrating AI model capabilities into the creative workflow to help you quickly turn text scripts into complete videos.

All data is stored locally by default with no cloud dependency, ensuring creative privacy and data security.

</div>

---

<div class="zh">

## 核心功能

| 模块 | 说明 |
|---|---|
| 📖 **剧本导入** | 支持导入文本剧本，自动按场景/段落拆分为独立片段 |
| 🎬 **片段拆解** | AI 自动解析每个片段的角色、场景、物品及分镜信息 |
| 🎨 **资产管理** | 管理角色形象、场景环境、道具物件，支持 AI 生图 |
| 🖼️ **分镜管理** | 为每个片段生成多组分镜，支持画面提示词编辑与参数调整 |
| 🎙️ **语音生成** | 为分镜旁白生成 TTS 语音，内置多款音色 |
| 🎥 **视频生成** | 基于分镜画面 + 语音合成视频片段，支持多分辨率与比例 |
| ✂️ **视频拼接** | 将片段内所有视频合并导出为完整成片 |

### 支持的创作风格

`国漫` `动漫` `日漫` `韩漫` `二次元` `真人`

### 支持的视频规格

分辨率：`480p` `720p` `1080p` `2K` `4K`
比例：`16:9` `9:16` `1:1` `4:3` `3:4` `21:9`

</div>

<div class="en" style="display:none">

## Core Features

| Module | Description |
|---|---|
| 📖 **Script Import** | Import text scripts and auto-split into independent clips by scene/paragraph |
| 🎬 **Clip Decomposition** | AI parses characters, scenes, items, and storyboards for each clip |
| 🎨 **Asset Management** | Manage character images, scene environments, and props with AI image generation |
| 🖼️ **Storyboard Editing** | Generate multiple storyboards per clip with prompt editing and parameter adjustment |
| 🎙️ **Voice Generation** | Generate TTS voiceovers for storyboard narration with built-in voice library |
| 🎥 **Video Generation** | Synthesize video clips from storyboard frames + voice, supporting multiple resolutions and aspect ratios |
| ✂️ **Video Concatenation** | Merge all videos within a clip into a single final export |

### Supported Art Styles

`Chinese Anime` `Anime` `Japanese Anime` `Korean Manhwa` `ACG` `Live Action`

### Supported Video Specs

Resolution: `480p` `720p` `1080p` `2K` `4K`
Aspect Ratio: `16:9` `9:16` `1:1` `4:3` `3:4` `21:9`

</div>

---

<div class="zh">

## 创作工作流

```
剧本导入 ──→ 片段管理 ──→ 资产管理 ──→ 分镜管理 ──→ 视频编辑 ──→ 导出成片
```

</div>

<div class="en" style="display:none">

## Creative Workflow

```
Script Import ──→ Clip Management ──→ Asset Management ──→ Storyboard Editing ──→ Video Editing ──→ Export
```

</div>

---

<div class="zh">

## 技术栈

| 层次 | 技术 | 说明 |
|---|---|---|
| 🖥️ 桌面壳 | **Tauri 2.x** | 跨平台桌面框架，负责窗口管理、IPC 通信、原生 API |
| 🎨 前端 | **React 18 + TypeScript + Vite** | UI 渲染，通过 `@tauri-apps/api` 调用后端命令 |
| ⚙️ 后端 | **Rust** (edition 2021) | 文件系统操作、数据库管理、进程生命周期控制 |
| 🗄️ 数据库 | **SQLite** (WAL 模式) | 本地存储，支持 Rust 层与 Node worker 多进程并发访问 |
| 🔧 任务引擎 | **Node.js 22** (sidecar) | 独立进程，通过 stdio JSON-line 协议与 Rust 通信，负责任务调度与 AI API 调用 |
| 🎞️ 视频处理 | **FFmpeg** | 视频拼接、格式转换 |
| 📦 状态管理 | **Zustand** + **TanStack Query** | 本地 UI 状态与服务端数据缓存 |

</div>

<div class="en" style="display:none">

## Tech Stack

| Layer | Technology | Description |
|---|---|---|
| 🖥️ Desktop Shell | **Tauri 2.x** | Cross-platform desktop framework for windowing, IPC, and native APIs |
| 🎨 Frontend | **React 18 + TypeScript + Vite** | UI rendering, invokes backend commands via `@tauri-apps/api` |
| ⚙️ Backend | **Rust** (edition 2021) | File system ops, database management, process lifecycle |
| 🗄️ Database | **SQLite** (WAL mode) | Local storage with concurrent access from Rust and Node worker |
| 🔧 Task Engine | **Node.js 22** (sidecar) | Independent process communicating via stdio JSON-line protocol; handles task scheduling and AI API calls |
| 🎞️ Video | **FFmpeg** | Video concatenation and format conversion |
| 📦 State | **Zustand** + **TanStack Query** | Local UI state and server-data caching |

</div>

---

<div class="zh">

## 架构设计

```
┌─────────────────────────────────────────┐
│               React 前端                 │
│   (UI 渲染 · 用户交互 · 状态管理)         │
└──────────────┬──────────────────────────┘
               │ Tauri IPC (invoke)
┌──────────────┴──────────────────────────┐
│              Rust 后端                    │
│   (项目 CRUD · 文件系统 · DB 初始化 ·     │
│    进程管理 · 事件推送)                   │
└──────┬──────────────────┬───────────────┘
       │ spawn & stdio    │ rusqlite
┌──────┴──────┐    ┌──────┴──────┐
│  Node Worker │    │   SQLite    │
│  (任务调度 ·  │    │  (本地数据库) │
│   AI API 调用)│    └─────────────┘
└──────┬───────┘
       │ HTTP
┌──────┴──────┐
│  火山引擎 API │
│  (文本/生图/  │
│   语音/视频)  │
└─────────────┘
```

**设计原则：**
- **三层分离**：前端(UI) → Rust(系统) → Node(AI)，各层职责清晰
- **任务驱动**：所有耗时操作（生图/语音/视频）必须走任务队列，禁止直接 API 调用
- **本地优先**：全部数据默认存于用户本机，无云端依赖
- **崩溃恢复**：Worker 异常退出后自动接管遗留任务，保证任务不丢失

</div>

<div class="en" style="display:none">

## Architecture

```
┌─────────────────────────────────────────┐
│             React Frontend              │
│   (UI Rendering · Interaction · State)  │
└──────────────┬──────────────────────────┘
               │ Tauri IPC (invoke)
┌──────────────┴──────────────────────────┐
│              Rust Backend               │
│   (Project CRUD · File System · DB Init │
│    Process Mgmt · Event Emission)       │
└──────┬──────────────────┬───────────────┘
       │ spawn & stdio    │ rusqlite
┌──────┴──────┐    ┌──────┴──────┐
│  Node Worker │    │   SQLite    │
│  (Task Sched ·│   │  (Local DB) │
│   AI API Calls)│  └─────────────┘
└──────┬───────┘
       │ HTTP
┌──────┴──────┐
│  Volcano Ark │
│  (Text/Image/│
│   Voice/Video)│
└─────────────┘
```

**Design Principles:**
- **Three-Layer Separation**: Frontend (UI) → Rust (System) → Node (AI), each with clear responsibilities
- **Task-Driven**: All long-running operations (image/voice/video generation) go through the task queue — direct API calls are forbidden
- **Local-First**: All data stored on the user's machine by default, no cloud dependency
- **Crash Recovery**: Worker crashes are detected and orphaned tasks are automatically reclaimed

</div>

---

<div class="zh">

## 项目结构

```
muse/
├── src/                     # React 前端源码
│   ├── components/          # UI 组件
│   │   ├── common/          #   通用组件（弹窗、按钮等）
│   │   ├── home/            #   启动页
│   │   ├── layout/          #   布局组件
│   │   ├── project/         #   项目工作区（片段、资产、分镜、视频页）
│   │   └── settings/        #   设置面板
│   ├── config/              # 业务配置（风格、分辨率、工作流定义）
│   ├── hooks/               # 自定义 Hooks
│   ├── services/            # Tauri 命令封装层
│   ├── styles/              # CSS 样式文件（按模块拆分）
│   ├── types/               # TypeScript 类型定义
│   └── utils/               # 工具函数
│
├── src-tauri/               # Tauri + Rust 后端
│   ├── src/
│   │   ├── main.rs          # 二进制入口
│   │   ├── lib.rs           # 应用初始化、插件注册、启动流程
│   │   ├── commands/        # Tauri 命令实现（项目/设置/脚本/视频/语音）
│   │   ├── app_paths.rs     # 路径解析（数据目录、FFmpeg、Node）
│   │   ├── sidecar.rs       # Worker 进程生命周期管理
│   │   └── project_log.rs   # 日志系统
│   ├── capabilities/        # Tauri 权限声明
│   ├── icons/               # 应用图标
│   └── tauri.conf.json      # Tauri 配置
│
├── worker/                  # Node.js Sidecar（独立 npm workspace）
│   ├── src/
│   │   ├── index.ts         # 入口：stdio 通信、命令分发
│   │   ├── task-runner.ts   # 任务调度引擎（轮询、锁、重试）
│   │   ├── handlers/        # 任务处理器（拆解/生图/语音/视频/拼接）
│   │   ├── clients/         # AI API 客户端封装
│   │   ├── config/          # Worker 端配置与默认值
│   │   ├── prompts/         # 模型提示词模板
│   │   └── utils/           # 工具函数
│   └── dist/                # 编译输出
│
├── ffmpeg/                  # FFmpeg 可执行文件
├── migrations/              # 数据库迁移脚本
├── scripts/                 # 构建辅助脚本
└── docs/                    # 设计文档
```

</div>

<div class="en" style="display:none">

## Project Structure

```
muse/
├── src/                     # React frontend source
│   ├── components/          # UI components
│   │   ├── common/          #   Shared components (modals, buttons)
│   │   ├── home/            #   Startup screen
│   │   ├── layout/          #   Layout components
│   │   ├── project/         #   Workspace (clips, assets, storyboards, video)
│   │   └── settings/        #   Settings panel
│   ├── config/              # Business config (styles, resolutions, workflow)
│   ├── hooks/               # Custom hooks
│   ├── services/            # Tauri command wrappers
│   ├── styles/              # CSS stylesheets (modular)
│   ├── types/               # TypeScript type definitions
│   └── utils/               # Utility functions
│
├── src-tauri/               # Tauri + Rust backend
│   ├── src/
│   │   ├── main.rs          # Binary entry point
│   │   ├── lib.rs           # App init, plugin registration, startup flow
│   │   ├── commands/        # Tauri command implementations
│   │   ├── app_paths.rs     # Path resolution (data dir, FFmpeg, Node)
│   │   ├── sidecar.rs       # Worker process lifecycle management
│   │   └── project_log.rs   # Logging system
│   ├── capabilities/        # Tauri permission declarations
│   ├── icons/               # App icons
│   └── tauri.conf.json      # Tauri configuration
│
├── worker/                  # Node.js sidecar (independent npm workspace)
│   ├── src/
│   │   ├── index.ts         # Entry: stdio communication, command dispatch
│   │   ├── task-runner.ts   # Task engine (polling, locking, retries)
│   │   ├── handlers/        # Task handlers (decomposition, image, voice, video, concat)
│   │   ├── clients/         # AI API client wrappers
│   │   ├── config/          # Worker-side config and defaults
│   │   ├── prompts/         # Model prompt templates
│   │   └── utils/           # Utility functions
│   └── dist/                # Build output
│
├── ffmpeg/                  # FFmpeg binaries
├── migrations/              # Database migration scripts
├── scripts/                 # Build helper scripts
└── docs/                    # Design documentation
```

</div>

---

<div class="zh">

## 数据目录

应用运行时数据统一存储在用户主目录下的隐藏文件夹中：

```
~/.muse/                     # 应用数据目录
├── settings.json            # 应用配置（API Key、模型参数）
├── app.sqlite               # 应用数据库（项目注册表）
├── workspace/               # 默认项目工作区
└── logs/
    └── muse.log             # 运行日志

<项目目录>/                   # 用户创建项目时指定
├── project.sqlite           # 项目数据库
├── source/                  # 原始剧本文件
├── clips/                   # 片段相关文件
├── assets/                  # 资产图片与缩略图
├── storyboards/             # 分镜草稿与定稿
├── audio/                   # 语音文件
├── video/                   # 生成的视频片段
├── exports/                 # 导出成片
└── cache/                   # 临时缓存
```

</div>

<div class="en" style="display:none">

## Data Directory

Runtime data is stored in a hidden folder under the user's home directory:

```
~/.muse/                     # App data directory
├── settings.json            # App configuration (API keys, model params)
├── app.sqlite               # App database (project registry)
├── workspace/               # Default project workspace
└── logs/
    └── muse.log             # Runtime logs

<project-directory>/         # Specified when creating a project
├── project.sqlite           # Project database
├── source/                  # Original script files
├── clips/                   # Clip-related files
├── assets/                  # Asset images and thumbnails
├── storyboards/             # Storyboard drafts and finals
├── audio/                   # Voice audio files
├── video/                   # Generated video clips
├── exports/                 # Final exports
└── cache/                   # Temporary cache
```

</div>

---

<div class="zh">

## 快速开始

### 环境要求

- **Node.js** ≥ 22
- **Rust** ≥ 1.77（通过 [rustup](https://rustup.rs/) 安装）
- **Windows** 10+ / **macOS** 12+ / **Linux**

### 开发模式

```bash
# 1. 安装前端依赖
npm install

# 2. 安装 Worker 依赖
npm install -w worker

# 3. 编译 Worker
npm run worker:build

# 4. 启动开发环境
npm run tauri:dev
```

### 构建生产包

```bash
npm run tauri:build
```

构建产物位于 `src-tauri/target/release/bundle/`。

### 常用命令

| 命令 | 说明 |
|---|---|
| `npm run tauri:dev` | 启动完整开发环境（Vite + Tauri） |
| `npm run tauri:build` | 构建生产安装包 |
| `npm run dev` | 仅启动 Vite 开发服务器 |
| `npm run build` | 仅构建前端 |
| `npm run worker:dev` | Worker 热重载开发模式 |
| `npm run worker:build` | 编译 Worker |

</div>

<div class="en" style="display:none">

## Getting Started

### Prerequisites

- **Node.js** ≥ 22
- **Rust** ≥ 1.77 (install via [rustup](https://rustup.rs/))
- **Windows** 10+ / **macOS** 12+ / **Linux**

### Development

```bash
# 1. Install frontend dependencies
npm install

# 2. Install Worker dependencies
npm install -w worker

# 3. Build the Worker
npm run worker:build

# 4. Start the development environment
npm run tauri:dev
```

### Production Build

```bash
npm run tauri:build
```

Build artifacts are located at `src-tauri/target/release/bundle/`.

### Common Commands

| Command | Description |
|---|---|
| `npm run tauri:dev` | Start full dev environment (Vite + Tauri) |
| `npm run tauri:build` | Build production installer |
| `npm run dev` | Start Vite dev server only |
| `npm run build` | Build frontend only |
| `npm run worker:dev` | Worker hot-reload dev mode |
| `npm run worker:build` | Build the Worker |

</div>

---

<div class="zh">

## 模型配置

- **语言模型**：Open API兼容
- **生图模型**：Open API兼容
- **视频模型**：火山Seedance-2.0系列模型API，暂未兼容其他格式

配置文件 `~/.muse/settings.json`。

</div>

<div class="en" style="display:none">

## Model Configuration

Muse currently integrates with **Volcano Ark** model services exclusively. Configure your API keys in the Settings panel:

- **Text Model**: Script decomposition and storyboard generation
- **Image Model**: Character/scene/prop image generation
- **Voice Model**: Storyboard narration TTS synthesis
- **Video Model**: Storyboard video generation

A default config file `~/.muse/settings.json` is automatically created on first launch.

</div>

---

<div align="center">
  <sub>Built with Tauri · React · Rust · SQLite · Node.js</sub>
</div>

<style>
  .lang-btn {
    display: inline-block;
    padding: 4px 14px;
    margin: 0 4px;
    border: 1px solid #30363d;
    border-radius: 6px;
    background: #0d1117;
    color: #8b949e;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.15s ease;
  }
  .lang-btn.active {
    background: #1f6feb;
    border-color: #1f6feb;
    color: #fff;
  }
  .lang-btn:hover:not(.active) {
    color: #c9d1d9;
    border-color: #8b949e;
  }
</style>

<script>
  function switchLang(lang) {
    document.querySelectorAll('.zh').forEach(el => el.style.display = lang === 'zh' ? '' : 'none');
    document.querySelectorAll('.en').forEach(el => el.style.display = lang === 'en' ? '' : 'none');
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.textContent.trim() === (lang === 'zh' ? '中' : 'EN'));
    });
    localStorage.setItem('muse-readme-lang', lang);
  }
  // restore saved preference
  (function() {
    var saved = localStorage.getItem('muse-readme-lang') || 'zh';
    switchLang(saved);
  })();
</script>
