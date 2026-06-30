# 模块 06：语音生成

## 1. 模块职责

本模块负责将分镜中的台词文本转换为可播放的语音音频文件，并将音频文件路径、时长、参数等信息回写给分镜，供后续视频合成与导出拼接使用。

具体职责包括：

- 支持两种语音来源：本地文件导入、火山引擎 TTS 合成
- 管理语音生成的完整生命周期（待生成 → 生成中 → 就绪 / 失败 / 已失效）
- 探测音频时长并回写分镜，驱动下游视频长度计算
- 维护语音参数（发音人、语速、音量、音调等）与台词的绑定关系
- 台词变更时联动失效已生成的语音及下游视频
- 失败时保留现场，让用户决定重试或改用本地语音

## 2. 设计约束

| 约束项 | 说明 |
|--------|------|
| 运行架构 | Tauri 2 为主进程，React 为前端 UI，SQLite 为本地持久化，Node worker 子进程执行耗时任务（网络请求、文件 IO） |
| 语音引擎 | 火山引擎语音合成（TTS），作为唯一的远端语音来源 |
| 工作区结构 | 所有音频文件统一存放于项目工作区 `audio/` 目录下，文件名以 `{storyboardId}_{timestamp}.{ext}` 格式命名 |
| 单分镜单语音 | 一条分镜同一时刻只保留一个最终语音结果，多角色场景需在分镜拆分阶段解决 |
| 时长探测 | 统一使用 FFprobe 进行音频时长探测 |
| 任务模型 | 语音生成遵循统一任务模板流程：校验输入 → 持久化任务和业务状态（本地事务）→ 提交远端请求 → 轮询 → 回写结果 → 失败补偿 |
| 轮询策略 | 火山引擎 TTS 任务轮询间隔建议 3 秒，最大轮询时长 5 分钟 |
| 默认参数 | `speedRate` 默认 `1.0`，`volume` 默认 `100`，`pitch` 默认 `100` |

## 3. 数据结构

### 3.1 分镜语音相关字段（Storyboard）

以下字段已在分镜模块中定义，本模块负责读写：

| 字段 | 类型 | 说明 |
|------|------|------|
| `voiceState` | `'pending' \| 'running' \| 'ready' \| 'failed' \| 'invalidated'` | 语音生成状态 |
| `voicePath` | `string?` | 音频文件在工作区中的相对路径，如 `audio/storyboard_abc_1716000000.mp3` |
| `voiceDuration` | `number?` | 音频时长（秒），用于视频长度计算和导出拼接 |
| `voiceParamJson` | `string?` | 序列化后的 `VoiceParam` JSON 字符串，记录本次生成使用的参数快照 |

### 3.2 VoiceParam

```ts
type VoiceParam = {
  provider: 'volcano';       // 语音来源，当前仅支持 volcano
  voiceId: string;           // 火山引擎发音人 ID
  speedRate?: number;        // 语速倍率，默认 1.0
  volume?: number;           // 音量，默认 100
  pitch?: number;            // 音调，默认 100
  emotion?: string;          // 情感风格，如 happy / sad / neutral
  language?: string;         // 语言代码，如 zh-CN / en-US
};
```

### 3.3 voiceState 状态流转

```
                        ┌──────────────────────────────────┐
                        │           台词变更                │
                        ▼                                  │
  pending ──(开始生成)──> running ──(成功)──> ready ──(台词变更)──> invalidated
    │                       │                                  │
    │                       └──(失败)──> failed                 │
    │                                      │                    │
    └──────────(本地导入)──────────────────>┘                    │
                                                               │
  failed ──(重试)──> running <────(重新生成)──── invalidated ────┘
```

各状态含义：

| 状态 | 含义 | 是否阻塞视频生成 |
|------|------|------------------|
| `pending` | 尚未生成语音，分镜刚创建或台词刚编辑 | 是 |
| `running` | 语音生成任务正在执行中 | 是 |
| `ready` | 语音文件已就绪，路径和时长已回写 | 否 |
| `failed` | 语音生成失败，等待用户重试或导入本地语音 | 是 |
| `invalidated` | 语音已生成但因台词变更而失效，需要重新生成 | 是 |

## 4. 详细流程

### 4.1 本地语音导入流程（local_file）

适用场景：用户自行录音、用户导入已有配音文件。

```
用户选择本地音频文件
  │
  ▼
校验文件类型（mp3 / wav / m4a / aac）
  │  不通过 → 返回错误提示
  ▼
创建任务记录（类型：import_storyboard_voice，状态：pending）
  │
  ▼
本地事务：更新分镜 voiceState = running
  │
  ▼
Node worker：将文件复制到工作区 audio/ 目录
  │  文件名：{storyboardId}_{timestamp}.{ext}
  │  复制失败 → 失败补偿，标记 voiceState = failed
  ▼
FFprobe 探测音频时长
  │  探测失败 → 标记 voiceState = failed，写入失败原因
  ▼
本地事务：回写分镜
  │  voicePath = audio/xxx.mp3
  │  voiceDuration = 探测到的秒数
  │  voiceParamJson = null（本地导入不记录 TTS 参数）
  │  voiceState = ready
  │
  ▼
更新任务状态为 success
  │
  ▼
通知前端刷新分镜语音状态
```

### 4.2 火山引擎 TTS 合成流程（volcano_tts）

适用场景：正常自动配音，通过台词文本调用火山引擎语音合成 API。

```
用户点击「生成语音」
  │
  ▼
校验输入
  │  - 台词非空（去除首尾空白后 length > 0）
  │  - voiceParam.voiceId 非空
  │  - voiceParam.provider === 'volcano'
  │  不通过 → 返回字段级错误提示
  ▼
填充默认参数
  │  speedRate ??= 1.0
  │  volume ??= 100
  │  pitch ??= 100
  ▼
创建任务记录（类型：generate_storyboard_voice，状态：pending）
  │
  ▼
本地事务：更新分镜
  │  voiceState = running
  │  voiceParamJson = JSON.stringify(voiceParam)
  │
  ▼
Node worker：请求火山引擎 TTS
  │  - 调用火山引擎语音合成 API 提交合成请求
  │  - 记录火山引擎返回的任务 ID（queryId / taskId）
  │  - 提交失败 → 失败补偿，标记 voiceState = failed
  │
  ▼
Node worker：轮询合成结果
  │  - 轮询间隔：3 秒
  │  - 最大轮询时长：5 分钟（约 100 次轮询）
  │  - 每次轮询检查任务状态
  │  - 状态为成功 → 获取音频下载 URL，跳出轮询
  │  - 状态为失败 → 跳出轮询，进入失败补偿
  │  - 超过最大轮询时长仍为处理中 → 超时失败，进入失败补偿
  │
  ▼
Node worker：下载音频文件
  │  - 从火山引擎返回的 URL 下载音频
  │  - 保存到工作区 audio/ 目录，文件名 {storyboardId}_{timestamp}.mp3
  │  - 下载失败 → 失败补偿，标记 voiceState = failed
  │
  ▼
FFprobe 探测音频时长
  │  探测失败 → 标记 voiceState = failed，写入失败原因
  │
  ▼
本地事务：回写分镜
  │  voicePath = audio/xxx.mp3
  │  voiceDuration = 探测到的秒数
  │  voiceState = ready
  │
  ▼
更新任务状态为 success
  │
  ▼
通知前端刷新分镜语音状态
```

### 4.3 失败补偿流程

当火山 TTS 合成或本地导入过程中任意环节失败时：

```
捕获异常
  │
  ▼
本地事务：回写分镜
  │  voiceState = failed
  │  voicePath 保持原值（若有旧文件则保留，方便用户判断）
  │  voiceDuration 保持原值
  │  不覆盖已有的 voiceParamJson
  ▼
更新任务状态为 failed，写入 errorMessage
  │
  ▼
通知前端展示失败状态和错误信息
  │
  ▼
等待用户决策：
  ├── 用户点击「重新生成」→ 走 4.2 流程
  └── 用户点击「导入本地语音」→ 走 4.1 流程
```

### 4.4 时长探测方法

使用 FFprobe（FFmpeg 工具集中的媒体探测器）探测音频文件时长。

**命令格式：**

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 -i <音频文件路径>
```

**输出示例：**

```
12.345000
```

**处理逻辑：**

1. Node worker 执行 ffprobe 命令，传入音频文件的绝对路径
2. 解析 stdout，`parseFloat` 得到秒数
3. 保留两位小数，如 `12.35`
4. 如果 ffprobe 返回错误或输出无法解析，视为探测失败

**注意事项：**

- FFprobe 路径由模块 08 第 8.1 节的启动流程统一检测并缓存，若未安装则语音生成流程直接标记 failed
- 文件路径包含空格或中文时需正确转义
- 探测超时设置为 10 秒，超时视为失败

### 4.5 台词变更联动失效

当用户编辑分镜台词并保存时，触发联动失效逻辑：

```
用户修改分镜台词并保存
  │
  ▼
本地事务：
  │  - 更新分镜 dialogue 字段
  │  - 检查 voiceState：
  │    ├── voiceState === 'ready' 或 'failed' → 设置 voiceState = 'invalidated'
  │    └── voiceState === 'running' → 标记需在任务完成后失效（或终止当前任务后置为 invalidated）
  │  - 检查 videoState：
  │    └── videoState === 'ready' 或 'failed' → 设置 videoState = 'invalidated'
  │  - 清空 voicePath? 否，保留旧文件路径供用户参考
  │  - 清空 voiceDuration? 否，保留旧值
  ▼
通知前端刷新分镜状态
  │
  ▼
前端展示提示：
  │  "台词已修改，语音和视频需要重新生成"
  │
  ▼
用户决策：
  ├── 点击「重新生成语音」→ 走 4.2 或 4.1 流程
  └── 继续编辑其他分镜
```

**关键规则：**

- 台词变更是语音失效的唯一触发源（除此之外，手动删除语音也会将 `voiceState` 置回 `pending`）
- 语音失效必然连带视频失效：`voiceState = invalidated` 时同步设置 `videoState = invalidated`
- `invalidated` 状态下，旧语音文件不删除，但不再参与视频合成
- 如果台词变为空字符串，`voiceState` 直接置为 `pending`，清空 `voicePath` 和 `voiceDuration`

### 4.6 多角色场景处理策略

**设计原则：一条分镜只保留一个最终语音结果。**

在分镜拆分阶段（见模块 05），应确保每个分镜的台词属于同一说话人。如果原始脚本中一段台词包含多个角色对话，需在分镜拆分时按角色切分为多条分镜。

**具体策略：**

| 情况 | 处理方式 |
|------|----------|
| 分镜台词包含多角色对话 | 提示用户在分镜编辑阶段拆分为多条分镜，每条对应一个角色 |
| 用户尝试为多角色分镜生成语音 | 使用分镜整体台词调用 TTS，`voiceId` 使用单一发音人，不支持混音 |
| 同一分镜切换发音人重新生成 | 覆盖旧语音文件，更新 `voiceParamJson`，`voiceState` 回到 `ready` |

第一版不做多说话人混音（即不为一条分镜分别生成多段语音再拼接），保持架构简洁。后续版本如需支持，可在分镜级别增加 `voiceSegments` 子结构扩展。

## 5. 接口定义

### 5.1 generate_storyboard_voice（火山引擎 TTS 合成）

**任务类型：** `generate_storyboard_voice`

**输入参数：**

```ts
type GenerateStoryboardVoiceInput = {
  storyboardId: string;
  dialogue: string;           // 分镜台词文本
  voiceParam: VoiceParam;     // 语音参数
};
```

**输出结果：**

```ts
type GenerateStoryboardVoiceOutput = {
  storyboardId: string;
  voicePath: string;          // 工作区相对路径
  voiceDuration: number;      // 秒
};
```

**执行流程（统一任务模板）：**

1. **校验输入** — 台词非空、`voiceParam.voiceId` 非空、`provider === 'volcano'`
2. **持久化任务和业务状态（本地事务）** — 创建 Task 记录，更新分镜 `voiceState = running`，写入 `voiceParamJson`
3. **提交远端请求** — Node worker 调用火山引擎 TTS API
4. **轮询** — 每 3 秒轮询一次，最长 5 分钟
5. **回写结果** — 下载音频到 `audio/`，FFprobe 探测时长，事务回写 `voicePath` / `voiceDuration` / `voiceState = ready`
6. **失败补偿** — 任意环节异常时，事务回写 `voiceState = failed`，Task 记录 `errorMessage`

> **缓存说明：** TTS 合成结果应按照模块 08 第 10 节的缓存策略进行缓存。缓存键：`hash(storyboardId + dialogue + voiceId + voiceParam + model)`，命中缓存时直接复用已有音频文件，跳过远端 TTS 请求。

### 5.2 import_storyboard_voice（本地语音导入）

**任务类型：** `import_storyboard_voice`

**输入参数：**

```ts
type ImportStoryboardVoiceInput = {
  storyboardId: string;
  filePath: string;           // 用户选择的本地文件绝对路径
};
```

**输出结果：**

```ts
type ImportStoryboardVoiceOutput = {
  storyboardId: string;
  voicePath: string;          // 工作区相对路径
  voiceDuration: number;      // 秒
};
```

**执行流程：**

1. **校验输入** — 文件存在、扩展名为 mp3/wav/m4a/aac
2. **持久化任务和业务状态（本地事务）** — 创建 Task 记录，更新分镜 `voiceState = running`
3. **复制文件** — Node worker 将文件复制到工作区 `audio/` 目录
4. **探测时长** — FFprobe 探测音频时长
5. **回写结果** — 事务回写 `voicePath` / `voiceDuration` / `voiceState = ready`
6. **失败补偿** — 复制或探测失败时，事务回写 `voiceState = failed`

### 5.3 delete_storyboard_voice（删除语音）

**输入参数：**

```ts
type DeleteStoryboardVoiceInput = {
  storyboardId: string;
};
```

**执行流程：**

1. 校验分镜存在
2. 本地事务：清空 `voicePath`、`voiceDuration`、`voiceParamJson`，设置 `voiceState = pending`
3. 同步设置 `videoState = invalidated`（语音删除后视频无法复用）
4. 可选：删除 `audio/` 目录下的物理文件（或标记为可清理，由垃圾回收机制处理）

### 5.4 前端 Tauri Command 接口

以下为 React 前端通过 Tauri IPC 调用的 Command：

| Command 名 | 参数 | 返回 | 说明 |
|------------|------|------|------|
| `generate_voice` | `{ storyboardId, dialogue, voiceParam }` | `TaskInfo` | 触发火山 TTS 任务，返回任务 ID 供前端轮询 |
| `import_voice` | `{ storyboardId, filePath }` | `TaskInfo` | 触发本地导入任务 |
| `delete_voice` | `{ storyboardId }` | `void` | 删除分镜语音 |
| `get_voice_voices` | 无 | `VoiceOption[]` | 获取可用发音人列表（火山引擎发音人） |

前端通过任务系统的统一轮询机制监听任务状态变化，任务完成后自动刷新分镜数据。

## 6. 校验规则

### 6.1 台词校验

| 规则 | 失败行为 |
|------|----------|
| 台词去除首尾空白后 `length > 0` | 返回错误：`台词不能为空` |
| 台词长度不超过 5000 字符 | 返回错误：`台词过长，请拆分为多条分镜` |
| 台词中不包含 SSML 特殊字符（如 `<` `>`）或已正确转义 | 返回错误：`台词包含非法字符` |

### 6.2 VoiceParam 校验

| 规则 | 默认值 | 失败行为 |
|------|--------|----------|
| `provider` 必须为 `'volcano'` | — | 返回错误：`不支持的语音来源` |
| `voiceId` 非空字符串 | — | 返回错误：`请选择发音人` |
| `speedRate` 在 0.5 ~ 2.0 之间 | `1.0` | 返回错误：`语速范围为 0.5 ~ 2.0` |
| `volume` 在 0 ~ 200 之间 | `100` | 返回错误：`音量范围为 0 ~ 200` |
| `pitch` 在 0 ~ 200 之间 | `100` | 返回错误：`音调范围为 0 ~ 200` |
| `emotion` 为枚举值 | 不传 | 返回错误：`不支持的情感类型` |
| `language` 为有效语言代码 | 不传 | 返回错误：`不支持的语言` |

### 6.3 本地文件校验

| 规则 | 失败行为 |
|------|----------|
| 文件扩展名为 `.mp3` / `.wav` / `.m4a` / `.aac` | 返回错误：`不支持的音频格式` |
| 文件大小不超过 50 MB | 返回错误：`音频文件过大` |
| 文件可正常读取 | 返回错误：`文件读取失败` |

## 7. 失效与重算规则

### 7.1 失效触发条件

| 触发源 | 失效范围 | 目标状态 |
|--------|----------|----------|
| 分镜台词变更 | 语音 + 视频 | `voiceState = invalidated`，`videoState = invalidated` |
| 手动删除语音 | 语音 + 视频 | `voiceState = pending`，`videoState = invalidated` |
| 切换发音人重新生成 | 语音（覆盖） | 旧语音文件被覆盖，`voiceState` 经 `running` 回到 `ready` |
| 分镜被删除 | 语音文件标记可清理 | 分镜及其语音数据一并删除 |

### 7.2 重算条件

以下情况需要重新生成语音：

- `voiceState === 'pending'`：从未生成过语音
- `voiceState === 'invalidated'`：台词已变更，旧语音不可用
- `voiceState === 'failed'`：上次生成失败，用户决定重试

当 `voiceState === 'ready'` 时，不触发重算，除非用户主动点击「重新生成」。

### 7.3 视频长度联动

语音时长直接影响视频长度：

- 分镜视频时长 = `max(voiceDuration, 估算画面时长)`
- 导出拼接时按分镜顺序拼接，每个分镜的视频时长由 `voiceDuration` 决定（若无语音则使用画面时长）
- `voiceDuration` 变化时（重新生成后时长不同），下游 `videoState` 需标记为 `invalidated`，触发视频重算

## 8. 异常与恢复

### 8.1 异常分类与处理

| 异常类型 | 触发场景 | 处理策略 |
|----------|----------|----------|
| 网络超时 | 提交火山 TTS 请求或下载音频时超时 | 标记 `voiceState = failed`，记录错误信息，等待用户重试 |
| 轮询超时 | 超过 5 分钟仍未获得合成结果 | 标记 `voiceState = failed`，提示用户稍后重试 |
| 火山引擎限流 | API 返回限流错误 | 标记 `voiceState = failed`，提示用户稍后重试 |
| 火山引擎鉴权失败 | API Key / Token 无效或过期 | 标记 `voiceState = failed`，提示用户检查引擎配置 |
| 文件 IO 失败 | 复制或写入 `audio/` 目录失败 | 标记 `voiceState = failed`，检查磁盘空间和权限 |
| FFprobe 不可用 | 系统未安装 FFprobe 或路径未配置 | 由模块 08 启动时统一检测（见 8.1 步骤 0），若不可用则语音任务直接标记 `failed` |
| FFprobe 探测失败 | 音频文件损坏或格式不支持 | 标记 `voiceState = failed`，提示用户检查音频文件 |

### 8.2 应用崩溃恢复

任务执行过程中如果应用崩溃（如 Tauri 进程异常退出）：

1. 应用重启后扫描 Task 表中 `status = running` 且 `type` 为 `generate_storyboard_voice` 或 `import_storyboard_voice` 的记录
2. 对应分镜的 `voiceState` 此时仍为 `running`
3. 将这些分镜的 `voiceState` 回退为 `failed`，Task 状态更新为 `failed`，记录 `errorMessage = '应用异常退出'`
4. 前端展示失败状态，等待用户重试

### 8.3 旧文件清理

- 重新生成语音时，旧音频文件被新文件覆盖（同名策略使用 `{storyboardId}_{timestamp}` 确保不冲突）
- 删除分镜时，对应的 `audio/` 文件标记为可清理
- 工作区垃圾回收机制定期清理无引用的音频文件（不在本模块职责内，由工作区管理模块负责）

## 9. UI 交互要求

### 9.1 语音编辑面板

在分镜详情面板中展示语音编辑区域：

**展示内容：**

| 元素 | 说明 |
|------|------|
| 台词文本 | 可编辑的多行文本框，显示当前分镜台词 |
| 发音人选择 | 下拉列表，选项来自火山引擎发音人列表 |
| 语速滑块 | 范围 0.5 ~ 2.0，步进 0.1，默认 1.0 |
| 音量滑块 | 范围 0 ~ 200，步进 10，默认 100 |
| 音调滑块 | 范围 0 ~ 200，步进 10，默认 100 |
| 情感选择 | 下拉列表（可选），选项：默认 / 开心 / 悲伤 / 严肃 等 |
| 试听播放器 | 当 `voiceState = ready` 时显示播放控件，可试听当前语音 |
| 时长显示 | 当 `voiceDuration` 存在时显示，如 `时长：12.35 秒` |

**状态指示：**

| voiceState | UI 展示 |
|------------|---------|
| `pending` | 灰色标签「未生成」 |
| `running` | 蓝色标签「生成中...」+ loading 动画 |
| `ready` | 绿色标签「已就绪」+ 试听按钮 |
| `failed` | 红色标签「生成失败」+ 错误信息 tooltip |
| `invalidated` | 橙色标签「已失效」+ 提示「台词已修改，请重新生成」 |

**操作按钮：**

| 按钮 | 显示条件 | 动作 |
|------|----------|------|
| 生成语音 | `voiceState` 为 `pending` / `invalidated` | 触发 `generate_storyboard_voice` 任务 |
| 重新生成 | `voiceState` 为 `ready` / `failed` | 确认弹窗后触发 `generate_storyboard_voice` 任务 |
| 导入本地语音 | 任何状态（除 `running`） | 打开文件选择器，选择后触发 `import_storyboard_voice` 任务 |
| 删除语音 | `voiceState` 为 `ready` | 确认弹窗后删除语音，`voiceState` 回到 `pending` |
| 试听 | `voiceState` 为 `ready` | 播放/暂停当前语音文件 |

### 9.2 批量操作

在分镜列表页支持批量语音生成：

- 勾选多条分镜 → 点击「批量生成语音」→ 依次为每条分镜创建语音任务
- 使用统一任务队列管理，避免并发过多导致火山引擎限流
- 批量任务进度条展示 `已完成 / 总数`

### 9.3 失效提示

当 `voiceState = invalidated` 时：

- 分镜卡片上显示橙色角标
- 语音编辑面板顶部显示提示条：「台词已修改，语音和视频需要重新生成」
- 提供「一键重新生成」快捷按钮

## 10. 最低落地清单

以下为第一版必须实现的功能项：

| 序号 | 功能项 | 验收标准 |
|------|--------|----------|
| 1 | 火山引擎 TTS 客户端 | Node worker 中实现火山引擎语音合成 API 调用，支持提交合成请求、轮询结果、下载音频 |
| 2 | 本地音频导入 | 支持用户选择 mp3/wav/m4a/aac 文件，复制到工作区 `audio/` 目录 |
| 3 | FFprobe 时长探测 | Node worker 中调用 ffprobe 命令，正确解析音频时长（秒），保留两位小数 |
| 4 | 分镜语音状态回写 | 任务完成后通过本地事务回写 `voicePath` / `voiceDuration` / `voiceState` |
| 5 | 台词变更联动失效 | 台词保存时触发事务，设置 `voiceState = invalidated` 和 `videoState = invalidated` |
| 6 | 默认参数填充 | `speedRate` 默认 1.0，`volume` 默认 100，`pitch` 默认 100 |
| 7 | 失败处理与重试 | 任意环节失败时标记 `voiceState = failed`，用户可重新生成或导入本地语音 |
| 8 | 轮询机制 | 火山 TTS 轮询间隔 3 秒，最大轮询时长 5 分钟，超时标记失败 |
| 9 | 语音编辑面板 | 前端展示台词、发音人选择、参数调节、试听、状态标签 |
| 10 | 应用崩溃恢复 | 重启后扫描中断中的语音任务，回退为 `failed` 状态 |
