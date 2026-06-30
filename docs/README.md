# Muse 桌面端文档

这份文档只做两件事：

1. 说明 `Muse` 当前已经实现到哪里。
2. 说明后续完整链路要按什么模块继续开发。

不再把所有规划内容都写成“已经存在”的系统。

## 1. 产品目标

Muse 是一个本地优先的桌面端创作工具，保留以下主链路：

1. 创建项目
2. 导入剧本
3. 自动拆分片段 / 分镜
4. 提取角色 / 场景 / 物品
5. 生成角色 / 场景 / 物品图
6. 编辑分镜
7. 生成融合分镜图
8. 生成语音
9. 生成视频片段
10. 导出完整视频

模型接入策略：
- 只接火山引擎系能力
- 文本理解 / 拆分 / 提示词生成
- 生图模型
- 生视频模型
- 语音模型

## 2. 当前实现状态

当前代码已经完成的是桌面应用骨架，而不是全链路生产系统。

### 2.1 已实现

- Tauri 应用可启动，窗口名为 `Muse`
- 首页已改为真实起始页
- 项目管理页已存在
- 创建项目弹窗已实现
- 项目可创建到本地工作区
- 工作区目录、`project.sqlite`、`manifest.json` 会自动创建
- 项目注册表可记录和读取项目列表
- 前端已能通过 Tauri command 拉取和展示项目

### 2.2 未实现

- 剧本导入
- 片段拆分
- 角色 / 场景 / 物品提取
- 资产生图
- 分镜生成与编辑
- 融合图生成
- 语音生成
- 视频生成
- 导出链路
- 任务中心与任务事件流

## 3. 当前架构

### 3.1 前端

当前前端集中在：

- [src/App.tsx](D:/xm/backend/desktop-lite/src/App.tsx)
- [src/styles.css](D:/xm/backend/desktop-lite/src/styles.css)
- [src/config/muse.ts](D:/xm/backend/desktop-lite/src/config/muse.ts)

当前页面结构：

1. 首页
   - 动态背景
   - `Muse` 标题
   - `创建项目`
   - `项目管理`
2. 项目管理页
   - 左侧项目列表
   - 右侧项目工作区占位
   - 工作流步骤展示
3. 创建项目弹窗
   - 项目名
   - 项目目录
   - 创建模式
   - 创作风格

### 3.2 Rust / Tauri

当前 Tauri 入口与命令：

- [src-tauri/src/lib.rs](D:/xm/backend/desktop-lite/src-tauri/src/lib.rs)
- [src-tauri/src/main.rs](D:/xm/backend/desktop-lite/src-tauri/src/main.rs)
- [src-tauri/src/commands.rs](D:/xm/backend/desktop-lite/src-tauri/src/commands.rs)
- [src-tauri/src/app_paths.rs](D:/xm/backend/desktop-lite/src-tauri/src/app_paths.rs)
- [src-tauri/src/db.rs](D:/xm/backend/desktop-lite/src-tauri/src/db.rs)

当前已暴露命令：

- `get_app_version`
- `create_project`
- `get_project`
- `list_projects`
- `start_worker`
- `stop_worker`

### 3.3 本地数据

当前本地数据分两层：

1. 应用级数据目录
   - 保存项目注册表
2. 项目工作区
   - 保存 `project.sqlite`
   - 保存 `manifest.json`
   - 保存项目级目录结构

默认策略：
- 应用级数据目录放在 Windows 用户目录下
- 项目默认目录放在 `D:\projects`

## 4. 当前项目创建实现

当前 `create_project` 的真实行为是：

1. 生成 `project_id`
2. 解析工作区路径
3. 创建工作区目录
4. 创建标准子目录
5. 初始化 `project.sqlite`
6. 执行迁移
7. 写入 `projects` 表
8. 更新应用级项目注册表
9. 写入 `manifest.json`
10. 返回前端所需的项目信息

当前会创建的目录包括：

- `source/scripts`
- `clips`
- `assets/characters/thumbs`
- `assets/scenes/thumbs`
- `assets/items/thumbs`
- `storyboards/draft`
- `storyboards/final`
- `audio`
- `video`
- `exports`
- `logs/tasks`
- `cache`

## 5. 文档分布

为了减少来回跳转，文档现在按“主文档 + 少量关键模块”组织。

- [模块索引](./modules/README.md)
- [模块 01：项目与工作区](./modules/01-project-and-workspace.md)
- [模块 10：桌面端页面与工作台](./modules/10-desktop-ui-workbench.md)

其余模块文档保留为完整链路开发设计稿，后续随着功能落地再逐步收敛。
