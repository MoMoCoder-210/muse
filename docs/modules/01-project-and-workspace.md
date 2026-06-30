# 模块 01：项目与工作区

这份文档只描述当前仓库里已经落地的项目创建与工作区实现，以及下一步要怎么扩展。

## 1. 当前实现范围

代码位置：

- [src-tauri/src/commands.rs](D:/xm/backend/desktop-lite/src-tauri/src/commands.rs)
- [src-tauri/src/app_paths.rs](D:/xm/backend/desktop-lite/src-tauri/src/app_paths.rs)
- [src-tauri/src/db.rs](D:/xm/backend/desktop-lite/src-tauri/src/db.rs)

当前已经实现：

- 创建项目
- 查询单个项目
- 查询项目列表
- 初始化项目工作区
- 初始化项目数据库
- 写入项目清单 `manifest.json`
- 维护应用级项目注册表

## 2. 当前数据结构

### 2.1 前端创建入参

当前前端传给 `create_project` 的结构：

```ts
type CreateProjectInput = {
  name: string;
  description?: string;
  workspace_path: string;
  input_mode?: string;
  style_mode?: string;
};
```

### 2.2 当前后端返回结构

```ts
type ProjectInfo = {
  id: string;
  name: string;
  description: string;
  workspace_path: string;
  status: string;
  current_step: string;
  created_at: string;
};
```

### 2.3 当前实际取值

当前项目创建后写入：

- `status = "active"`
- `current_step = "project"`

`input_mode` 当前代码接受字符串，但前端实际使用：

- `manual`
- `script`

`style_mode` 当前前端实际使用：

- `国漫`
- `动漫`
- `日漫`
- `韩漫`
- `二次元`
- `真人`

注意：
- 当前 Rust 代码里 `style_mode` 的默认值仍是 `"RS"`，这是后续需要继续统一的地方。
- 文档这里按“当前前端真实输入”记录。

## 3. 当前创建流程

当前 `create_project` 的真实执行顺序：

1. 生成 `project_id`
2. 解析 `input_mode` 和 `style_mode`
3. 解析工作区目录
4. 创建项目目录树
5. 解析应用级数据目录
6. 在工作区创建 `project.sqlite`
7. 执行 `migrations/` 下的 SQL
8. 向 `projects` 表插入一条项目记录
9. 更新应用级 `project-registry.json`
10. 写入 `manifest.json`
11. 返回 `ProjectInfo`

## 4. 当前目录结构

创建项目时会生成：

```text
{workspace}/
  project.sqlite
  manifest.json
  source/
    scripts/
  clips/
  assets/
    characters/
      thumbs/
    scenes/
      thumbs/
    items/
      thumbs/
  storyboards/
    draft/
    final/
  audio/
  video/
  exports/
  logs/
    tasks/
  cache/
```

## 5. 应用级数据

当前还有一层应用级目录，用来保存项目注册表：

- `project-registry.json`

用途：

1. 快速发现已有项目
2. 从应用级目录映射到具体工作区
3. 让 `list_projects` 不依赖单一集中数据库

## 6. 当前 IPC 接口

### 6.1 `create_project`

用途：
- 创建工作区
- 初始化数据库
- 注册项目

当前行为：
- 不拆剧本
- 不创建片段
- 不触发任务

### 6.2 `get_project`

用途：
- 根据 `project_id` 读取项目详情

当前实现：
- 先查项目注册表
- 再打开目标工作区内的 `project.sqlite`

### 6.3 `list_projects`

用途：
- 列出应用已知项目

当前实现：
- 读取注册表
- 逐个打开工作区数据库
- 汇总返回

## 7. 与文档设计稿的差异

当前代码还没有实现这些项目级能力：

- `open_project`
- `archive_project`
- `delete_project`
- 项目封面
- `stop_step`
- `auto_continue`
- 剧本型项目创建后自动入队拆分任务

这些能力仍然可以沿用后续设计文档，但不能当成当前现状。

## 8. 下一步建议

项目与工作区模块下一步建议按这个顺序补：

1. 统一 `input_mode` / `style_mode` 的前后端枚举
2. 增加 `open_project`
3. 增加 `update_project`
4. 增加 `archive_project` / `delete_project`
5. 为 `script` 模式接入剧本原文落库
6. 创建 `split_script_source` 初始任务

这条顺下来后，模块 02 才能无缝接上。
