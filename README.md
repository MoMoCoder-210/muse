<div align="center">

  <img src="app-icon.png" alt="Muse" width="96" />

  # Muse

  **AI 视频创作桌面工具**

  从剧本导入到完整视频产出，全链路 AI 辅助创作

  <br/>

  [English](README_EN.md) · [Apache 2.0 开源协议](LICENSE) · [Releases 下载](https://github.com/MoMoCoder-210/muse/releases)

</div>

---

## 简介

Muse 是一款本地优先的桌面 AI 视频创作工具。基于剧本导入 → 分集拆解 → 素材管理 → 镜头生成 → 视频合成的主链路，将 AI 模型能力深度融入创作流程，帮助你快速将文本剧本转化为完整视频。

所有数据默认存储在本地，无需云端依赖，保障创作隐私与数据安全。

---

## 核心功能

| 模块 | 说明 |
|---|---|
| 📖 **剧本导入** | 支持导入文本剧本，自动按场景/段落拆分为独立分集 |
| 🎬 **分集拆解** | AI 自动解析每个分集的人物、场景、道具及镜头信息 |
| 🎨 **素材管理** | 管理人物形象、场景环境、道具物件，支持 AI 生图 |
| 🖼️ **镜头管理** | 为每个分集生成多组镜头，支持画面提示词编辑与参数调整 |
| 🎙️ **语音生成** | 为镜头旁白生成 TTS 语音，内置多款音色 |
| 🎥 **视频生成** | 基于镜头画面 + 语音合成视频分集，支持多分辨率与比例 |
| ✂️ **视频拼接** | 将分集内所有视频合并导出为完整成片 |
| 🔍 **视频超分** | 基于本地 ncnn-vulkan 引擎对镜头视频进行 2x/3x/4x 高清放大，支持断点续跑与任务队列 |

### 支持的创作风格

`国漫` `动漫` `日漫` `韩漫` `二次元` `真人`

### 支持的视频规格

分辨率：`480p` `720p` `1080p` `2K` `4K`
比例：`16:9` `9:16` `1:1` `4:3` `3:4` `21:9`

---

## 创作工作流

```
剧本导入 ──→ 分集管理 ──→ 素材管理 ──→ 镜头管理 ──→ 视频编辑 ──→ 视频超分 ──→ 导出成片
```

---

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

---

## 架构设计

```
┌─────────────────────────────────────────┐
│               React 前端                 │
│   (UI 渲染 · 用户交互 · 状态管理)         │
└──────────────┬──────────────────────────┘
               │ Tauri IPC (invoke)
┌──────────────┴──────────────────────────┐
│              Rust 后端                    │
│   (作品 CRUD · 文件系统 · DB 初始化 ·     │
│    进程管理 · 事件推送)                   │
└──────┬──────────────────┬───────────────┘
       │ spawn & stdio    │ rusqlite
┌──────┴──────┐    ┌──────┴──────┐
│  Node Worker│    │   SQLite    │
│  (任务调度 ·  │    │  (本地数据库) │
│   AI API 调用)│    └─────────────┘
└──────┬───────┘
       │ HTTP
┌──────┴──────┐
│  大模型  API │
│  (文本/生图/  │
│   语音/视频)  │
└─────────────┘
```

**设计原则：**
- **三层分离**：前端(UI) → Rust(系统) → Node(AI)，各层职责清晰
- **任务驱动**：所有耗时操作（生图/语音/视频）必须走任务队列，禁止直接 API 调用
- **本地优先**：全部数据默认存于用户本机，无云端依赖
- **崩溃恢复**：Worker 异常退出后自动接管遗留任务，保证任务不丢失

---

## 作品结构

```
muse/
├── src/                     # React 前端源码
│   ├── components/          # UI 组件
│   │   ├── common/          #   通用组件（弹窗、按钮等）
│   │   ├── home/            #   启动页
│   │   ├── layout/          #   布局组件
│   │   ├── project/         #   作品工作区（分集、素材、镜头、视频页）
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
│   │   ├── commands/        # Tauri 命令实现（作品/设置/脚本/视频/语音）
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

---

## 数据目录

应用运行时数据统一存储在用户主目录下的隐藏文件夹中：

```
~/.muse/                     # 应用数据目录
├── settings.json            # 应用配置（API Key、模型参数）
├── app.sqlite               # 应用数据库（作品注册表）
├── workspace/               # 默认作品工作区
└── logs/
    └── muse.log             # 运行日志

<作品目录>/                   # 用户创建作品时指定
├── project.sqlite           # 作品数据库
├── source/                  # 原始剧本文件
├── clips/                   # 分集相关文件
├── assets/                  # 素材图片与缩略图
├── storyboards/             # 镜头草稿与定稿
├── audio/                   # 语音文件
├── video/                   # 生成的视频分集
├── exports/                 # 导出成片
└── cache/                   # 临时缓存
```

---

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

---

## 模型配置

- **语言模型**：Open API 兼容
- **生图模型**：Open API 兼容
- **视频模型**：火山 Seedance-2.0 系列模型 API，暂未兼容其他格式

配置文件 `~/.muse/settings.json`。

---

## 当前局限

> 受限于个人资金与精力，目前仅完成了 **Windows 64 位**的兼容测试，视频模型仅验证了 **Seedance-2.0-mini**。如果你希望在其他平台（macOS / Linux）上使用或接入更多视频模型，欢迎赞助支持，我会优先推进。

---

## 后续计划

- [x] AI 剧本优化（润色、补全、改写）
- [x] 视频超分辨率（本地 ncnn-vulkan，已上线）
- [ ] 图片超分辨率（后续版本上线）
- [ ] 智能体功能（图片超分完成后启动，可能长时间不更新新功能，专注智能体功能）

---

## 致谢

超分辨率功能使用了以下开源项目的技术方案：

- [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) —— 基于 ncnn-vulkan 的本地超分引擎（模型与推理方案）

---

<div align="center">
  <sub>Built with Tauri · React · Rust · SQLite · Node.js</sub>
  <br/>
  <sub>Licensed under <a href="LICENSE">Apache 2.0</a></sub>
</div>
