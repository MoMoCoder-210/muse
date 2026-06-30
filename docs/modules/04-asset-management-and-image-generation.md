# 模块 04：资产管理与资产生图

## 1. 模块职责

本模块负责角色（character）、场景（scene）、物品（item）三类资产的统一管理及资产图像生成。具体职责包括：

- 项目级资产库的增删改查与持久化（SQLite）
- 资产与片段（Clip）的关联关系维护
- 资产去重检测与冲突处理（同名合并、相似度提示、类型冲突）
- 资产提示词组装与火山引擎图像生成调用
- 生成图片的下载落盘、缩略图生成、结果回写
- 批量生图的任务编排与并发控制
- 资产变更后对引用该资产的分镜进行失效标记（invalidation engine）
- 项目默认参数与分镜级参数的合并规则执行

本模块运行在 Tauri 2 桌面端框架内，前端使用 React 渲染资产管理界面，后端通过 Tauri Command 与 Rust 侧交互，耗时任务（火山引擎 API 调用、图片下载、缩略图生成）委托给 Node worker 执行，所有业务数据持久化在本地 SQLite 数据库中。

## 2. 设计约束

1. **技术栈固定**：Tauri 2（Rust 后端） + React（前端） + SQLite（本地数据库） + Node worker（异步任务执行） + 火山引擎（图像生成远端服务）。
2. **单机离线优先**：所有资产元数据存储在本地 SQLite，不依赖远端数据库。火山引擎仅在生图时被调用，网络不可用时资产编辑功能不受影响。
3. **任务统一调度**：所有生图操作必须走统一任务系统（模块 08），任务类型为 `generate_asset_image`，不允许绕过任务系统直接调用火山引擎 API。
4. **文件落盘规范**：生成图片必须下载到本地项目目录，缩略图同步生成，前端列表页只加载缩略图。
5. **单资产单任务**：每个资产同一时间最多有一个 `generate_asset_image` 任务处于 `pending` 或 `running` 状态，重复提交将被拒绝或合并。
6. **资产变更可追溯**：资产的 prompt、description、referenceImagePath 等关键字段变更后，必须触发分镜失效标记，确保下游分镜图不会使用过期数据。
7. **并发安全**：批量生图时通过任务队列并发控制机制限制同时处于 `running` 状态的任务数量，避免火山引擎 API 限流。

## 3. 数据结构

### 3.1 Asset

```ts
type Asset = {
  id: string;
  projectId: string;
  clipId?: string;
  type: 'character' | 'scene' | 'item';
  name: string;
  description: string;
  prompt: string;
  referenceImagePath?: string;
  generatedImagePath?: string;
  generatedImageThumbPath?: string;
  source: 'model' | 'manual' | 'imported';
  status: 'draft' | 'confirmed' | 'image_pending' | 'image_ready' | 'failed';
  createdAt: string;
  updatedAt: string;
};
```

字段语义：

| 字段 | 说明 |
|---|---|
| `id` | 资产唯一 ID，UUID v4 |
| `projectId` | 所属项目 ID |
| `clipId` | 关联片段 ID，项目级资产可为空 |
| `type` | 资产类型：角色/场景/物品 |
| `name` | 资产名称，同一项目内同类型不允许完全重名 |
| `description` | 自然语言描述，用于辅助生图和展示 |
| `prompt` | 生图提示词，可手动编辑或由描述自动组装 |
| `referenceImagePath` | 参考图本地路径（可选） |
| `generatedImagePath` | 生成图原图本地路径 |
| `generatedImageThumbPath` | 生成图缩略图本地路径 |
| `source` | 来源：模型生成/手动创建/外部导入 |
| `status` | 生命周期状态（见下方状态机） |
| `createdAt` / `updatedAt` | ISO 8601 时间戳 |

**Asset 状态机：**

```
draft ──(用户确认)──> confirmed ──(提交生图)──> image_pending ──(生图成功)──> image_ready
  │                      │                        │
  └──(提交生图)──────────>│                        └──(生图失败)──> failed
                           │                                           │
                           └───────────────────────────────────────────┘
                                         (用户重试生图)
```

- `draft`：刚创建，尚未确认
- `confirmed`：用户已确认资产信息，可以提交生图
- `image_pending`：生图任务正在执行中
- `image_ready`：生图完成，`generatedImagePath` 已填充
- `failed`：生图失败，可重试

### 3.2 AssetImageTaskPayload

任务 `generate_asset_image` 的 inputJson 结构：

```ts
type AssetImageTaskPayload = {
  assetId: string;
  prompt: string;
  referenceImages?: string[];  // 本地参考图路径列表
  imageParam: ImageParam;      // 来自模块参数定义
};
```

### 3.3 ImageParam

```ts
type ImageParam = {
  model: string;
  resolution: string;
  quality: string;
  amount: number;
  seed?: number;
  aspectRatio?: string;
};
```

- `model`：火山引擎图像模型 ID
- `resolution`：输出分辨率，如 `1024x1024`
- `quality`：质量档位，如 `standard` / `hd`
- `amount`：生成数量，默认 1
- `seed`：随机种子（可选），用于可复现
- `aspectRatio`：宽高比（可选），如 `16:9`

### 3.4 数据库表设计

```sql
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  clip_id TEXT,
  type TEXT NOT NULL CHECK(type IN ('character','scene','item')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  reference_image_path TEXT,
  generated_image_path TEXT,
  generated_image_thumb_path TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('model','manual','imported')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','image_pending','image_ready','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(clip_id) REFERENCES clips(id) ON DELETE SET NULL
);

CREATE INDEX idx_assets_project_type ON assets(project_id, type);
CREATE INDEX idx_assets_clip ON assets(clip_id);
CREATE INDEX idx_assets_status ON assets(status);
```

## 4. 详细流程

### 4.1 资产创建流程

**触发场景**：
- 剧本解析（模块 03）自动提取角色/场景/物品
- 用户在资产管理页手动新建
- 用户从外部导入图片创建资产

**流程**：

1. **校验输入**：`projectId` 必须存在；`type` 必须为合法枚举；`name` 非空且不超过 100 字符。
2. **去重检测**（见第 4.6 节）：检查同项目内是否已有同名同类型资产。
3. **组装 prompt**：若用户未手动填写 prompt，则根据 `name` + `description` 自动组装基础提示词。组装规则：
   - 角色：`"{name}, {description}, full body, character design, high quality"`
   - 场景：`"{name}, {description}, environment, wide shot, detailed background"`
   - 物品：`"{name}, {description}, product shot, centered, clean background"`
4. **持久化**：写入 SQLite `assets` 表，`status` 初始为 `draft`（手动创建）或 `confirmed`（模型提取后自动确认），`source` 设置为对应来源。
5. **返回资产对象**给前端。

### 4.2 资产编辑流程

**可编辑字段**：`name`、`description`、`prompt`、`referenceImagePath`、`type`、`clipId`。

**流程**：

1. **读取资产**：从 SQLite 查询当前资产，确认存在。
2. **校验**：同创建校验规则。
3. **检测变更**：比较新旧值，记录哪些关键字段发生了变化（`name`、`description`、`prompt`、`referenceImagePath` 被视为关键字段）。
4. **持久化**：更新 `assets` 表，刷新 `updatedAt`。
5. **触发失效标记**：如果有关键字段变更，调用失效标记引擎（见第 7 节），将引用该资产的分镜标记为 `invalidated`。
6. **状态回退**：如果资产当前为 `image_ready` 且 `prompt` 或 `referenceImagePath` 发生变更，则状态回退为 `confirmed`（表示生成图已与提示词不匹配，需要重新生图）。前端应提示用户"资产已修改，建议重新生成图片"。

### 4.3 资产生图完整任务流程

本流程严格遵循模块 08 的统一任务模板：校验输入 → 持久化任务和业务状态（本地事务）→ 提交远端请求 → 轮询 → 回写结果 → 失败补偿。

#### 步骤 1：校验输入

- 资产 ID 必须存在且属于当前项目
- 资产 `status` 必须为 `confirmed` 或 `failed`（`draft` 状态需先确认，`image_pending` 状态拒绝重复提交）
- `prompt` 非空
- `imageParam.model` 必须为火山引擎支持的模型 ID
- `imageParam.resolution` 必须为合法分辨率字符串
- `imageParam.amount` 在 1–4 之间
- 如有 `referenceImages`，每个路径指向的文件必须存在

#### 步骤 2：持久化任务和业务状态（本地事务）

在单个 SQLite 事务中：

1. 创建 Task 记录，`type = 'generate_asset_image'`，`status = 'pending'`，`inputJson` 为序列化的 `AssetImageTaskPayload`。
2. 更新 Asset 记录：`status = 'image_pending'`，`updatedAt = now()`。
3. 提交事务。若事务失败，任务不被创建，资产状态不变。

#### 步骤 3：提交远端请求

Node worker 接管任务执行（任务状态变为 `running`）：

1. 从 inputJson 中解析 `prompt`、`referenceImages`、`imageParam`。
2. 如有参考图，将本地图片读取为 base64 编码。
3. 组装火山引擎图像生成 API 请求体：
   ```json
   {
     "model": "<imageParam.model>",
     "prompt": "<prompt>",
     "image": "<base64 of reference image, if any>",
     "size": "<resolution, e.g. 1024x1024>",
     "quality": "<imageParam.quality>",
     "n": "<imageParam.amount>",
     "seed": "<imageParam.seed, if provided>",
     "response_format": "url"
   }
   ```
4. 调用火山引擎 API，发送 POST 请求。
5. 解析响应，提取远端任务 ID 或直接返回的图片 URL。

#### 步骤 4：轮询

- 如果火山引擎 API 返回的是异步任务 ID（需要轮询）：
  1. 将 Task 状态更新为 `waiting_remote`。
  2. 以指数退避策略轮询（初始间隔 3 秒，最大间隔 30 秒，最多轮询 60 次，总超时 5 分钟）。
  3. 每次轮询前检查 Task 是否被用户取消（`status == 'canceled'`），如已取消则终止轮询。
  4. 轮询成功拿到图片 URL 后，进入下载阶段。
- 如果火山引擎 API 直接返回图片 URL（同步模式）：
  1. 跳过轮询，直接进入下载阶段。

#### 步骤 5：下载图片与缩略图生成

1. 将 Task 状态更新为 `downloading`。
2. 下载原始图片到本地项目目录：
   - 路径规则：`{projectDir}/assets/{type}s/{assetId}.png`
   - 若 `amount > 1`，多张图命名为 `{assetId}-1.png`、`{assetId}-2.png` 等，仅将第一张作为主图回写到 Asset。
3. 生成缩略图：
   - 使用 Node worker 中的图像处理库（如 `sharp`）将原图缩放至最大边 256px。
   - 输出格式 JPEG，质量 80。
   - 路径：`{projectDir}/assets/{type}s/thumbs/{assetId}.jpg`
4. 返回本地路径。

#### 步骤 6：回写结果

在单个 SQLite 事务中：

1. 更新 Asset 记录：
   - `generatedImagePath = <下载路径>`
   - `generatedImageThumbPath = <缩略图路径>`
   - `status = 'image_ready'`
   - `updatedAt = now()`
2. 更新 Task 记录：`status = 'success'`，`outputJson` 存储生成图片路径等信息。
3. 提交事务。

**缓存**：生成结果按缓存策略写入 `cache/model-results/` 目录（见模块 08 第 10 节）。缓存键 = hash(assetId + prompt + referenceImages + imageParam + model)。相同 prompt 和参数重复生成时命中缓存，跳过 API 调用。

#### 步骤 7：触发分镜同步

- 资产图首次生成成功后，调用失效标记引擎，将引用该资产的分镜标记为 `invalidated`（因为分镜现在可以使用真实的资产图了）。

### 4.4 批量生图策略与并发控制

**批量范围**：

| 批量类型 | 选择条件 |
|---|---|
| 当前片段全部资产 | `clipId = <当前片段>` 且 `status IN ('confirmed', 'failed')` |
| 当前项目全部角色 | `projectId = <当前项目>` 且 `type = 'character'` 且 `status IN ('confirmed', 'failed')` |
| 当前项目全部未生成资产 | `projectId = <当前项目>` 且 `status IN ('confirmed', 'failed')` |

**执行策略**：

1. **任务拆分**：为本次批量操作生成一个 batchId（UUID），所有创建的任务共享此 batchId。为每个符合条件的资产创建独立的 `generate_asset_image` 任务，每个任务 inputJson 只包含单个资产。不做巨型批量任务。
2. **并发控制**：
   - 通过任务队列的并发限制配置，限制同时处于 `running` 状态的 `generate_asset_image` 任务数量。
   - 默认并发上限：3（可配置）。
   - 超过上限的任务保持 `pending` 状态，等待前面任务完成后再被调度。
3. **参数统一**：批量生图时所有任务共享同一组 `ImageParam`（用户在批量生图弹窗中指定），不允许每个资产使用不同参数。
4. **失败隔离**：单个资产生图失败不影响其他资产。失败任务的 Asset 状态变为 `failed`，其他任务继续执行。
5. **进度反馈**：前端通过轮询或事件订阅获取批量进度（已完成/总数）。
6. **取消支持**：用户可取消整个批量操作。取消时，`UPDATE tasks SET status = 'canceled' WHERE batch_id = ? AND status = 'pending'`，running 状态任务在下次轮询检查时终止。已完成的子任务不回滚。
7. **批次进度**：批次进度通过 batchId 查询：`SELECT count(*) FROM tasks WHERE batch_id = ? AND status = 'success'` / `SELECT count(*) FROM tasks WHERE batch_id = ?`。前端通过 batch_progress 事件实时更新。

### 4.5 资产删除流程

1. **校验**：确认资产存在且属于当前项目。
2. **检查引用**：查询是否有分镜引用该资产。如果有，提示用户"该资产被 N 个分镜引用，删除后这些分镜将失去该资产引用"。
3. **删除文件**：如果 `generatedImagePath` 存在，删除原图文件；如果 `generatedImageThumbPath` 存在，删除缩略图文件。
4. **删除记录**：从 SQLite `assets` 表删除记录。
5. **触发失效标记**：引用该资产的分镜标记为 `invalidated`。

### 4.6 资产去重详细规则

#### 4.6.1 同名合并

**触发条件**：新创建资产时，同项目内已存在 `type` 相同且 `name` 完全相同的资产（忽略首尾空格，不区分大小写）。

**处理方式**：

1. 如果新资产 `source = 'model'`（剧本解析）且已有资产 `source` 也为 `'model'`：
   - 不创建新记录。
   - 合并 `description`：取两者中较长的描述（信息量更大）。
   - 合并 `prompt`：如果已有 prompt 为空则用新 prompt 覆盖，否则保留已有 prompt。
   - 更新 `updatedAt`。
2. 如果新资产 `source = 'model'` 且已有资产 `source` 为 `'manual'` 或 `'imported'`：
   - 不创建新记录。
   - 保留用户手动创建的资产数据，仅将新资产的 `description` 追加到已有资产（如果已有描述不包含新描述内容）。
3. 如果新资产 `source = 'manual'` 或 `'imported'`：
   - 拒绝创建，返回冲突提示："已存在同名同类型资产「{name}」，请使用其他名称或编辑已有资产。"

#### 4.6.2 相似度提示

**触发条件**：新创建资产时，同项目内同类型不存在完全同名资产，但存在名称高度相似的资产。

**相似度判定**：

- 使用编辑距离（Levenshtein distance）计算名称相似度。
- 归一化相似度 = `1 - (editDistance / max(len(a), len(b)))`。
- 阈值：相似度 >= 0.8 时触发提示。

**处理方式**：

- 不自动合并，向前端返回相似资产列表和相似度分数。
- 前端展示提示："检测到相似资产「{existingName}」（相似度 {score}%），是否仍要创建新资产？"
- 用户选择"仍然创建"则正常创建；选择"查看已有"则跳转到已有资产。

#### 4.6.3 类型冲突

**触发条件**：新创建资产时，同项目内存在 `name` 相同但 `type` 不同的资产。

**处理方式**：

- 允许创建（不同类型的同名资产是合法的，如一个叫"城堡"的场景和一个叫"城堡"的物品）。
- 前端返回警告提示："项目中已存在名为「{name}」的{otherType}资产，请确认类型选择正确。"
- 不阻止操作，仅提示。

## 5. 接口定义

### 5.1 Tauri Command 接口

以下接口均通过 Tauri 2 的 `invoke` 机制从前端 React 调用。

#### `asset_create`

```ts
invoke('asset_create', {
  projectId: string,
  clipId?: string,
  type: 'character' | 'scene' | 'item',
  name: string,
  description?: string,
  prompt?: string,
  referenceImagePath?: string,
  source?: 'model' | 'manual' | 'imported',
}) => Promise<{ asset: Asset; dedupInfo?: DedupInfo }>
```

返回值中 `dedupInfo` 在触发相似度提示时包含：

```ts
type DedupInfo = {
  kind: 'similar';
  similarAssets: Array<{ asset: Asset; score: number }>;
};
```

#### `asset_update`

```ts
invoke('asset_update', {
  assetId: string,
  patch: Partial<Pick<Asset, 'name' | 'description' | 'prompt' | 'referenceImagePath' | 'type' | 'clipId'>>,
}) => Promise<{ asset: Asset; invalidatedClipCount: number }>
```

返回 `invalidatedClipCount` 表示本次编辑触发了多少个分镜的失效标记。

#### `asset_delete`

```ts
invoke('asset_delete', { assetId: string }) => Promise<{ deleted: boolean; invalidatedClipCount: number }>
```

#### `asset_list`

```ts
invoke('asset_list', {
  projectId: string,
  type?: 'character' | 'scene' | 'item',
  clipId?: string,
  status?: Asset['status'],
  search?: string,
}) => Promise<{ assets: Asset[] }>
```

#### `asset_get`

```ts
invoke('asset_get', { assetId: string }) => Promise<{ asset: Asset | null }>
```

#### `asset_generate_image`

提交单个资产生图任务。

```ts
invoke('asset_generate_image', {
  assetId: string,
  imageParam: ImageParam,
  promptOverride?: string,  // 覆盖资产自身的 prompt
}) => Promise<{ taskId: string }>
```

内部流程：校验 → 创建任务（status=pending）→ 更新资产 status=image_pending → 返回 taskId。Node worker 异步执行实际生图。

#### `asset_batch_generate_image`

批量提交生图任务。

```ts
invoke('asset_batch_generate_image', {
  projectId: string,
  scope: 'clip_all' | 'project_characters' | 'project_ungenerated',
  clipId?: string,  // scope='clip_all' 时必填
  imageParam: ImageParam,
}) => Promise<{ taskIds: string[]; skippedAssetIds: string[] }>
```

`skippedAssetIds` 包含因状态不合法（如已是 `image_pending`）而跳过的资产。

#### `asset_confirm`

将 `draft` 状态资产确认为 `confirmed`。

```ts
invoke('asset_confirm', { assetId: string }) => Promise<{ asset: Asset }>
```

#### `asset_replace_image`

手动替换资产生成图（用户上传外部图片替代 AI 生成结果）。

```ts
invoke('asset_replace_image', {
  assetId: string,
  imagePath: string,  // 用户选择的本地图片路径
}) => Promise<{ asset: Asset }>
```

内部流程：复制图片到 `assets/{type}s/` 目录 → 生成缩略图 → 更新 Asset 的 `generatedImagePath`、`generatedImageThumbPath`、`status = 'image_ready'` → 触发分镜失效标记。

### 5.2 前端 React 组件接口

资产管理页通过 React Context 或 Zustand store 管理状态，核心方法：

```ts
interface AssetStore {
  assets: Asset[];
  loading: boolean;
  filter: { type?: Asset['type']; status?: Asset['status']; search: string };
  selectedIds: Set<string>;
  // 操作方法
  loadAssets: (projectId: string) => Promise<void>;
  createAsset: (input: AssetCreateInput) => Promise<void>;
  updateAsset: (assetId: string, patch: Partial<Asset>) => Promise<void>;
  deleteAsset: (assetId: string) => Promise<void>;
  batchGenerate: (scope: BatchScope, param: ImageParam) => Promise<void>;
  generateSingle: (assetId: string, param: ImageParam) => Promise<void>;
}
```

## 6. 校验规则

### 6.1 资产名称校验

- 非空，去除首尾空格后长度 1–100 字符。
- 不允许包含换行符。
- 不允许包含文件系统非法字符：`< > : " / \ | ? *`。
- 同项目同类型内忽略大小写唯一（去重合并除外）。

### 6.2 资产描述校验

- 最大长度 2000 字符。
- 允许为空字符串。

### 6.3 资产提示词校验

- 生图提交时 `prompt` 非空。
- 最大长度 4000 字符。
- 不允许包含火山引擎 API 的禁止词汇（由 Node worker 侧在提交前做关键词过滤，命中则拒绝任务并返回错误信息）。

### 6.4 参考图校验

- 文件格式：PNG、JPG、JPEG、WEBP。
- 文件大小：不超过 10MB。
- 图片分辨率：单边不低于 256px，单边不超过 4096px。
- 路径必须为本地可访问路径。

### 6.5 ImageParam 校验

| 字段 | 校验规则 |
|---|---|
| `model` | 必须在火山引擎已配置模型列表中 |
| `resolution` | 格式 `WxH`，如 `1024x1024`；宽高均在 512–2048 之间 |
| `quality` | 枚举值 `standard` 或 `hd` |
| `amount` | 整数，1–4 |
| `seed` | 可选，正整数，0–4294967295 |
| `aspectRatio` | 可选，格式 `W:H`，如 `16:9`；与 `resolution` 不冲突时生效 |

## 7. 失效与重算规则

### 7.1 失效标记引擎

**目的**：当资产发生变更时，自动标记引用该资产的分镜为"需重算"状态，确保分镜融合图不会使用过期的资产数据。

**触发事件**：

| 事件 | 是否触发失效标记 | 说明 |
|---|---|---|
| 资产图首次生成成功 | 是 | 分镜现在可使用真实资产图 |
| 资产图被替换 | 是 | 资产图已变更 |
| 资产名称修改 | 是 | 分镜提示词中可能引用了资产名称 |
| 资产描述修改 | 是 | 分镜提示词可能包含资产描述 |
| 资产提示词修改 | 否（直接回退资产状态为 confirmed） | 提示词变更影响下次生图，不影响已有分镜 |
| 资产参考图更换 | 是 | 参考图变更可能影响生图结果 |
| 资产被删除 | 是 | 分镜失去该资产引用 |

**失效标记执行流程**：

1. **查找引用关系**：查询 `storyboard_assets` 关联表（见模块 09），找到所有引用该资产且属于同一项目的分镜。关联表支持高效的反向查询，无需全表扫描 JSON 数组。
2. **判断分镜当前状态**：
   - 如果分镜尚未生成融合图（`imageState` 为 `pending`）：仅更新引用缓存，不额外标记（因为本就没有需要失效的图）。
   - 如果分镜已生成融合图（`imageState` 为 `ready`）：将 `imageState` 更新为 `invalidated`。
3. **批量更新**：使用单条 SQL 批量更新所有受影响分镜，避免逐条查询。
4. **返回计数**：返回被标记为 `invalidated` 的分镜数量，供前端展示提示。

### 7.2 参数合并规则

**场景**：分镜在生成融合图时需要使用图像参数。参数来源有两个层级：

1. **项目默认参数**：项目级配置的 `ImageParam`，作为基线。
2. **分镜级参数覆盖**：单个分镜可以覆盖部分参数字段。

**合并规则**：

```
finalParam = { ...projectDefaultParam, ...clipOverrideParam }
```

- 浅合并：分镜级参数中显式设置的字段覆盖项目默认参数的对应字段。
- 未在分镜级参数中设置的字段使用项目默认值。
- 资产生图（本模块）使用的参数来源不同于分镜融合图：
  - 资产生图参数来自 `asset_generate_image` 接口传入的 `imageParam`。
  - 如果用户未显式传参，使用项目默认参数。
  - 资产生图不使用分镜级参数覆盖（资产是项目级或片段级资源，不属于具体分镜）。

**参数合并校验**：

- 合并后的参数必须通过第 6.5 节的校验。
- 如果合并后参数不合法（如分镜级覆盖了非法分辨率），使用项目默认参数作为 fallback，并记录警告日志。

### 7.3 分镜失效后的用户交互

- 前端在分镜列表中以视觉标识（如黄色边框 + "需更新"标签）展示 `invalidated` 状态的分镜。
- 用户可点击"重新生成"按钮触发分镜融合图重算（由模块 05 处理，本模块仅负责标记）。
- 支持批量重算：选中多个 `invalidated` 分镜，一次性提交重算任务。

## 8. 异常与恢复

### 8.1 火山引擎 API 调用失败

| 异常类型 | 处理策略 |
|---|---|
| 网络超时 | 重试 2 次，间隔 5 秒。仍失败则 Task 标记 `failed`，Asset 回退为 `failed`。 |
| API 返回 4xx（参数错误/鉴权失败） | 不重试，Task 标记 `failed`，错误信息写入 Task 的 `error` 字段。 |
| API 返回 5xx（服务端错误） | 重试 3 次，指数退避（5s/10s/20s）。仍失败则 Task 标记 `failed`。 |
| API 返回内容安全审核拒绝 | 不重试，Task 标记 `failed`，错误信息提示用户修改 prompt。 |
| API 限流（429） | 重试 3 次，间隔 30 秒。仍失败则 Task 标记 `failed`。 |

### 8.2 轮询超时

- 轮询达到最大次数或总超时时间后仍未拿到结果，Task 标记 `failed`。
- Asset 状态回退为 `failed`。
- 前端展示"生图超时，请重试"。

### 8.3 图片下载失败

- 下载过程中网络中断或文件写入失败：
  - 重试 2 次，间隔 3 秒。
  - 仍失败则 Task 标记 `failed`，Asset 状态保持 `image_pending`（不回退为 `failed`，因为远端已生成成功，只是本地下载失败）。
  - 提供"重新下载"操作：基于已保存的远端图片 URL 重新下载，不需要重新调用火山引擎 API。

### 8.4 缩略图生成失败

- 缩略图生成失败不阻塞任务完成。
- `generatedImageThumbPath` 留空。
- 前端在缩略图路径为空时 fallback 加载原图（带 loading 状态）。
- 后台可在闲时补生成缩略图。

### 8.5 任务被取消

- 用户取消任务后，Task 状态变为 `canceled`。
- Asset 状态回退：从 `image_pending` 回退为 `confirmed`。
- 如果取消时远端任务已在执行，不主动通知火山引擎取消（远端资源浪费可接受），仅停止本地轮询。
- 如果取消时图片已下载但未回写，丢弃已下载文件。

### 8.6 应用崩溃恢复

- 应用重启后，Node worker 扫描所有 `status = 'running'` 或 `status = 'waiting_remote'` 的 `generate_asset_image` 任务。
- 对于 `running` 状态且无法恢复远端上下文的任务：标记为 `failed`，Asset 回退为 `failed`。
- 对于 `waiting_remote` 状态且有远端任务 ID 的任务：尝试恢复轮询。如果远端任务已过期或无法查询，标记为 `failed`。
- 所有 `image_pending` 状态的资产在恢复扫描完成后，如果对应任务已 `failed`，则资产状态同步为 `failed`。

## 9. UI 交互要求

### 9.1 资产管理页

**布局**：左侧分类导航 + 右侧资产网格/列表。

**分类导航**：

- 三个 Tab：角色（character）、场景（scene）、物品（item）。
- 每个 Tab 显示数量徽标。
- 支持切换"全部"/"当前片段"范围（片段模式下仅显示 `clipId` 匹配的资产）。

**资产卡片**：

- 显示缩略图（`generatedImageThumbPath`，无图时显示类型图标占位符）。
- 显示资产名称。
- 显示状态标签（draft=灰色、confirmed=蓝色、image_pending=蓝色脉动、image_ready=绿色、failed=红色）。
- 支持单选和多选（Shift+点击多选，Ctrl/Cmd+点击切换选中）。

**搜索栏**：

- 实时搜索资产名称和描述。
- 支持按状态筛选（下拉选择）。

**操作工具栏**：

- 批量生图按钮：选中 2 个以上资产时激活。
- 批量删除按钮：选中 1 个以上资产时激活。
- 新建资产按钮。
- 导入图片按钮。

### 9.2 资产详情侧栏

点击资产卡片时从右侧滑出详情面板，展示：

| 区域 | 内容 |
|---|---|
| 头部 | 缩略图 + 名称 + 状态标签 + 类型标签 |
| 基本信息区 | 名称（可编辑）、描述（可编辑文本域）、类型（下拉）、关联片段（下拉） |
| 提示词区 | prompt（可编辑文本域），"从描述生成"按钮（自动组装 prompt） |
| 参考图区 | 参考图预览 + "上传参考图"按钮 + "清除参考图"按钮 |
| 生成图区 | 生成图原图预览 + "生成图片"按钮 + "替换图片"按钮 + "下载"按钮 |
| 任务历史区 | 最近 5 条 `generate_asset_image` 任务记录，显示状态、时间、错误信息 |
| 操作区 | "确认资产"按钮（draft 状态时）、"删除资产"按钮 |

### 9.3 批量生图弹窗

**触发**：点击工具栏"批量生图"按钮。

**内容**：

1. 范围确认：显示"即将为 N 个资产生成图片"。
2. 参数设置：
   - 模型选择（下拉，从火山引擎已配置模型列表加载）。
   - 分辨率选择（下拉或自定义输入）。
   - 质量选择（standard / hd 单选）。
   - 生成数量（1–4 数字输入）。
   - 种子（可选数字输入，留空则随机）。
3. 确认按钮 + 取消按钮。
4. 提交后关闭弹窗，在资产管理页顶部显示进度条：`已完成 X / N`。
5. 进度条支持"取消"操作。

### 9.4 生图进度反馈

- 单个生图：资产卡片状态标签变为蓝色脉动 `image_pending`，卡片右上角显示小型 spinner。
- 批量生图：页面顶部固定进度条，显示已完成数/总数。每个正在生成的资产卡片单独显示 spinner。
- 生图完成：卡片缩略图刷新，状态标签变为绿色 `image_ready`，展示 200ms 的成功动画。
- 生图失败：状态标签变为红色 `failed`，卡片显示错误图标，点击可查看错误详情。

### 9.5 去重提示交互

- 同名冲突（同类型）：Toast 错误提示"已存在同名同类型资产"，不创建。
- 相似度提示：Modal 弹窗，列出相似资产卡片（缩略图 + 名称 + 相似度），提供"仍然创建"和"查看已有资产"两个按钮。
- 类型冲突警告：Toast 警告提示"项目中已存在名为 X 的 Y 类型资产"，允许继续创建。

## 10. 最低落地清单

以下为本模块必须实现的最小功能集合，确保端到端可用：

1. **SQLite assets 表**：建表、索引、基本 CRUD SQL。
2. **Tauri Command 接口**：`asset_create`、`asset_update`、`asset_delete`、`asset_list`、`asset_get`、`asset_confirm`、`asset_generate_image`、`asset_batch_generate_image`、`asset_replace_image`。
3. **火山引擎图像生成客户端**（Node worker 侧）：请求组装、API 调用、响应解析、异步轮询。
4. **图片下载与缩略图生成**（Node worker 侧）：HTTP 下载、sharp 缩略图生成、文件落盘。
5. **任务集成**：`generate_asset_image` 任务类型注册到统一任务系统，支持 pending → running → waiting_remote → downloading → success/failed 全状态流转。
6. **资产去重检测**：同名合并逻辑 + 相似度计算 + 类型冲突警告。
7. **分镜失效标记引擎**：资产变更时查询引用关系并批量更新分镜 `imageState = invalidated`。
8. **参数合并**：项目默认参数与分镜级覆盖的浅合并逻辑，资产生图参数 fallback。
9. **React 资产管理页**：分类导航、资产卡片网格、搜索筛选、多选、批量生图弹窗、进度条。
10. **React 资产详情侧栏**：字段编辑、参考图上传、生成图预览、任务历史。
11. **崩溃恢复**：应用重启时扫描未完成任务并恢复或标记失败。
