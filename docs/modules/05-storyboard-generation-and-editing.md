# 模块 05：分镜生成与分镜编辑

## 1. 模块职责

本模块是桌面端视频创作工具的核心创作层，负责：

1. **分镜生成**：根据片段正文、剧本理解结果和已确认资产，调用火山引擎文本模型生成结构化分镜列表（`Storyboard[]`）。
2. **分镜编辑**：让分镜成为整条链路的可编辑主工作单元——用户在此完成台词、画面描述、提示词、引用资产、参数的逐条或批量编辑。
3. **失效与重算管理**：当分镜字段或引用资产发生变更时，自动标记下游产物（语音、融合图、视频）为 `invalidated`，驱动重算流程。
4. **参数合并**：将项目默认参数与分镜级参数按覆盖规则合并，输出最终用于媒体生成的参数 JSON。
5. **融合图入口**：为下一阶段媒体生成提供数据入口，包括单独生成、批量生成、本地替代图上传等动作。

## 2. 设计约束

| 约束项 | 说明 |
|--------|------|
| 架构框架 | Tauri 2（Rust 主进程）+ React（前端 UI）+ SQLite（本地持久化）+ Node worker（异步任务执行）+ 火山引擎（云端模型服务） |
| 文本模型 | 分镜生成调用火山引擎豆包文本模型，通过 Node worker 发起 HTTP 请求并轮询 |
| 图片模型 | 分镜融合图调用火山引擎图像生成模型，任务类型为 `generate_storyboard_image` |
| 任务执行 | 所有模型调用走统一任务模板：校验输入 → 持久化任务和业务状态（本地事务）→ 提交远端请求 → 轮询 → 回写结果 → 失败补偿 |
| 数据存储 | 分镜数据持久化在本地 SQLite `storyboards` 表中；资产引用关系通过 `character_ids`、`scene_ids`、`item_ids` 字段（JSON 数组）存储 |
| 并发控制 | 同一片段的分镜生成任务进行中，锁该片段，禁止重复提交；分镜编辑保存时使用乐观锁（`updatedAt` 比较） |
| 顺序保证 | 分镜的 `seqNum` 字段维护展示与导出顺序；批量重排时需保证无重复、无空洞 |
| 离线能力 | 编辑操作完全离线；模型调用需要网络，失败后可重试 |

## 3. 数据结构

### 3.1 Storyboard（分镜实体）

```ts
type Storyboard = {
  id: string;                    // 分镜唯一标识（UUID）
  projectId: string;             // 所属项目 ID
  clipId: string;                // 所属片段 ID
  seqNum: number;                // 镜号（从 1 开始，用于展示与导出顺序）
  sourceText: string;            // 原文（来自片段正文）
  summary?: string;              // 摘要（模型生成）
  dialogue?: string;             // 台词（模型生成或用户编辑）
  visualDescription: string;     // 画面描述（模型生成或用户编辑）
  imagePrompt: string;           // 图像提示词（用于融合图生成）
  videoPrompt: string;           // 视频提示词（用于视频生成）
  characterIds: string[];        // 引用角色资产 ID 列表
  sceneIds: string[];            // 引用场景资产 ID 列表
  itemIds: string[];             // 引用物品资产 ID 列表
  imageParamJson?: string;       // 图像生成参数（覆盖项目默认值后的合并结果）
  videoParamJson?: string;       // 视频生成参数
  voiceParamJson?: string;       // 语音生成参数
  imageState: 'pending' | 'running' | 'ready' | 'failed' | 'invalidated';
  voiceState: 'pending' | 'running' | 'ready' | 'failed' | 'invalidated';
  videoState: 'pending' | 'running' | 'ready' | 'failed' | 'invalidated';
  fusedImagePath?: string;       // 融合图本地路径
  voicePath?: string;            // 语音文件本地路径
  voiceDuration?: number;        // 语音时长（秒）
  videoPath?: string;            // 视频文件本地路径
  videoDuration?: number;        // 视频时长（秒）
  createdAt: string;             // 创建时间（ISO 8601）
  updatedAt: string;             // 更新时间（ISO 8601）
};
```

### 3.2 任务类型

| 任务类型 | 说明 | 执行方式 |
|----------|------|----------|
| `generate_storyboards` | 根据片段和资产生成一组结构化分镜 | Node worker → 火山引擎文本模型 |
| `generate_storyboard_image` | 为单条分镜生成融合图 | Node worker → 火山引擎图像模型 |

### 3.3 相关实体引用

| 实体 | 来源模块 | 关键字段 |
|------|----------|----------|
| Project | 模块 01 | `id`、`defaultImageParamJson`、`defaultVideoParamJson`、`defaultVoiceParamJson` |
| Clip | 模块 02 | `id`、`projectId`、`sourceText`（片段正文） |
| ClipScript | 模块 03 | `clipId`、`status`（`pending` / `running` / `success` / `failed`）、`resultJson`（剧本理解结果） |
| Character / Scene / Item | 模块 04 | `id`、`projectId`、`name`、`imagePath`、`paramJson` |

## 4. 详细流程

### 4.1 分镜生成流程（`generate_storyboards`）

遵循统一任务模板：校验输入 → 持久化任务和业务状态（本地事务）→ 提交远端请求 → 轮询 → 回写结果 → 失败补偿。

#### 步骤 1：校验输入

执行第 7 节的完整前置校验清单（10 项）。任一校验失败，立即返回错误信息，不创建任务。

#### 步骤 2：持久化任务和业务状态（本地事务）

在 SQLite 中执行本地事务：

1. 创建 `Task` 记录，`type = 'generate_storyboards'`，`status = 'pending'`，关联 `projectId` 和 `clipId`，`lockKey = 'storyboards:{clipId}'`。同一 `clipId` 的 `generate_storyboards` 任务不会并发执行（见模块 08 第 6 节逻辑锁）。
2. 事务提交后任务进入待执行队列。

#### 步骤 3：提交远端请求

Node worker 取出任务后：

1. 读取片段正文（`Clip.sourceText`）。
2. 读取剧本理解结果（`ClipScript.resultJson`），解析其中的场景拆分、角色出场、情节要点。
3. 读取已确认资产列表（`Character[]`、`Scene[]`、`Item[]`），提取 `id`、`name`、`imagePath`。
4. 读取项目默认参数（`Project.defaultImageParamJson` 等）。
5. 按第 5.2 节的提示词模板组装请求 prompt。
6. 调用火山引擎豆包文本模型，提交生成请求。

#### 步骤 4：轮询

Node worker 轮询火山引擎任务状态：

- 每 3 秒查询一次，最多轮询 120 次（超时 6 分钟）。
- 任务状态映射：`pending` / `running` → 本地 `Task.status = 'running'`；`succeeded` → 进入回写；`failed` → 进入失败补偿。

#### 步骤 5：回写结果

模型返回后，Node worker 执行：

1. 解析模型输出，校验输出结构（必须为 JSON 数组，每个元素包含 `summary`、`dialogue`、`visualDescription`、`imagePrompt`、`videoPrompt`、`characterIds`、`sceneIds`、`itemIds`）。
2. 校验 `seqNum` 连续性（从 1 开始）。
3. 校验引用的资产 ID 在已确认资产列表中存在。
4. 校验每条分镜的 dialogue 只包含一个说话人（多角色对白应已被拆分）。
5. 为每条分镜生成 `id`（UUID）、`createdAt`、`updatedAt`。
6. 执行参数合并（第 6 节），将合并后的参数写入 `imageParamJson`、`videoParamJson`、`voiceParamJson`。
7. 所有分镜的 `imageState`、`voiceState`、`videoState` 初始化为 `pending`。
8. 在 SQLite 事务中批量插入 `Storyboard[]` 记录。
9. 更新 `Task.status = 'success'`，释放逻辑锁（删除 `task_locks` 中 `storyboards:{clipId}` 记录）。

#### 步骤 6：失败补偿

当任务失败（模型返回错误、输出校验失败、超时）时：

1. 更新 `Task.status = 'failed'`，记录错误信息到 `Task.errorMessage`。
2. 释放逻辑锁（删除 `task_locks` 中 `storyboards:{clipId}` 记录）。
3. 不创建任何分镜记录（原子性保证）。
4. 前端可重新触发生成。

### 4.2 分镜编辑流程（同步操作）

分镜编辑是纯本地同步操作，不涉及模型调用。

#### 步骤 1：接收编辑 payload

前端提交编辑后的分镜列表（完整或差量），包含修改的字段和 `updatedAt`（乐观锁）。

#### 步骤 2：校验

- 镜号：`seqNum` 无重复、无空洞、从 1 连续。
- 引用资产：`characterIds`、`sceneIds`、`itemIds` 中的 ID 在资产表中存在。
- 参数：`imageParamJson`、`videoParamJson`、`voiceParamJson` 为合法 JSON 字符串。
- 乐观锁：提交的 `updatedAt` 必须等于数据库中的当前值，否则返回冲突错误。

#### 步骤 3：保存

在 SQLite 事务中：

1. 更新分镜字段。
2. 更新 `updatedAt` 为当前时间。
3. 执行失效标记（第 8 节）——根据改动字段自动将下游产物标记为 `invalidated`。

#### 步骤 4：返回结果

返回更新后的分镜列表，前端刷新状态指示器。

### 4.3 分镜融合图生成流程（`generate_storyboard_image`）

#### 步骤 1：校验输入

- 目标分镜 `imageState` 不能为 `running`（防止重复提交）。
- `imagePrompt` 不能为空。
- 引用的角色、场景、物品资产必须有 `imagePath`。

#### 步骤 2：持久化任务和业务状态（本地事务）

1. 创建 `Task` 记录，`type = 'generate_storyboard_image'`，关联 `storyboardId`。
2. 将分镜 `imageState` 更新为 `running`。

#### 步骤 3：提交远端请求

Node worker 组装图像生成请求：

1. 将 `imagePrompt`、引用资产的 `imagePath`（角色图、场景图、物品图）合并为图像生成 prompt。
2. 使用 `imageParamJson`（已合并参数）作为生成参数。
3. 调用火山引擎图像生成模型。

#### 步骤 4：轮询

同分镜生成流程，轮询图像生成任务状态。

#### 步骤 5：回写结果

1. 下载生成的图像到本地存储目录。
2. 更新 `fusedImagePath` 为本地路径。
3. 更新 `imageState = 'ready'`。

#### 步骤 6：失败补偿

1. 更新 `imageState = 'failed'`。
2. 记录错误信息到 `Task.errorMessage`。
3. 保留上一次成功的 `fusedImagePath`（如果有），用户可选择回滚。

## 5. 接口定义

### 5.1 Tauri Command 接口

以下接口通过 Tauri IPC 暴露给前端 React 调用。

#### 5.1.1 生成分镜

```ts
// 命令名：generate_storyboards
// 触发分镜生成任务
interface GenerateStoryboardsRequest {
  projectId: string;
  clipId: string;
}

interface GenerateStoryboardsResponse {
  taskId: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  storyboards?: Storyboard[];
  error?: string;
}
```

#### 5.1.2 更新分镜（单条）

```ts
// 命令名：update_storyboard
// 更新单条分镜字段，自动触发失效标记
interface UpdateStoryboardRequest {
  id: string;
  fields: Partial<Pick<Storyboard,
    'seqNum' | 'summary' | 'dialogue' | 'visualDescription' |
    'imagePrompt' | 'videoPrompt' |
    'characterIds' | 'sceneIds' | 'itemIds' |
    'imageParamJson' | 'videoParamJson' | 'voiceParamJson'
  >>;
  updatedAt: string; // 乐观锁
}

interface UpdateStoryboardResponse {
  storyboard: Storyboard;
  invalidated: {
    image: boolean;
    voice: boolean;
    video: boolean;
  };
}
```

#### 5.1.3 批量更新分镜

```ts
// 命令名：batch_update_storyboards
// 批量更新分镜字段（用于批量编辑、批量重排）
interface BatchUpdateStoryboardsRequest {
  updates: UpdateStoryboardRequest[];
}

interface BatchUpdateStoryboardsResponse {
  storyboards: Storyboard[];
  invalidatedSummary: {
    totalImageInvalidated: number;
    totalVoiceInvalidated: number;
    totalVideoInvalidated: number;
  };
}
```

#### 5.1.4 批量重排分镜

```ts
// 命令名：reorder_storyboards
// 拖拽排序后批量更新 seqNum
interface ReorderStoryboardsRequest {
  clipId: string;
  orderedIds: string[]; // 新顺序的分镜 ID 列表
}

interface ReorderStoryboardsResponse {
  storyboards: Storyboard[];
}
```

#### 5.1.5 生成单条分镜融合图

```ts
// 命令名：generate_storyboard_image
// 为单条分镜触发融合图生成任务
interface GenerateStoryboardImageRequest {
  storyboardId: string;
}

interface GenerateStoryboardImageResponse {
  taskId: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  fusedImagePath?: string;
  error?: string;
}
```

#### 5.1.6 批量生成分镜融合图

```ts
// 命令名：batch_generate_storyboard_images
// 为多条分镜批量触发融合图生成
interface BatchGenerateStoryboardImagesRequest {
  storyboardIds: string[];
}

interface BatchGenerateStoryboardImagesResponse {
  taskIds: string[];
  results: Array<{
    storyboardId: string;
    taskId: string;
    status: 'pending' | 'running' | 'success' | 'failed';
    fusedImagePath?: string;
    error?: string;
  }>;
}
```

#### 5.1.7 上传本地替代图

```ts
// 命令名：upload_storyboard_image
// 用户上传本地图片作为分镜融合图替代
interface UploadStoryboardImageRequest {
  storyboardId: string;
  imagePath: string; // 本地图片路径
}

interface UploadStoryboardImageResponse {
  storyboard: Storyboard;
}
```

#### 5.1.8 回滚融合图

```ts
// 命令名：rollback_storyboard_image
// 回滚到上一次成功的融合图
interface RollbackStoryboardImageRequest {
  storyboardId: string;
}

interface RollbackStoryboardImageResponse {
  storyboard: Storyboard;
  rolledBack: boolean;
}
```

#### 5.1.9 批量重算融合图

```ts
// 命令名：batch_regenerate_images
// 对所有 imageState = 'invalidated' 或 'failed' 的分镜批量重新生成融合图
interface BatchRegenerateImagesRequest {
  clipId: string;
  filter?: ('invalidated' | 'failed')[];
}

interface BatchRegenerateImagesResponse {
  taskIds: string[];
  triggeredCount: number;
}
```

#### 5.1.10 批量重算视频

```ts
// 命令名：batch_regenerate_videos
// 对所有 videoState = 'invalidated' 或 'failed' 的分镜批量重新生成视频
interface BatchRegenerateVideosRequest {
  clipId: string;
  filter?: ('invalidated' | 'failed')[];
}

interface BatchRegenerateVideosResponse {
  taskIds: string[];
  triggeredCount: number;
}
```

#### 5.1.11 合并参数预览

```ts
// 命令名：preview_merged_params
// 预览项目默认参数与分镜级参数合并后的最终参数（不保存）
interface PreviewMergedParamsRequest {
  storyboardId: string;
  overrides?: {
    imageParamJson?: string;
    videoParamJson?: string;
    voiceParamJson?: string;
  };
}

interface PreviewMergedParamsResponse {
  imageParamJson: string;
  videoParamJson: string;
  voiceParamJson: string;
  diffLog: Array<{
    field: string;
    projectDefault: string;
    storyboardOverride: string;
    merged: string;
  }>;
}
```

### 5.2 批量操作接口汇总

| 接口 | 用途 | 操作类型 |
|------|------|----------|
| `batch_update_storyboards` | 批量编辑分镜字段 | 同步 |
| `reorder_storyboards` | 拖拽重排序号 | 同步 |
| `batch_generate_storyboard_images` | 批量生成融合图 | 异步任务 |
| `batch_regenerate_images` | 批量重算失效融合图 | 异步任务 |
| `batch_regenerate_videos` | 批量重算失效视频 | 异步任务 |

## 6. 参数合并规则

### 6.1 合并原理

每条分镜的最终生成参数 = 项目默认参数 + 分镜级覆盖参数。

合并发生在以下时机：
- 分镜生成完成时（首次写入 `imageParamJson` 等）
- 用户编辑分镜参数并保存时
- 项目默认参数变更后批量刷新时

### 6.2 合并算法

```
对每个参数类别（image / video / voice）：

1. 解析 Project.default{Category}ParamJson 为 baseObject
2. 解析 Storyboard.{category}ParamJson 为 overrideObject
3. 深度合并：overrideObject 的每个 key 覆盖 baseObject 的同名 key
   - 如果 overrideObject 的 key 值为 null，则删除该 key（显式禁用）
   - 如果 overrideObject 的 key 不存在于 baseObject，则新增
   - 嵌套对象递归合并
4. 序列化合并结果为 JSON 字符串
5. 写回 Storyboard.{category}ParamJson
```

### 6.3 合并示例

```json
// 项目默认图像参数
{
  "model": "doubao-image-2.0",
  "size": "1024x1024",
  "style": "anime",
  "guidance_scale": 7.5,
  "negative_prompt": "blurry, low quality"
}

// 分镜级覆盖参数
{
  "size": "1792x1024",
  "guidance_scale": null,
  "seed": 42
}

// 合并结果
{
  "model": "doubao-image-2.0",
  "size": "1792x1024",
  "style": "anime",
  "guidance_scale": null,   // 显式禁用，生成时跳过该参数
  "negative_prompt": "blurry, low quality",
  "seed": 42                // 新增参数
}
```

### 6.4 参数类别

| 参数类别 | 项目默认字段 | 分镜字段 | 用途 |
|----------|-------------|---------|------|
| 图像 | `defaultImageParamJson` | `imageParamJson` | 融合图生成 |
| 视频 | `defaultVideoParamJson` | `videoParamJson` | 视频生成 |
| 语音 | `defaultVoiceParamJson` | `voiceParamJson` | 语音生成 |

## 7. 校验规则

### 7.1 前置校验清单（10 项）

分镜生成任务提交前，必须依次通过以下 10 项校验。任一失败即中止，返回对应的错误码和错误信息。

| 序号 | 校验项 | 校验逻辑 | 错误码 |
|------|--------|----------|--------|
| 1 | 项目 ID 不能为空 | `request.projectId` 必须为非空字符串 | `STORYBOARD_PROJECT_ID_EMPTY` |
| 2 | 片段 ID 不能为空 | `request.clipId` 必须为非空字符串 | `STORYBOARD_CLIP_ID_EMPTY` |
| 3 | 角色和场景不能同时为空 | 片段关联的 `Character[]` 和 `Scene[]` 不能同时为空数组 | `STORYBOARD_ASSETS_EMPTY` |
| 4 | 角色资产必须有图 | 所有引用的 `Character.imagePath` 必须为非空字符串且文件存在 | `STORYBOARD_CHARACTER_NO_IMAGE` |
| 5 | 物品资产必须有图 | 所有引用的 `Item.imagePath` 必须为非空字符串且文件存在（如果引用了物品） | `STORYBOARD_ITEM_NO_IMAGE` |
| 6 | 场景资产必须有图 | 所有引用的 `Scene.imagePath` 必须为非空字符串且文件存在 | `STORYBOARD_SCENE_NO_IMAGE` |
| 7 | 资产名称不能重复 | 同一项目下 `Character.name`、`Scene.name`、`Item.name` 各自不能重复 | `STORYBOARD_ASSET_NAME_DUPLICATE` |
| 8 | 剧本理解必须已完成 | `ClipScript.status` 必须为 `success`，且 `resultJson` 非空 | `STORYBOARD_SCRIPT_NOT_READY` |
| 9 | 分镜数量不超过 100 | 模型返回的分镜数组长度 ≤ 100 | `STORYBOARD_COUNT_EXCEEDED` |
| 10 | 图片地址长度不超过 255 字符 | 所有引用资产的 `imagePath` 长度 ≤ 255 | `STORYBOARD_IMAGE_PATH_TOO_LONG` |

### 7.2 编辑校验

| 校验项 | 校验逻辑 | 错误码 |
|--------|----------|--------|
| 镜号唯一 | 同一片段下 `seqNum` 不能重复 | `STORYBOARD_SEQ_DUPLICATE` |
| 镜号连续 | `seqNum` 从 1 开始，无空洞 | `STORYBOARD_SEQ_GAP` |
| 引用资产存在 | `characterIds`、`sceneIds`、`itemIds` 中的 ID 在资产表中存在 | `STORYBOARD_REF_NOT_FOUND` |
| 参数 JSON 合法 | `imageParamJson`、`videoParamJson`、`voiceParamJson` 为合法 JSON 字符串 | `STORYBOARD_PARAM_JSON_INVALID` |
| 乐观锁 | 提交的 `updatedAt` == 数据库当前值 | `STORYBOARD_VERSION_CONFLICT` |
| 提示词非空 | `imagePrompt` 和 `videoPrompt` 不能为空字符串 | `STORYBOARD_PROMPT_EMPTY` |

## 8. 失效与重算规则

### 8.1 失效规则矩阵

当分镜字段被编辑后，根据改动字段自动将下游产物标记为 `invalidated`。

| 改动字段 | 语音失效 (`voiceState`) | 融合图失效 (`imageState`) | 视频失效 (`videoState`) | 其他影响 |
|----------|:---:|:---:|:---:|------|
| `dialogue`（台词） | ✅ | — | ✅ | 语音需重新合成；视频需重新生成（ lip-sync 变化） |
| `visualDescription`（画面描述） | — | ✅ | ✅ | 融合图需重新生成；视频需重新生成 |
| `imagePrompt`（图像提示词） | — | ✅ | ✅ | 融合图需重新生成；视频需重新生成 |
| `videoPrompt`（视频提示词） | — | — | ✅ | 仅视频需重新生成 |
| `characterIds`（引用角色） | — | ✅ | ✅ | 角色图变化影响融合图；视频需重新生成 |
| `sceneIds`（引用场景） | — | ✅ | ✅ | 场景图变化影响融合图；视频需重新生成 |
| `itemIds`（引用物品） | — | ✅ | ✅ | 物品图变化影响融合图；视频需重新生成 |
| `seqNum`（镜号/顺序） | — | — | — | 导出顺序变化；时间线需重新计算；不触发媒体重算 |
| `imageParamJson`（图像参数） | — | ✅ | ✅ | 参数变化影响融合图生成；视频需重新生成 |
| `videoParamJson`（视频参数） | — | — | ✅ | 仅视频参数变化 |
| `voiceParamJson`（语音参数） | ✅ | — | ✅ | 语音需重新合成；视频需重新生成 |
| `summary`（摘要） | — | — | — | 无下游影响（仅展示用途） |
| `sourceText`（原文） | — | — | — | 无下游影响（仅展示用途） |

### 8.2 失效标记执行

编辑保存时，在同一 SQLite 事务中：

1. 比较修改前后的字段值，识别改动的字段集合 `changedFields`。
2. 查阅失效规则矩阵，得出需要失效的产物类型集合 `invalidatedTargets`。
3. 对每个需要失效的产物，更新对应的状态字段为 `invalidated`。
4. 返回 `invalidated` 摘要给前端，前端据此显示"需要重算"的视觉指示。

### 8.3 失效后的重算触发

失效标记仅表示"产物已过期"，不自动触发重算。重算由用户显式触发：

- 单条重算：用户在分镜详情区点击"重新生成"按钮。
- 批量重算：用户在列表区选择多条分镜，点击"批量重算"。
- 一键重算：用户点击"重算所有失效项"，系统自动筛选 `imageState = 'invalidated'` 或 `videoState = 'invalidated'` 的分镜并批量提交任务。

### 8.4 顺序改动的影响

`seqNum` 改动不触发任何媒体失效，但影响：

- 导出顺序：最终视频拼接按 `seqNum` 排序。
- 时间线计算：导出时需根据每条分镜的 `voiceDuration` 或 `videoDuration` 重新计算时间线偏移。
- 前端列表展示顺序立即更新。

## 9. 分镜生成提示词模板

### 9.1 系统提示词（System Prompt）

```
你是一个专业的影视分镜编剧。你的任务是根据给定的片段正文、剧本分析结果和可用资产，将片段拆分为多个结构化分镜。

输出要求：
1. 输出必须是 JSON 数组，每个元素代表一个分镜。
2. 每个分镜包含以下字段：
   - seqNum: 镜号（整数，从 1 开始连续递增）
   - summary: 该分镜的简短摘要（一句话）
   - dialogue: 该分镜中的台词（如有旁白或对白）
   - visualDescription: 画面描述（镜头类型、人物动作、场景环境、氛围）
   - imagePrompt: 图像生成提示词（英文，用于 AI 图像生成，描述画面中的关键视觉元素）
   - videoPrompt: 视频生成提示词（英文，用于 AI 视频生成，描述镜头运动和动态变化）
   - characterIds: 出场角色资产 ID 列表
   - sceneIds: 出现场景资产 ID 列表
   - itemIds: 出场物品资产 ID 列表

规则：
- 分镜数量不超过 100 条。
- 每个分镜的 imagePrompt 应包含角色外貌特征、场景环境、光影氛围的描述。
- 每个分镜的 videoPrompt 应包含镜头运动方式（如 pan、zoom、static）、人物动态、环境变化。
- characterIds、sceneIds、itemIds 中的 ID 必须来自下方提供的可用资产列表。
- 台词与画面描述使用中文，imagePrompt 和 videoPrompt 使用英文。
- 每条分镜的台词应属于同一说话人。如果原始脚本中一段对白包含多个角色交替说话，需按角色将对话拆分为多条分镜，确保每条分镜只有一个说话人。旁白算作独立的说话人。
```

### 9.2 用户提示词（User Prompt）模板

```
## 片段正文
{clip.sourceText}

## 剧本分析结果
{ClipScript.resultJson}

## 可用资产

### 角色
{characterList.map(c => `- ID: ${c.id} | 名称: ${c.name} | 外貌描述: ${c.appearance || '无'}`).join('\n')}

### 场景
{sceneList.map(s => `- ID: ${s.id} | 名称: ${s.name} | 环境描述: ${s.description || '无'}`).join('\n')}

### 物品
{itemList.map(i => `- ID: ${i.id} | 名称: ${i.name} | 描述: ${i.description || '无'}`).join('\n')}

## 项目风格
{project.style || '通用'}

请根据以上信息生成分镜列表。
```

### 9.3 输出校验

模型返回后，Node worker 校验：

```ts
interface StoryboardModelOutput {
  seqNum: number;
  summary: string;
  dialogue: string;
  visualDescription: string;
  imagePrompt: string;
  videoPrompt: string;
  characterIds: string[];
  sceneIds: string[];
  itemIds: string[];
}

// 校验规则：
// 1. 顶层为 JSON 数组
// 2. 数组长度 1~100
// 3. seqNum 从 1 连续递增
// 4. characterIds / sceneIds / itemIds 中的每个 ID 在可用资产列表中存在
// 5. imagePrompt 和 videoPrompt 非空
// 6. visualDescription 非空
```

## 10. 异常与恢复

### 10.1 任务级异常

| 异常场景 | 处理方式 | 恢复操作 |
|----------|----------|----------|
| 火山引擎 API 调用失败 | 任务标记 `failed`，记录错误信息 | 用户重新触发生成 |
| 模型返回非法 JSON | 任务标记 `failed`，记录原始输出 | 用户重新触发生成 |
| 输出校验失败（引用资产不存在等） | 任务标记 `failed`，记录校验错误 | 用户检查资产后重新触发 |
| 轮询超时（6 分钟未完成） | 任务标记 `failed`，记录超时 | 用户重新触发生成 |
| Node worker 崩溃 | 任务保持 `running`，下次启动时扫描超时任务（超过 10 分钟）并标记为 `failed` | 用户重新触发生成 |
| SQLite 事务失败 | 回滚事务，任务不创建 | 用户重新触发 |

### 10.2 编辑级异常

| 异常场景 | 处理方式 | 恢复操作 |
|----------|----------|----------|
| 乐观锁冲突 | 返回当前数据库版本，提示用户刷新 | 前端拉取最新数据后重新提交 |
| 参数 JSON 非法 | 返回字段级错误信息 | 用户修正后重新保存 |
| 引用资产已被删除 | 返回 `STORYBOARD_REF_NOT_FOUND` | 用户重新选择资产后保存 |

### 10.3 数据一致性保证

- **分镜生成**：采用"全有或全无"策略——模型返回的分镜全部校验通过后才批量写入；任一条校验失败，整批不写入。
- **分镜编辑**：单条编辑失败不影响其他分镜；批量编辑中单条失败时，成功的不回滚，失败的返回错误列表。
- **失效标记**：与字段更新在同一事务中完成，保证不会出现"字段已改但下游未失效"的不一致状态。

## 11. UI 交互要求

### 11.1 列表区

| 列 | 说明 |
|----|------|
| 镜号 | `seqNum`，可拖拽排序 |
| 状态 | 三列状态指示器（图像/语音/视频），用颜色区分 `pending`/`running`/`ready`/`failed`/`invalidated` |
| 缩略图 | `fusedImagePath` 的缩略图，无图时显示占位符 |
| 台词摘要 | `dialogue` 的前 30 字符 |
| 时长 | `voiceDuration` 或 `videoDuration`，格式为 `mm:ss` |

交互：
- 点击行 → 选中并在详情区展开该分镜
- 拖拽行 → 触发 `reorder_storyboards`
- 多选行 → 启用批量操作工具栏

### 11.2 详情区

可编辑字段：

| 字段 | 编辑方式 | 失效影响 |
|------|----------|----------|
| 原文（`sourceText`） | 只读文本框 | 无 |
| 摘要（`summary`） | 文本输入框 | 无 |
| 台词（`dialogue`） | 多行文本输入框 | 语音 + 视频 |
| 画面描述（`visualDescription`） | 多行文本输入框 | 融合图 + 视频 |
| 图像提示词（`imagePrompt`） | 多行文本输入框 | 融合图 + 视频 |
| 视频提示词（`videoPrompt`） | 多行文本输入框 | 视频 |
| 引用角色（`characterIds`） | 资产选择器（多选） | 融合图 + 视频 |
| 引用场景（`sceneIds`） | 资产选择器（多选） | 融合图 + 视频 |
| 引用物品（`itemIds`） | 资产选择器（多选） | 融合图 + 视频 |
| 图像参数（`imageParamJson`） | JSON 编辑器 + 预览合并结果 | 融合图 + 视频 |
| 视频参数（`videoParamJson`） | JSON 编辑器 + 预览合并结果 | 视频 |
| 语音参数（`voiceParamJson`） | JSON 编辑器 + 预览合并结果 | 语音 + 视频 |

交互：
- 字段修改后实时显示"将导致 XX 失效"的提示。
- 保存按钮触发 `update_storyboard`，返回后更新状态指示器。
- 参数编辑器旁有"预览合并参数"按钮，调用 `preview_merged_params` 接口。

### 11.3 批量操作工具栏

在列表区多选分镜后显示：

| 操作 | 接口 | 说明 |
|------|------|------|
| 批量编辑参数 | `batch_update_storyboards` | 对选中分镜统一设置参数覆盖 |
| 批量重排 | `reorder_storyboards` | 重新排序选中分镜的相对顺序 |
| 批量重算融合图 | `batch_generate_storyboard_images` | 对选中分镜触发融合图生成 |
| 批量重算失效融合图 | `batch_regenerate_images` | 对选中分镜中 `invalidated`/`failed` 的触发重算 |
| 批量重算失效视频 | `batch_regenerate_videos` | 对选中分镜中 `invalidated`/`failed` 的触发重算 |

### 11.4 全局操作

| 操作 | 接口 | 说明 |
|------|------|------|
| 一键重算所有失效项 | `batch_regenerate_images` + `batch_regenerate_videos` | 对整片段所有 `invalidated`/`failed` 的分镜批量重算 |
| 上传替代图 | `upload_storyboard_image` | 为单条分镜上传本地图片替代融合图 |
| 回滚融合图 | `rollback_storyboard_image` | 回滚到上一次成功的融合图 |

### 11.5 状态颜色规范

| 状态 | 颜色 | 含义 |
|------|------|------|
| `pending` | 灰色 | 等待生成 |
| `running` | 蓝色（动画） | 正在生成 |
| `ready` | 绿色 | 已完成 |
| `failed` | 红色 | 生成失败 |
| `invalidated` | 橙色 | 已过期，需重算 |

## 12. 最低落地清单

以下为本模块必须实现的最小功能集，按优先级排序：

| 序号 | 功能 | 说明 |
|------|------|------|
| 1 | 分镜表（SQLite） | `storyboards` 表，包含所有 `Storyboard` 类型字段 |
| 2 | 分镜生成任务（`generate_storyboards`） | 完整走通统一任务模板六步流程 |
| 3 | 10 项前置校验 | 分镜生成提交前的完整校验清单 |
| 4 | 分镜生成提示词模板 | System Prompt + User Prompt + 输出校验 |
| 5 | 参数合并引擎 | 项目默认参数 + 分镜级覆盖的深度合并 |
| 6 | 分镜单条编辑 | `update_storyboard` 接口 + 乐观锁 |
| 7 | 失效标记引擎 | 编辑保存时按失效规则矩阵自动标记下游产物 |
| 8 | 分镜批量编辑保存 | `batch_update_storyboards` 接口 |
| 9 | 分镜顺序编辑器 | `reorder_storyboards` 接口 + 拖拽 UI |
| 10 | 资产引用选择器 | 前端组件，支持多选角色/场景/物品 |
| 11 | 分镜融合图生成任务（`generate_storyboard_image`） | 完整走通统一任务模板六步流程 |
| 12 | 批量生成融合图 | `batch_generate_storyboard_images` 接口 |
| 13 | 上传本地替代图 | `upload_storyboard_image` 接口 |
| 14 | 回滚融合图 | `rollback_storyboard_image` 接口 |
| 15 | 批量重算失效项 | `batch_regenerate_images` + `batch_regenerate_videos` |
| 16 | 分镜列表区 UI | 镜号、状态、缩略图、台词摘要、时长 |
| 17 | 分镜详情区 UI | 所有可编辑字段 + 失效提示 |
| 18 | 批量操作工具栏 | 多选后的批量操作入口 |
| 19 | 任务异常恢复 | 超时任务扫描 + 失败重试机制 |
| 20 | 参数合并预览 | `preview_merged_params` 接口 + diff 展示 |
