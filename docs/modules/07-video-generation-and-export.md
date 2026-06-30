# 模块 07：视频生成与导出

## 1. 模块职责

本模块负责将分镜的融合图/参考图与语音转换为视频片段，再将项目中所有片段的分镜视频按顺序拼接、合成字幕与背景音乐，最终导出为完整成片。

具体职责边界：

- 分镜级视频生成：调用火山引擎视频生成模型，按 `VideoParam` 生成单条分镜视频，下载并回写本地路径。
- 分镜级视频状态管理：维护 `videoState` 生命周期，处理失效与重算。
- 项目级导出：读取项目时间线，生成拼接清单，通过 FFmpeg 合成最终 `exports/final.mp4`。
- 导出配置管理：分辨率、帧率、字幕、背景音乐、输出路径等可配置项。
- 失效与重算：当融合图、语音、视频提示词等前置产物变化时，自动标记视频失效；当顺序变化时，仅标记导出时间线失效。

本模块运行在 Tauri 2 桌面端，视频生成与导出的重计算任务通过 Node worker 执行，状态与元数据持久化到 SQLite，远端调用通过火山引擎 OpenAPI 完成，本地合成通过 FFmpeg 完成。

## 2. 设计约束

| 约束编号 | 约束内容 | 说明 |
|---------|---------|------|
| C-07-01 | 视频生成必须通过 Node worker 执行 | 火山引擎调用为长耗时网络请求，不能阻塞 Tauri 主线程与 React UI |
| C-07-02 | 所有任务必须遵循统一任务模板 | 校验输入 → 持久化任务和业务状态（本地事务）→ 提交远端请求 → 轮询 → 回写结果 → 失败补偿 |
| C-07-03 | 视频文件本地存储 | 下载后存入项目工作区 `video/<storyboardId>.mp4`，路径回写 SQLite |
| C-07-04 | 导出全程本地化 | 不依赖任何外部编辑器（如剪映），全部通过 FFmpeg 完成 |
| C-07-05 | 视频生成与导出解耦 | 视频生成是分镜级操作，导出是项目级操作，两者独立触发 |
| C-07-06 | 失效优先 | 前置产物变化时必须先标记视频失效，不允许用过期视频直接导出 |
| C-07-07 | 轮询有界 | 视频任务轮询间隔 10 秒，最大轮询时长 10 分钟，超时后标记任务失败 |
| C-07-08 | 金额与参数校验前置 | 在提交远端请求前必须完成 VideoParam 完整性与模式匹配校验 |

## 3. 数据结构

### 3.1 Storyboard 视频相关字段

以下字段已在 Storyboard 数据结构中定义，本模块负责写入和维护：

```ts
type Storyboard = {
  // ... 其他字段省略

  // 视频相关字段
  videoState: 'pending' | 'running' | 'ready' | 'failed' | 'invalidated';
  videoPath?: string;           // 本地视频文件路径 video/<storyboardId>.mp4
  videoDuration?: number;       // 视频时长（秒）
  fusedImagePath?: string;      // 融合图路径（image_to_video 模式的前置条件）
  voicePath?: string;           // 语音文件路径
  voiceDuration?: number;       // 语音时长（秒）
};
```

字段状态语义：

| videoState | 含义 |
|------------|------|
| `pending` | 视频任务已创建但尚未提交远端 |
| `running` | 已提交火山引擎，正在轮询 |
| `ready` | 视频已下载并回写 `videoPath` |
| `failed` | 生成失败（远端错误、下载失败、超时等） |
| `invalidated` | 前置产物已变更，当前视频过期，需重新生成 |

### 3.2 VideoParam

```ts
type VideoParam = {
  model: string;                                    // 火山引擎视频模型标识
  duration: number;                                  // 视频时长（秒）
  resolution: string;                                // 分辨率，如 "720p"、"1080p"
  aspectRatio: string;                               // 画幅比，如 "16:9"、"9:16"
  fps?: number;                                      // 帧率，默认 30
  amount?: number;                                   // 生成数量，默认 1
  mode: 'image_to_video' | 'reference_image_to_video';
};
```

`mode` 字段决定视频生成的方式（详见第 4.1 节）。

### 3.3 任务类型

本模块涉及两种任务类型，均遵循统一任务模板：

- `generate_storyboard_video`：分镜级视频生成任务
- `export_project_video`：项目级导出任务

### 3.4 导出配置

```ts
type ExportConfig = {
  resolution: string;          // 输出分辨率，如 "1080p"
  fps: number;                 // 输出帧率，如 30
  withSubtitle: boolean;       // 是否烧录字幕
  withBgm: boolean;            // 是否加入背景音乐
  bgmPath?: string;            // 背景音乐文件路径（withBgm 为 true 时必填）
  outputPath: string;          // 输出路径，默认 exports/final.mp4
};
```

## 4. 详细流程

### 4.1 视频生成模式判断逻辑

在创建 `generate_storyboard_video` 任务前，必须根据分镜内容判断视频生成模式：

**模式 A：`image_to_video`（图生视频）**

适用条件：
- 分镜已生成融合图（`fusedImagePath` 存在且文件有效）

执行方式：
- 将融合图作为首帧图像提交给火山引擎视频模型
- 模型基于首帧图像和视频提示词生成视频

**模式 B：`reference_image_to_video`（参考图生视频）**

适用条件：
- 分镜使用角色/场景/物品参考图直接生成视频（对应 RS / ZH 模式）
- 无需融合图，直接使用参考图作为生成输入

执行方式：
- 将角色/场景/物品参考图作为参考输入提交给火山引擎视频模型
- 模型基于参考图和视频提示词生成视频

模式判断伪代码：

```ts
function determineVideoMode(storyboard: Storyboard): VideoParam['mode'] {
  if (storyboard.fusedImagePath && fileExists(storyboard.fusedImagePath)) {
    return 'image_to_video';
  }
  if (storyboard.referenceImages && storyboard.referenceImages.length > 0) {
    return 'reference_image_to_video';
  }
  throw new Error('无法确定视频生成模式：缺少融合图和参考图');
}
```

### 4.2 `generate_storyboard_video` 任务流程

本任务遵循统一任务模板：校验输入 → 持久化任务和业务状态（本地事务）→ 提交远端请求 → 轮询 → 回写结果 → 失败补偿。

#### 步骤 1：校验输入

执行第 6.1 节的视频生成前置校验清单。校验失败则直接返回错误，不创建任务。

#### 步骤 2：持久化任务和业务状态（本地事务）

在 SQLite 中以事务方式执行以下操作：

1. 创建任务记录（`task_type = 'generate_storyboard_video'`，`status = 'pending'`）
2. 更新分镜 `videoState = 'pending'`
3. 记录任务输入快照（storyboardId、VideoParam、模式、提示词哈希）

事务提交后，分镜状态已持久化，即使后续远端调用失败，本地状态也一致。

#### 步骤 3：提交远端请求

通过 Node worker 调用火山引擎视频生成 OpenAPI：

1. 根据 `mode` 准备输入图像：
   - `image_to_video`：上传融合图，获取 `imageUrl`
   - `reference_image_to_video`：上传参考图，获取参考图 URL 列表
2. 组装请求参数（model、duration、resolution、aspectRatio、fps、prompt）
3. 提交生成请求，获取远端 `taskId`
4. 将远端 `taskId` 回写到本地任务记录

提交成功后更新分镜 `videoState = 'running'`。

#### 步骤 4：轮询

轮询规则（约束 C-07-07）：

- 轮询间隔：10 秒
- 最大轮询时长：10 分钟
- 每次轮询通过 Node worker 调用火山引擎任务查询接口
- 轮询状态映射：
  - 远端 `processing` → 本地 `running`，继续轮询
  - 远端 `succeeded` → 进入下载流程
  - 远端 `failed` → 标记任务失败，进入失败补偿
  - 超过最大轮询时长仍未完成 → 标记任务超时失败，进入失败补偿

#### 步骤 5：回写结果

远端任务成功后：

1. 从火山引擎返回结果中获取视频下载 URL
2. 通过 Node worker 下载视频文件到 `video/<storyboardId>.mp4`
3. 校验下载文件完整性（文件大小 > 0，可被 FFmpeg 探测）
4. 使用 FFprobe 读取视频时长
5. 更新 SQLite：
   - 分镜 `videoState = 'ready'`
   - 分镜 `videoPath = 'video/<storyboardId>.mp4'`
   - 分镜 `videoDuration = <探测时长>`
   - 任务记录 `status = 'success'`，`outputJson = { videoPath, duration }`

#### 步骤 6：失败补偿

当步骤 3-5 任一环节失败时：

1. 更新分镜 `videoState = 'failed'`
2. 任务记录 `status = 'failed'`，记录错误信息
3. 保留已下载的部分文件（如有）供诊断
4. UI 显示失败原因，提供「重试」入口
5. 重试时重新从步骤 1 开始，覆盖旧任务记录

### 4.3 `export_project_video` 任务流程

本任务遵循统一任务模板。

#### 步骤 1：校验输入

执行第 6.2 节的导出前置条件检查。

#### 步骤 2：持久化任务和业务状态（本地事务）

1. 创建任务记录（`task_type = 'export_project_video'`，`status = 'pending'`）
2. 记录导出配置快照（ExportConfig 序列化）

#### 步骤 3：生成拼接清单

通过 Node worker 读取 SQLite：

1. 读取项目下所有片段（Segment）
2. 按片段在项目中的顺序遍历
3. 读取每个片段的分镜列表，按分镜顺序（`sortOrder`）排列
4. 对每条分镜，找到其 `videoPath`（`videoState` 必须为 `ready`）
5. 生成拼接清单（concat list），格式为 FFmpeg concatdemuxer 格式：

```
file 'video/storyboard-001.mp4'
file 'video/storyboard-002.mp4'
file 'video/storyboard-003.mp4'
...
```

#### 步骤 3.5：视频归一化

不同分镜的 AI 生成视频可能存在编码参数差异（分辨率、帧率、像素格式、音频采样率）。concat demuxer 要求所有输入文件参数完全一致，因此需要在拼接前进行归一化处理。

**归一化策略：**

1. 读取项目导出配置中的目标分辨率（`exportConfig.resolution`）和目标帧率（`exportConfig.fps`，默认 30）。
2. 遍历所有分镜视频，使用 FFprobe 检测每个文件的编码参数。
3. 对于参数不一致的视频，使用 FFmpeg 重新编码到统一参数：

```bash
ffmpeg -i <input> -s <target_resolution> -r <target_fps> -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 <normalized_output>
```

4. 参数一致的视频直接使用原文件（`-c copy`），避免不必要的重编码。
5. 归一化后的文件写入 `cache/normalized/` 目录，文件名格式：`<storyboardId>_normalized.mp4`。
6. concat 列表使用归一化后的文件路径。

**判断是否需要归一化的条件（任一满足即需重编码）：**
- 分辨率与目标不一致
- 帧率与目标不一致
- 视频编码不是 H.264
- 音频采样率不是 44100Hz
- 像素格式不是 yuv420p
- 无音频流（需补齐静音音轨）

#### 步骤 4：生成字幕文件（如需）

如果 `ExportConfig.withSubtitle = true`：

1. 遍历所有分镜，收集每条分镜的台词文本和语音时长
2. 按分镜顺序累加时间偏移，计算每条字幕的起止时间
3. 生成 SRT 字幕文件 `exports/subtitles.srt`：

```
1
00:00:00,000 --> 00:00:03,500
第一句台词

2
00:00:03,500 --> 00:00:07,200
第二句台词
```

字幕时间轴基于语音时长累加，确保与视频内容同步。

#### 步骤 5：调用 FFmpeg 合成

通过 Node worker 调用 FFmpeg：

**无字幕、无背景音乐：**

```bash
# 所有输入已归一化，可直接 -c copy
ffmpeg -f concat -safe 0 -i concat_list.txt -c copy exports/final.mp4
```

**有字幕（烧录）：**

```bash
ffmpeg -f concat -safe 0 -i concat_list.txt -vf "subtitles=exports/subtitles.srt" -c:v libx264 -c:a aac exports/final.mp4
```

**有背景音乐：**

```bash
# 所有输入已归一化，视频流可直接 -c:v copy
ffmpeg -f concat -safe 0 -i concat_list.txt -i bgm.mp3 -map 0:v:0 -map 0:a:0 -map 1:a:0 -filter_complex "[1:a]volume=0.3[bgm];[0:a][bgm]amix=inputs=2:duration=first" -c:v copy -c:a aac exports/final.mp4
```

**有字幕且有背景音乐：**

合并上述滤镜参数，同时应用 `subtitles` 滤镜和 `amix` 滤镜。

输出分辨率和帧率通过 `-s` 和 `-r` 参数控制（当与源视频不一致时需要重新编码视频流）。

#### 步骤 6：回写结果

1. 校验输出文件 `exports/final.mp4` 存在且可播放
2. 使用 FFprobe 读取成片总时长
3. 更新 SQLite：
   - 任务记录 `status = 'success'`，`outputJson = { outputPath, duration }`
   - 写入导出记录表（导出时间、配置、路径、时长）

#### 步骤 7：失败补偿

- FFmpeg 合成失败：保留 FFmpeg stderr 日志，标记任务失败，UI 显示错误
- 拼接清单中存在缺失视频：不启动 FFmpeg，直接返回错误并提示用户先完成所有分镜视频生成
- 归一化失败：单个分镜视频归一化失败时，记录错误日志，标记该分镜，跳过并继续处理其他分镜。用户可在导出报告中查看哪些分镜被跳过。

## 5. 接口定义

### 5.1 视频生成接口

```ts
// Tauri Command：创建分镜视频生成任务
interface CreateStoryboardVideoTaskInput {
  storyboardId: string;
  videoParam: VideoParam;
  prompt: string;               // 视频提示词
}

interface CreateStoryboardVideoTaskOutput {
  taskId: string;               // 本地任务 ID
  remoteTaskId?: string;        // 火山引擎任务 ID（提交后回填）
  videoState: Storyboard['videoState'];
}

// Tauri Command：查询视频任务状态
interface GetStoryboardVideoStatusOutput {
  videoState: Storyboard['videoState'];
  videoPath?: string;
  videoDuration?: number;
  remoteTaskId?: string;
  errorMessage?: string;
}

// Tauri Command：重试视频生成
interface RetryStoryboardVideoTaskInput {
  storyboardId: string;
}
```

### 5.2 导出接口

```ts
// Tauri Command：创建项目导出任务
interface CreateExportTaskInput {
  projectId: string;
  exportConfig: ExportConfig;
}

interface CreateExportTaskOutput {
  taskId: string;
  outputPath: string;
}

// Tauri Command：查询导出任务状态
interface GetExportTaskStatusOutput {
  status: 'pending' | 'running' | 'success' | 'failed';
  outputPath?: string;
  duration?: number;
  errorMessage?: string;
  segmentCount?: number;
  storyboardCount?: number;
}

// Tauri Command：获取导出记录列表
interface GetExportHistoryInput {
  projectId: string;
  page?: number;
  pageSize?: number;
}

interface ExportRecord {
  id: string;
  projectId: string;
  outputPath: string;
  duration: number;
  exportConfig: ExportConfig;
  createdAt: string;
  status: 'success' | 'failed';
}

// Tauri Command：检查导出就绪状态
interface CheckExportReadinessOutput {
  ready: boolean;
  missingVideos: Array<{
    storyboardId: string;
    segmentId: string;
    reason: string;
  }>;
  totalStoryboards: number;
  readyStoryboards: number;
}
```

### 5.3 Node worker 内部接口

```ts
// Node worker：调用火山引擎视频生成
interface VolcanoVideoGenerateInput {
  model: string;
  mode: 'image_to_video' | 'reference_image_to_video';
  imageUrl?: string;            // image_to_video 模式：融合图 URL
  referenceImageUrls?: string[];// reference_image_to_video 模式：参考图 URL 列表
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  fps?: number;
}

interface VolcanoVideoGenerateOutput {
  remoteTaskId: string;
}

// Node worker：轮询火山引擎任务
interface VolcanoVideoPollInput {
  remoteTaskId: string;
}

interface VolcanoVideoPollOutput {
  status: 'processing' | 'succeeded' | 'failed';
  videoUrl?: string;            // succeeded 时返回
  errorMessage?: string;        // failed 时返回
}

// Node worker：下载视频文件
interface DownloadVideoInput {
  url: string;
  localPath: string;            // video/<storyboardId>.mp4
}

interface DownloadVideoOutput {
  success: boolean;
  filePath: string;
  fileSize: number;
}

// Node worker：FFmpeg 合成
interface FfmpegComposeInput {
  concatListPath: string;
  subtitlePath?: string;        // 有字幕时提供
  bgmPath?: string;             // 有背景音乐时提供
  outputPath: string;
  resolution: string;
  fps: number;
}

interface FfmpegComposeOutput {
  success: boolean;
  outputPath: string;
  duration: number;
  stderr: string;               // FFmpeg 日志
}
```

## 6. 校验规则

### 6.1 视频生成前置校验清单

在创建 `generate_storyboard_video` 任务前，必须逐项校验：

| 序号 | 校验项 | 条件 | 失败处理 |
|------|--------|------|---------|
| 1 | 融合图存在 | `mode = image_to_video` 时，`fusedImagePath` 存在且文件有效 | 返回错误：融合图缺失，请先完成融合图生成 |
| 2 | 参考图存在 | `mode = reference_image_to_video` 时，参考图列表非空且文件有效 | 返回错误：参考图缺失，请先配置参考图 |
| 3 | 视频提示词存在 | 分镜的视频提示词字段非空且非纯空白 | 返回错误：视频提示词为空 |
| 4 | VideoParam 完整 | `model`、`duration`、`resolution`、`aspectRatio`、`mode` 均有值 | 返回错误：视频参数不完整 |
| 5 | 分镜未被标记失效 | `videoState != 'invalidated'` 或用户明确触发重新生成 | 允许重新生成，重置状态 |
| 6 | 语音已就绪或静音配置 | `voicePath` 存在且文件有效，或项目配置允许静音视频 | 返回错误：语音未就绪 |

校验函数伪代码：

```ts
function validateVideoGeneration(storyboard: Storyboard, videoParam: VideoParam, prompt: string): ValidationResult {
  const errors: string[] = [];

  if (videoParam.mode === 'image_to_video') {
    if (!storyboard.fusedImagePath || !fileExists(storyboard.fusedImagePath)) {
      errors.push('融合图缺失，请先完成融合图生成');
    }
  }

  if (videoParam.mode === 'reference_image_to_video') {
    if (!storyboard.referenceImages || storyboard.referenceImages.length === 0) {
      errors.push('参考图缺失，请先配置参考图');
    }
  }

  if (!prompt || prompt.trim().length === 0) {
    errors.push('视频提示词为空');
  }

  if (!videoParam.model || !videoParam.duration || !videoParam.resolution || !videoParam.aspectRatio || !videoParam.mode) {
    errors.push('视频参数不完整');
  }

  if (storyboard.videoState === 'invalidated' && !userExplicitRetry) {
    errors.push('分镜视频已失效，请确认重新生成');
  }

  if (!storyboard.voicePath || !fileExists(storyboard.voicePath)) {
    if (!projectConfig.allowSilentVideo) {
      errors.push('语音未就绪');
    }
  }

  return { valid: errors.length === 0, errors };
}
```

### 6.2 导出前置条件检查

在创建 `export_project_video` 任务前，必须完成以下检查：

| 序号 | 检查项 | 条件 | 失败处理 |
|------|--------|------|---------|
| 1 | 所有分镜视频存在 | 项目下所有片段的所有分镜 `videoState = 'ready'` 且 `videoPath` 文件有效 | 返回缺失清单，提示用户先完成视频生成 |
| 2 | 项目时间线有效 | 至少存在一个片段，且每个片段至少有一条分镜 | 返回错误：项目时间线为空 |
| 3 | 输出路径可写 | `outputPath` 所在目录存在且有写权限 | 返回错误：输出路径不可用 |
| 4 | 背景音乐文件存在 | `withBgm = true` 时，`bgmPath` 文件有效 | 返回错误：背景音乐文件缺失 |
| 5 | 无失效分镜 | 不存在 `videoState = 'invalidated'` 的分镜 | 返回错误：存在失效分镜，请先重新生成视频 |

检查接口返回 `CheckExportReadinessOutput`，包含缺失视频的详细清单，便于 UI 定位问题分镜。

## 7. 失效与重算规则

### 7.1 视频失效规则

当分镜的前置产物发生变化时，必须标记视频失效：

| 触发事件 | 影响 | 失效操作 |
|---------|------|---------|
| 融合图改动（重新生成融合图） | 视频基于旧融合图生成，已过期 | `videoState = 'invalidated'`，清空 `videoPath` |
| 语音改动（重新生成语音） | 视频时长可能与语音不匹配 | `videoState = 'invalidated'`，清空 `videoPath` |
| 视频提示词改动 | 视频内容基于旧提示词，已过期 | `videoState = 'invalidated'`，清空 `videoPath` |

失效操作在对应前置产物写入完成时同步执行，作为同一 SQLite 事务的一部分。

### 7.2 导出时间线失效规则

| 触发事件 | 影响 | 失效操作 |
|---------|------|---------|
| 分镜顺序改动（排序变化） | 拼接顺序变化，但单条视频仍有效 | 标记导出时间线失效（不影响 `videoState`） |
| 片段顺序改动 | 同上 | 标记导出时间线失效 |
| 片段增删 | 拼接清单变化 | 标记导出时间线失效 |

导出时间线失效不影响已生成的分镜视频，仅意味着上一次导出结果已过期，需要重新导出。

### 7.3 失效传播链

```
融合图改动 ──> videoState = invalidated ──> 导出时间线失效
语音改动   ──> videoState = invalidated ──> 导出时间线失效
提示词改动 ──> videoState = invalidated ──> 导出时间线失效
顺序改动   ──> （videoState 不变）────────> 导出时间线失效
```

失效传播通过 SQLite 事务保证原子性：前置产物写入 + 失效标记 + 导出时间线标记在同一事务中完成。

## 8. 异常与恢复

### 8.1 视频生成异常处理

| 异常场景 | 检测方式 | 恢复策略 |
|---------|---------|---------|
| 火山引擎 API 调用失败 | HTTP 错误码或网络超时 | 标记 `videoState = 'failed'`，保留任务记录，提供重试入口 |
| 远端任务轮询超时 | 超过 10 分钟最大轮询时长 | 标记 `videoState = 'failed'`，错误信息记录"轮询超时"，提供重试入口 |
| 远端任务失败 | 轮询返回 `failed` 状态 | 标记 `videoState = 'failed'`，记录远端错误信息，提供重试入口 |
| 视频下载失败 | 下载过程网络错误或文件校验失败 | 标记 `videoState = 'failed'`，清理已下载的部分文件，提供重试入口 |
| 下载文件损坏 | FFprobe 无法读取时长 | 标记 `videoState = 'failed'`，删除损坏文件，提供重试入口 |
| Node worker 崩溃 | worker 进程异常退出 | 任务记录保持 `running`，下次启动时扫描超时任务（超过 10 分钟的 `running` 任务），标记为 `failed` |
| 本地磁盘空间不足 | 写入文件失败 | 标记 `videoState = 'failed'`，错误信息记录"磁盘空间不足" |

### 8.2 导出异常处理

| 异常场景 | 检测方式 | 恢复策略 |
|---------|---------|---------|
| 拼接清单中存在缺失视频 | 校验阶段发现 `videoState != 'ready'` | 不启动 FFmpeg，返回缺失清单，提示用户先完成视频生成 |
| FFmpeg 合成失败 | FFmpeg 退出码非 0 | 保留 stderr 日志，标记任务失败，UI 显示错误详情 |
| 输出文件不可用 | 合成后文件不存在或大小为 0 | 标记任务失败，提示检查磁盘空间和路径权限 |
| 字幕生成失败 | SRT 文件写入错误 | 跳过字幕，降级为无字幕导出，在 UI 中提示降级信息 |
| 归一化失败 | FFmpeg 归一化退出码非 0 或 FFprobe 无法读取参数 | 记录错误日志，标记该分镜，跳过并继续处理其他分镜。用户可在导出报告中查看哪些分镜被跳过 |
| FFprobe 读取时长失败 | 成片无法被 FFprobe 解析 | 标记任务完成但警告"时长未知"，允许用户手动播放验证 |

### 8.3 启动时恢复

应用启动时扫描 SQLite 任务表：

1. 查找 `status = 'running'` 且 `task_type = 'generate_storyboard_video'` 的任务
2. 如果任务创建时间距今超过 10 分钟（最大轮询时长），标记为 `failed`，触发失败补偿
3. 如果任务创建时间距今未超过 10 分钟，尝试恢复轮询（如果远端 `taskId` 存在）
4. 查找 `status = 'running'` 且 `task_type = 'export_project_video'` 的任务，标记为 `failed`（导出任务不支持恢复，需重新执行）

## 9. UI 交互要求

### 9.1 视频任务面板

在分镜详情或分镜列表中展示视频状态：

| 状态 | UI 展示 |
|------|---------|
| `pending` | 灰色标签"等待中"，不可导出 |
| `running` | 蓝色标签"生成中"，可显示轮询进度（已轮询时长 / 10 分钟），不可导出 |
| `ready` | 绿色标签"已就绪"，显示视频时长，可预览播放，可导出 |
| `failed` | 红色标签"失败"，显示错误原因，提供"重试"按钮 |
| `invalidated` | 橙色标签"已失效"，提示"前置产物已变更，请重新生成"，提供"重新生成"按钮 |

视频预览：`ready` 状态下点击可内联播放视频，使用 `<video>` 标签加载本地文件路径。

### 9.2 批量视频生成

在片段级别或项目级别提供"批量生成视频"操作：

- 展示待生成分镜列表，每条标注是否通过前置校验
- 未通过校验的分镜标红并显示原因，不可勾选
- 通过校验的分镜可勾选，点击"批量生成"后并行创建多个 `generate_storyboard_video` 任务
- 展示整体进度：已完成 / 总数

### 9.3 导出页

导出页展示以下信息：

**导出配置区域：**
- 分辨率选择（下拉：720p / 1080p / 原始分辨率）
- 帧率选择（下拉：24 / 30 / 60）
- 字幕开关（勾选框）
- 背景音乐开关（勾选框 + 文件选择器）
- 输出路径（文本框 + 浏览按钮，默认 `exports/final.mp4`）

**导出就绪检查区域：**
- 总分镜数 / 已就绪分镜数
- 缺失视频清单（如有），每条可点击跳转到对应分镜
- "全部就绪"时导出按钮可点击，否则置灰

**导出进度区域：**
- 当前步骤（生成拼接清单 → 生成字幕 → FFmpeg 合成 → 完成）
- FFmpeg 实时日志（可展开查看 stderr 输出）

**导出记录区域：**
- 最近导出记录列表（时间、配置摘要、路径、时长）
- 每条记录可点击"打开所在目录"

### 9.4 失效提示

当分镜视频被标记为 `invalidated` 时：

- 在分镜列表中以橙色角标提示
- 在导出页的就绪检查中拦截，提示"存在失效分镜，请先重新生成视频"
- 用户修改融合图/语音/提示词后，弹窗提示"此操作将使已生成的视频失效，是否继续？"

## 10. 最低落地清单

以下为本模块必须实现的最小功能集，按优先级排列：

| 序号 | 功能项 | 技术实现 | 验收标准 |
|------|--------|---------|---------|
| 1 | 火山引擎视频生成客户端 | Node worker 内封装火山引擎 OpenAPI 调用 | 能提交生成请求并获取远端 taskId |
| 2 | 视频任务轮询器 | Node worker 内定时轮询（10 秒间隔，10 分钟超时） | 能正确识别 succeeded / failed / 超时 |
| 3 | 视频下载器 | Node worker 内 HTTP 下载 + 文件校验 | 下载后文件可被 FFprobe 读取时长 |
| 4 | 视频生成模式判断 | Tauri command 内根据 fusedImagePath / referenceImages 判断 mode | 正确区分 image_to_video 和 reference_image_to_video |
| 5 | 视频生成前置校验 | Tauri command 内执行 6 项校验清单 | 缺任一前置条件时返回明确错误 |
| 6 | 视频状态生命周期管理 | SQLite 事务更新 videoState | pending → running → ready / failed / invalidated 转换正确 |
| 7 | 失效与重算 | 前置产物写入时同事务标记失效 | 融合图/语音/提示词改动后 videoState 正确变为 invalidated |
| 8 | 拼接清单生成 | Node worker 读取 SQLite 生成 FFmpeg concat 格式 | 清单顺序与项目时间线一致 |
| 9 | SRT 字幕生成 | Node worker 根据语音时长累加时间轴 | 字幕时间与视频内容同步 |
| 10 | FFmpeg 合成 | Node worker 调用 FFmpeg 完成拼接、烧录字幕、混入背景音乐 | 输出可播放的 final.mp4 |
| 11 | 导出前置条件检查 | Tauri command 内检查所有分镜 videoState | 返回缺失视频清单 |
| 12 | 导出配置管理 | ExportConfig 数据结构 + UI 配置面板 | 分辨率/帧率/字幕/背景音乐/输出路径可配置 |
| 13 | 导出记录表 | SQLite 表存储导出历史 | 可查询最近导出记录 |
| 14 | 启动时任务恢复 | 应用启动时扫描 running 任务并恢复或标记失败 | 不存在永久卡在 running 的任务 |
| 15 | 视频任务 UI 面板 | React 组件展示视频状态与进度 | 五种 videoState 正确展示，可预览可重试 |
| 16 | 导出页 UI | React 组件展示配置、就绪检查、进度、记录 | 导出流程完整可操作 |
