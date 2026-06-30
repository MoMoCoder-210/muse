# 模块 08：任务运行时、状态机与恢复

## 1. 模块职责

这个模块是桌面端的本地工作流引擎。它负责所有异步任务的入队、执行、状态推进、失败补偿和重启恢复。所有耗时动作（剧本拆分、剧本理解、资产生图、分镜生成、融合图生成、语音生成、视频生成、导出）都必须通过这个模块调度，不能在 UI 线程或 IPC 命令中直接执行远端请求。

## 2. 统一生成任务模板

所有生成动作遵循同一套任务模板流程。任何新增的生成类型都必须按此模板实现。

### 2.1 模板流程

```text
1. 校验输入
   ├── 检查必填字段
   ├── 检查前置条件（上游是否完成、资源是否就绪）
   └── 检查逻辑锁（是否有同类型任务正在运行）

2. 持久化任务和业务状态（本地事务）
   ├── 写入 Task 记录（status = pending）
   ├── 更新业务实体状态（如 ClipScript.status = running）
   └── 以上两步在同一 SQLite 事务中，保证原子性

3. 提交远端请求（事务提交后）
   ├── worker 取到 pending 任务，标记为 running
   ├── 组装请求参数
   ├── 调用火山引擎 API 或本地处理逻辑
   └── 如果是远端任务，保存 remoteTaskId，状态转为 waiting_remote

4. 轮询或等待回调
   ├── 远端任务：按固定间隔轮询状态
   ├── 本地任务：直接执行完成后转入下一步
   └── 轮询成功后状态转为 downloading（如有文件需下载）

5. 回写结果
   ├── 下载文件到工作区（如需要）
   ├── 更新业务实体（路径、状态、参数）
   ├── 更新 Task（status = success，outputJson，finishedAt）
   ├── 释放逻辑锁
   └── 推送进度事件到前端

6. 失败补偿
   ├── 更新 Task（status = failed，errorMessage，retryCount）
   ├── 更新业务实体状态为 failed
   ├── 释放逻辑锁
   ├── 保留错误信息和原始响应用于诊断
   └── 推送失败事件到前端
```

### 2.2 事务边界

事务只覆盖"持久化任务记录 + 更新业务状态"这一步。远端请求、文件下载、结果回写都在事务外执行。这样保证了：

- 任务记录和业务状态一致（要么都成功，要么都回滚）
- 远端请求失败不会导致已落库的数据回滚（任务记录保留，可以重试）
- 长时间的远端调用不会占用数据库事务

### 2.3 前端提交约束

UI 提交后只做两件事：校验输入、在同一事务中写入 Task 和业务状态。提交后立即返回，不等待远端结果。前端通过事件流订阅任务进度。

## 3. 任务执行模型

### 3.1 架构

```text
前端 (React)
  │
  ├── Tauri IPC 命令 ──→ 服务层（Rust/TS）
  │                          ├── 校验输入
  │                          ├── 开启 SQLite 事务
  │                          ├── 写入 Task（pending）
  │                          ├── 更新业务状态
  │                          ├── 提交事务
  │                          └── 通知 worker
  │
  ├── 事件流订阅 ←──────── worker（Node sidecar）
  │                          ├── 轮询 pending 任务
  │                          ├── 获取逻辑锁
  │                          ├── 标记 running
  │                          ├── 执行具体逻辑
  │                          ├── 调用火山引擎 API
  │                          ├── 轮询远端状态
  │                          ├── 下载结果文件
  │                          ├── 回写业务状态
  │                          ├── 释放逻辑锁
  │                          └── 推送事件
  │
  └── TanStack Query 轮询业务状态（兜底）
```

### 3.2 worker 设计

worker 是一个 Node.js sidecar 进程，通过 stdio 与 Tauri 主进程通信。核心循环：

```text
while (running) {
  1. 查询所有 status = 'pending' 且 lockKey 未被占用的 Task（按 createdAt 排序）
  2. 对每条 Task：
     a. 根据 task.type 映射到 apiType（text / image / voice / video / local）
     b. 检查该 apiType 并发数是否达上限 → 达上限则跳过
     c. 检查该 apiType 是否被暂停（配额耗尽）→ 暂停则跳过
     d. 尝试获取逻辑锁
  3. 三项都通过：
     a. 获取令牌（rateLimiter.acquire）
     b. 标记 Task 为 running
     c. 根据 type 分发到对应 handler
     d. handler 执行（传入 AbortSignal 用于优雅退出）
     e. 成功：标记 success，回写业务状态，释放锁和令牌，推送事件
     f. 失败：标记 failed，回写业务状态，释放锁和令牌，推送事件
  4. 如果是 waiting_remote 的任务，恢复轮询
  5. 如果本轮无可执行任务，休眠 1 秒
}
```

worker 通过逻辑锁保证同一业务对象 + 同一任务类型不会并发运行，通过 `RateLimiter` 保证同一 API 类型的请求不超过 QPS 和并发上限（见 7.5 节）。

**SQLite 多进程访问要求：**

Node worker 和 Tauri Rust 层同时访问同一个 SQLite 数据库文件。必须满足以下要求（见模块 09 第 3.11 节）：
1. 数据库必须启用 WAL 模式（`PRAGMA journal_mode = WAL`）
2. 连接必须设置 `busy_timeout = 5000`，写冲突时自动重试
3. 写事务保持短小，避免长时间占用写锁
4. task_locks 表的逻辑锁是应用层防重，不替代 WAL 的数据库层并发控制

### 3.2.1 为什么使用 Node sidecar 而非 Rust 原生

选择 Node.js sidecar 而非 Rust 原生任务执行，基于以下考量：

1. **火山引擎 SDK 优先支持 Node.js**：火山引擎的官方 SDK 和示例代码以 Node.js/Python 为主，Rust 生态中缺乏成熟的大模型 API 客户端。使用 Node sidecar 可以直接复用官方 SDK，减少封装成本。
2. **团队技术栈**：团队以 JavaScript/TypeScript 为主要技术栈，Node worker 的开发和维护成本更低。
3. **生态库支持**：better-sqlite3、fluent-ffmpeg、axios 等库在 Node.js 生态中成熟稳定，Rust 对应库的成熟度和文档丰富度有差距。
4. **FFmpeg 集成**：Node.js 通过 child_process 调用 FFmpeg 的模式在实践中被广泛验证，Rust 的 FFmpeg 绑定（ffmpeg-next 等）成熟度不足。

**stdio 通信开销及缓解措施：**

Rust↔Node 通过 stdio JSON 通信，存在序列化开销。缓解措施：
1. 通信消息保持精简，大文件路径而非文件内容通过 IPC 传递。
2. 前端订阅任务进度通过 Tauri emit/listen 事件流，不轮询 IPC 命令。
3. Node worker 直接读写 SQLite 获取业务数据，不通过 Rust 中转。
4. 高频进度事件（如下载进度）在 worker 侧节流，每 500ms 最多推送一次。
5. 二进制数据（图片、视频）不通过 stdio 传输，直接写文件系统，只传路径。

### 3.2.2 Sidecar 生命周期管理

Node sidecar 是独立进程，Tauri 主进程负责其完整生命周期：启动 → 健康监控 → 崩溃恢复 → 优雅退出。生命周期管理在 Rust 侧实现（`SidecarManager`），不依赖 worker 自身的健康逻辑。

#### 启动流程

```text
Tauri App 启动
  │
  ├── 1. SidecarManager.start()
  │      ├── 通过 tauri::api::process::Command 启动 Node worker 二进制
  │      ├── 为 worker 生成唯一 workerId（UUID）
  │      ├── 通过环境变量 WORKER_ID 传入 workerId
  │      └── 启动 10 秒超时计时器，等待 worker 的 ready 消息
  │
  ├── 2. Worker 初始化（Node 进程内）
  │      ├── 连接 SQLite（启用 WAL 模式 + busy_timeout）
  │      ├── 检测 FFmpeg/FFprobe 路径
  │      ├── 创建 RateLimiter 实例
  │      ├── 注册所有 TaskHandler
  │      └── 向 stdout 发送 {"version":1,"msg":"ready","workerId":"...","protocolVersion":1}
  │
  ├── 3. Tauri 收到 ready 消息
  │      ├── 校验 protocolVersion 是否兼容
  │      ├── 记录 workerId
  │      └── 发送 {"version":1,"cmd":"start_recovery"}（触发 8.1 节恢复扫描）
  │
  ├── 4. Worker 执行恢复扫描
  │      ├── 清理过期锁
  │      ├── 重置 running 状态的任务
  │      └── 恢复 waiting_remote 任务的轮询
  │
  └── 5. Worker 进入主循环
         └── 每 10 秒发送 heartbeat
```

**启动失败处理：**
- 10 秒内未收到 `ready` 消息：Tauri 杀掉 worker 进程，按崩溃重启策略处理（见下文）。
- `protocolVersion` 不兼容：Tauri 杀掉 worker 进程，弹出错误对话框"应用版本不兼容，请更新应用"。
- worker 启动时自身初始化失败（如 SQLite 文件损坏）：worker 发送 `{"msg":"error","message":"..."}` 后退出，Tauri 显示错误并提供"打开工作区目录"按钮。

#### 健康监控

双机制检测 worker 存活：

**机制一：心跳**

worker 每 10 秒发送一次心跳：
```json
{"version":1,"msg":"heartbeat","workerId":"abc-123","activeTasks":3}
```

Tauri 侧维护 `lastHeartbeatAt` 时间戳，每 5 秒检查一次。如果距离上次心跳超过 30 秒，判定 worker 卡死（可能因 native 模块死锁或无限循环），触发强制重启。

**机制二：进程退出回调**

Tauri 通过 `Command::on_exit` 监听 worker 进程退出事件。无论正常退出还是崩溃退出，都会立即触发。这是主要检测机制，心跳作为备份。

退出码含义：
- `0`：正常退出（收到 shutdown 命令后退出）
- 非 `0`：异常退出（崩溃、OOM、native 模块错误）

#### 崩溃恢复

当检测到 worker 异常退出或心跳超时后，立即执行：

```text
1. 确认 worker 进程已终止（必要时 taskkill /F）
2. 立即清理该 workerId 持有的所有锁（不等 30 分钟超时）：
   DELETE FROM task_locks WHERE locked_by = ?;  -- locked_by 中存储的是 workerId:taskId
3. 重置该 worker 的所有 running 任务：
   -- 本地任务回退为 pending
   UPDATE tasks SET status = 'pending'
   WHERE status = 'running' AND lock_key IN (
     SELECT lock_key FROM task_locks WHERE locked_by LIKE 'workerId:%'
   );
   -- 远端任务恢复为 waiting_remote
   UPDATE tasks SET status = 'waiting_remote'
   WHERE status = 'running' AND remote_task_id IS NOT NULL
   AND lock_key IN (SELECT lock_key FROM task_locks WHERE locked_by LIKE 'workerId:%');
4. 推送 worker_crashed 事件到前端
5. UI 显示"工作进程已重启，正在恢复任务..."提示
6. 按重启策略启动新 worker
7. 新 worker 启动后执行 8.1 节恢复扫描
```

**与 30 分钟锁超时的区别：** 正常的锁超时清理是兜底机制（防止漏处理），崩溃恢复是即时清理（worker 已确认死掉，锁一定无效）。崩溃恢复不等锁超时。

#### 重启策略

```text
重启计数器（5 分钟滑动窗口）
  │
  ├── 重启次数 < 3：
  │    ├── 等待 2 秒（给 OS 释放资源的时间）
  │    ├── 启动新 worker
  │    └── 重启计数器 +1
  │
  ├── 重启次数 = 3（5 分钟内第 3 次崩溃）：
  │    ├── 停止自动重启
  │    ├── 推送 worker_failed 事件
  │    └── UI 显示错误对话框：
  │         "工作进程多次崩溃，已停止自动重启。
  │          [手动重启] [打开日志] [反馈问题]"
  │
  └── 重启计数器重置：
       如果 worker 稳定运行超过 5 分钟，计数器归零
```

**Windows 特殊处理：** Windows 上 `taskkill /F /PID <pid>` 是可靠的进程终止方式。如果 worker 启动了 FFmpeg 子进程，这些子进程可能成为孤儿进程。SidecarManager 在杀掉 worker 后应检查并清理 worker 的子进程树（通过 Windows Job Object 或 `taskkill /F /T /PID <pid>`）。

#### 优雅退出

用户关闭应用窗口时：

```text
1. Tauri 发送 {"version":1,"cmd":"shutdown","timeoutMs":30000}
2. Worker 收到 shutdown：
   a. 停止轮询 pending 任务（不取新任务）
   b. RateLimiter 停止发放新令牌
   c. 当前正在执行的 handler 通过 AbortSignal 收到取消信号
   d. handler 应在 5 秒内响应取消：
      - 将任务标记为 pending（不是 failed）
      - 释放锁
   e. waiting_remote 的轮询循环立即停止
   f. Worker 发送 {"version":1,"msg":"shutting_down","pendingTasks":N}
   g. Worker 退出（exit code 0）
3. Tauri 等待 Worker 退出：
   a. 正常退出：关闭应用
   b. 30 秒超时未退出：taskkill /F 强制终止
   c. 强制终止后，running 状态的任务在下次启动时由恢复扫描处理
```

**未完成任务的处理：** 优雅退出时被标记为 `pending` 的任务，下次启动时 worker 会自动拾取继续执行。`waiting_remote` 的任务保留 `remoteTaskId`，下次启动时恢复轮询。用户不会丢失工作进度。

#### Worker 内部错误处理

handler 执行过程中抛出的未捕获异常不应导致 worker 崩溃：

```text
handler.execute() 异常
  │
  ├── Worker 的 try-catch 捕获
  ├── 标记 Task 为 failed，写入 errorMessage
  ├── 释放锁和令牌
  ├── 推送 task_failed 事件
  ├── 向 Tauri 发送 {"msg":"error","message":"...","stack":"...","taskId":"..."}
  └── Worker 继续运行，处理下一个任务
```

只有以下情况会导致 worker 进程退出（触发崩溃恢复）：
- 内存不足（OOM）：Node.js 进程被 OS 杀死
- native 模块崩溃（如 better-sqlite3 的段错误）：进程直接退出
- `process.exit()` 被显式调用：不应在代码中使用

#### SidecarManager 接口

Rust 侧的 `SidecarManager` 负责上述所有逻辑：

```rust
struct SidecarManager {
    worker_id: String,
    last_heartbeat: Instant,
    restart_count: u32,
    restart_window_start: Instant,
    child: Option<CommandChild>,
}

impl SidecarManager {
    // 启动 worker，等待 ready 握手
    async fn start(&mut self) -> Result<(), SidecarError>;
    // 停止 worker（优雅退出）
    async fn shutdown(&mut self, timeout_ms: u64) -> Result<(), SidecarError>;
    // 强制重启（崩溃恢复）
    async fn restart(&mut self) -> Result<(), SidecarError>;
    // 心跳检查（每 5 秒调用）
    fn check_heartbeat(&mut self) -> HeartbeatStatus;
    // 进程退出回调
    async fn on_exit(&mut self, exit_code: i32);
}
```

### 3.3 handler 注册

每种任务类型对应一个 handler。handler 接口：

```ts
interface TaskHandler {
  // 任务类型
  type: TaskType;

  // 执行任务
  execute(task: Task, ctx: TaskContext): Promise<TaskResult>;

  // 检查是否可恢复（用于重启恢复）
  canResume(task: Task): boolean;

  // 恢复任务（用于重启时恢复 waiting_remote 状态的任务）
  resume(task: Task, ctx: TaskContext): Promise<TaskResult>;
}

interface TaskContext {
  // 工作区路径
  workspacePath: string;
  // SQLite 连接（必须启用 WAL 模式，见模块 09 第 3.11 节）
  db: Database;
  // 推送事件的函数
  emit: (event: TaskEvent) => void;
  // 火山引擎客户端
  volcano: {
    text: VolcanoTextClient;
    image: VolcanoImageClient;
    video: VolcanoVideoClient;
    voice: VolcanoVoiceClient;
  };
  // FFmpeg 工具（路径由启动时检测，见 8.1 步骤 0）
  ffmpeg: FFmpegHelper;
  // API 限流器（见 7.5 节）
  rateLimiter: RateLimiter;
  // 取消信号（用于优雅退出时中断 handler）
  signal: AbortSignal;
}

interface FFmpegHelper {
  ffmpegPath: string;       // FFmpeg 可执行文件路径
  ffprobePath: string;      // FFprobe 可执行文件路径
  // 执行 FFmpeg 命令
  exec(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
  // 执行 FFprobe 探测
  probe(filePath: string): Promise<{ duration: number; width: number; height: number; codec: string }>;
  // 检测工具可用性（启动时调用）
  static detect(): Promise<FFmpegHelper | null>;
}

interface TaskResult {
  success: boolean;
  outputJson?: string;
  errorMessage?: string;
  remoteTaskId?: string;
  needPolling?: boolean;
}
```

路径在应用启动时检测并缓存（见 8.1 步骤 0）。

## 4. 数据结构

### 4.1 Task

```ts
type TaskType =
  | 'split_script_source'
  | 'generate_clip_script'
  | 'generate_asset_image'
  | 'generate_storyboards'
  | 'generate_storyboard_image'
  | 'generate_storyboard_voice'
  | 'import_storyboard_voice'
  | 'generate_storyboard_video'
  | 'export_project_video';

type TaskStatus =
  | 'pending'      // 已入队，等待 worker 取走
  | 'running'      // worker 正在执行
  | 'waiting_remote' // 已提交远端，等待轮询
  | 'downloading'  // 远端已完成，正在下载结果
  | 'success'      // 成功完成
  | 'failed'       // 执行失败
  | 'canceled';    // 用户取消

type Task = {
  id: string;
  projectId: string;
  clipId?: string;
  storyboardId?: string;
  assetId?: string;
  type: TaskType;
  status: TaskStatus;
  lockKey: string;           // 逻辑锁键，格式见 6.1
  inputJson: string;         // 任务输入参数
  outputJson?: string;       // 任务输出结果
  remoteTaskId?: string;     // 火山引擎返回的远端任务 ID
  errorMessage?: string;     // 失败时的错误信息
  retryCount: number;        // 已重试次数
  maxRetry: number;          // 最大重试次数，默认 3
  startedAt?: string;        // 开始执行时间
  finishedAt?: string;       // 完成时间
  batchId?: string;           // 批次 ID，批量操作时同一批次共享
  createdAt: string;
  updatedAt: string;
};
```

### 4.2 任务事件

```ts
type TaskEvent =
  | { type: 'task_started'; taskId: string; taskType: TaskType }
  | { type: 'task_progress'; taskId: string; progress: number; message?: string }
  | { type: 'task_waiting_remote'; taskId: string; remoteTaskId: string }
  | { type: 'task_downloading'; taskId: string; progress: number }
  | { type: 'task_success'; taskId: string; outputJson?: string }
  | { type: 'task_failed'; taskId: string; errorMessage: string }
  | { type: 'task_canceled'; taskId: string }
  | { type: 'task_invalidated'; taskId: string; reason: string }
  // 系统级事件（非任务级）
  | { type: 'worker_crashed'; workerId: string; message: string }
  | { type: 'worker_restarted'; workerId: string; recoveredTasks: number }
  | { type: 'worker_failed'; message: string }  // 自动重启次数耗尽
  | { type: 'quota_exhausted'; apiType: 'text' | 'image' | 'voice' | 'video'; message: string }
  | { type: 'quota_resumed'; apiType: 'text' | 'image' | 'voice' | 'video' };

批量操作（批量生图、批量生成语音、批量生成视频等）创建多个 Task 时，所有 Task 共享同一个 `batchId`（UUID）。

**批次状态查询：**
```sql
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as completed,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
  SUM(CASE WHEN status IN ('pending', 'running', 'waiting_remote', 'downloading') THEN 1 ELSE 0 END) as in_progress
FROM tasks WHERE batch_id = ?;
```

**批次取消：**
用户取消批量操作时，将该批次下所有 `pending` 状态的 Task 标记为 `canceled`，`running` 状态的 Task 在下次轮询检查时终止。已完成的 Task 不回滚（保留已生成的结果）。

**批次进度事件：**
worker 推送 `batch_progress` 事件（频率：每 1 秒最多一次），payload 包含 `batchId`、`total`、`completed`、`failed`。前端通过 `batchId` 订阅进度，无需客户端聚合。

## 5. 状态机

### 5.1 项目状态机

```text
new → active → archived
         ↓
      failed（项目创建失败，可重试）
```

项目状态保存在 `Project.status` 字段。

### 5.2 片段状态机

```text
pending → script_ready → asset_ready → storyboard_ready → media_ready → done
  │           │              │                │                  │
  ↓           ↓              ↓                ↓                  ↓
failed     failed         failed           failed             failed
```

片段状态保存在 `Clip.status` 字段。每个阶段失败后可以重试，重试成功后继续推进。

### 5.3 分镜状态机

每条分镜有三个独立的状态字段：`imageState`、`voiceState`、`videoState`，各自独立推进。

```text
imageState:  pending → running → ready → invalidated
                                ↓
                              failed

voiceState:  pending → running → ready → invalidated
                                ↓
                              failed

videoState:  pending → running → ready → invalidated
                                ↓
                              failed
```

`invalidated` 表示上游变更导致当前结果需要重新生成。用户手动触发重算后状态回到 `pending`。

### 5.4 任务状态机

```text
pending → running → success
    │         │
    │         ├──→ waiting_remote → downloading → success
    │         │         │                │
    │         │         ↓                ↓
    │         │       failed           failed
    │         │
    │         ↓
    │       failed
    │
    ↓
  canceled
```

任务失败后可以重试：重试时创建新的 Task 记录（新 id），`retryCount` 从上一条继承。旧 Task 保留用于审计。

### 5.5 项目步骤状态机

```text
project → split → script → asset → storyboard → voice → video → export
```

`Project.currentStep` 记录当前进度。`Project.autoContinue` 控制是否自动进入下一步。用户可设置 `stopStep` 让流程停在某一步等待人工确认。

步骤推进规则（片段级）：

1. 每个 Clip 独立维护 `currentStep`，不依赖其他 Clip 的进度。
2. 当某个 Clip 当前步骤的所有子任务都成功后，如果项目 `autoContinue = true` 且该 Clip 的 `currentStep` < 项目 `stopStep`，自动推进该 Clip 到下一步。
3. 项目 `currentStep` 是聚合值（取所有 Clip 中最慢的步骤），仅用于 UI 展示，不作为推进条件。
4. 不同 Clip 可以处于不同步骤，用户可对不同 Clip 并行操作。
5. Clip 失败只影响该 Clip 自身，其他 Clip 不受影响。

## 6. 逻辑锁

### 6.1 lockKey 规则

```text
任务类型                    lockKey 格式
─────────────────────────  ──────────────────────────────────
split_script_source        split:{projectId}:{sourceId}
generate_clip_script       script:{clipId}
generate_asset_image       asset_image:{assetId}
generate_storyboards       storyboards:{clipId}
generate_storyboard_image  sb_image:{storyboardId}
generate_storyboard_voice  sb_voice:{storyboardId}
import_storyboard_voice    sb_voice:{storyboardId}
generate_storyboard_video  sb_video:{storyboardId}
export_project_video       export:{projectId}
```

### 6.2 锁的获取与释放

获取锁（伪代码）：

```sql
-- 原子操作：检查并设置
INSERT INTO task_locks (lock_key, locked_by, locked_at)
VALUES (?, ?, datetime('now'))
ON CONFLICT(lock_key) DO NOTHING;

-- 检查是否获取成功
SELECT locked_by FROM task_locks WHERE lock_key = ?;
-- 如果 locked_by == 当前 taskId，获取成功
-- 否则获取失败
```

释放锁：

```sql
DELETE FROM task_locks WHERE lock_key = ? AND locked_by = ?;
```

### 6.3 锁的超时与清理

锁有 30 分钟超时。worker 启动时和每 5 分钟清理一次过期锁：

```sql
DELETE FROM task_locks
WHERE locked_at < datetime('now', '-30 minutes');
```

清理过期锁后，对应的 `running` 或 `waiting_remote` 状态的 Task 会被重启恢复逻辑处理。

### 6.4 锁与任务状态的关系

- 获取锁成功 → Task 标记为 `running`
- 获取锁失败 → Task 保持 `pending`，下一轮 worker 循环再试
- 任务完成/失败 → 释放锁和令牌
- worker 崩溃 → SidecarManager 立即清理该 workerId 的所有锁（见 3.2.2 崩溃恢复），不等 30 分钟超时
- worker 正常退出 → 优雅退出流程将 running 任务标记为 pending 并释放锁（见 3.2.2 优雅退出）
- 30 分钟超时清理 → 兜底机制，防止 SidecarManager 遗漏的场景（如 Tauri 自身崩溃后重启）

## 7. 运行时流程

### 7.1 入队

```text
1. 前端调用 Tauri IPC 命令（如 generateClipScript）
2. 服务层校验输入
3. 计算 lockKey
4. 开启 SQLite 事务
5. 插入 Task 记录（status = pending）
6. 更新业务实体状态（如 ClipScript.status = 'running'）
7. 提交事务
8. 通过 stdio 通知 worker 有新任务
9. 返回 { taskId } 给前端
```

### 7.2 执行

```text
1. worker 查询所有 status = 'pending' 的 Task（按 createdAt 排序）
2. 对每条 Task 检查三项条件：
   a. apiType 并发数是否达上限（见 7.5.1 令牌桶配置）
   b. apiType 是否被暂停（配额耗尽）
   c. lockKey 是否被占用
3. 三项都通过：
   a. 获取令牌（rateLimiter.acquire）
   b. 获取逻辑锁
   c. 标记 Task 为 running
   d. 根据 type 分发到对应 handler
   e. handler.execute() 执行（传入 AbortSignal 用于优雅退出）
   f. handler 返回 TaskResult
   g. 成功：标记 success，回写业务状态，释放锁和令牌，推送事件
   h. 失败：标记 failed，回写业务状态，释放锁和令牌，推送事件
4. 任一条件不通过：跳过该 Task，继续检查下一条
5. 本轮无可执行 Task：休眠 1 秒
```

### 7.3 远端轮询

对于需要调用火山引擎的任务（资产生图、融合图、语音、视频）：

```text
1. handler 调用火山引擎 API 提交请求
2. 获取 remoteTaskId
3. 标记 Task 为 waiting_remote
4. 保存 remoteTaskId
5. 启动轮询循环：
   a. 每隔 N 秒查询远端任务状态
   b. 推送 task_progress 事件
   c. 如果远端任务完成，标记 Task 为 downloading
   d. 下载结果文件到工作区
   e. 标记 Task 为 success
   f. 回写业务状态
   g. 释放锁
6. 如果远端任务失败或超时，标记 Task 为 failed
```

轮询间隔建议：

- 图像生成：5 秒
- 语音生成：3 秒
- 视频生成：10 秒
- 最大轮询时长：10 分钟

### 7.4 推送

worker 通过 Tauri 的事件机制推送 `TaskEvent` 到前端：

```ts
// Tauri 前端监听
import { listen } from '@tauri-apps/api/event';

listen<TaskEvent>('task-event', (event) => {
  const { taskId, type } = event.payload;
  // 更新 TanStack Query 缓存
  // 更新 Zustand 状态
  // 显示 toast 通知
});
```

前端同时用 TanStack Query 每 2 秒轮询业务状态作为兜底，防止事件丢失。

### 7.5 API 限流与重试策略

所有调用火山引擎 API 的 handler 必须通过统一的 `RateLimiter` 组件控制请求频率和并发。`RateLimiter` 在 worker 进程内运行，不持久化（令牌桶状态是瞬时的，重启后自然恢复）。

#### 7.5.1 令牌桶配置

按 API 类型独立限流，互不影响：

```text
API 类型   | 对应 TaskType                              | 桶容量 | 补充速率   | 最大并发
──────────|────────────────────────────────────────────|──────|──────────|────────
text      | split_script_source, generate_clip_script, | 5    | 2 个/秒   | 2
          | generate_storyboards                       |      |           |
image     | generate_asset_image,                      | 3    | 1 个/秒   | 3
          | generate_storyboard_image                  |      |           |
voice     | generate_storyboard_voice                  | 3    | 1 个/秒   | 2
video     | generate_storyboard_video                  | 1    | 1 个/5秒  | 1
local     | import_storyboard_voice,                   | —    | —         | 2
          | export_project_video                       |      |           |
```

`local` 类型不调用远端 API，仅受并发限制，不限流。

令牌桶参数可在 `settings` 表中配置覆盖（键：`rate_limit_text`、`rate_limit_image` 等，值为 JSON），方便后续调整而不用改代码。

#### 7.5.2 RateLimiter 接口

```ts
type ApiType = 'text' | 'image' | 'voice' | 'video' | 'local';

interface RateLimiter {
  // 获取令牌（阻塞直到有令牌可用或超时）
  // 如果该 API 类型被暂停（配额耗尽），抛出 QuotaExhaustedError
  acquire(apiType: ApiType, timeoutMs?: number): Promise<void>;

  // 释放并发槽位（API 调用结束后调用）
  release(apiType: ApiType): void;

  // 检查是否有可用令牌（不阻塞）
  canAcquire(apiType: ApiType): boolean;

  // 获取当前并发数
  getActiveCount(apiType: ApiType): number;

  // 报告 429 错误，触发退避
  reportRateLimit(apiType: ApiType, retryAfterMs?: number): void;

  // 报告配额耗尽，暂停该类型
  reportQuotaExhausted(apiType: ApiType, message: string): void;

  // 手动恢复（用户在 UI 点击"继续"）
  resume(apiType: ApiType): void;
}
```

`RateLimiter` 实例在 worker 启动时创建，通过 `TaskContext` 传入每个 handler。

#### 7.5.3 错误分类与处理

handler 调用火山引擎 API 时，必须对返回的错误进行分类处理：

```text
HTTP 状态码        | 分类       | 处理方式
──────────────────|──────────|──────────────────────────────────
200               | 成功       | 处理结果
400               | 参数错误    | 标记 failed，不重试，提示用户修正
401 / 403         | 认证失败    | 标记 failed，推送 auth_error 事件，提示用户检查凭证
429               | 限流        | 读取 Retry-After 头，退避后重试
429 + quota错误码  | 配额耗尽    | 暂停该 API 类型，推送 quota_exhausted 事件
500 / 502 / 503 / 504 | 服务端错误 | 退避重试（计入 retryCount）
timeout           | 网络超时    | 退避重试（计入 retryCount）
ECONNREFUSED      | 网络不可达  | 退避重试（计入 retryCount）
其他              | 未知错误    | 标记 failed，不重试，保留原始响应用于诊断
```

#### 7.5.4 退避重试策略

对于可重试错误（429、5xx、timeout、ECONNREFUSED），使用指数退避 + 随机抖动：

```text
重试次数  | 基础等待   | 抖动范围    | 实际等待
─────────|──────────|──────────|──────────────
第 1 次  | 5 秒      | 0 ~ 2 秒   | 5 ~ 7 秒
第 2 次  | 15 秒     | 0 ~ 5 秒   | 15 ~ 20 秒
第 3 次  | 30 秒     | 0 ~ 10 秒  | 30 ~ 40 秒
```

**429 特殊处理：** 如果响应包含 `Retry-After` 头（单位秒），则使用该值作为等待时间，但上限 120 秒。超过 `maxRetry`（默认 3 次）后标记任务为 `failed`。

**退避期间的任务状态：** 任务保持 `running` 状态（不回退到 `pending`），因为远端请求已经提交。handler 内部在退避等待期间应定期检查任务是否被用户取消（通过 `AbortSignal`）。

#### 7.5.5 并发控制与任务调度

worker 核心循环在选取 pending 任务时，需同时检查逻辑锁和并发限制：

```text
while (running) {
  1. 查询所有 status = 'pending' 的 Task（按 createdAt 排序）
  2. 对每条 Task：
     a. 根据 task.type 映射到 apiType（text/image/voice/video/local）
     b. 检查该 apiType 的并发数是否已达上限 → 达上限则跳过，继续看下一条
     c. 检查该 apiType 是否被暂停（配额耗尽）→ 暂停则跳过
     d. 检查 lockKey 是否被占用 → 被占用则跳过
     e. 三项都通过：获取令牌 → 获取锁 → 标记 running → 分发到 handler
  3. 如果本轮没有可执行的任务（全部被并发限制或锁阻塞），休眠 1 秒
  4. 如果有 waiting_remote 的任务，恢复轮询
}
```

这确保了即使有 20 个 pending 的图片生成任务，也最多同时运行 3 个；同时文本类任务可以并行推进，不受图片任务排队影响。

#### 7.5.6 配额耗尽处理

当火山引擎返回配额耗尽错误（通常为 429 + 特定错误码）时：

1. `RateLimiter.reportQuotaExhausted(apiType, message)` 被调用
2. 该 API 类型被标记为"暂停"状态，`canAcquire()` 返回 `false`
3. 所有该类型的 `pending` 任务保持 `pending`（不标记 failed）
4. 正在执行的该类型任务允许完成（不中断）
5. worker 推送 `quota_exhausted` 事件到前端
6. 前端显示警告横幅："今日图像生成配额已用尽，请在设置中检查配额或稍后重试"
7. 用户可在设置页面手动点击"恢复"按钮调用 `RateLimiter.resume(apiType)`
8. 恢复后，暂停期间积压的 `pending` 任务自动开始执行

配额状态不持久化——worker 重启后，所有 API 类型默认为"未暂停"状态。这是因为配额限制是远端的，本地无法准确知道何时恢复，由用户判断或定时尝试。

#### 7.5.7 与 Sidecar 生命周期的交互

- **worker 崩溃重启后**：令牌桶状态丢失（桶满），但补充速率不变，不会导致突发流量。配额暂停状态也丢失，worker 会尝试调用 API，如果配额仍未恢复，会再次触发 `quota_exhausted`。
- **优雅退出时**：`RateLimiter` 停止发放新令牌（`acquire()` 立即返回 `false`），正在执行的任务允许在 shutdown timeout 内完成。
- **handler 内部退避等待期间收到 shutdown 信号**：`AbortSignal` 触发，handler 应捕获 `AbortError`，将任务标记为 `pending`（不是 `failed`），释放锁，让下次启动时重新执行。

## 8. 恢复策略

### 8.1 应用重启恢复

应用启动时，worker 执行恢复扫描：

```text
0. **外部工具检测**：检测 FFmpeg 和 FFprobe 是否安装且可用。
   - 检测路径：优先使用系统 PATH 中的 ffmpeg/ffprobe；如未找到，检查应用内置的 ffmpeg 目录。
   - 检测方式：执行 `ffmpeg -version` 和 `ffprobe -version`，解析版本号。
   - 缓存路径：将检测到的 ffmpeg/ffprobe 绝对路径缓存到内存和 SQLite 的 settings 表（键：`ffmpeg_path`、`ffprobe_path`）。
   - 缺失处理：如果任一工具不可用，在 UI 显示警告横幅，语音生成（模块 06）和视频生成/导出（模块 07）任务直接标记为 `failed`，错误信息提示用户安装或配置 FFmpeg/FFprobe 路径。
   - 用户配置：用户可在设置页面手动指定 FFmpeg/FFprobe 路径，覆盖自动检测结果。
1. 清理过期逻辑锁（locked_at < now - 30min）
2. 查询所有 status IN ('running', 'waiting_remote', 'downloading') 的 Task
3. 对每条 Task：
   a. 如果 status = 'running'：
      - 本地任务：回退为 pending，重新执行
      - 远端任务且有 remoteTaskId：恢复为 waiting_remote，恢复轮询
      - 远端任务但无 remoteTaskId：回退为 pending，重新执行
   b. 如果 status = 'waiting_remote'：
      - 有 remoteTaskId：恢复轮询
      - 无 remoteTaskId：回退为 pending
   c. 如果 status = 'downloading'：
      - 回退为 pending，重新执行下载
4. 释放这些 Task 对应的逻辑锁（因为 worker 重启了，锁可能已失效）
5. 重新获取锁后继续执行
```

### 8.2 失败重试

#### 自动重试

以下错误自动重试（`retryCount < maxRetry` 时）：

- 网络超时
- 火山引擎 5xx 错误
- 下载失败
- 远端任务状态未知

自动重试时创建新的 Task 记录，`retryCount` 从原 Task 继承 + 1。原 Task 保留 `failed` 状态。

重试退避策略：

- 第 1 次重试：等待 5 秒
- 第 2 次重试：等待 15 秒
- 第 3 次重试：等待 30 秒

#### 手动重试

以下错误不自动重试，需要用户修正后手动触发：

- 提示词为空或格式错误
- 资产图缺失
- 视频参数不完整
- 模型返回内容解析失败（JSON 格式错误）

用户在前端点击"重试"按钮，服务层创建新的 Task 记录，`retryCount` 重置为 0。

### 8.3 失效重算

当上游变更时，下游不直接删除已有结果，而是标记为 `invalidated`：

```text
1. 上游变更（如台词修改）
2. 找到受影响的下游分镜
3. 设置 voiceState = 'invalidated', videoState = 'invalidated'
4. 推送失效事件到前端
5. 前端显示"需重新生成"标记
6. 用户手动点击"重新生成"触发新的 Task
```

失效规则详见各模块文档的"失效与重算规则"章节。

## 9. 进度事件流协议

### 9.1 事件格式

所有任务事件通过 Tauri 的 `emit` 推送到前端，事件名统一为 `task-event`：

```ts
// 事件 payload 就是 TaskEvent 类型
type TaskEvent =
  | { type: 'task_started'; taskId: string; taskType: TaskType }
  | { type: 'task_progress'; taskId: string; progress: number; message?: string }
  | { type: 'task_waiting_remote'; taskId: string; remoteTaskId: string }
  | { type: 'task_downloading'; taskId: string; progress: number }
  | { type: 'task_success'; taskId: string; outputJson?: string }
  | { type: 'task_failed'; taskId: string; errorMessage: string }
  | { type: 'task_canceled'; taskId: string }
  | { type: 'task_invalidated'; taskId: string; reason: string }
  // 系统级事件（非任务级）
  | { type: 'worker_crashed'; workerId: string; message: string }
  | { type: 'worker_restarted'; workerId: string; recoveredTasks: number }
  | { type: 'worker_failed'; message: string }
  | { type: 'quota_exhausted'; apiType: 'text' | 'image' | 'voice' | 'video'; message: string }
  | { type: 'quota_resumed'; apiType: 'text' | 'image' | 'voice' | 'video' };
```

### 9.2 前端订阅

```ts
// 前端统一订阅
const unsubscribe = await listen<TaskEvent>('task-event', (event) => {
  const payload = event.payload;
  // 根据 type 更新 UI
  switch (payload.type) {
    case 'task_started':
      // 显示"生成中"状态
      break;
    case 'task_progress':
      // 更新进度条
      break;
    case 'task_success':
      // 刷新业务数据
      queryClient.invalidateQueries({ queryKey: ['storyboard', payload.taskId] });
      break;
    case 'task_failed':
      // 显示错误信息和"重试"按钮
      break;
    case 'task_invalidated':
      // 显示"需重新生成"标记
      break;
    case 'worker_crashed':
      // 显示横幅："工作进程已重启，正在恢复任务..."
      break;
    case 'worker_restarted':
      // 移除崩溃横幅，显示"已恢复 N 个任务"
      break;
    case 'worker_failed':
      // 显示错误对话框："工作进程多次崩溃，请手动重启"
      break;
    case 'quota_exhausted':
      // 显示警告横幅："${apiType} 配额已用尽"
      break;
    case 'quota_resumed':
      // 移除配额警告横幅
      break;
  }
});
```

### 9.3 批量任务进度

对于批量操作（如批量生图、批量生成视频），每个子任务各自推送事件。前端聚合显示总进度：

```ts
// 前端聚合
const totalTasks = batchTaskIds.length;
const completedTasks = batchTaskIds.filter(id => taskStatus[id] === 'success').length;
const progress = (completedTasks / totalTasks) * 100;
```

## 10. 模型结果缓存策略

### 10.1 设计原则

所有调用火山引擎 API 的任务（文本模型、图像模型、语音 TTS、视频生成）的结果都应缓存。相同输入参数重复调用时，优先读取缓存，跳过远端请求。

### 10.2 缓存键

缓存键由任务类型和输入参数的哈希值组成：

```text
cacheKey = hash(taskType + 关键参数)
```

各任务的缓存键参数：
- split_script_source: hash(sourceText + mode + model)
- generate_clip_script: hash(clipId + sourceText + mode + model)
- generate_asset_image: hash(assetId + prompt + referenceImages + imageParam + model)
- generate_storyboards: hash(clipId + sourceText + scriptSummary + model)
- generate_storyboard_image: hash(storyboardId + imagePrompt + imageParam + model)
- generate_storyboard_voice: hash(storyboardId + dialogue + voiceId + voiceParam + model)
- generate_storyboard_video: hash(storyboardId + videoPrompt + videoParam + mode + model)

### 10.3 缓存存储

缓存文件存储在 `cache/model-results/` 目录下，文件名为 `{cacheKey}.json`（文本类结果）或 `{cacheKey}.{ext}`（媒体类结果）。

### 10.4 缓存生命周期

- **有效期**：24 小时。超过 24 小时的缓存文件在应用启动时自动清理。
- **失效条件**：用户手动修改了输入参数（如编辑了 prompt、更换了参考图），缓存自动失效。
- **手动清除**：用户可在设置页面一键清除所有模型结果缓存。
- **缓存命中时**：任务直接标记为 `success`，outputJson 指向缓存文件路径，不调用远端 API。

### 10.5 不缓存的场景

- 导出任务（export_project_video）：纯本地 FFmpeg 操作，无需缓存。
- 本地语音导入（import_storyboard_voice）：纯本地文件操作，无需缓存。
- 重新生成（用户主动选择"重新生成"）：跳过缓存，强制调用远端 API。

## 11. 任务日志

### 11.1 日志内容

每个任务都必须保存以下信息到 SQLite（Task 表的 inputJson / outputJson / errorMessage 字段）和文件系统：

| 字段 | 存储位置 | 说明 |
|------|----------|------|
| 输入参数 | Task.inputJson | 任务创建时的完整输入 |
| 模型请求参数 | 日志文件 | 发送给火山引擎的实际请求体 |
| 远端任务 ID | Task.remoteTaskId | 火山引擎返回的任务标识 |
| 轮询记录 | 日志文件 | 每次轮询的时间、状态、响应摘要 |
| 结果摘要 | Task.outputJson | 任务完成后的输出 |
| 错误堆栈 | Task.errorMessage + 日志文件 | 失败时的完整错误信息 |
| 重试次数 | Task.retryCount | 已重试次数 |

### 11.2 日志文件格式

```text
logs/tasks/{taskId}.log
```

每个任务一个日志文件，内容格式：

```text
[2026-06-29T10:00:00] [START] task=abc123 type=generate_asset_image input={"assetId":"...","prompt":"..."}
[2026-06-29T10:00:01] [REQ] POST /api/v1/images/generate body={"model":"...","prompt":"..."}
[2026-06-29T10:00:02] [RESP] {"taskId":"remote-xxx","status":"processing"}
[2026-06-29T10:00:07] [POLL] remoteTaskId=remote-xxx status=processing
[2026-06-29T10:00:12] [POLL] remoteTaskId=remote-xxx status=done url=https://...
[2026-06-29T10:00:13] [DOWNLOAD] from=https://... to=assets/characters/abc-main.png
[2026-06-29T10:00:14] [SUCCESS] output={"imagePath":"assets/characters/abc-main.png"}
```

### 11.3 日志清理

日志文件保留 7 天。worker 启动时清理超过 7 天的日志文件：

```sql
-- SQLite 中删除超过 7 天的已完成/失败任务记录
DELETE FROM tasks
WHERE status IN ('success', 'failed', 'canceled')
  AND finished_at < datetime('now', '-7 days');
```

## 12. 接口定义

### 12.1 Tauri IPC 命令

```ts
// 查询任务状态
getTask(input: { taskId: string }): Promise<Task | null>

// 查询项目的任务列表
listTasks(input: {
  projectId: string;
  type?: TaskType;
  status?: TaskStatus;
  limit?: number;
}): Promise<Task[]>

// 取消任务
cancelTask(input: { taskId: string }): Promise<void>

// 手动重试任务
retryTask(input: { taskId: string }): Promise<{ newTaskId: string }>

// 清理过期任务
cleanupTasks(input: { projectId: string }): Promise<{ cleaned: number }>
```

### 12.2 worker 通信协议

Tauri 主进程与 Node worker 之间通过 stdio 通信，消息格式为 JSON。每条消息必须包含 `version` 字段用于协议版本校验。

```ts
// 协议版本号，当前为 1。不兼容的版本号应拒绝连接。
const PROTOCOL_VERSION = 1;

// 主进程 → worker（通过 stdin 写入）
type WorkerCommand =
  | { version: number; cmd: 'enqueue'; taskId: string }
  | { version: number; cmd: 'cancel'; taskId: string }
  | { version: number; cmd: 'shutdown'; timeoutMs: number }  // 优雅退出，worker 在 timeoutMs 内完成当前任务后退出
  | { version: number; cmd: 'ping' };                         // 健康检查请求

// worker → 主进程（通过 stdout 输出）
type WorkerMessage =
  | { version: number; msg: 'ready'; workerId: string; protocolVersion: number }      // 启动完成握手
  | { version: number; msg: 'heartbeat'; workerId: string; activeTasks: number }      // 心跳，每 10 秒一次
  | { version: number; msg: 'task_event'; event: TaskEvent }
  | { version: number; msg: 'batch_progress'; batchId: string; total: number; completed: number; failed: number }
  | { version: number; msg: 'quota_exhausted'; apiType: 'text' | 'image' | 'voice' | 'video'; message: string }
  | { version: number; msg: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { version: number; msg: 'error'; message: string; stack?: string; taskId?: string }  // 未捕获异常
  | { version: number; msg: 'shutting_down'; pendingTasks: number };                      // 确认收到 shutdown
```

**协议校验要求：**

1. 收到消息后必须用 zod 或 ajv 校验 schema，格式不符的消息直接丢弃并记录日志。
2. `version` 不匹配时：worker 发送 `{"msg":"error","message":"protocol version mismatch"}` 并退出；Tauri 侧提示用户更新应用。
3. worker 收到无法解析的 `cmd` 时：回复 `{"msg":"error","message":"unknown command: ..."}`，不退出。
4. Tauri 侧收到 `msg: 'error'` 时：记录日志，如果 `taskId` 存在则标记该任务为 `failed`。

## 13. 最低落地清单

1. `tasks` 表和 `task_locks` 表的 SQLite DDL
2. `TaskType` 和 `TaskStatus` 类型定义
3. worker 进程的启动和 stdio 通信（含启动握手协议 3.2.2）
4. 任务入队器（IPC 命令 → 写 Task → 通知 worker）
5. worker 核心循环（取 pending → 检查限流 → 获取锁 → 执行 → 回写 → 释放锁）
6. `TaskHandler` 接口和至少一个 handler 实现
7. 逻辑锁的获取、释放、超时清理
8. 进度事件流的 emit + 前端 listen
9. 重启恢复扫描逻辑
10. 自动重试 + 手动重试机制
11. 失效标记引擎（标记 invalidated + 推送事件）
12. 任务日志文件写入和清理
13. Sidecar 生命周期管理：启动握手、心跳检测、崩溃重启、优雅退出（见 3.2.2）
14. `RateLimiter` 实现：令牌桶限流、429 退避重试、配额耗尽暂停（见 7.5）
15. stdio 协议版本校验和 schema 校验（zod / ajv）
