# 模块 02：剧本导入与片段拆分

## 1. 模块职责

这个模块负责把外部文本变成系统内部可处理的片段列表。它不是简单的文件导入器，而是"内容规范化 + 快速规则拆分 + 模型语义拆分"的组合模块。模块的输入是一份原始剧本文本，输出是一组有序的 `Clip` 记录。

## 2. 设计约束

1. **两段式拆分**：先尝试本地规则拆分（正则匹配集数标志），规则不匹配时再走模型智能拆分（语义切分）。两段式拆分保证有明确结构的剧本可以秒级拆分，无结构的剧本也能通过模型完成。

2. **先记录后异步**：剧本导入后先保存 `ScriptSource` 记录和 `split_script_source` 任务（同一事务），然后通知 worker 执行拆分。导入操作本身是同步的，但拆分是异步的。

3. **保留原始和规范化两份内容**：`ScriptSource.rawContent` 保存原始内容，`ScriptSource.normalizedContent` 保存规范化后的内容。拆分基于规范化内容进行，但用户可以查看原始内容。

4. **片段编辑触发下游失效**：片段人工编辑（合并、拆分、改正文）后，该片段的下游任务（剧本理解、资产生成、分镜生成）必须标记失效。

## 3. 文本规范化

导入时先做统一规范化，规范化后的内容用于后续拆分和模型调用。

### 3.1 规范化步骤

```text
1. 统一换行符为 \n（处理 \r\n 和 \r）
2. 清除连续空白和不可见字符（零宽字符、BOM）
3. 全角括号转半角：（ → (, ） → )
4. 全角字符转半角（字母、数字、标点）
5. 半角引号转中文引号（左右配对）：" → " 和 "
6. 修正常见 OCR 噪声（如"己经"→"已经"、"未口道"→"不知道"）
7. 剔除设定部分（开头有人物介绍/背景设定等关键词时，剥离到正文开始）
8. 保留原始段落结构
```

### 3.2 设定部分剔除规则

如果剧本开头包含以下关键词，则剔除从开头到第一个集数标志之间的内容：

```text
人物介绍、角色介绍、背景设定、故事梗概、故事背景、
主要人物、人物设定、角色设定、剧情简介、内容简介
```

### 3.3 乱码检测

采样前 1000 字符，如果拉丁扩展字符（U+0080-U+024F）占比超过 30%，判定为乱码，拒绝导入。

### 3.4 长度限制

混合长度计算（每个中文字符、英文单词、标点各算 1），上限 100,000 语义字数。超限时截断并提示用户。

## 4. 规则拆分

### 4.1 集数标志正则模式

规则拆分通过检测以下集数标志来切分片段：

```text
(?:^|\n)\s*【*\[*第*\s*[一二三四五六七八九十百零\d0-9]+\s*[集章幕场回节]
(?:^|\n)\s*[（(]\s*[一二三四五六七八九十\d0-9]+\s*[)）]
(?:^|\n)\s*[Ee][Pp]\.?\\s*\\d+
(?:^|\n)\s*[Cc][Hh][Aa][Pp][Tt][Ee][Rr]\\s*\\d+
(?:^|\n)\s*[Ee][Pp][Ii][Ss][Oo][Dd][Ee]\\s*\\d+
(?:^|\n)\s*场景\\s*\\d+
```

支持的格式包括：第X集/章/幕/场/回/节（中文数字或阿拉伯数字）、(X) 括号编号、EP.X、Episode X、Chapter X、场景X（行首）。

### 4.2 拆分流程

```text
1. 扫描全文，检测所有集数标志位置
2. 如果第一个标志前有设定关键词，剔除设定部分，重新扫描
3. 按标志位置切割：每集内容 = 当前标志到下一个标志之间的文本
4. 对每集内容做清理：
   a. 移除集数标志文本本身
   b. 移除开头冒号
   c. 全角转半角（如规范化步骤 3-4）
   d. 半角引号配对（如规范化步骤 5）
5. 输出 ClipDraft[] 列表
```

### 4.3 成功判定条件

规则拆分在以下条件全部满足时判定为成功：

- 至少拆出 1 个片段
- 每个片段正文非空（至少 50 字）
- 片段顺序连续（index 从 1 开始递增）
- 文本总量覆盖原文 80% 以上

否则判定为失败，转入智能拆分。

### 4.4 输出格式

```ts
type ClipDraft = {
  index: number;
  title: string;       // 规则模式下为空字符串
  summary: string;     // 规则模式下为空字符串
  content: string;
  wordCount: number;
};
```

## 5. 模型智能拆分

当规则拆分失败时，调用豆包文本模型做语义切分。

### 5.1 分块策略

长文本必须分块处理，避免单次请求超出模型上下文限制：

```text
1. 短文本（< 1500 字）且无集数标志 → 直接作为单集返回
2. 文本 ≤ 6000 字 → 单次调用模型
3. 文本 > 6000 字 → 分块处理：
   a. 按段落边界分块，每块约 6000 字
   b. 从第二块开始，校验项目状态（可能已被删除）
   c. 优先读取缓存（跳过已成功的块）
   d. input = carryOver + 当前 chunk
      （carryOver 是上一批最后一集的残余内容，如果过短则回收）
   e. 非末批：使用 midPrompt（要求最后一集字数与前一致，便于衔接）
   f. 末批：使用 lastPrompt（要求各集字数均衡）
   g. 非末批尾集过短（< 800 字）→ 回收为 carryOver，并入下批
   h. 缓存本批结果到 cache/model-results/ 目录（24 小时有效，缓存策略见模块 08 第 10 节）。缓存键 = hash(sourceText + mode + model)
```

### 5.2 提示词模板

```text
# 角色
你是一个高精度的剧本分集与结构化专家。

# 核心规则
1. 一字不差：切分后的内容必须严格保留原文，不允许增删改
2. 设定剔除：剔除"人物介绍"、"背景设定"等非正文部分
3. 输出格式：标准 JSON 数组，禁止 Markdown 符号

# 工作流程
模式 A：有集数标志 → 按标志自然切分
模式 B：无集数标志 → 以 1000 字为目标，800-1200 字弹性范围，保证语义完整性（不能在句子中间断开）

# 输出格式
JSON 数组，每个对象包含：
- wordCount: 该集字数
- content: 该集完整原文（使用中文引号）
```

### 5.3 输出格式

模型必须返回 JSON 数组，不能返回解释性文本：

```json
[
  {
    "wordCount": 999,
    "content": "该集完整原文..."
  }
]
```

### 5.4 调用参数

| 参数 | 值 |
|------|-----|
| 模型 | 豆包文本模型 |
| 最大分块大小 | 6,000 字符 |
| 尾集回收阈值 | 800 字 |
| 最大重试 | 3 次 |
| 重试间隔 | 退避策略：5s → 15s → 30s |
| 限流 | 1 次/10 秒 |

## 6. 数据结构

### 6.1 Clip

```ts
type ClipStatus = 'pending' | 'script_ready' | 'asset_ready' | 'storyboard_ready' | 'media_ready' | 'done' | 'failed';

type Clip = {
  id: string;
  projectId: string;
  sourceId: string;
  sortIndex: number;
  title: string;
  summary: string;
  sourceText: string;
  estimatedDuration?: number;  // 预估时长（秒）
  status: ClipStatus;
  createdAt: string;
  updatedAt: string;
};
```

### 6.2 拆分任务输出

`split_script_source` 任务的 `outputJson`：

```ts
type SplitTaskOutput = {
  clips: Array<{
    sortIndex: number;
    title: string;
    summary: string;
    sourceText: string;
    wordCount: number;
    estimatedDuration?: number;
  }>;
  splitMode: 'rule' | 'model';
  totalWordCount: number;
};
```

## 7. 任务流

### 7.1 `split_script_source`

输入（`inputJson`）：

```ts
type SplitTaskInput = {
  projectId: string;
  sourceId: string;
  forceAi?: boolean;            // 强制走智能拆分
};
```

流程：

```text
1. 读取 ScriptSource.normalizedContent
2. 如果 forceAi 为 true，跳到步骤 4
3. 尝试规则拆分：
   a. 扫描集数标志
   b. 如果成功（满足 4.3 判定条件），生成 Clip[]
   c. 跳到步骤 6
4. 智能拆分：
   a. 按分块策略切分文本
   b. 构造提示词
   c. 请求豆包文本模型
   d. 校验 JSON 输出
   e. 如校验失败，执行一次 JSON 修复提示词重试
   f. 如仍失败，标记任务失败
5. 解析模型输出，生成 Clip[]
6. 批量插入 Clip 记录（同一事务）
7. 更新 ScriptSource.splitStatus = 'success'
8. 更新 Project.currentStep = 'script'（如果 autoContinue）
9. 推送 task_success 事件
```

## 8. 校验与回退

### 8.1 校验项

模型输出必须通过以下校验：

| 校验项 | 条件 | 失败处理 |
|--------|------|----------|
| JSON 合法性 | 能解析为 JSON 数组 | 执行一次 JSON 修复提示词 |
| index 连续性 | sortIndex 从 1 开始递增 | 自动修复排序 |
| content 非空 | 每个片段至少 50 字 | 标记失败 |
| 单片段长度 | 不超过 10,000 语义字数 | 截断并标记 |
| 文本覆盖率 | 拆分后总字数 ≥ 原文 80% | 标记失败，保留原始响应 |

### 8.2 回退策略

第一次失败（JSON 格式错误）：

- 执行一次 JSON 修复提示词（"请将以下内容转为标准 JSON 数组，不要包含任何解释性文本"）
- 重新校验

第二次失败：

- 标记任务为 `failed`
- 保留模型原始响应在 `Task.errorMessage`
- UI 显示"拆分失败，请进入人工拆分模式"

## 9. 片段人工编辑

### 9.1 编辑操作

桌面端必须支持以下片段编辑操作：

- 合并片段：将两个相邻片段合并为一个
- 拆分片段：将一个片段在指定位置拆分为两个
- 修改标题
- 修改摘要
- 修改正文
- 调整顺序：拖拽排序
- 删除片段

### 9.2 失效逻辑

片段编辑后需要触发下游失效：

```text
1. 合并/拆分/删除片段：
   a. 删除该片段的下游任务记录（ClipScript、Storyboard）
   b. 删除该片段的 Asset 记录
   c. 将片段状态重置为 pending
2. 修改正文：
   a. 标记 ClipScript 为失效（如果有）
   b. 标记该片段的所有 Storyboard 为 invalidated
   c. 将片段状态回退到 script_ready 之前的阶段
3. 修改标题/摘要：
   a. 不触发失效（仅元数据变更）
4. 调整顺序：
   a. 不触发内容失效
   b. 但导出顺序需重新计算
```

## 10. 接口定义

### 10.1 Tauri IPC 命令

```ts
// 导入剧本
importScript(input: {
  projectId: string;
  sourceType: 'paste' | 'txt' | 'docx';
  content?: string;
  filePath?: string;
}): Promise<{ sourceId: string }>

// 触发拆分
splitScriptSource(input: {
  projectId: string;
  sourceId: string;
  forceAi?: boolean;
}): Promise<{ taskId: string }>

// 获取片段列表
listClips(input: { projectId: string }): Promise<Clip[]>

// 更新片段
updateClip(input: {
  clipId: string;
  title?: string;
  summary?: string;
  sourceText?: string;
}): Promise<void>

// 合并片段
mergeClips(input: { clipIds: [string, string] }): Promise<{ mergedClipId: string }>

// 拆分片段
splitClip(input: {
  clipId: string;
  splitPosition: number;  // 字符位置
}): Promise<{ firstClipId: string; secondClipId: string }>

// 调整顺序
reorderClips(input: {
  projectId: string;
  clipIds: string[];  // 按新顺序排列的 ID
}): Promise<void>

// 删除片段（移动到回收站）
deleteClip(input: { clipId: string }): Promise<void>
```

## 11. 最低落地清单

1. 文本规范化工具（全角转半角、引号配对、剔除设定、乱码检测）
2. `txt/docx` 文件读取器
3. 规则拆分器（正则模式集 + 判定条件）
4. 豆包文本模型调用器
5. 分块策略实现（6000 字分块、尾集回收、缓存）
6. JSON 校验器和修复提示词
7. 片段落库逻辑（批量插入）
8. 片段人工编辑器（合并、拆分、改正文、调序）
9. 下游失效触发逻辑
