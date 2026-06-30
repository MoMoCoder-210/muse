# 模块 10：桌面端页面与交互工作台

## 1. 模块职责

这个模块定义桌面端视频创作工具的完整前端工作台结构与交互规范。它负责把项目、片段、资产、分镜、任务等后端数据模型组织成一套可操作的桌面工作流，让用户从剧本导入到成片导出都在一个连贯的三栏工作台中完成。

本模块不定义后端服务逻辑，只定义：

- 前端信息架构与布局规范
- 各页面的功能清单与交互流程
- 进度、失败、失效的可视化规范
- 桌面端特有功能的设计要求
- 前端状态管理方案与视图切换方案

技术栈：Tauri 2 + React 18 + TypeScript + Vite + TanStack Query v5 + Zustand。

## 2. 设计约束

1. **单窗口三栏布局**：整个创作流程在一个主窗口内完成，不使用多窗口。三栏布局固定可见，左栏可折叠，右栏可折叠，中栏始终保留。

2. **不使用传统路由**：不引入 React Router。视图切换基于当前选中片段的 `currentStep` 驱动（项目级 `currentStep` 为聚合值，仅用于顶栏展示），中栏根据选中片段的当前步骤渲染对应的工作台组件。左栏的项目列表 ↔ 工作台切换是唯一的全局视图切换点。

3. **数据获取只走 TanStack Query**：所有从后端（Tauri IPC）获取的数据必须通过 TanStack Query 管理。组件不直接调用 `invoke()`，统一通过封装的 query hooks 获取。

4. **轻量 UI 状态走 Zustand**：当前选中的项目、片段、分镜、资产，面板展开/折叠状态，当前步骤等纯 UI 状态用 Zustand 管理。这些状态不持久化到数据库，应用重启后从数据库恢复默认选中项。

5. **任务进度走事件流**：长任务的进度通过 Tauri 的 `emit`/`listen` 推送的 `task-event` 事件实时更新 UI。TanStack Query 每 2 秒轮询业务状态作为兜底，防止事件丢失。

6. **桌面端无权限包裹**：不保留 Web 版的登录、权限、角色包裹逻辑。所有功能对本地用户直接开放。

7. **文件优先本地**：所有媒体文件（图片、音频、视频）存储在本地工作区，前端通过 `convertFileSrc` 或 Tauri 的 asset 协议加载本地文件，不走 HTTP。

8. **失败可恢复是底线**：任何任务失败后，UI 必须提供至少一个可操作的恢复路径（重试、查看日志、回到上游修正），不能只显示红字。

## 3. 信息架构

### 3.1 三栏工作台总览

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  顶栏：项目名 · 聚合 currentStep 步骤条 · autoContinue/stopStep 开关 · 设置入口│
├──────────┬───────────────────────────────────────────┬───────────────────────┤
│          │                                           │                       │
│  左栏     │              中栏（主编辑区）              │     右栏              │
│  项目树   │   按片段 currentStep 切换视图              │   任务与参数           │
│  260px   │                                           │   320px               │
│          │                                           │                       │
│  可折叠   │                                           │   可折叠               │
│  → 48px  │                                           │   → 48px              │
│          │                                           │                       │
├──────────┴───────────────────────────────────────────┴───────────────────────┤
│  底栏：worker 状态 · 最近任务 · 本地磁盘用量                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 左栏：项目树

宽度 260px，可折叠为 48px（只显示图标）。自上而下三层结构：

**第一层：项目列表**

- 显示所有 `Project` 记录（来自 `listProjects` IPC）
- 每项显示：项目名、status 标签、currentStep 简写（聚合值，所有片段中最慢的步骤）、最后更新时间
- 点击项目 → 切换当前项目（写入 Zustand `selectedProjectId`），中栏和右栏随之刷新
- 当前选中项目高亮
- 底部有"新建项目"按钮

**第二层：当前项目片段列表**

- 当选中某个项目后，展开该项目下的 `Clip` 列表（来自 `listClips` query）
- 每项显示：sortIndex、title、status 标签、**currentStep 简写**（片段当前步骤，如 script、asset 等）
- status 用颜色区分：pending（灰）、script_ready（蓝）、asset_ready（青）、storyboard_ready（绿）、media_ready（橙）、done（深绿）、failed（红）
- currentStep 简写用小号标签显示在 status 标签旁，帮助用户快速识别每个片段的独立进度
- 点击片段 → 切换当前片段（写入 Zustand `selectedClipId`），中栏和右栏随之刷新
- 用户可点击任意片段进行操作，不受其他片段进度限制（片段间独立推进）
- 当前选中片段高亮

**第三层：当前片段分镜概览**

- 当选中某个片段后，展开该片段下的 `Storyboard` 概览（来自 `listStoryboards` query）
- 每项显示：seqNum、台词摘要（截断 20 字）、三状态指示灯（imageState/voiceState/videoState）
- 三状态指示灯颜色：pending（灰点）、running（蓝转圈）、ready（绿点）、failed（红点）、invalidated（黄点）
- 点击分镜 → 跳转到分镜工作台并定位到该分镜（写入 Zustand `selectedStoryboardId`）

**折叠状态**：左栏折叠为 48px 时只显示项目图标和片段数量角标，hover 展开 flyout 面板。

### 3.3 中栏：主编辑区

宽度自适应（`flex: 1`）。根据选中片段的 `currentStep` 渲染对应的工作台视图（项目级 `currentStep` 为聚合值，仅用于顶栏步骤条展示）：

| currentStep | 中栏视图 | 说明 |
|-------------|----------|------|
| project | 项目首页 | 新建/打开/最近项目 |
| split | 剧本导入与片段拆分 | 剧本预览、拆分进度、片段列表 |
| script | 片段剧本工作台 | 剧本生成与编辑（详见模块 03） |
| asset | 资源工作台 | 角色/场景/物品管理与生图 |
| storyboard | 分镜工作台 | 分镜列表与详情编辑 |
| voice | 分镜工作台（语音态） | 复用分镜工作台，语音列高亮 |
| video | 视频时间线 | 分镜视频时间线预览与生成 |
| export | 导出页 | 输出路径、设置、导出记录 |

步骤切换规则（片段级）：

- 顶栏步骤条显示项目聚合步骤（所有片段中最慢的步骤），用户可点击跳转查看任意已完成步骤
- 中栏视图由当前选中片段的 `currentStep` 驱动，用户可点击左栏任意片段切换工作内容
- 每个片段独立推进：片段当前步骤的所有子任务 success 后，`autoContinue = true` 且 `stopStep` 未命中时自动推进该片段
- `stopStep` 命中时，对应片段的步骤条位置显示"等待确认"标记
- 不同片段可处于不同步骤，用户可对进度快的片段提前操作，不阻塞其他片段

### 3.4 右栏：任务与参数

宽度 320px，可折叠为 48px。自上而下四个区块：

**区块一：当前步骤参数**

- 根据 currentStep 显示对应参数面板
- project 步骤：项目设置（name、styleMode、autoContinue、stopStep）
- asset 步骤：默认图像参数（ImageParam）
- storyboard 步骤：分镜图像参数
- voice 步骤：默认语音参数（VoiceParam）
- video 步骤：默认视频参数（VideoParam）
- export 步骤：导出设置
- 参数修改后自动保存（debounce 1 秒），或提供"应用"按钮

**区块二：最近任务**

- 显示当前项目最近 20 条 `Task` 记录（来自 `listTasks` query）
- 每条显示：type 简称、status 标签、进度条（running 时）、finishedAt
- 按 status 颜色区分：pending（灰）、running/waiting_remote/downloading（蓝）、success（绿）、failed（红）、canceled（灰删除线）
- 点击任务 → 展开详情（inputJson、outputJson、errorMessage、retryCount）

**区块三：失败信息**

- 过滤出当前项目中 `status = 'failed'` 的任务
- 每条失败任务显示：errorMessage 摘要、重试次数（retryCount/maxRetry）
- 提供操作按钮：重试、查看日志、跳转到上游

**区块四：快捷重试**

- 对失败任务提供一键重试按钮
- 重试按钮调用 `retryTask` IPC，创建新 Task
- 重试后原失败任务保留审计记录，新 Task 出现在最近任务列表顶部
- 如果是自动重试类型的错误（网络超时、5xx），显示"自动重试中"状态

**折叠状态**：右栏折叠为 48px 时只显示任务状态汇总图标（绿勾/红叉/蓝转圈），hover 展开 flyout 面板。

### 3.5 顶栏

- 左侧：当前项目名 + 返回项目列表按钮
- 中间：项目级步骤进度条（project → split → script → asset → storyboard → voice → video → export），显示聚合步骤（所有片段中最慢的步骤），当前步骤高亮，已完成步骤打勾，点击可跳转。同时在步骤条下方显示当前选中片段的 currentStep 标记
- 右侧：autoContinue 开关、stopStep 下拉选择、设置按钮（项目设置、桌面端设置）

### 3.6 底栏

- 左侧：worker 运行状态指示灯（运行中/已停止）
- 中间：最近一条任务的状态文字（如"正在生成资产图 3/8"）
- 右侧：本地磁盘用量（当前工作区目录大小，点击可清理缓存）

## 4. 页面清单

### 4.1 项目首页

**触发条件**：选中片段的 `currentStep = 'project'`（或未选中项目/片段）时显示。

**功能清单**：

| 功能 | 说明 | 数据来源 |
|------|------|----------|
| 新建项目 | 打开新建项目对话框 | createProject IPC |
| 打开项目 | 文件系统浏览选择 workspace 目录 | openProject IPC |
| 最近项目列表 | 按 updatedAt 降序排列 | listProjects query |
| 项目卡片 | 显示项目名、styleMode、currentStep、状态、封面图、最后更新时间 | Project + coverPath |
| 归档项目 | 在卡片菜单中归档 | archiveProject IPC |
| 删除项目 | 在卡片菜单中删除（移到回收站） | deleteProject IPC |

**新建项目对话框交互流程**：

```text
1. 点击"新建项目"按钮 → 弹出对话框
2. 填写项目名（1-50 字符，实时校验）
3. 选择工作区路径（调用 Tauri 文件系统对话框，或手动输入路径）
4. 选择输入模式：
   - empty（空项目，手动添加内容）
   - script（剧本项目，粘贴文本或上传 txt/docx 文件）
5. 选择风格模式：RS（图生）/ TS（融生）/ ZH（综合）
6. 可选：设置 stopStep（停在哪步等待确认）
7. 可选：设置 autoContinue（是否自动推进）
8. 可选：配置默认图像/视频/语音参数
9. 如果是 script 模式：
   a. 粘贴文本 或 拖拽文件到上传区 或 点击选择文件
   b. 实时显示字数统计
   c. 乱码检测预览（采样前 1000 字符）
10. 点击"创建" → 调用 createProject IPC
11. 创建成功 → 切换到该项目工作台，中栏显示"拆分中"
12. 创建失败 → 对话框内显示错误码对应提示，不关闭对话框
```

**打开项目交互流程**：

```text
1. 点击"打开项目"按钮 → 调用 Tauri 文件系统对话框
2. 用户选择包含 manifest.json 的目录
3. 调用 openProject IPC
4. 校验 manifest.json 和 SQLite 可用性
5. 成功 → 切换到该项目工作台
6. 失败 → 提示错误原因（路径无效、数据库损坏等）
```

**最近项目列表交互**：

- 卡片点击 → 直接打开该项目工作台
- 卡片右键或菜单按钮 → 归档 / 删除 / 在文件管理器中显示
- 列表支持搜索过滤（按项目名模糊匹配）

### 4.2 项目工作台

**触发条件**：选中项目后，选中片段的 `currentStep` 为 `split` 或 `script` 时显示。

**功能清单**：

| 功能 | 说明 |
|------|------|
| 剧本预览 | 显示 ScriptSource 的 normalizedContent，只读 |
| 拆分进度 | 显示 split_script_source 任务的实时进度 |
| 片段列表 | 显示该项目的所有 Clip，按 sortIndex 排序 |
| 片段状态 | 每个片段显示 status 标签 |
| 片段编辑 | 双击片段可编辑 title、summary |
| 片段排序 | 拖拽调整 sortIndex |
| 片段合并/拆分 | 手动合并相邻片段或拆分片段 |
| 快速跳转 | 点击片段跳转到对应步骤（剧本生成/资源/分镜） |
| 触发剧本生成 | 选中片段后点击"生成剧本"按钮 |

**拆分进度交互流程**：

```text
1. 项目创建后（script 模式），项目 currentStep = 'split'（聚合值，此时无片段）
2. 中栏显示剧本预览（上半区）和拆分进度（下半区）
3. 右栏显示 split_script_source 任务进度
4. 监听 task-event：
   - task_started → 显示"拆分中"转圈
   - task_progress → 更新进度条
   - task_success → 刷新片段列表，显示拆分结果
   - task_failed → 显示错误信息 + 重试按钮
5. 拆分成功后，创建 Clip 记录，每个片段 current_step 初始为 'split'：
   a. 如果 autoContinue = true → 自动推进片段到 script 步骤
   b. 如果 autoContinue = false → 显示"拆分完成，点击继续"按钮
```

**片段列表交互**：

```text
1. 展示所有 Clip，每项显示：
   - sortIndex（序号）
   - title（标题，可编辑）
   - summary（摘要，截断显示）
   - status 标签
   - 分镜数量
2. 操作：
   - 点击选中 → 右栏显示该片段参数和任务
   - 双击标题 → 进入编辑模式
   - 拖拽 → 调整顺序（调用 updateClipSortOrder IPC）
   - 右键菜单 → 生成剧本 / 拆分 / 合并 / 删除
3. 批量操作：
   - Ctrl+多选 → 批量生成剧本
   - 批量删除
```

### 4.3 资源工作台

**触发条件**：选中片段的 `currentStep = 'asset'` 时显示。

**布局**：中栏内部分为左右两区：

- 左区（60%）：资产卡片网格
- 右区（40%）：资产详情编辑面板

**功能清单**：

| 功能 | 说明 |
|------|------|
| 类型切换 | 顶部 Tab 切换：角色（character）/ 场景（scene）/ 物品（item） |
| 资产卡片 | 显示名称、缩略图、status 标签 |
| 搜索过滤 | 按名称模糊搜索 |
| 批量选中 | Ctrl+多选或框选 |
| 批量生图 | 选中多个资产后一键提交生图任务 |
| 单项编辑 | 点击卡片在右侧面板编辑 |
| 单项生图 | 在详情面板点击"生成图片"按钮 |
| 替换图片 | 上传本地图片替换生成的图片 |
| 手动添加 | 手动新增资产（source = 'manual'） |
| 导入资产 | 从本地文件导入资产图（source = 'imported'） |

**资产详情面板**：

```text
显示并可编辑：
- name（名称）
- description（描述）
- prompt（提示词）
- referenceImagePath（参考图，支持拖拽上传）
- generatedImagePath（生成图，只读，显示缩略图）
- status（只读状态标签）
- source（来源标签：model/manual/imported）

操作按钮：
- 生成图片 → 提交 generate_asset_image 任务
- 重新生成 → 重置图片后重新生成
- 上传替换 → 选择本地图片文件
- 确认资产 → status 改为 confirmed
- 最近任务 → 展开该资产的历史生图任务
```

**批量生图交互流程**：

```text
1. 在资产卡片网格中多选资产（只选 status 非 image_ready 的）
2. 点击"批量生图"按钮
3. 弹出确认对话框：显示选中数量、将使用的参数（来自项目默认 ImageParam）
4. 确认后：
   a. 调用批量提交 IPC，后端返回 batchId
   b. 为每个资产创建独立的 generate_asset_image Task（不做成一条巨型任务），关联到同一 batchId
   c. 每个 Task 各自推送 task-event，同时推送 batch-progress 事件
   d. 卡片上显示"生成中"转圈
5. 进度展示：
   a. 顶部聚合进度条：已完成 X / 总数 Y（失败 Z），通过 batchId 跟踪
   b. 每个卡片独立显示状态
6. 单个失败不影响其他，失败的卡片显示红色 + 重试按钮
7. 全部成功后，如果 autoContinue 且 stopStep 未命中 asset → 推进到 storyboard
```

**资产与分镜同步提示**：

- 当资产图首次生成或资产信息修改后，如果该资产被分镜引用，需要在详情面板显示提示："此资产被 N 条分镜引用，修改后将影响这些分镜的融合图"
- 修改保存后，相关分镜的 `imageState` 被标记为 `invalidated`

### 4.4 分镜工作台

**触发条件**：选中片段的 `currentStep` 为 `storyboard`、`voice` 或 `video` 时显示（voice/video 步骤复用分镜工作台，只是高亮列不同）。

**布局**：中栏内部分为左右两区：

- 左区（40%）：分镜列表
- 右区（60%）：分镜详情编辑器

**分镜列表**：

| 列 | 说明 |
|----|------|
| seqNum | 镜号，可编辑，拖拽排序 |
| 缩略图 | fusedImagePath 的缩略图，无图时显示占位 |
| 台词摘要 | dialogue 截断 20 字 |
| 时长 | voiceDuration 或 videoDuration |
| imageState | 状态指示灯 |
| voiceState | 状态指示灯（voice/video 步骤高亮） |
| videoState | 状态指示灯（video 步骤高亮） |

**分镜详情编辑器**：

```text
可编辑字段：
- seqNum（镜号）
- dialogue（台词）
- visualDescription（画面描述）
- imagePrompt（图像提示词）
- videoPrompt（视频提示词）
- characterIds（引用角色，多选下拉，来自 Asset 列表）
- sceneIds（引用场景）
- itemIds（引用物品）
- imageParam（图像参数，默认继承项目参数，可覆盖）
- videoParam（视频参数）
- voiceParam（语音参数）

只读展示：
- fusedImagePath（融合图，大图预览）
- voicePath（语音，内联播放器）
- videoPath（视频，内联播放器）
- imageState / voiceState / videoState（状态标签）

操作按钮：
- 生成融合图 → 提交 generate_storyboard_image 任务
- 生成语音 → 提交 generate_storyboard_voice 任务
- 生成视频 → 提交 generate_storyboard_video 任务
- 上传替代图 → 选择本地图片作为融合图替代
- 回滚融合图 → 回到上一次生成结果
```

**分镜失效与重算交互**：

```text
触发场景 → UI 反馈：
1. 用户修改 dialogue（台词）
   → 语音卡片变为"需重生成"（voiceState = invalidated，黄色标记）
   → 视频卡片变为"受上游影响"（videoState = invalidated，黄色标记）
   → 融合图不受影响（台词不影响画面）

2. 用户修改 visualDescription 或 imagePrompt
   → 融合图卡片变为"需重生成"（imageState = invalidated）
   → 视频卡片变为"受上游影响"（videoState = invalidated）

3. 用户修改 videoPrompt
   → 视频卡片变为"需重生成"（videoState = invalidated）

4. 用户修改引用资产（characterIds/sceneIds/itemIds）
   → 融合图卡片变为"需重生成"
   → 视频卡片变为"受上游影响"

5. 用户修改 seqNum（仅排序）
   → 导出时间线标记为"需更新"
   → 不影响已有视频

每个 invalidated 卡片提供"重新生成"按钮，点击后提交对应任务。
批量操作支持"重算所有失效分镜"。
```

**分镜批量操作**：

| 操作 | 说明 |
|------|------|
| 批量重排 | 选中多个分镜拖拽调整顺序 |
| 批量改参数 | 选中多个分镜统一修改 imageParam/videoParam |
| 批量重算融合图 | 选中多个分镜批量提交生图任务 |
| 批量重算语音 | 选中多个分镜批量提交语音任务 |
| 批量重算视频 | 选中多个分镜批量提交视频任务 |

### 4.5 视频时间线

**触发条件**：选中片段的 `currentStep = 'video'` 时作为中栏的替代视图（也可以在分镜工作台中通过 Tab 切换）。

**功能清单**：

| 功能 | 说明 |
|------|------|
| 时间线预览 | 所有分镜视频按 seqNum 拼接预览，显示总时长 |
| 分镜视频卡片 | 每条分镜显示视频缩略图、时长、状态 |
| 单独生成 | 每条分镜可单独提交视频生成任务 |
| 批量生成 | 选中多条分镜批量提交 |
| 视频播放 | 内联播放器播放已生成的视频 |
| 失效标记 | videoState = invalidated 的分镜高亮显示"需重生成" |
| 时间线校验 | 检查所有分镜是否都有视频文件，缺失的标红 |

### 4.6 导出页

**触发条件**：选中片段的 `currentStep = 'export'` 时显示。

**功能清单**：

| 功能 | 说明 |
|------|------|
| 输出路径 | 选择导出文件保存路径（Tauri 文件对话框） |
| 分辨率 | 下拉选择：720p / 1080p / 2K / 4K |
| 帧率 | 下拉选择：24 / 30 / 60 |
| 字幕开关 | 是否将分镜台词生成为 srt 字幕并入视频 |
| 背景音乐开关 | 是否加入背景音乐（需要选择音频文件） |
| 导出按钮 | 点击后提交 export_project_video 任务 |
| 导出进度 | 实时显示 FFmpeg 拼接进度 |
| 导出记录 | 历史导出记录列表（来自 exports 表） |
| 导出预检 | 导出前检查所有分镜视频文件是否存在 |

**导出交互流程**：

```text
1. 进入导出页，先执行导出预检：
   a. 调用 checkProjectExportReadiness IPC
   b. 检查所有分镜是否有 videoPath 且文件存在
   c. 如果有缺失，显示红色警告列表："分镜 #3 缺少视频文件"
   d. 缺失项提供"跳转到分镜"按钮
2. 用户配置导出参数：
   a. 选择输出路径
   b. 选择分辨率、帧率
   c. 选择是否带字幕、背景音乐
3. 点击"导出"：
   a. 调用 createExport IPC，创建 export 记录 + export_project_video Task
   b. 中栏显示导出进度（FFmpeg 拼接进度）
   c. 监听 task-event 更新进度
4. 导出成功：
   a. 显示"导出完成"提示
   b. 提供"打开文件所在目录"按钮（调用 Tauri shell open）
   c. 导出记录列表刷新
5. 导出失败：
   a. 显示错误信息
   b. 提供重试按钮
   c. 提供查看日志按钮
```

**导出记录列表**：

- 每条记录显示：输出文件名、format、resolution、fps、status、createdAt
- status 为 success 的记录提供"打开文件"和"在文件管理器中显示"按钮
- status 为 failed 的记录提供"重试"和"查看日志"按钮

## 5. 交互原则

### 5.1 进度必须可见

**适用场景**：所有耗时超过 1 秒的操作。

**UI 规范**：

每个进行中的任务卡片必须包含以下元素：

```text
┌─────────────────────────────────────────┐
│  [任务类型图标] 资产生图 · 角色"主角"     │
│                                          │
│  ███████████░░░░░░░░░  55%               │
│                                          │
│  状态：远端生成中    最后更新：10:32:15   │
└─────────────────────────────────────────┘
```

| 元素 | 说明 |
|------|------|
| 任务类型 | 显示 type 对应的中文名称和业务对象名 |
| 进度条 | running/waiting_remote/downloading 状态显示进度条 |
| 进度百分比 | 来自 task_progress 事件的 progress 字段，0-100 |
| 状态文字 | pending（排队中）/ running（执行中）/ waiting_remote（远端生成中）/ downloading（下载中） |
| 最后更新时间 | 来自 Task.updatedAt，每秒刷新"X 秒前" |
| 错误信息 | failed 状态时显示 errorMessage 摘要 |

**批量任务进度**：

```text
┌─────────────────────────────────────────┐
│  批量资产生图  [batchId: bat_xxx]        │
│  已完成 4 / 总数 8（失败 1）             │
│  ██████░░░░░░░░░░░░░  50%               │
│                                          │
│  [查看详情]                              │
└─────────────────────────────────────────┘
```

- 进度格式：已完成 X / 总数 Y（失败 Z）
- 进度通过 `batchId` 跟踪，不依赖客户端 task ID 数组
- 聚合进度 = (success + failed) / total * 100
- 点击"查看详情"展开每个子任务的状态卡片

**BatchProgressEvent 监听**：

```ts
// 监听 batch-progress 事件
type BatchProgressEvent = {
  batchId: string;
  taskType: TaskType;
  total: number;
  success: number;
  failed: number;
  running: number;
  pending: number;
};

function useBatchProgressListener(batchId: string | null) {
  const [progress, setProgress] = useState<BatchProgressEvent | null>(null);

  useEffect(() => {
    if (!batchId) return;
    const unlisten = listen<BatchProgressEvent>('batch-progress', (event) => {
      if (event.payload.batchId === batchId) {
        setProgress(event.payload);
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [batchId]);

  return progress;
}
```

- 批量操作提交后返回 `batchId`，前端通过 `batchId` 订阅 `batch-progress` 事件
- 后端在每条子任务状态变更时推送 `BatchProgressEvent`（包含 batchId、total、success、failed、running、pending）
- 前端不再依赖客户端维护的 task ID 数组来计算进度，统一以 `batchId` 为准
- TanStack Query 每 2 秒轮询 `listTasks({ batchId })` 作为兜底

**兜底机制**：即使 task-event 事件丢失，TanStack Query 每 2 秒轮询业务状态，确保进度最终一致。

### 5.2 失败必须可操作

**适用场景**：任何 `status = 'failed'` 的任务或业务实体。

**UI 规范**：

失败卡片必须提供至少一个操作按钮，不能只显示红色文字：

```text
┌─────────────────────────────────────────┐
│  ❌ 资产生图失败 · 角色"主角"             │
│                                          │
│  错误：火山引擎返回 500 内部错误          │
│  已重试 2/3 次                           │
│                                          │
│  [重试]  [查看日志]  [回到上游修正]       │
└─────────────────────────────────────────┘
```

| 操作按钮 | 行为 | 适用场景 |
|----------|------|----------|
| 重试 | 调用 retryTask IPC，创建新 Task | 参数没问题，远端临时故障 |
| 查看日志 | 打开日志查看器，显示 logs/tasks/{taskId}.log | 需要诊断错误原因 |
| 回到上游修正 | 跳转到上游编辑页面（如资产编辑、分镜编辑） | 参数有误需要修改 |
| 取消 | 调用 cancelTask IPC | 不再需要此任务 |

**自动重试 vs 手动重试的 UI 区分**：

- 自动重试类型的错误（网络超时、5xx、下载失败）：
  - 卡片显示"自动重试中（第 N 次）"
  - 倒计时显示下次重试时间
  - 提供手动"立即重试"按钮跳过等待

- 手动重试类型的错误（参数错误、资产缺失、解析失败）：
  - 卡片显示"需要手动处理"
  - 不自动重试
  - 提供"回到上游修正"按钮优先

**错误信息展示**：

- errorMessage 截断显示前 100 字符
- 点击展开显示完整错误信息
- 完整错误信息包含：错误码、错误描述、原始响应（如有）

### 5.3 失效必须可见

**适用场景**：上游变更导致下游结果需要重新生成时，下游结果被标记为 `invalidated`。

**UI 规范**：

被标记为 `invalidated` 的业务实体必须用醒目的视觉标记提示用户：

```text
分镜卡片（imageState = invalidated）：
┌─────────────────────────────────────────┐
│  ⚠️ 需重生成                              │
│  [融合图缩略图，半透明 + 黄色边框]        │
│  镜号 #3 · 台词："..."                    │
│  原因：画面描述已修改                     │
│  [重新生成]                              │
└─────────────────────────────────────────┘
```

| 状态字段 | invalidated 时的视觉标记 |
|----------|--------------------------|
| imageState | 融合图缩略图半透明 + 黄色虚线边框 + "需重生成"标签 |
| voiceState | 语音播放器旁显示黄色"需重生成"标签 |
| videoState | 视频缩略图半透明 + 黄色虚线边框 + "受上游影响"标签 |

**失效原因展示**：

- 每个 invalidated 的卡片显示失效原因（来自 task_invalidated 事件的 reason 字段）
- 常见原因：
  - "台词已修改"
  - "画面描述已修改"
  - "图像提示词已修改"
  - "视频提示词已修改"
  - "引用资产已变更"

**批量重算**：

- 分镜列表顶部显示"有 N 条分镜需要重算"的汇总提示
- 提供"重算所有失效项"按钮，一键提交所有 invalidated 分镜的重新生成任务
- 批量重算时按依赖顺序执行：先重算融合图 → 再重算语音 → 最后重算视频

**失效传播规则**（前端展示，后端执行）：

```text
dialogue 改动 → voiceState=invalidated, videoState=invalidated
visualDescription / imagePrompt 改动 → imageState=invalidated, videoState=invalidated
videoPrompt 改动 → videoState=invalidated
引用资产改动 → imageState=invalidated, videoState=invalidated
seqNum 改动 → 仅导出时间线失效，不重算视频
```

## 6. 状态管理

### 6.1 双层状态架构

前端状态分为两层，职责严格分离：

| 层 | 工具 | 职责 | 是否持久化 |
|----|------|------|------------|
| 服务端状态 | TanStack Query v5 | 所有从 Tauri IPC 获取的业务数据（Project、Clip、Asset、Storyboard、Task 等） | 缓存在内存，不持久化到本地文件 |
| UI 状态 | Zustand | 当前选中项、面板状态、视图模式等轻量交互状态 | 不持久化，重启后从数据库恢复默认值 |

### 6.2 TanStack Query 数据获取

**Query Key 命名规范**：

```ts
// 项目级
['projects']                                    // 项目列表
['project', projectId]                          // 单个项目
['projects', 'recent']                          // 最近项目

// 片段级
['clips', projectId]                            // 项目的片段列表
['clip', clipId]                                // 单个片段

// 资产级
['assets', projectId, type]                     // 项目的某类资产
['asset', assetId]                              // 单个资产

// 分镜级
['storyboards', clipId]                         // 片段的分镜列表
['storyboard', storyboardId]                    // 单个分镜

// 任务级
['tasks', projectId, { status, type }]          // 项目的任务列表
['task', taskId]                                // 单个任务

// 导出级
['exports', projectId]                          // 项目的导出记录
```

**Query hooks 封装示例**：

```ts
// hooks/useProjects.ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => invoke<Project[]>('listProjects'),
  });
}

export function useProject(projectId: string | null) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => invoke<Project>('getProject', { projectId }),
    enabled: !!projectId,
  });
}

export function useClips(projectId: string | null) {
  return useQuery({
    queryKey: ['clips', projectId],
    queryFn: () => invoke<Clip[]>('listClips', { projectId }),
    enabled: !!projectId,
  });
}

export function useStoryboards(clipId: string | null) {
  return useQuery({
    queryKey: ['storyboards', clipId],
    queryFn: () => invoke<Storyboard[]>('listStoryboards', { clipId }),
    enabled: !!clipId,
  });
}

export function useTasks(projectId: string | null, filter?: { status?: string; type?: string }) {
  return useQuery({
    queryKey: ['tasks', projectId, filter],
    queryFn: () => invoke<Task[]>('listTasks', { projectId, ...filter }),
    enabled: !!projectId,
    refetchInterval: 2000,  // 兜底轮询
  });
}
```

**Mutation 封装示例**：

```ts
// hooks/useProjectMutations.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => invoke<{ projectId: string }>('createProject', { input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useRetryTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => invoke<{ newTaskId: string }>('retryTask', { taskId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
```

**事件驱动的缓存失效**：

```ts
// 监听 task-event 自动刷新对应数据
import { listen } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';

function useTaskEventListener() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = listen<TaskEvent>('task-event', (event) => {
      const payload = event.payload;

      switch (payload.type) {
        case 'task_started':
        case 'task_progress':
        case 'task_waiting_remote':
        case 'task_downloading':
          // 更新任务列表缓存
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
          break;

        case 'task_success':
          // 刷新任务列表 + 对应业务数据
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
          // 根据 taskType 刷新对应业务数据
          invalidateBusinessData(queryClient, payload);
          break;

        case 'task_failed':
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
          break;

        case 'task_invalidated':
          // 刷新受影响的业务数据
          queryClient.invalidateQueries({ queryKey: ['storyboards'] });
          break;
      }
    });

    return () => { unlisten.then(fn => fn()); };
  }, [queryClient]);
}

function invalidateBusinessData(queryClient: QueryClient, event: TaskEvent) {
  // 根据 taskType 判断需要刷新哪些 query
  // 如 generate_asset_image → 刷新 assets
  // 如 generate_storyboard_image → 刷新 storyboards
  // 如 generate_storyboard_voice → 刷新 storyboards
  // 如 generate_storyboard_video → 刷新 storyboards
}
```

### 6.3 Zustand UI 状态

**Store 定义**：

```ts
// stores/workbenchStore.ts
import { create } from 'zustand';

type WorkbenchState = {
  // 当前选中项
  selectedProjectId: string | null;
  selectedClipId: string | null;
  selectedStoryboardId: string | null;
  selectedAssetId: string | null;

  // 面板状态
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;

  // 视图模式
  assetTab: 'character' | 'scene' | 'item';
  storyboardView: 'list' | 'detail' | 'timeline';

  // 全局视图
  view: 'home' | 'workbench';  // home = 项目首页, workbench = 工作台

  // Actions
  selectProject: (projectId: string | null) => void;
  selectClip: (clipId: string | null) => void;
  selectStoryboard: (storyboardId: string | null) => void;
  selectAsset: (assetId: string | null) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  setAssetTab: (tab: 'character' | 'scene' | 'item') => void;
  setStoryboardView: (view: 'list' | 'detail' | 'timeline') => void;
  setView: (view: 'home' | 'workbench') => void;
};

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  selectedProjectId: null,
  selectedClipId: null,
  selectedStoryboardId: null,
  selectedAssetId: null,
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,
  assetTab: 'character',
  storyboardView: 'list',
  view: 'home',

  selectProject: (projectId) =>
    set({
      selectedProjectId: projectId,
      selectedClipId: null,      // 切换项目时清空片段选中
      selectedStoryboardId: null,
      selectedAssetId: null,
      view: projectId ? 'workbench' : 'home',
    }),

  selectClip: (clipId) =>
    set({
      selectedClipId: clipId,
      selectedStoryboardId: null,  // 切换片段时清空分镜选中
    }),

  selectStoryboard: (storyboardId) => set({ selectedStoryboardId: storyboardId }),
  selectAsset: (assetId) => set({ selectedAssetId: assetId }),
  toggleLeftPanel: () => set((s) => ({ leftPanelCollapsed: !s.leftPanelCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  setAssetTab: (tab) => set({ assetTab: tab }),
  setStoryboardView: (view) => set({ storyboardView: view }),
  setView: (view) => set({ view }),
}));
```

**使用规范**：

- 组件中只通过 selector 订阅需要的字段，避免全量订阅导致不必要重渲染
- 切换项目时自动清空子级选中项，防止跨项目数据错位
- `view` 字段控制全局视图：未选项目时为 `home`，选中项目后为 `workbench`

### 6.4 视图切换方案

**不使用 React Router**。视图切换基于 Zustand 的 `view` 字段和当前选中片段的 `currentStep` 驱动（项目级 `currentStep` 为聚合值，仅用于顶栏步骤条展示）：

```tsx
// App.tsx
function App() {
  const view = useWorkbenchStore((s) => s.view);
  const selectedProjectId = useWorkbenchStore((s) => s.selectedProjectId);
  const { data: project } = useProject(selectedProjectId);

  // 全局事件监听
  useTaskEventListener();

  if (view === 'home' || !selectedProjectId) {
    return <ProjectHomePage />;
  }

  // 基于选中片段的 currentStep 切换中栏视图（项目级 currentStep 仅用于顶栏步骤条）
  const selectedClipId = useWorkbenchStore((s) => s.selectedClipId);
  const { data: clips } = useClips(selectedProjectId);
  const selectedClip = clips?.find(c => c.id === selectedClipId);
  const clipStep = selectedClip?.currentStep ?? project?.currentStep ?? 'project';

  return (
    <WorkbenchLayout>
      <LeftPanel />
      <MainArea step={clipStep} />
      <RightPanel />
    </WorkbenchLayout>
  );
}

// MainArea 根据 step 渲染对应组件
function MainArea({ step }: { step: ProjectStep }) {
  switch (step) {
    case 'project':
      return <ProjectHomePage />;
    case 'split':
      return <ScriptImportView />;
    case 'script':
      return <ClipScriptView />;
    case 'asset':
      return <AssetWorkbench />;
    case 'storyboard':
    case 'voice':
      return <StoryboardWorkbench step={step} />;
    case 'video':
      return <VideoTimelineView />;
    case 'export':
      return <ExportPage />;
    default:
      return <ProjectHomePage />;
  }
}
```

**步骤跳转规则**：

```ts
// 用户点击步骤条跳转（片段级）
function handleStepJump(targetStep: ProjectStep) {
  const clipId = useWorkbenchStore.getState().selectedClipId;
  // 调用 IPC 更新片段的 currentStep
  invoke('updateClipStep', { clipId, step: targetStep });
  // TanStack Query 自动刷新 clip 数据，MainArea 重新渲染
  // 项目级 currentStep 由后端自动聚合更新
}
```

- 只允许跳转到片段已完成步骤或当前步骤
- 不允许跳过片段未完成步骤（前端校验 + 后端校验）
- `autoContinue` 自动推进时，片段步骤条有过渡动画

## 7. 桌面端特性

### 7.1 文件系统浏览

**场景**：选择工作区路径、选择输出路径、选择参考图、选择背景音乐文件。

**实现方案**：

```ts
import { open } from '@tauri-apps/plugin-dialog';

// 选择目录（用于工作区路径、输出路径）
async function selectDirectory(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: '选择目录',
  });
  return selected as string | null;
}

// 选择文件（用于参考图、剧本文件、背景音乐）
async function selectFile(filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters,
  });
  return selected as string | null;
}
```

**集成点**：

- 新建项目对话框中的工作区路径选择
- 导出页的输出路径选择
- 资产详情面板的参考图上传
- 导出页的背景音乐文件选择
- 打开项目的目录选择

### 7.2 拖拽导入

**场景**：拖拽剧本文件到新建项目对话框、拖拽图片到资产详情面板作为参考图。

**实现方案**：

```tsx
import { useDrop } from '@tauri-apps/plugin-drag';

function ScriptDropZone() {
  const { onDragOver, onDrop } = useDrop({
    onDrop: async (event) => {
      const files = event.paths;
      // 校验文件类型
      const validFiles = files.filter(f => /\.(txt|docx)$/i.test(f));
      if (validFiles.length > 0) {
        // 读取文件内容
        const content = await readFile(validFiles[0]);
        // 填入对话框
      }
    },
  });

  return (
    <div onDragOver={onDragOver} onDrop={onDrop}>
      拖拽剧本文件到此处
    </div>
  );
}
```

**支持拖拽的区域**：

| 区域 | 接受的文件类型 | 行为 |
|------|---------------|------|
| 新建项目对话框 | .txt, .docx | 读取为剧本内容 |
| 资产详情面板 | .png, .jpg, .jpeg, .webp | 设为参考图或替换生成图 |
| 导出页 | .mp3, .wav, .m4a | 设为背景音乐 |
| 项目首页 | 包含 manifest.json 的目录 | 打开为已有项目 |

### 7.3 本地文件加载

**场景**：在 UI 中显示本地图片、播放本地音频和视频。

**实现方案**：

```ts
import { convertFileSrc } from '@tauri-apps/api/core';

// 将本地文件路径转换为可加载的 URL
function getLocalFileUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}

// 在组件中使用
function AssetImage({ path }: { path: string }) {
  const url = getLocalFileUrl(path);
  return <img src={url} alt="资产图" />;
}

function VideoPlayer({ path }: { path: string }) {
  const url = getLocalFileUrl(path);
  return <video src={url} controls />;
}
```

**注意事项**：

- 数据库中存储的是工作区相对路径，需要先通过 PathHelper 拼接为绝对路径
- 缩略图优先加载 `generatedImageThumbPath`，点击时再加载原图
- 大视频文件不预加载，点击播放时再加载

### 7.4 本地日志查看

**场景**：任务失败时查看详细日志。

**实现方案**：

```ts
import { readTextFile } from '@tauri-apps/plugin-fs';

async function readTaskLog(taskId: string): Promise<string> {
  // 日志路径：logs/tasks/{taskId}.log（相对于工作区）
  const logPath = await invoke<string>('getTaskLogPath', { taskId });
  return await readTextFile(logPath);
}
```

**日志查看器组件**：

```text
┌─────────────────────────────────────────────────┐
│  任务日志 · abc123 · generate_asset_image       │
├─────────────────────────────────────────────────┤
│  [2026-06-29T10:00:00] [START] task=abc123 ...  │
│  [2026-06-29T10:00:01] [REQ] POST /api/v1/...   │
│  [2026-06-29T10:00:02] [RESP] {"taskId":"..."}  │
│  [2026-06-29T10:00:07] [POLL] status=processing │
│  [2026-06-29T10:00:12] [POLL] status=done       │
│  [2026-06-29T10:00:13] [DOWNLOAD] ...           │
│  [2026-06-29T10:00:14] [SUCCESS] ...            │
│                                                  │
│  [复制]  [在文件管理器中显示]                    │
└─────────────────────────────────────────────────┘
```

- 日志按时间戳倒序显示（最新在底部）
- 支持关键字搜索过滤
- 支持复制全文
- 支持"在文件管理器中显示"（调用 Tauri shell open 打开日志文件所在目录）

### 7.5 本地缓存清理

**场景**：清理工作区的临时缓存文件、过期的任务日志、已删除项目的残留目录。

**实现方案**：

```ts
// 查询磁盘用量
async function getWorkspaceDiskUsage(projectId: string): Promise<{
  total: number;       // 总大小（字节）
  cache: number;       // cache 目录大小
  logs: number;        // logs 目录大小
  assets: number;      // assets 目录大小
  video: number;       // video 目录大小
  exports: number;     // exports 目录大小
}> {
  return await invoke('getWorkspaceDiskUsage', { projectId });
}

// 清理缓存
async function cleanCache(projectId: string): Promise<{
  cleanedSize: number;
  deletedFiles: number;
}> {
  return await invoke('cleanCache', { projectId });
}
```

**清理面板**：

```text
┌─────────────────────────────────────────────────┐
│  本地存储                                       │
├─────────────────────────────────────────────────┤
│  工作区总大小：2.3 GB                            │
│                                                  │
│  资产图     ████████████  890 MB                │
│  视频       ██████████████████  1.2 GB          │
│  导出       ████  180 MB                        │
│  缓存       ██  45 MB    [清理]                 │
│  日志       █  12 MB     [清理]                 │
│                                                  │
│  [清理全部缓存]                                 │
└─────────────────────────────────────────────────┘
```

- 缓存目录（cache/）：可安全清理，包含下载中转文件等临时文件
- 日志目录（logs/tasks/）：清理超过 7 天的日志文件
- 资产图和视频：不提供一键清理，只能通过删除项目清理
- 导出文件：用户手动管理，不自动清理

### 7.6 在文件管理器中显示

**场景**：右键菜单或按钮"在文件管理器中显示"，打开系统文件管理器并定位到指定文件或目录。

```ts
import { open } from '@tauri-apps/plugin-shell';

async function revealInFileManager(path: string) {
  await open(path);
}
```

**集成点**：

- 项目卡片右键菜单 → 在文件管理器中显示工作区目录
- 资产图右键 → 在文件管理器中显示图片文件
- 导出记录 → 在文件管理器中显示导出文件
- 任务日志查看器 → 在文件管理器中显示日志文件

### 7.7 系统通知

**场景**：长任务完成或失败时，如果应用窗口不在前台，通过系统通知提醒用户。

```ts
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

async function notifyTaskComplete(taskType: string, success: boolean) {
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === 'granted';
  }
  if (granted) {
    sendNotification({
      title: success ? '任务完成' : '任务失败',
      body: `${taskType} ${success ? '已成功完成' : '执行失败'}`,
    });
  }
}
```

- 仅在窗口失焦时发送通知
- 点击通知将窗口置顶并跳转到对应任务

## 8. 任务事件流的前端处理

### 8.1 事件订阅

所有任务事件通过 Tauri 的 `emit`/`listen` 机制推送，事件名统一为 `task-event`。前端在应用启动时全局订阅一次：

```ts
// TaskEvent 类型（与模块 08 一致）
type TaskEvent =
  | { type: 'task_started'; taskId: string; taskType: TaskType }
  | { type: 'task_progress'; taskId: string; progress: number; message?: string }
  | { type: 'task_waiting_remote'; taskId: string; remoteTaskId: string }
  | { type: 'task_downloading'; taskId: string; progress: number }
  | { type: 'task_success'; taskId: string; outputJson?: string }
  | { type: 'task_failed'; taskId: string; errorMessage: string }
  | { type: 'task_canceled'; taskId: string }
  | { type: 'task_invalidated'; taskId: string; reason: string };
```

### 8.2 事件处理策略

| 事件类型 | 前端处理 |
|----------|----------|
| task_started | 任务卡片状态变蓝"执行中"，进度条归零 |
| task_progress | 更新进度条百分比，更新最后更新时间 |
| task_waiting_remote | 状态变"远端生成中"，显示 remoteTaskId |
| task_downloading | 状态变"下载中"，更新下载进度 |
| task_success | 任务卡片变绿，刷新对应业务数据缓存（invalidateQueries），显示成功 toast |
| task_failed | 任务卡片变红，显示错误信息和操作按钮，显示失败 toast |
| task_canceled | 任务卡片变灰删除线，显示"已取消" |
| task_invalidated | 对应业务实体卡片显示"需重生成"黄色标记，显示原因 |

### 8.3 Toast 通知规范

```ts
// 成功
toast.success('资产生图完成', { description: '角色"主角"图片已生成' });

// 失败
toast.error('资产生图失败', {
  description: '火山引擎返回 500 错误',
  action: { label: '查看', onClick: () => openLogViewer(taskId) },
});

// 进度（不弹 toast，更新右栏任务列表）
```

- 成功和失败事件弹 toast
- 进度事件不弹 toast，只更新右栏任务列表和卡片状态
- 批量任务只弹一次汇总 toast（全部完成/部分失败），不逐条弹

## 9. 组件架构

### 9.1 目录结构

```text
src/
├── App.tsx                          # 根组件，视图切换入口
├── main.tsx                         # Tauri 入口
├── components/
│   ├── layout/
│   │   ├── WorkbenchLayout.tsx      # 三栏布局容器
│   │   ├── TopBar.tsx               # 顶栏
│   │   ├── LeftPanel.tsx            # 左栏（项目树）
│   │   ├── RightPanel.tsx           # 右栏（任务与参数）
│   │   └── BottomBar.tsx            # 底栏
│   ├── project/
│   │   ├── ProjectHomePage.tsx      # 项目首页
│   │   ├── ProjectCard.tsx          # 项目卡片
│   │   ├── CreateProjectDialog.tsx  # 新建项目对话框
│   │   └── ProjectSettings.tsx      # 项目设置面板
│   ├── script/
│   │   ├── ScriptImportView.tsx     # 剧本导入与拆分视图
│   │   └── ClipListView.tsx         # 片段列表
│   ├── asset/
│   │   ├── AssetWorkbench.tsx       # 资源工作台
│   │   ├── AssetCard.tsx            # 资产卡片
│   │   ├── AssetDetailPanel.tsx     # 资产详情面板
│   │   └── BatchGenerateButton.tsx  # 批量生图按钮
│   ├── storyboard/
│   │   ├── StoryboardWorkbench.tsx  # 分镜工作台
│   │   ├── StoryboardList.tsx       # 分镜列表
│   │   ├── StoryboardDetail.tsx     # 分镜详情编辑器
│   │   └── StateIndicator.tsx       # 三状态指示灯
│   ├── video/
│   │   ├── VideoTimelineView.tsx    # 视频时间线
│   │   └── VideoPlayer.tsx          # 视频播放器
│   ├── export/
│   │   ├── ExportPage.tsx           # 导出页
│   │   └── ExportHistory.tsx        # 导出记录
│   ├── task/
│   │   ├── TaskList.tsx             # 任务列表
│   │   ├── TaskCard.tsx             # 任务卡片
│   │   ├── FailedTaskPanel.tsx      # 失败任务面板
│   │   └── LogViewer.tsx            # 日志查看器
│   └── common/
│       ├── StatusBadge.tsx          # 状态标签
│       ├── ProgressBar.tsx          # 进度条
│       ├── FileDropZone.tsx         # 拖拽上传区
│       ├── LocalImage.tsx           # 本地图片加载
│       └── DiskUsagePanel.tsx       # 磁盘用量面板
├── hooks/
│   ├── useProjects.ts               # 项目相关 query hooks
│   ├── useClips.ts                  # 片段相关 query hooks
│   ├── useAssets.ts                 # 资产相关 query hooks
│   ├── useStoryboards.ts            # 分镜相关 query hooks
│   ├── useTasks.ts                  # 任务相关 query hooks
│   ├── useExports.ts                # 导出相关 query hooks
│   └── useTaskEventListener.ts     # 任务事件全局监听
├── stores/
│   └── workbenchStore.ts            # Zustand UI 状态
├── types/
│   └── index.ts                     # 共享类型定义
└── lib/
    ├── tauri.ts                     # Tauri invoke 封装
    ├── file.ts                      # 文件路径转换工具
    └── format.ts                    # 格式化工具（字节大小、时间等）
```

### 9.2 共享类型定义

```ts
// types/index.ts
// 与后端数据结构保持一致（见模块 09 数据存储与本地文件布局）

export type InputMode = 'empty' | 'script';
export type StyleMode = 'RS' | 'TS' | 'ZH';
export type ProjectStatus = 'active' | 'archived' | 'failed';
export type ProjectStep = 'project' | 'split' | 'script' | 'asset' | 'storyboard' | 'voice' | 'video' | 'export';
export type StopStep = 'asset' | 'storyboard' | 'voice' | 'video' | 'export' | null;

export type Project = {
  id: string;
  name: string;
  workspacePath: string;
  inputMode: InputMode;
  styleMode: StyleMode;
  status: ProjectStatus;
  currentStep: ProjectStep;  // 聚合值，取所有片段中最慢的步骤（只读，由片段状态推导）
  stopStep: StopStep;
  autoContinue: boolean;
  coverPath?: string;
  defaultImageParamJson?: string;
  defaultVideoParamJson?: string;
  defaultVoiceParamJson?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClipStatus = 'pending' | 'script_ready' | 'asset_ready' | 'storyboard_ready' | 'media_ready' | 'done' | 'failed';

export type Clip = {
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

export type AssetType = 'character' | 'scene' | 'item';
export type AssetStatus = 'draft' | 'confirmed' | 'image_pending' | 'image_ready' | 'failed';

export type Asset = {
  id: string;
  projectId: string;
  clipId?: string;
  type: AssetType;
  name: string;
  description: string;
  prompt: string;
  referenceImagePath?: string;
  generatedImagePath?: string;
  generatedImageThumbPath?: string;
  source: 'model' | 'manual' | 'imported';
  status: AssetStatus;
  createdAt: string;
  updatedAt: string;
};

export type MediaState = 'pending' | 'running' | 'ready' | 'failed' | 'invalidated';

export type Storyboard = {
  id: string;
  projectId: string;
  clipId: string;
  seqNum: number;
  dialogue: string;
  visualDescription: string;
  imagePrompt: string;
  videoPrompt: string;
  characterIds: string[];
  sceneIds: string[];
  itemIds: string[];
  imageState: MediaState;
  voiceState: MediaState;
  videoState: MediaState;
  fusedImagePath?: string;
  voicePath?: string;
  voiceDuration?: number;
  videoPath?: string;
  videoDuration?: number;
  createdAt: string;
  updatedAt: string;
};

export type TaskType =
  | 'split_script_source'
  | 'generate_clip_script'
  | 'generate_asset_image'
  | 'generate_storyboards'
  | 'generate_storyboard_image'
  | 'generate_storyboard_voice'
  | 'import_storyboard_voice'
  | 'generate_storyboard_video'
  | 'export_project_video';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_remote'
  | 'downloading'
  | 'success'
  | 'failed'
  | 'canceled';

export type Task = {
  id: string;
  projectId: string;
  type: TaskType;
  status: TaskStatus;
  errorMessage?: string;
  retryCount: number;
  maxRetry: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
};
```

## 10. 最低落地清单

1. **项目首页**：项目列表、新建项目对话框（含文件路径选择、拖拽上传）、打开项目、项目卡片
2. **三栏工作台布局**：WorkbenchLayout 容器、顶栏步骤条、左栏项目树（三层折叠）、右栏任务与参数面板、底栏状态栏
3. **剧本导入视图**：剧本预览、拆分进度展示、片段列表（排序、编辑、跳转）
4. **资源工作台**：类型切换 Tab、资产卡片网格、详情编辑面板、批量生图、单项生图、参考图上传
5. **分镜工作台**：分镜列表（三状态指示灯）、详情编辑器（全部可编辑字段）、融合图/语音/视频状态展示、失效标记与重算、批量操作
6. **视频时间线**：分镜视频拼接预览、单独/批量生成、视频播放器、缺失文件检查
7. **导出页**：输出路径选择、导出参数配置、导出预检、导出进度、导出记录列表
8. **任务中心**：任务列表、任务卡片（进度/状态/错误信息）、失败任务面板、重试按钮、日志查看器
9. **状态管理**：TanStack Query hooks 封装（全部业务数据的 query/mutation）、Zustand workbenchStore（选中项/面板状态/视图模式）、task-event 全局监听与缓存失效
10. **桌面端特性**：文件系统浏览（Tauri dialog）、拖拽导入（Tauri drag）、本地文件加载（convertFileSrc）、本地日志查看（readTextFile）、本地缓存清理面板、在文件管理器中显示（shell open）、系统通知（window 失焦时）
