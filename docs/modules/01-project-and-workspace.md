# 模块 01：项目与工作区

## 1. 模块职责

这个模块负责桌面端项目的生命周期管理。它不是只创建一条项目记录，而是在一次操作中同时建立项目记录、工作区目录、本地数据库、默认参数和初始任务环境。项目模块是整个系统的起点，但它不负责真正执行拆分、生成等工作——那些交给任务运行时（模块 08）。

## 2. 设计约束

1. **先记录后异步**：项目创建时如果有剧本输入，先保存 `ScriptSource` 记录和 `split_script_source` 任务（同一事务），然后通知 worker 执行。不在项目创建过程中同步执行剧本拆分。

2. **参数继承**：项目创建时设定的默认参数（图像、视频、语音）会自动继承到该项目的所有分镜。分镜可以覆盖这些参数，但未覆盖时使用项目默认值。

3. **输入模式决定首条任务**：空项目不创建任何任务；剧本项目创建 `split_script_source` 任务。

4. **工作区原子性**：工作区目录创建、数据库初始化、项目记录写入必须在一个原子操作中完成。如果中间任何一步失败，要么回滚到初始状态，要么标记为初始化失败。

## 3. 数据结构

### 3.1 Project

```ts
type InputMode = 'empty' | 'script';
type StyleMode = 'RS' | 'TS' | 'ZH';
type ProjectStatus = 'active' | 'archived' | 'failed';
type ProjectStep = 'project' | 'split' | 'script' | 'asset' | 'storyboard' | 'voice' | 'video' | 'export';
type StopStep = 'asset' | 'storyboard' | 'voice' | 'video' | 'export' | null;

type Project = {
  id: string;
  name: string;
  description: string;
  workspacePath: string;
  inputMode: InputMode;
  styleMode: StyleMode;
  status: ProjectStatus;
  currentStep: ProjectStep;  // 聚合值，取所有片段中最慢的步骤（只读，由片段状态推导）
  stopStep: StopStep;
  autoContinue: boolean;
  coverPath?: string;
  defaultImageParamJson?: string;   // ImageParam JSON，见模块 09
  defaultVideoParamJson?: string;   // VideoParam JSON
  defaultVoiceParamJson?: string;   // VoiceParam JSON
  createdAt: string;
  updatedAt: string;
};
```

### 3.2 ScriptSource

```ts
type SourceType = 'paste' | 'txt' | 'docx';
type SplitStatus = 'pending' | 'running' | 'success' | 'failed';

type ScriptSource = {
  id: string;
  projectId: string;
  sourceType: SourceType;
  fileName?: string;
  rawContent: string;
  normalizedContent: string;
  splitStatus: SplitStatus;
  retryCount: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};
```

### 3.3 Clip（片段）

片段类型完整定义详见模块 02。此处仅列出与步骤推进相关的字段：

```ts
type ClipStatus = 'pending' | 'script_ready' | 'asset_ready' | 'storyboard_ready' | 'media_ready' | 'done' | 'failed';

type Clip = {
  id: string;
  projectId: string;
  sortIndex: number;
  title: string;
  summary: string;
  sourceText: string;
  currentStep: ProjectStep;  // 片段当前步骤
  status: ClipStatus;
  createdAt: string;
  updatedAt: string;
};
```

> **注意**：`currentStep` 是片段级别的步骤字段，每个片段独立推进。项目级 `currentStep` 是所有片段 `currentStep` 的聚合值（取最慢的步骤）。clips 表的 `current_step` 列定义详见模块 09。

### 3.4 风格模式说明

| 模式 | 含义 | 生成流程 |
|------|------|----------|
| RS | 图生模式 | 资产图 → 融合图 → 图生视频 |
| TS | 融生模式 | 资产图 → 融合图 → 图生视频（融图和视频参数不同） |
| ZH | 综合模式 | 资产图 → 故事版图 → 参考图生视频 |

三种模式的区别主要体现在分镜融合图生成和视频生成阶段（详见模块 05 和 07）。

## 4. 工作区结构

项目创建时必须立刻创建以下目录：

```text
{workspacePath}/
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

### manifest.json

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

> **manifest.json 的定位**：manifest.json 是引导元数据，仅用于项目发现和版本检查。存储字段：projectId、projectName、workspaceVersion、schemaVersion、createdAt。所有运行时元数据（项目状态、步骤、参数等）以 project.sqlite 为唯一权威。两者冲突时以 project.sqlite 为准。`updateProjectSettings` 命令只更新 project.sqlite，不同步 manifest.json。

## 5. 创建流程

### 5.1 空项目

```text
1. 校验项目名非空（1-50 字符）
2. 校验工作区路径可写
3. 创建工作区目录（含所有子目录）
4. 初始化 SQLite（建表 + migration）
5. 写入 manifest.json
6. 插入 Project 记录（inputMode = 'empty', currentStep = 'project'）
7. 返回 { projectId }
8. 前端打开项目工作台
```

### 5.2 剧本项目

```text
1. 校验项目名非空
2. 校验工作区路径可写
3. 校验剧本内容非空
4. 校验内容长度不超过 100,000 语义字数
5. 乱码检测（采样前 1000 字符，拉丁扩展字符占比 > 30% 则判定乱码）
6. 如果是文件上传，读取文件内容（支持 txt / docx）
7. 文本规范化（见模块 02 第 3 节）
8. 创建工作区目录
9. 初始化 SQLite
10. 写入 manifest.json
11. 开启 SQLite 事务
12. 插入 Project 记录（inputMode = 'script'）  // currentStep 为聚合值，初始无片段时为 'split'
13. 插入 ScriptSource 记录（splitStatus = 'pending'）
14. 插入 Task 记录（type = 'split_script_source', status = 'pending'）
15. 提交事务
16. 通知 worker
17. 返回 { projectId }
18. 前端打开项目工作台并显示"拆分中"
```

> **片段创建与初始步骤**：拆分任务（`split_script_source`）执行成功后由 worker 创建 Clip 记录（见模块 08）。每个片段的 `current_step` 初始为 `'project'`，拆分完成后推进为 `'split'`，随后根据任务推进进入 `'script'` 步骤。项目级 `currentStep` 随之更新为所有片段中最慢的步骤。

### 5.3 参数继承机制

项目创建时设定的默认参数保存在 `Project.defaultImageParamJson`、`defaultVideoParamJson`、`defaultVoiceParamJson` 中。

后续每个模块在创建分镜时，参数合并规则：

```text
最终参数 = 项目默认参数 → 分镜级参数覆盖
```

具体合并逻辑：

```ts
function mergeParams<T>(projectDefault: T | undefined, storyboardOverride: T | undefined): T {
  if (!projectDefault) return storyboardOverride ?? getDefaultFallback();
  if (!storyboardOverride) return projectDefault;
  return { ...projectDefault, ...storyboardOverride };
}
```

## 6. 项目状态机

```text
                      ┌─────────────────────────────────────────────────────┐
                      │                                                     │
   new ──→ active ──→ │ project → split → script → asset →               │
                      │   → storyboard → voice → video → export → done     │
                      │                                                     │
                      │ 每个片段独立推进，项目 currentStep = 聚合最慢步骤    │
                      └─────────────────────────────────────────────────────┘
                ↓
            archived（用户手动归档）

  片段步骤失败 → 该片段 currentStep 保持不变，等待重试
  其他片段不受影响，可继续推进
```

### 步骤推进规则（片段级）

1. 每个片段独立推进 currentStep
2. 当一个片段当前步骤的所有子任务都 `success` 后，如果 `autoContinue = true` 且 `currentStep < stopStep`，自动推进该片段到下一步
3. 项目级 currentStep 是聚合值：取所有片段中最慢的步骤（例如 9 个片段在 script 步骤，1 个在 split 步骤，则项目 currentStep = split）
4. 用户可对不同片段并行操作：例如对已完成 script 步骤的片段提前进入 asset 步骤，不等其他片段

### stopStep 控制点

用户可以设置停在哪一步等待人工确认：

| stopStep | 含义 | 停在什么位置 |
|----------|------|-------------|
| asset | 资产确认 | 资产生图完成后 |
| storyboard | 分镜确认 | 分镜生成完成后 |
| voice | 语音确认 | 语音生成完成后 |
| video | 视频确认 | 视频生成完成后 |
| export | 导出前 | 所有视频生成完成后 |
| null | 不停 | 全自动到导出 |

## 7. 接口定义

### 7.1 Tauri IPC 命令

```ts
// 创建项目
createProject(input: {
  name: string;
  description?: string;
  workspacePath: string;
  inputMode: InputMode;
  styleMode: StyleMode;
  stopStep?: StopStep;
  autoContinue?: boolean;
  sourceType?: SourceType;
  sourceContent?: string;           // paste 模式
  sourceFilePath?: string;          // txt/docx 模式
  defaultImageParam?: ImageParam;
  defaultVideoParam?: VideoParam;
  defaultVoiceParam?: VoiceParam;
}): Promise<{ projectId: string }>

// 打开已有项目
openProject(input: { workspacePath: string }): Promise<{ projectId: string }>

// 获取项目信息
getProject(input: { projectId: string }): Promise<Project | null>

// 获取项目列表
listProjects(): Promise<Array<Project & { lastModified: string }>>

// 更新项目设置
updateProjectSettings(input: {
  projectId: string;
  name?: string;
  description?: string;
  autoContinue?: boolean;
  stopStep?: StopStep;
  defaultImageParam?: ImageParam;
  defaultVideoParam?: VideoParam;
  defaultVoiceParam?: VoiceParam;
}): Promise<void>

// 归档项目
archiveProject(input: { projectId: string }): Promise<void>

// 删除项目（移动到回收站）
deleteProject(input: { projectId: string }): Promise<void>
```

### 7.2 错误码

```ts
type ProjectErrorCode =
  | 'PROJECT_NAME_EMPTY'           // 项目名为空
  | 'PROJECT_NAME_TOO_LONG'        // 项目名超过 50 字符
  | 'WORKSPACE_PATH_INVALID'       // 工作区路径不可写或不存在
  | 'WORKSPACE_PATH_EXISTS'        // 工作区路径已被其他项目占用
  | 'SCRIPT_CONTENT_EMPTY'         // 剧本内容为空
  | 'SCRIPT_CONTENT_TOO_LONG'      // 剧本内容超过 100,000 语义字数
  | 'SCRIPT_MOJIBAKE_DETECTED'     // 检测到乱码
  | 'SCRIPT_FILE_PARSE_FAILED'     // 剧本文件解析失败
  | 'DB_INIT_FAILED'               // SQLite 初始化失败
  | 'WORKSPACE_INIT_FAILED'        // 工作区目录创建失败
  | 'PROJECT_NOT_FOUND'            // 项目不存在
  | 'PROJECT_ALREADY_EXISTS';      // 项目已存在
```

## 8. 异常处理

### 8.1 常见失败场景

| 场景 | 原因 | 处理 |
|------|------|------|
| 工作区路径无权限 | 操作系统权限 | 返回 `WORKSPACE_PATH_INVALID` |
| 工作区路径已被占用 | 同一路径创建了多个项目 | 返回 `WORKSPACE_PATH_EXISTS` |
| 剧本文件解析失败 | docx 格式损坏 | 返回 `SCRIPT_FILE_PARSE_FAILED` |
| 乱码检测 | 编码错误 | 返回 `SCRIPT_MOJIBAKE_DETECTED` |
| SQLite 初始化失败 | 磁盘空间不足或权限 | 返回 `DB_INIT_FAILED`，清理已创建的目录 |
| 目录创建部分失败 | 磁盘空间不足 | 返回 `WORKSPACE_INIT_FAILED`，清理已创建的目录 |

### 8.2 回滚策略

项目创建过程中的原子性保障：

```text
1. 记录已创建的资源（目录、文件、数据库）
2. 如果任何步骤失败：
   a. 关闭数据库连接
   b. 删除已创建的目录（整个工作区目录）
   c. 返回错误码
3. 不留半成品状态
```

### 8.3 恢复策略

如果应用在项目创建过程中崩溃：

- 启动时扫描所有项目的 manifest.json
- 如果 manifest.json 存在但数据库不可用，标记项目为 `failed`
- 如果目录存在但 manifest.json 不存在，提示用户清理残留目录
- 如果 ScriptSource 已写入但任务未入队，重启时由 worker 的恢复逻辑补发（见模块 08 第 8.1 节）

## 9. 最低落地清单

1. 项目创建表单（项目名、工作区路径选择、输入模式、风格模式）
2. 工作区目录创建逻辑（含所有子目录）
3. SQLite 初始化 + migration 执行
4. `Project` 持久化
5. `ScriptSource` 持久化
6. `manifest.json` 读写
7. 首条任务入队
8. 项目列表页
9. 参数继承和合并逻辑
