# Muse AI Agent 技术架构方案

> 版本: 0.3.1 → 0.4.1 | 日期: 2026-08-06 | 状态: 方案评审通过

---

## 目录

- [一、产品形态与目标](#一产品形态与目标)
- [二、竞品调研](#二竞品调研)
- [三、现有能力图谱](#三现有能力图谱)
- [四、架构总览](#四架构总览)
- [五、核心模块设计](#五核心模块设计)
- [六、可行性验证](#六可行性验证)
- [七、记忆与知识管理](#七记忆与知识管理)
- [八、子 Agent 策略](#八子-agent-策略)
- [九、前端页面架构与目录规划](#九前端页面架构与目录规划)
- [十、实施路线](#十实施路线)
- [十一、风险与对策](#十一风险与对策)
- [附录](#附录)

---

## 一、产品形态与目标

```
┌──────────────────────────────┐  ┌────────────────────────────────┐
│   左侧：Agent 画布             │  │   右侧：智能体对话框              │
│   (React Flow)               │  │   (Chat UI + Vercel AI SDK)    │
│                              │  │                                │
│   · 项目/分集/素材节点可视化    │  │   User: "把第3集素材超分到2x"     │
│   · Agent 操作实时更新画布     │  │   Agent: 找到3个素材 → 逐个提交   │
│   · 节点拖拽/缩放/连线        │  │   ✓ 人物A 完成  ⟳ 场景B 67%     │
└──────────────────────────────┘  └────────────────────────────────┘
```

**目标**：自然语言操作软件 → 画布实时反馈 → 能力自发现 → 操作可追溯

---

## 二、竞品调研

**能力声明机制**：Claude Code/OpenCode 用 System Prompt 注入 Tool 列表 → MCP 协议实现动态发现 → Agent Skills（2025.12 开放标准）用 SKILL.md 封装复杂流程。Muse 借鉴后者：简单能力用 ToolDef，复杂流程用 SKILL.md。

**框架选型**：

| 框架 | Stars | 核心特点 | 借鉴内容 |
|------|------|---------|---------|
| Hermes Agent | 140k+ | 自进化 + Tool Search + 三层记忆 | Tool Registry 自注册、Tool Search 按需加载 |
| LangGraph | 15k+ | 有向状态图、人工审批节点 | 后期复杂编排参考 |
| Mem0 | 25k+ | 长期记忆层、本地模式 | **直接集成** |

---

## 三、现有能力图谱

Muse 现有 **17 个能力域、40+ Tauri 命令**，按操作类型分组：

| 域 | 核心命令 | Tool 分类 |
|----|---------|----------|
| 项目管理 | create/list/get/delete_project | 查询 + 创建 + 删除 |
| 分集管理 | create/list/update/delete/split_clip | 查询 + 创建 + 删除 |
| 剧本管理 | import_script, generate/cancel_clip_script | 创建 + 取消 |
| 素材管理 | add/delete/update_asset_in_clip | 修改 |
| 素材生图 | generate_asset_image, retry/cancel | 创建 |
| 素材图片管理 | list/select/delete/import/copy | 查询 + 删除 |
| 素材超分 | enqueue_asset_upscale | 创建 |
| 镜头管理 | create/list/update/delete/reorder | 全类型 |
| 镜头生图/视频 | generate_storyboard_image/video, bind | 创建 |
| 镜头视频超分 | enqueue/cancel/retry_upscale | 创建 + 取消 |
| 语音合成 | generate_voice, bind/preview | 创建 |
| 设置/Worker | get_status, start/stop_worker | 查询 + 管理 |

**14 张数据库表**：projects / clips / assets / asset_images / storyboards / storyboard_videos / voices / upscale_jobs / settings 等。

---

## 四、架构总览

```
┌────────────────────────────────────────────────────────────┐
│  前端 TypeScript（Agent 全部逻辑）                           │
│                                                             │
│  Vercel AI SDK (generateText + tool calling + streaming)    │
│      │  tool("list_clips", …)   tool("enqueue_upscale", …)  │
│      ▼                                                      │
│  invoke("tauri_command", params) ──→ 现有 Rust 命令         │
│                                                             │
│  左侧 React Flow 画布 ←── 项目数据与 Agent 操作派生刷新      │
│  右侧 Chat UI ←── useChat hook 流式渲染                     │
└────────────────────────────────────────────────────────────┘
                        │  Tauri IPC  │  tauri-plugin-http (CORS)
                        ▼              ▼
              现有 Rust 后端(零改动)    LLM API (OpenAI/Claude)
```

**设计原则**：后端零 Rust 新增代码、Agent 全在 TypeScript、画布是项目数据与任务状态的可交互投影而非业务状态源、能力自发现。

---

## 五、核心模块设计

### 5.1 技术选型

| 问题 | 结论 |
|------|------|
| Agent Engine 语言 | **TypeScript + Vercel AI SDK**（Rust AI 生态近乎为空） |
| 为什么前端能跑 Agent | `invoke()` 直达所有后端命令，Agent = "聪明的命令调用者" |
| 画布 | **React Flow**（行业标准，MIT 开源） |
| 跨域方案 | `tauri-plugin-http` 原生 fetch（Rust 侧 3 行） |
| 长期记忆 | **Mem0**（纯 TS SDK，本地 SQLite 模式） |
| 依赖 | `ai` `@ai-sdk/*` `zod` `reactflow` `mem0ai`（6 个） |

### 5.2 Tool 系统

一个 Tool = Zod Schema + description + `invoke()`。分类权限：

| 类别 | 数量 | 权限 |
|------|------|------|
| 查询（list/get） | ~15 | 自动执行 |
| 创建/修改（generate/enqueue） | ~15 | 弹确认卡片 |
| 删除（delete） | ~5 | 红色二次确认 |

```typescript
// 典型 Tool 定义 — 完整 Tool Registry 中的每个命令照此模式注册
export const upscaleAssetImageTool = tool({
  description: `AI 超分素材图片。支持模型：anime(2x/3x/4x) | x4plus-anime | x4plus`,
  parameters: z.object({
    clipId: z.string(), assetType: z.enum(['character','scene','item']),
    assetName: z.string(), model: z.string(), scale: z.number(),
  }),
  execute: async (params) => {
    await invoke('enqueue_asset_upscale', { input: params });
    return { status: 'queued' };
  },
});
```

**Registry 与模型可见集分离**：`Tool Registry` 保存并注册完整 40+ Tool 定义、权限和精确 Zod Schema，供运行时检索；每轮模型只接收本次请求需要的 `visibleTools`，绝不将完整 Registry 或全量 Schema 注入上下文。

**两阶段 Tool Search**：

1. **候选检索**：根据领域、用户意图和当前项目/画布上下文过滤并排序，返回 **4–8 个**候选概要（名称、简述、目标对象、风险级别），不加载完整 Schema。
2. **精确加载**：结合候选概要和必要时的用户澄清，选择 **1 个，最多 2 个** Tool 的精确 Schema 组成 `visibleTools`；其余候选仍只保留概要。Schema、候选概要与画布摘要共同受单轮上下文预算约束，超预算时优先缩短概要或要求澄清，不扩大候选上限。

固定工具组仅用于当前项目查询、单对象查看等高频、低歧义且参数稳定的场景。批量、删除、跨域操作，或目标/动作不明确的请求，必须先走 Tool Search；若仍无法唯一确定对象、范围或动作，则先澄清再加载 Schema。

### 5.3 Agent Engine

Vercel AI SDK 内置 Agent Loop；每轮先检索候选并精确加载 Schema，再配置可见工具和 system prompt：

```typescript
const candidates = searchToolCandidates({
  intent: classifyIntent(context.history),
  domain: context.activeDomain,
  canvas: context.nodes,
  limit: 8,
});
const visibleTools = loadToolSchemas({
  candidates,
  selected: resolveToolSelection(candidates, context),
  maxSchemas: 2,
  contextBudget: TOOL_CONTEXT_BUDGET,
});

const result = await generateText({
  model: openai('gpt-4o'),
  system: buildSystemPrompt(context),
  messages: context.history,
  tools: visibleTools,
  maxSteps: 10,              // 自动多轮 tool calling
  onStepFinish: ({ toolCalls, toolResults }) => {
    // 每个 tool call 完成后刷新权威项目数据，再更新其画布投影
    toolCalls.forEach(tc => canvasUpdate(tc, toolResults));
  },
});
```

Tool Call 确认流程：写操作 (`generate_*`/`enqueue_*`) → 弹确认卡片 → 用户批准后执行。删除操作需二次确认。固定工具组以外的候选选择、Schema 加载和澄清结果应记录到会话日志，用于评估路由准确率与上下文成本。

### 5.4 Context Builder

分层 Prompt 结构（学 Claude Code）：

```typescript
function buildSystemPrompt(ctx: AgentContext): string {
  return [
    IDENTITY,                         // 身份 + 能力边界
    buildCanvasContext(ctx.nodes),    // 当前画布快照 JSON
    buildMemoryContext(ctx.memories), // Mem0 检索的长期记忆
    `当前作品: ${ctx.projectName}`,   // 项目上下文
    CONSTRAINTS,                     // 操作约束规则
  ].join('\n\n');
}
```

画布状态压缩为 JSON 摘要（节点类型 + label + 子节点统计），避免注入全量画布数据。Tool Search 的候选概要和精确 Schema 也计入同一上下文预算；完整 Tool Registry 不属于 Prompt 上下文。

### 5.5 画布模型

画布不是通用参数节点编辑器，也不承载作品业务状态；它是当前作品生产关系的**可交互投影**。项目、分集、素材、镜头、媒体产物和异步任务仍以现有数据库与 Tauri 查询结果为准。画布只保存视图状态（筛选、缩放、局部折叠、用户固定位置），任何创建、绑定、取消、删除或编辑都必须回到既有业务命令和手动工作区执行。

**设计边界**：借鉴 ComfyUI 的清楚端口、可追踪连线与局部操作感，但不显示模型、提示词、尺寸等通用参数端口，也不允许任意拖线改变业务关系。画布回答的是「这个影视作品的资源从哪里来、被哪一镜使用、生成了什么、任务进行到哪里」，而不是「如何拼装一条图像工作流」。

#### 5.5.1 数据投影与层级

```text
权威项目数据 / 任务轮询 / Tool Result
            │  按 projectId 刷新、归一化
            ▼
CanvasProjection（语义节点、允许的业务边、聚合摘要）
            │  稳定布局 + 仅视图状态
            ▼
React Flow nodes / edges
            │
            ├─ 聚焦、预览、跳转手动编辑、发起 Chat 意图
            └─ 不直接写入 projects、clips、assets、storyboards、任务表
```

每个画布对象使用稳定的 `entityType:entityId` 作为节点 ID；Task 使用任务 ID，媒体版本使用媒体记录 ID。节点数据至少包含 `projectId`、可选 `clipId`、关联实体 ID、显示状态、更新时间和可预览媒体信息。关系由归一化数据计算，不由用户手工连线创建。

| 视觉层级 | 业务含义 | 画布职责 |
|---|---|---|
| 作品根 | 一个 `Project` | 提供当前作品入口、整体计数和全局状态，不展示全部内部细节 |
| 分集泳道 | 一个 `Clip` | 同一分集的素材、镜头及其产物的唯一容器；跨分集对象不直接混排 |
| 生产对象 | `Asset`、`Storyboard` | 展示可复用素材与镜头的引用、使用和生成关系 |
| 媒体产物 | `Image`、`Video`、`Voice` | 展示最新可用版本和必要的版本摘要，支持预览与定位 |
| 异步任务 | `Task`、`Upscale` | 展示排队、执行、成功、失败或取消；不把任务日志展开成节点图 |

#### 5.5.2 固定阅读方向与分集泳道

画布严格按从左至右的影视生产语义排布，所有同分集对象放在同一泳道或其局部分组中：

```text
项目列                 分集泳道（每行一个 Clip）
Project ────────▶ [Clip 标头] │ 素材 / 镜头 │ 图片 / 视频 / 语音 / 任务与超分
左侧范围                         中间生产区                 右侧产出区
```

1. **左侧范围列**：`Project` 位于最左；`Clip` 以横向泳道的固定标题条出现，按分集顺序从上到下排列。项目到分集只显示所属关系，不将 Project 拉成连接到每个子对象的放射中心。
2. **中间生产区**：泳道内左半为 `Asset`，右半为 `Storyboard`；镜头引用素材时从素材指向镜头。素材按角色、场景、道具分组，镜头按顺序号排列。
3. **右侧产出区**：`Image`、`Video`、`Voice`、`Task/Upscale` 沿生成顺序向右放置。超分任务和超分结果相邻，避免跨回左侧的回折线。
4. **跨分集内容**：项目级共享素材可在左侧「共享素材摘要」中出现；每个泳道仅放引用胶囊和一条汇总线，不复制完整节点，也不绘制穿越其他泳道的长线。

未选中泳道默认显示有限的关键节点与计数；展开一个泳道不应同时展开全部分集。这样可以保留生产流程而非形成网状资源图。

#### 5.5.3 节点内容与尺寸档位

所有节点遵循相同内容优先级：**缩略图或类型图标 → 标题 → 一行关键元数据 → 状态 → 不超过三个局部操作**。无缩略图时使用低对比度类型图标与首字母占位；长标题两行截断，完整名称放在悬停提示中。节点内不展示大段提示词、完整路径、原始任务日志或全量参数。

| 节点 | 内容层级 | 尺寸档位与使用条件 | 局部操作 |
|---|---|---|---|
| `Project` | 封面/作品图标、作品名、分集数、任务汇总、最近更新时间 | `summary` 260 × 120；仅一张根节点 | 聚焦全部分集、打开项目设置 |
| `Clip` | 分集号与名称、脚本/镜头/任务计数、泳道汇总状态 | 泳道标题高 40，展开区最小宽 760；不是可自由漂浮卡片 | 展开/折叠、聚焦该集、打开分集工作区 |
| `Asset` | 类型图标（角色/场景/道具）、主缩略图、名称、已被引用次数、最新素材图状态 | `compact` 156 × 76；`standard` 208 × 136；选中或有媒体时用标准档 | 预览、聚焦使用它的镜头、打开素材编辑 |
| `Storyboard` | 镜头号、构图缩略图、镜头简述、时长/顺序、图像与视频状态 | `compact` 176 × 88；`standard` 224 × 154 | 预览、聚焦引用素材/产物、打开镜头编辑 |
| `Image` | 缩略图、所属素材或镜头名称、版本/分辨率、就绪状态 | `compact` 152 × 108；`standard` 208 × 150 | 大图预览、查看版本、打开对应编辑位置 |
| `Video` | 视频封面、所属镜头、时长/分辨率、播放或生成状态 | `compact` 168 × 108；`standard` 232 × 158 | 静音悬停预览、播放预览、打开镜头编辑 |
| `Voice` | 声音图标或波形、角色/台词摘要、时长、绑定状态 | `compact` 168 × 76；`standard` 216 × 112 | 播放/暂停、聚焦绑定镜头、打开语音绑定 |
| `Task` / `Upscale` | 操作图标、目标名称、阶段/进度、模型或倍率摘要、错误摘要 | `compact` 176 × 72；执行中或失败时固定显示 | 查看 Tool Call、重试/取消（仍走确认）、打开任务详情 |

`summary` 仅用于作品或折叠集合；`compact` 用于概览和密集泳道；`standard` 用于选中、悬停或用户手动展开。尺寸变化只能在节点锚点内扩展，不能改变列归属或导致同泳道重新洗牌。

#### 5.5.4 业务关系与连线语义

只保留四类可被创作者直接理解的业务关系。所有边从原因或上游对象指向下游对象，箭头统一位于目标端；端口只表示关系入口/出口，不可自由拖拽建边。

| 关系 | 含义与典型方向 | 颜色与线型 | 聚合规则 |
|---|---|---|---|
| **所属** `BELONGS_TO` | `Project → Clip`、`Clip → Asset/Storyboard` | 中性灰细实线，低强调箭头 | 泳道内用容器关系表达；默认不为每个子对象重复画线 |
| **引用/使用** `USES` | `Asset → Storyboard`、共享素材摘要 → 泳道引用胶囊 | 蓝灰实线，目标端小箭头 | 同一素材被同一镜头多次使用时合为一条并标注数量；超过 3 个目标折叠为「+N 个镜头」 |
| **生成** `GENERATES` | `Storyboard → Image/Video/Voice`，或 `Task → 产物` | 柔和蓝紫实线，目标端实心箭头 | 同源的历史版本默认仅显示当前选中/最新版本，其余归入版本摘要节点 |
| **处理** `PROCESSES` | `Image/Video → Upscale Task → 处理后产物` | 琥珀灰短虚线，目标端实心箭头 | 同一批处理用一个任务节点和数量徽标；完成后可收拢为「已处理 N 项」 |

连线从卡片左右中部的固定锚点出入，采用平滑正交路径和一致的最小间距；不使用彩虹色、双向箭头、无标签长边或跨越整张画布的多重平行边。布局器优先调整同列排序和路径轨道减少交叉；仍无法避免时，在边交点显示轻量跨线桥，不把交点误导为节点。超出当前泳道、筛选范围或折叠组的目标以边尾摘要表示，例如「引用 4 个隐藏镜头」，点击后仅展开相关对象。

#### 5.5.5 状态与更新

状态来自业务数据和任务轮询，节点不自行推断或持久化业务状态：

- `ready`：默认中性色；媒体可预览。
- `queued` / `running`：低饱和蓝色进度条或环形进度，仅任务和待产物节点显示。
- `succeeded`：短暂柔和绿色完成反馈，随后回归默认状态，避免整图常驻绿点。
- `failed`：克制砖红色边框与一行错误摘要；错误详情仅在检查器或 Tool Call 中展开。
- `cancelled` / `missing`：灰色弱化，保留关联以解释生产历史。

更新顺序必须是「执行 Tool → 刷新权威实体或任务状态 → 重建受影响的投影片段 → 保留视图位置与选择」；不得先以乐观节点替代真实业务记录。可在任务提交后显示临时 `Task` 节点，但它必须以 Tool Call ID 关联，并在首次真实任务状态返回后替换或移除。

### 5.6 画布视觉与交互规范

#### 5.6.1 Mac 风格视觉系统

画布采用低饱和、轻材质的桌面创作工具风格，并以 CSS 变量支持浅色/深色自适应。视觉目标是让媒体与生产关系成为焦点，而非让节点边框和状态色争夺注意力。

| 元素 | 浅色模式 | 深色模式 | 规范 |
|---|---|---|---|
| 画布底色 | 冷灰白渐变，极弱点阵 | 深石墨渐变，极弱点阵 | 不使用高对比网格；网格仅辅助定位 |
| 泳道面板 | 白色 72% 透明度 | 深灰 58% 透明度 | `backdrop-filter` 轻模糊，圆角 16px，1px 半透明描边 |
| 节点卡片 | 白色/浅灰半透明 | 深灰/近黑半透明 | 圆角 12px，1px 细描边，默认无重阴影 |
| 选中与聚焦 | 低饱和系统蓝描边 | 提亮但不刺眼的系统蓝描边 | 外发光最多一层；关联对象使用 35% 强度，不全图变色 |
| 标题与元数据 | 深灰标题、次级灰元数据 | 近白标题、暖灰元数据 | 标题 13–14px、元数据 11–12px，统一字重层级 |
| 状态色 | 蓝=进行、绿=短暂成功、琥珀=警告、砖红=失败 | 保持语义、降低填充饱和度 | 不以颜色作为唯一信息，始终配合图标/文本 |

缩略图圆角 8px，媒体卡片中缩略图占可视面积的 50%–60%；任务、语音和摘要节点以图标优先。悬停才显示细边阴影和局部操作，非活动节点保持安静。所有触控目标不少于 28px，节点工具栏不遮挡标题、状态和连接锚点。

#### 5.6.2 精确交互约定

| 操作 | 节点/连线行为 | 与手动工作区和 Chat 的联动 |
|---|---|---|
| **单击节点** | 选中节点；媒体在右侧检查器打开预览，非媒体显示关系摘要与元数据；再次单击保持选择，不触发写操作 | 对应对象的 Tool Call 卡片滚入可见区域并高亮；若无对应调用，仅显示对象摘要 |
| **单击连线或数量徽标** | 选中该关系，突出其两端与同类边；数量徽标展开受限的关联列表 | 点击列表对象即聚焦其节点和关联 Tool Call |
| **悬停节点/边** | 仅高亮直接上下游一跳关系；显示完整标题、状态解释和最多三个局部操作 | 悬停 `Task/Upscale` 时同步高亮关联 Tool Call；悬停 Tool Call 时反向高亮目标节点、任务和生成边 |
| **双击节点** | 不在画布内编辑字段；立即跳到该对象在现有手动工作区的编辑位置 | 跳转时携带 `projectId`、`clipId` 与实体 ID；Chat 会话保留，返回 Agent 后恢复焦点 |
| **右键节点** | 打开上下文菜单：预览、聚焦上游/下游、复制名称、在手动模式打开、查看关联 Tool Call；任务可显示重试/取消 | 写操作菜单项先在 Chat 生成带范围的确认卡片，不能绕过现有确认策略 |
| **单击空白处 / Esc** | 清除画布选择与关联高亮，保持当前筛选、视口和折叠状态 | Chat 不清除对话或待确认卡片 |

媒体预览使用现有图片灯箱、视频播放器或语音播放能力；画布不复制媒体编辑器。点击「聚焦关联节点」以当前对象为中心做局部 fit view，并只显示必要的一跳或用户指定深度。Tool Call 卡片与节点通过实体 ID、任务 ID、Tool Call ID 建立双向映射：一个批量调用只高亮其目标摘要节点和计数，不瞬间展开所有受影响对象。

#### 5.6.3 布局、导航与用户控制

1. **列规则**：列索引由实体语义固定：`Project` = 0，`Clip` 泳道标题 = 1，`Asset` = 2，`Storyboard` = 3，`Image/Video/Voice` = 4，`Task/Upscale` 与处理后版本 = 5。生成和处理链只允许向右或在同列内短距离连接。
2. **泳道规则**：按分集顺序纵向排列；一个 `Clip` 是独立布局域。项目级共享素材位于左侧摘要区，引用进入每个泳道后终止于引用胶囊，避免跨泳道长边。
3. **稳定位置**：排序键固定为业务顺序（分集号、素材类型/名称、镜头序号、创建时间）加实体 ID。数据刷新只插入或移除受影响节点，不重排没有冲突的既有节点。
4. **自动整理**：首次进入、用户点击「整理此分集」或发现重叠时执行。它只移动未固定节点；用户拖动后标记为 `pinned`，全局整理不覆盖固定位置。提供「重置此分集布局」作为显式可逆操作，不做隐式自动复位。
5. **连线排布**：先根据引用和生成边的重心排序同列节点，再分配固定轨道；当边长超过两个列距或穿越折叠对象时改为摘要边，而不是继续绕线。
6. **视图工具**：提供 `Fit view`（全部可见节点或当前分集）、`Minimap`（仅显示泳道和列，不渲染缩略图）、按节点类型/状态/分集的筛选，以及按名称、镜头号、任务 ID 搜索。搜索结果只聚焦命中和最短关联路径。

初始进入默认 fit 到 `Project` 与最近活动分集；从 Chat 触发的聚焦仅改变当前视口，不改变用户的筛选和固定位置。画布视图偏好以 `projectId` 为键保存，业务对象的增删改仍以项目数据为唯一来源。

#### 5.6.4 首期可实现范围与文件拆分

**首期范围**：只展示当前项目、分集泳道、素材、镜头、最新图片/视频/语音以及进行中或最近完成的任务；支持四类受控业务边、单击预览/聚焦、双击打开手动编辑、Tool Call 双向高亮、分集折叠、Fit view、Minimap、类型/状态筛选和搜索。首期不支持手工创建关系、任意端口连线、全量媒体版本铺开、跨项目关系、画布内字段编辑或复杂多人协作布局。

推荐将画布职责拆分为下列 TypeScript 与样式文件，避免 `AgentPage` 同时承担数据归一化、布局、节点渲染和 Chat 同步：

```text
src/agent/domain/canvas.ts            # CanvasEntity、CanvasRelation、视图状态与允许关系类型
src/agent/canvas/node-data.ts         # 项目数据/任务数据 -> 语义节点、摘要与 Tool Call 映射
src/agent/canvas/layout.ts            # 分集泳道、固定列、排序、固定位置与摘要边布局
src/agent/canvas/sync.ts              # Tool Result、轮询刷新、增量投影与选择/聚焦同步
src/agent/canvas/nodes.tsx            # Project/Clip/Asset/Storyboard/Media/Task 节点及共有卡片
src/agent/canvas/index.ts             # React Flow 适配层、Canvas API、筛选与视图控制
src/components/agent/AgentPage.tsx    # 组合画布、检查器、Chat；不含画布业务计算
src/components/agent/ToolCallCard.tsx # Tool Call 状态与实体/任务反向高亮入口
src/styles/agent/canvas.css           # 主题变量、泳道、节点、边、状态与 minimap
src/styles/agent/tool-call.css        # Tool Call 与画布关联高亮样式
```

### 5.7 通信协议

| 事件 | 方向 | 载荷 |
|------|------|------|
| `agent:stream-delta` | Agent → Chat UI | `{ delta }` 流式文本 |
| `agent:tool-call` | Agent → Chat UI | `{ toolCallId, toolName, params, entityRefs, needConfirm }` |
| `agent:tool-result` | Agent → 画布 | `{ toolCallId, result, entityRefs, refreshScope }`；画布据此刷新投影，不直接写业务状态 |
| `canvas:focus` | 画布 → Chat UI | `{ entityRef, taskId?, toolCallId? }` |
| `user:confirm` | Chat UI → Agent | `{ toolCallId, approved }` |

### 5.8 安全模型

- **查询类** → 自动执行
- **创建/修改类** → 确认卡片，用户批准后执行
- **删除类** → 红色二次确认
- **批量操作** → 先告知影响范围，用户确认后执行
- **画布局部操作** → 仅发起已关联对象的预览、聚焦、导航或 Chat 确认请求；不得绕过上述权限模型直接调用写操作

---

## 六、可行性验证

**全部 6 项通过**。关键论证：桌面应用安全模型 ≠ Web 应用。

| 维度 | Web 应用 | Muse 桌面端 |
|------|---------|-----------|
| API Key 存储 | 服务器（所有用户共享） | 用户本地（自己用自己 Key） |
| Key 泄露后果 | 任何用户可盗刷 | 看自己的 Key = 零风险 |
| CORS | 浏览器严格拦截 | tauri-plugin-http 原生 fetch |

**结论**：Vercel AI SDK 的"不推荐客户端"警告不适用于桌面应用。纯前端 Agent 完全可行。

| 组件 | 技术 | 代码量 |
|------|------|--------|
| Agent Loop | AI SDK generateText (内置) | 0 |
| Tool 定义 | tool() + Zod → invoke() | ~200 |
| Context Builder | 分层 Prompt + 画布序列化 | ~80 |
| Canvas API | React Flow 投影、泳道布局与节点组件 | ~420 |
| Chat UI | useChat hook + Tool Card | ~250 |
| **总计** | | **~950 行** |

---

## 七、记忆与知识管理

四层架构：

| 层 | 内容 | 实现 |
|----|------|------|
| 短期工作记忆 | 当前对话上下文 | AI SDK messages[] |
| 会话持久化 | 跨刷新恢复 | SQLite `agent_sessions` (messages JSON + LLM 摘要) |
| 长期记忆 | 跨会话事实/偏好/知识 | **Mem0**（TS SDK，本地 SQLite + embedding） |
| 技能记忆 | 可复用操作流程 | Agent Skills 的 `SKILL.md` 文件 |

**为何选 Mem0**：唯一原生支持 TypeScript + 本地模式的记忆层。自动去重/过期/冲突处理。LOCOMO 基准 68.4%，token 仅 1800/对话。

**不引入**：Letta（太重）/ Zep（影视无密集关系）/ LangMem（绑定 LangGraph 生态）

**窗口管理**：正常 ≤20 轮自动管理，超限触发摘要压缩（前 10 轮 → 1 条摘要消息），恢复时加载 15 轮 + 摘要。

---

## 八、子 Agent 策略

> 2024-2025 业界教训：**单 Agent + 好工具 > 多 Agent 瞎协作**

Muse 初期：**单 Agent + 40+ Tool Registry**，所有操作共享同一批 Tauri 命令；每轮经 Tool Search 仅暴露少量相关工具。复杂流程用 SKILL.md 封装。

后期按需引入：AI SDK 的 `tool()` 内委托模式（子任务用不同 model + system prompt 处理）。

**不引入**：多 Agent 编排 / LangGraph 工作流引擎 / CrewAI 角色系统。

---

## 九、前端页面架构与目录规划

### 9.1 页面信息架构

```
AppShell（标题栏 / 全局入口 / Toast）
├─ 标题栏 TitleBar              Agent 模式切换按钮 + 设置 + 窗口控制
├─ 首页 Home                    创建作品、进入作品管理
├─ 作品管理 Projects            保持现有作品列表、创建、删除、选择作品
├─ Agent 页面 AgentPage         独立页面，左画布 + 右 Chat（替换整个主内容区）
└─ 设置 Settings                服务、模型、API Key、Agent 配置（覆盖层）
```

`HomePage`、`ProjectManagementPage` 保持原样不动。`AgentPage` 是独立顶层页面，与作品管理页平级。
Agent 模式切换按钮放在 `TitleBar`（窗口标题栏），不在项目工作区内部。选中作品后按钮启用，点击进入 Agent 页面，页面内有「返回」按钮回到手动模式。

### 9.2 模式切换

| 操作 | 触发方式 | 效果 |
|------|---------|------|
| 进入 Agent | TitleBar 的「Agent」按钮（选中作品后启用） | 替换主内容区为 `AgentPage`，传入当前选中作品 |
| 退出 Agent | `AgentPage` 顶部「返回」按钮 或 TitleBar 的「手动模式」按钮 | 回到 `ProjectManagementPage`，手动模式工作流完整保留 |

- 手动模式 `ProjectWorkspace` 零改动，不存在 `ManualWorkspace` 包装层
- Agent 页面完全独立，不侵入现有项目工作区
- 两个模式不共享页面帧，状态隔离更干净

### 9.3 导航与路由边界

- 顶层导航只有 Home、作品管理和 Agent。不存在 `/agent` 路由，也不提供跨项目 Agent 写操作。
- 缺失或无效 `projectId` 时 Agent 按钮禁用，不会进入 Agent 页面。
- `ProjectManagementPage` 通过 `onSelectedProjectChange` 回调向上同步选中作品，供 `TitleBar` 判断 Agent 按钮可用性。

### 9.4 目录结构

```
src/
├─ App.tsx                         # 管理 view、Agent 模式、选中作品同步
├─ components/
│  ├─ layout/
│  │   └─ TitleBar.tsx              # Agent 按钮 + 设置 + 窗口控制
│  ├─ project/
│  │   ├─ ProjectManagementPage.tsx # 新增 onSelectedProjectChange 回调
│  │   └─ ProjectWorkspace.tsx      # 恢复原始代码，零 Agent 侵入
│  └─ agent/
│      ├─ AgentPage.tsx             # 左画布、检查器和右侧 Chat 的页面组合
│      └─ ToolCallCard.tsx          # 工具调用确认与画布双向高亮
├─ agent/
│  ├─ domain/                       # context / intent / policy / canvas 纯逻辑
│  ├─ canvas/                       # 节点投影、稳定布局、同步、受控节点组件
│  ├─ engine/                       # AI SDK Agent Loop 封装
│  └─ tools/                        # Tool Registry + 两阶段搜索 + query 工具
├─ store/
│  ├─ workspace-store.ts            # 工作区模式状态
│  └─ agent-store.ts                # Agent 会话和每项目画布视图状态
├─ hooks/
│  ├─ useWorkspace.ts
│  └─ useAgentSession.ts            # Agent 会话生命周期
├─ services/
│  ├─ tauri.ts                      # 现有 IPC（不变）
│  ├─ agent-api.ts                  # Agent 配置持久化
│  └─ agent-session.ts             # 会话存储
├─ types/
│  └─ agent.ts                      # Agent 类型定义
└─ styles/agent/                    # 页面、画布与 Tool Call 样式
```

### 9.5 现有组件影响范围

| 组件 | 影响 | 说明 |
|------|------|------|
| `ProjectWorkspace.tsx` | **零改动** | 恢复原始代码 |
| `ProjectManagementPage.tsx` | 新增 1 个 prop | `onSelectedProjectChange` 回调 |
| `TitleBar.tsx` | 新增 Agent 按钮 + props | `onEnterAgent` / `onExitAgent` / `isAgentMode` / `canEnterAgent` |
| `App.tsx` | 新增 ~30 行 | Agent 模式状态管理 + `AgentPage` 渲染 |
| `AgentPage.tsx` | 组合职责收敛 | 只装配画布、检查器和 Chat，不计算业务边或布局 |
| 其他手动工作区组件 | **零改动** | 不涉及 |

### 9.6 首期与后续

**首期**：Home、作品管理和 Agent 页面独立可用；TitleBar 的 Agent 按钮完整工作；10 个查询 Tool 可对话调用。画布展示一个项目内的分集泳道、素材/镜头/最新产物与任务，并可预览、聚焦和与 Tool Call 互相定位。

**后续**：扩充 Tool、接入更多任务类型与版本摘要、会话持久化、SKILL.md、Mem0 长期记忆；画布始终通过项目数据刷新，不演化为第二套业务状态。

---

## 十、实施路线

### Phase 1：基础设施（已完成）

- ✅ 安装依赖（`ai` `@ai-sdk/*` `zod` `reactflow` `mem0ai`）
- ✅ `agent/domain/`：Context Builder、意图分类、安全策略、画布基础类型
- ✅ `agent/tools/`：Tool Registry + 两阶段 Tool Search + 10 个查询类 Tool
- ✅ `agent/engine/`：Vercel AI SDK v7 `generateText` + Tool 桥接
- ✅ `store/` `hooks/`：Agent 会话 + 工作区状态管理
- ✅ `components/agent/AgentPage.tsx`：独立 Agent 页面（左画布 + 右 Chat）
- ✅ `TitleBar`：Agent 模式切换按钮
- ✅ `App.tsx`：Agent 视图路由 + 选中作品同步
- ✅ `SettingsPage`：Agent 配置 Tab（provider/model/API Key）
- ✅ `schema.sql`：`agent_sessions` 表
- ✅ 手动模式零改动，`ProjectWorkspace` 恢复原始代码

### Phase 2：作品数据与画布联动（2 周）

- 建立以项目查询结果、任务状态与 Tool Result 为输入的 `CanvasProjection`；明确画布只持有视图状态，禁止反向成为项目、媒体或任务的状态源。
- 实现固定左→右列、按 `Clip` 分集泳道、稳定排序与局部折叠；先支持 Project、Clip、Asset、Storyboard、Image、Video、Voice、Task/Upscale 节点及四类受控业务关系。
- 实现 Mac 风格节点、媒体检查器、任务状态、Fit view、Minimap、类型/状态筛选和搜索；节点数据刷新时保持用户固定位置、筛选与视口。
- 打通画布与 Chat：Tool Call → 受影响投影刷新；节点/任务 → 关联 Tool Call 高亮、定位和确认卡片；双击跳回现有手动编辑位置。
- 注册全部 40+ Tool，保持完整 Registry 与每轮 `visibleTools` 分离；禁止跨项目写操作。
- 验证未保存编辑不会被自动提交或覆盖，生成、超分等异步任务在两种模式中持续可见。

### Phase 3：项目级智能增强（2-3 周）

- 补充项目内长会话、任务历史、Agent Skills（SKILL.md）+ Mem0 长期记忆。
- 扩展高价值的项目内批量编排，同时保持影响范围提示和写操作确认；批量任务在画布中使用摘要节点，不展开为密集连线。
- 根据真实项目规模校准泳道折叠、版本摘要、边聚合阈值和自动整理规则，并评估节点渲染与布局性能。
- 按真实会话评估路由准确率、候选命中率、Token/成本与澄清率，校准候选排序和上下文预算。

---

## 十一、风险与对策

| 风险 | 对策 |
|------|------|
| LLM API 不稳定 | 本地 Ollama 兜底，重试 3 次 |
| 模型操作错误 | 写操作确认 + 删除二次确认；所有 Tool 锁定当前项目上下文 |
| Tool 过多模型迷路 | 完整 Registry 不注入模型；两阶段 Tool Search 先筛 4–8 个候选概要，再仅加载 1 个、最多 2 个精确 Schema |
| 候选路由错误或请求歧义 | 高风险、批量和歧义请求强制搜索；无法唯一确定对象、范围或动作时先澄清 |
| Token 消耗大 | 画布状态摘要 + 消息历史定期压缩；设置单轮上下文预算 |
| 画布与业务数据不一致 | 数据库/Tauri 查询和任务状态为唯一事实来源；Tool 完成后按范围刷新投影，临时任务节点以 Tool Call ID 对账并可被真实任务替换 |
| 大项目形成网状杂乱 | 固定左→右列、Clip 泳道、四类业务边、同源聚合、跨范围摘要和版本折叠；不开放任意连线 |
| 自动布局打断创作 | 仅整理未固定节点；手动拖动即固定；重置布局必须由用户显式触发且限定当前分集 |
| 画布卡顿 | 分集按需展开、缩略图懒加载、节点 >100 时优先摘要/折叠，Minimap 使用简化渲染 |
| Agent 改造破坏既有工作流 | Agent 页面完全独立，不侵入 `ProjectWorkspace`；手动模式零改动 |

---

## 附录

### A. 依赖 & 文件清单

**npm 依赖**：`ai` `@ai-sdk/openai` `@ai-sdk/anthropic` `zod` `reactflow` `mem0ai`（6 个）
**CORS**：`tauri-plugin-http`（Rust 3 行）

**新增/调整文件**：
```text
src/components/agent/{AgentPage,ToolCallCard}.tsx
src/agent/domain/{context,intent,policy,canvas,types}.ts
src/agent/canvas/{index,node-data,layout,sync,nodes}.ts(x)
src/agent/engine/{engine,index}.ts
src/agent/tools/{registry,search,query,index}.ts
src/store/{workspace-store,agent-store}.ts
src/hooks/{useWorkspace,useAgentSession}.ts
src/services/{agent-api,agent-session}.ts
src/types/agent.ts
src/styles/agent/{workspace,canvas,tool-call,agent-config}.css
```

画布相关文件的职责必须分离：`domain/canvas.ts` 定义语义类型和允许关系；`node-data.ts` 从权威业务数据生成投影；`layout.ts` 只计算泳道与位置；`sync.ts` 负责 Tool/任务刷新与高亮映射；`nodes.tsx` 只负责卡片渲染。任何文件都不应把画布节点当作可提交的业务记录。

**修改文件**：
```text
src/App.tsx                          # Agent 视图路由 + 选中作品同步
src/components/layout/TitleBar.tsx    # Agent 模式切换按钮
src/components/project/ProjectManagementPage.tsx  # onSelectedProjectChange
src/components/settings/SettingsPage.tsx          # Agent 配置 Tab
src/styles.css                                   # 导入 agent 样式
migrations/schema.sql                            # agent_sessions 表
scripts/copy-worker-deps.mjs                      # 跳过 workspace symlink
```

**未改动的组件**：`ProjectWorkspace.tsx` 保持原始代码，零 Agent 侵入。

**后端**：零新增 Rust 代码。

### B. 画布验收清单

- 任意已加载项目都能从左到右读出 Project、Clip、素材/镜头和产物/任务的生产关系；不出现跨整图的默认放射状连线。
- 同一 Clip 的对象只在本泳道展开；共享素材和跨泳道关系以引用胶囊与计数摘要表达。
- 节点单击、悬停、双击、右键分别满足预览/聚焦、局部关联高亮、跳转手动编辑和受控操作入口的约定。
- Tool Call 与实体、任务之间能双向定位；画布刷新后不丢失用户选择、固定位置或当前视口。
- 改变画布布局、筛选或折叠状态不会直接修改作品、分集、素材、镜头、媒体或任务业务数据。

### C. 参考资料

- [Vercel AI SDK - Agents](https://sdk.vercel.ai/docs/ai-sdk-core/agents)
- [Agent Skills Specification](https://agentskills.io/specification)
- [Hermes Agent - Tool Registry](https://github.com/NousResearch/hermes-agent)
- [React Flow](https://reactflow.dev/examples)
- [Mem0 - Memory Layer](https://github.com/mem0ai/mem0)
