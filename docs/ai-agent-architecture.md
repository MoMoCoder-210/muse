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
|------|-------|---------|---------|
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
│  左侧 React Flow 画布 ←── Agent 操作实时推送节点变更         │
│  右侧 Chat UI ←── useChat hook 流式渲染                     │
└────────────────────────────────────────────────────────────┘
                        │  Tauri IPC  │  tauri-plugin-http (CORS)
                        ▼              ▼
              现有 Rust 后端(零改动)    LLM API (OpenAI/Claude)
```

**设计原则**：后端零 Rust 新增代码、Agent 全在 TypeScript、画布是唯一状态源、能力自发现。

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
    // 每个 tool call 完成 → 更新画布
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

7 种节点类型：`ProjectNode / ClipNode / AssetNode / ImageNode / StoryboardNode / VideoNode / UpscaleNode`
4 种连线类型：`GENERATED_BY / UPSCALED_FROM / BELONGS_TO / DEPENDS_ON`

**Agent Tool Call → 画布更新流**：

```
Tool 执行成功 → canvas.addNodes(pendingNodes) → Canvas 出现 spinner 节点
             → 3s 轮询状态变化 → canvas.updateNode(id, { status: 'ready', path })
             → upscale-done 事件 → canvas.addUpscaleEdge()
```

Canvas API 暴露：`addNode / updateNode / addEdge / focusNode / fitView`。

### 5.6 通信协议

| 事件 | 方向 | 载荷 |
|------|------|------|
| `agent:stream-delta` | Agent → Chat UI | `{ delta }` 流式文本 |
| `agent:tool-call` | Agent → Chat UI | `{ toolName, params, needConfirm }` |
| `agent:tool-result` | Agent → 画布 | `{ result, canvasOps }` |
| `user:confirm` | Chat UI → Agent | `{ approved }` |

### 5.7 安全模型

- **查询类** → 自动执行
- **创建/修改类** → 确认卡片，用户批准后执行
- **删除类** → 红色二次确认
- **批量操作** → 先告知影响范围，用户确认后执行

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
| Canvas API | React Flow wrapper | ~200 |
| Chat UI | useChat hook + Tool Card | ~250 |
| **总计** | | **~730 行** |

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
│      ├─ AgentPage.tsx             # 独立 Agent 页面（左画布 + 右 Chat）
│      └─ ToolCallCard.tsx          # 工具调用确认卡片
├─ agent/
│  ├─ domain/                       # context / intent / policy / canvas 纯逻辑
│  ├─ engine/                       # AI SDK Agent Loop 封装
│  └─ tools/                        # Tool Registry + 两阶段搜索 + query 工具
├─ store/
│  ├─ workspace-store.ts            # 工作区模式状态
│  └─ agent-store.ts                # Agent 会话状态（按 projectId 隔离）
├─ hooks/
│  ├─ useWorkspace.ts
│  └─ useAgentSession.ts            # Agent 会话生命周期
├─ services/
│  ├─ tauri.ts                      # 现有 IPC（不变）
│  ├─ agent-api.ts                  # Agent 配置持久化
│  └─ agent-session.ts             # 会话存储
├─ types/
│  └─ agent.ts                      # Agent 类型定义
└─ styles/agent/                    # Agent 页面 + 确认卡片样式
```

### 9.5 现有组件影响范围

| 组件 | 影响 | 说明 |
|------|------|------|
| `ProjectWorkspace.tsx` | **零改动** | 恢复原始代码 |
| `ProjectManagementPage.tsx` | 新增 1 个 prop | `onSelectedProjectChange` 回调 |
| `TitleBar.tsx` | 新增 Agent 按钮 + props | `onEnterAgent` / `onExitAgent` / `isAgentMode` / `canEnterAgent` |
| `App.tsx` | 新增 ~30 行 | Agent 模式状态管理 + `AgentPage` 渲染 |
| 其他所有组件 | **零改动** | 不涉及 |

### 9.6 首期与后续

**首期**：Home、作品管理和 Agent 页面独立可用；TitleBar 的 Agent 按钮完整工作；10 个查询 Tool 可对话调用。

**后续**：扩充 Tool、画布节点对接、会话持久化、SKILL.md、Mem0 长期记忆。

---

## 十、实施路线

### Phase 1：基础设施（已完成）

- ✅ 安装依赖（`ai` `@ai-sdk/*` `zod` `reactflow` `mem0ai`）
- ✅ `agent/domain/`：Context Builder、意图分类、安全策略、画布模型
- ✅ `agent/tools/`：Tool Registry + 两阶段 Tool Search + 10 个查询类 Tool
- ✅ `agent/engine/`：Vercel AI SDK v7 `generateText` + Tool 桥接
- ✅ `store/` `hooks/`：Agent 会话 + 工作区状态管理
- ✅ `components/agent/AgentPage.tsx`：独立 Agent 页面（左画布 + 右 Chat）
- ✅ `TitleBar`：Agent 模式切换按钮
- ✅ `App.tsx`：Agent 视图路由 + 选中作品同步
- ✅ `SettingsPage`：Agent 配置 Tab（provider/model/API Key）
- ✅ `schema.sql`：`agent_sessions` 表
- ✅ 手动模式零改动，`ProjectWorkspace` 恢复原始代码

### Phase 2：项目内 Agent 模式与核心能力接入（2 周）

- 实现 `AgentWorkspace`：左侧 React Flow 画布、右侧 Chat、Tool Card 和当前项目上下文
- 注册全部 40+ Tool，保持完整 Registry 与每轮 `visibleTools` 分离；禁止跨项目写操作
- 接入领域/意图/上下文候选排序、澄清分支、确认流程和 Tool Call → 项目数据/画布刷新联动
- 实现按项目的会话、画布和待确认操作持久化，以及切回手动模式后的阶段/选中对象恢复
- 验证未保存编辑不会被自动提交或覆盖，生成、超分等异步任务在两种模式中持续可见

### Phase 3：项目级智能增强（2-3 周）

- 补充项目内长会话、任务历史、Agent Skills（SKILL.md）+ Mem0 长期记忆
- 扩展高价值的项目内批量编排，同时保持影响范围提示和写操作确认
- 按真实会话评估路由准确率、候选命中率、Token/成本与澄清率，校准候选排序和上下文预算

---

## 十一、风险与对策

| 风险 | 对策 |
|------|------|
| LLM API 不稳定 | 本地 Ollama 兜底，重试 3 次 |
| 模型操作错误 | 写操作确认 + 删除二次确认；所有 Tool 锁定当前项目上下文 |
| Tool 过多模型迷路 | 完整 Registry 不注入模型；两阶段 Tool Search 先筛 4–8 个候选概要，再仅加载 1 个、最多 2 个精确 Schema |
| 候选路由错误或请求歧义 | 高风险、批量和歧义请求强制搜索；无法唯一确定对象、范围或动作时先澄清 |
| Token 消耗大 | 画布状态摘要 + 消息历史定期压缩；设置单轮上下文预算 |
| 画布卡顿 | React Flow 虚拟化，节点 >100 聚合 |
| Agent 改造破坏既有工作流 | Agent 页面完全独立，不侵入 `ProjectWorkspace`；手动模式零改动 |

---

## 附录

### A. 依赖 & 文件清单

**npm 依赖**：`ai` `@ai-sdk/openai` `@ai-sdk/anthropic` `zod` `reactflow` `mem0ai`（6 个）
**CORS**：`tauri-plugin-http`（Rust 3 行）

**新增文件**：
```text
src/components/agent/{AgentPage,ToolCallCard}.tsx
src/agent/domain/{context,intent,policy,canvas,types}.ts
src/agent/engine/{engine,index}.ts
src/agent/tools/{registry,search,query,index}.ts
src/store/{workspace-store,agent-store}.ts
src/hooks/{useWorkspace,useAgentSession}.ts
src/services/{agent-api,agent-session}.ts
src/types/agent.ts
src/styles/agent/{workspace,agent-config}.css
```

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

### B. 参考资料

- [Vercel AI SDK - Agents](https://sdk.vercel.ai/docs/ai-sdk-core/agents)
- [Agent Skills Specification](https://agentskills.io/specification)
- [Hermes Agent - Tool Registry](https://github.com/NousResearch/hermes-agent)
- [React Flow](https://reactflow.dev/examples)
- [Mem0 - Memory Layer](https://github.com/mem0ai/mem0)
