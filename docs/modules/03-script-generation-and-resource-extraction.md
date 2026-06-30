# 模块 03：剧本理解与资源抽取

## 1. 模块职责

这个模块负责把每个片段从"原文文本"转成"可制作剧本结果"。它包含两个子步骤：剧本理解（模型分析片段正文，输出结构化结果）和资源抽取确认（用户确认角色/场景/物品列表）。模块结束时，输出片段级结构化剧本结果和确认后的资产列表，进入资产生图模块。

## 2. 设计约束

1. **先记录后异步**：剧本理解是一个异步任务。UI 提交后先保存 `ClipScript` 记录和 `generate_clip_script` 任务（同一事务），然后通知 worker 执行。不在 UI 线程里直接调用模型。

2. **模型抽取结果和用户确认结果分开**：模型返回的资源是候选列表，用户可以增删改。只有用户确认后的资源才生成 `Asset` 记录并进入资产生图队列。

3. **资源校验**：角色和场景不能同时为空。资产必须有图才能进入下一步（分镜生成）。

4. **stopStep 控制**：用户可以设置停在哪一步等待人工确认。如果 `stopStep = 'asset'`，剧本理解完成后不自动进入资产生图。

## 3. 数据结构

### 3.1 ClipScript

```ts
type ClipScriptStatus = 'pending' | 'running' | 'success' | 'failed';
type StopStep = 'asset' | 'storyboard' | 'voice' | 'video' | 'export' | null;

type ClipScript = {
  id: string;
  projectId: string;
  clipId: string;
  sourceText: string;
  optimizedText?: string;
  scriptSummary?: string;
  rawModelOutput?: string;      // 模型原始响应，用于诊断
  mode?: 'RS' | 'TS' | 'ZH';
  extractedResourcesJson?: string;  // 候选资源列表（JSON），格式：{ characters: ExtractedResource[], scenes: ExtractedResource[], items: ExtractedResource[] }
  stopStep?: StopStep;
  status: ClipScriptStatus;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};
```

### 3.2 ExtractedResource

模型抽取的候选资源：

```ts
type ExtractedResource = {
  type: 'character' | 'scene' | 'item';
  name: string;
  description: string;
  prompt: string;              // 生图提示词
  tags?: string[];
  referenceHint?: string;      // 参考图提示
};
```

### 3.3 剧本理解任务输入输出

`generate_clip_script` 任务：

```ts
// 输入
type ClipScriptTaskInput = {
  projectId: string;
  clipId: string;
  sourceText: string;
  styleMode: 'RS' | 'TS' | 'ZH';
  projectDefaultParams?: {
    imageParam?: ImageParam;
    videoParam?: VideoParam;
    voiceParam?: VoiceParam;
  };
};

// 输出
type ClipScriptTaskOutput = {
  scriptSummary: string;
  optimizedText?: string;
  mode: 'RS' | 'TS' | 'ZH';
  characters: ExtractedResource[];
  scenes: ExtractedResource[];
  items: ExtractedResource[];
};
```

## 4. 剧本理解

### 4.1 提示词模板

```text
# 角色
你是一个专业的剧本结构化分析专家。

# 任务
分析以下剧本文本，提取结构化信息。

# 输出格式
必须返回标准 JSON 对象，不要包含任何解释性文本或 Markdown 符号。

{
  "scriptSummary": "片段摘要（100字以内）",
  "mode": "RS | TS | ZH",
  "characters": [
    {
      "name": "角色名",
      "description": "角色外貌和性格描述",
      "prompt": "用于生成角色图像的提示词",
      "tags": ["标签1", "标签2"]
    }
  ],
  "scenes": [
    {
      "name": "场景名",
      "description": "场景环境描述",
      "prompt": "用于生成场景图像的提示词"
    }
  ],
  "items": [
    {
      "name": "物品名",
      "description": "物品描述",
      "prompt": "用于生成物品图像的提示词"
    }
  ]
}

# 抽取规则
1. 优先抽取全局主角色
2. 再抽取片段场景
3. 最后抽取片段关键物品
4. 每个资源必须有 name 和 prompt
5. prompt 应该是英文的图像生成提示词，包含外貌/材质/光影等细节
6. mode 建议：以对话为主的片段用 RS，以场景描写为主的用 TS，综合的用 ZH

# 剧本文本
{sourceText}
```

### 4.2 任务流程

```text
1. 读取 Clip.sourceText
2. 创建 ClipScript 记录（status = 'running'）
3. 组装提示词（注入 sourceText 和 styleMode）
4. 请求豆包文本模型
5. 保存原始响应到 ClipScript.rawModelOutput
6. 解析 JSON 输出
7. 校验输出结构
8. 回写 ClipScript（scriptSummary, optimizedText, mode, status = 'success'）
9. 将候选资源序列化后写入 ClipScript.extractedResourcesJson 字段
10. 推送 task_success 事件
11. 如果 autoContinue 且 stopStep 未命中 asset，自动进入资源确认
12. 否则等待用户在前端确认资源
```

### 4.3 失败处理

| 失败来源 | 处理 |
|----------|------|
| 模型响应不是 JSON | 执行一次 JSON 修复提示词重试 |
| 模型抽取过空（角色和场景都为空） | 标记失败，提示用户手动编辑 |
| 抽取结果字段缺失 | 自动补默认值，标记需要人工确认 |
| 模型调用超时 | 自动重试（退避策略：5s → 15s → 30s） |

## 5. 资源抽取规则

### 5.1 抽取优先级

1. 先抽全局主角色（在整个项目范围内出现的角色）
2. 再抽片段场景（当前片段涉及的场景）
3. 最后抽片段关键物品（对剧情有推动作用的物品）

### 5.2 去重规则

| 情况 | 处理 |
|------|------|
| 同名完全相同 | 合并为一条 |
| 名称不同但相似度高（> 0.6） | 提示用户确认是否合并 |
| 类型冲突（同名但一个是角色一个是场景） | 交给用户选择 |

### 5.3 必填规则

- 角色至少有 `name`
- 场景至少有 `name`
- 资产生图前必须有 `prompt`（如果模型没有生成，用户需要手动补充）

### 5.4 资产完成检查

资源确认后检查所有资产是否都有图：

```text
1. 遍历确认后的角色/场景/物品列表
2. 检查每个资产的 generatedImagePath 是否非空
3. 如果全部有图 → 标记 Clip.status = 'asset_ready'
4. 如果有空图 → 进入资产生图队列
```

## 6. 资源确认流程

### 6.1 `confirm_clip_resources`

这是一个同步操作（不是异步任务），由用户在前端确认后直接执行。前端从 `ClipScript.extractedResourcesJson` 读取候选资源列表，展示给用户编辑确认。

输入：

```ts
type ConfirmResourcesInput = {
  clipId: string;
  characters: ExtractedResource[];
  scenes: ExtractedResource[];
  items: ExtractedResource[];
};
```

流程：

```text
1. 校验至少有角色或场景（两者不能同时为空）
2. 对同名资源做去重
3. 对每个资源生成 Asset 记录：
   a. 设置 type, name, description, prompt
   b. 设置 source = 'model'
   c. 设置 status = 'confirmed'
4. 如果资产已有图（从其他片段复用），保持 image_ready 状态
5. 标记 ClipScript 资源已确认
6. 更新 Clip.status = 'asset_ready'（如果全部有图）或 'script_ready'（如果有空图）
7. 如果 autoContinue 且 stopStep 未命中，自动进入资产生图队列
```

### 6.2 从 ClipScript 到 Asset 的转换器

```ts
function convertToAsset(
  resource: ExtractedResource,
  projectId: string,
  clipId: string
): Asset {
  return {
    id: generateId(),
    projectId,
    clipId,
    type: resource.type,
    name: resource.name,
    description: resource.description,
    prompt: resource.prompt,
    source: 'model',
    status: 'confirmed',
    createdAt: now(),
    updatedAt: now(),
  };
}
```

转换时需要注意：

- 如果项目级已有同名同类型的资产，复用已有资产（不新建）
- 复用时检查已有资产的 `generatedImagePath`，如果有图则保持 `image_ready`
- 新建的资产状态为 `confirmed`，等待资产生图

## 7. stopStep 控制

### 7.1 stopStep 取值

| stopStep | 含义 | 停在哪里 |
|----------|------|----------|
| asset | 资产确认 | 剧本理解完成后，等待用户确认资源 |
| storyboard | 分镜确认 | 资产生图完成后，等待用户确认分镜 |
| voice | 语音确认 | 分镜融合图完成后，等待用户确认语音 |
| video | 视频确认 | 语音完成后，等待用户确认视频 |
| export | 导出前 | 所有视频生成完成后 |
| null | 不停 | 全自动到导出 |

### 7.2 推进逻辑

```text
当前步骤完成后：
1. 检查 autoContinue
2. 如果 autoContinue = false，停住
3. 如果 autoContinue = true，检查 stopStep
4. 如果 stopStep 命中当前步骤，停住
5. 否则自动推进到下一步，并创建对应的 Task
```

## 8. 接口定义

### 8.1 Tauri IPC 命令

```ts
// 生成片段剧本
generateClipScript(input: {
  clipId: string;
}): Promise<{ taskId: string }>

// 获取片段剧本结果
getClipScript(input: { clipId: string }): Promise<ClipScript | null>

// 确认资源
confirmClipResources(input: ConfirmResourcesInput): Promise<{ assetIds: string[] }>

// 重新生成片段剧本
regenerateClipScript(input: { clipId: string }): Promise<{ taskId: string }>

// 手动编辑剧本结果
updateClipScript(input: {
  clipId: string;
  scriptSummary?: string;
  optimizedText?: string;
  mode?: 'RS' | 'TS' | 'ZH';
}): Promise<void>
```

## 9. UI 交互要求

### 9.1 剧本理解页

显示：

- 原片段文本（只读）
- 模型生成的摘要
- 模式建议（RS/TS/ZH）
- 资源候选列表（角色/场景/物品分类显示）
- 每个资源的名称、描述、提示词

用户操作：

- 接受结果 → 进入资源确认
- 重新生成 → 创建新的 generate_clip_script 任务
- 手工编辑结果 → 直接修改候选资源列表

### 9.2 资源确认页

显示：

- 角色列表（可编辑名称、描述、提示词）
- 场景列表
- 物品列表
- 每个资源可标记"保留"或"删除"
- 可手动新增资源

用户操作：

- 新增资源
- 删除资源
- 改名
- 改描述
- 改提示词
- 确认 → 进入资产生图

## 10. 失败和重试

### 10.1 失败来源

| 来源 | 错误信息 | 重试方式 |
|------|----------|----------|
| 模型响应不是 JSON | "模型返回格式错误" | 自动重试 1 次 JSON 修复 |
| 模型抽取过空 | "未抽取出有效资源" | 手动重试（用户修改后重新生成） |
| 抽取结果字段缺失 | "资源缺少必填字段" | 自动补默认值，标记需人工确认 |
| 模型调用超时 | "模型调用超时" | 自动重试（退避策略） |
| 网络错误 | "网络连接失败" | 自动重试（退避策略） |

### 10.2 重试策略

- 自动重试：网络波动、超时、5xx 错误（退避策略：5s → 15s → 30s）
- 手动重试：提示词错误、抽取过空、JSON 修复失败

## 11. 与下一模块的边界

这个模块结束时，必须已经得到：

- 片段级结构化剧本结果（`ClipScript`，status = success）
- 确认后的资产列表（`Asset[]`，status = confirmed）
- 每个资产的初始提示词

但这个模块不负责：

- 生成资产图（模块 04）
- 生成分镜（模块 05）

## 12. 最低落地清单

1. `ClipScript` 表和持久化
2. 豆包文本模型提示词模板
3. 资源抽取 JSON 结构定义
4. 资源确认 UI（角色/场景/物品列表编辑）
5. 资源去重规则实现
6. 从 `ClipScript` 到 `Asset` 的转换器
7. stopStep 推进逻辑
