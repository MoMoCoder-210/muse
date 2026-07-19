# Muse 项目开发规范

> 版本：1.0 | 更新日期：2026-07-03

---

## 1. 项目结构

```
Muse/
├── src/                          # 前端（React + TypeScript + Vite）
│   ├── components/
│   │   ├── common/               # 通用组件
│   │   ├── home/                 # 首页组件
│   │   ├── layout/               # 布局组件
│   │   ├── project/              # 项目管理组件
│   │   └── settings/             # 设置页组件
│   ├── config/                   # 配置文件
│   ├── hooks/                    # 自定义 Hook
│   ├── services/                 # 服务层
│   ├── styles/                   # 样式文件（按组件/功能拆分）
│   ├── types/                    # TypeScript 类型定义
│   ├── utils/                    # 工具函数
│   ├── styles.css                # 样式入口
│   └── App.tsx                   # 应用入口
│
├── src-tauri/src/                # 后端（Rust + Tauri）
│   ├── commands/                 # Tauri 命令（按领域拆分）
│   │   ├── mod.rs
│   │   ├── util.rs               # 共享工具函数
│   │   ├── project.rs            # 项目 CRUD
│   │   ├── clip.rs               # 片段管理
│   │   ├── script.rs             # 剧本拆解
│   │   └── settings.rs           # 设置管理
│   ├── db.rs                     # 数据库初始化
│   ├── sidecar.rs                # Worker 进程管理
│   ├── project_log.rs            # 项目日志
│   ├── app_paths.rs              # 路径解析
│   ├── lib.rs                    # 应用入口
│   └── main.rs                   # 桌面入口
│
├── worker/src/                   # Worker 进程（TypeScript + Node.js）
│   ├── handlers/                 # 任务处理器
│   ├── utils/                    # 工具函数
│   ├── config/                   # 配置
│   ├── prompts/                  # LLM 提示词模板
│   ├── db.ts                     # 数据库操作
│   ├── task-runner.ts            # 任务调度器
│   ├── settings-manager.ts       # 设置管理
│   ├── rate-limiter.ts           # 速率限制
│   └── index.ts                  # Worker 入口
│
└── migrations/                   # 数据库迁移脚本
```

---

## 2. 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 组件 | PascalCase 文件 + PascalCase 导出 | `ClipListPanel.tsx` |
| Hook | `use` + PascalCase | `useClipPolling.ts` |
| 服务/工具/类型/样式 | kebab-case，与功能对应 | `import-script.ts`、`clip-list.css` |
| Rust 模块/函数 | snake_case | `project.rs`、`create_project()` |
| TS 变量/函数 | camelCase | `selectedId`、`handleCreate()` |
| TS 常量 | UPPER_SNAKE_CASE | `STATUS_LABEL` |
| TS 类型/接口 | PascalCase | `ProjectInfo`、`Props` 命名为 `{Name}Props` |
| 未使用参数 | `_` 前缀 | `_onProjectUpdated` |
| CSS 类名 | kebab-case | `clip-list-panel` |
| CSS 变量 | `--` + kebab-case | `--spacing-md` |

---

## 3. 注释规范

- 所有注释使用**中文**
- 文件头 + 公共函数均需 JSDoc/`///`：

```typescript
/**
 * 功能简述。
 *
 * @param name 参数说明
 * @returns 返回值说明
 * @author yt @date 20260703（当天日期）
 */
```

```rust
/// 功能简述
///
/// @author yt @date 20260703（当天日期）
pub fn create_project(...) -> ... { }
```

---

## 4. 样式规范

- 所有颜色、圆角、间距、字号使用 `tokens.css` / `theme.ts` 中的 CSS 变量，**禁止硬编码 `px`**
- 一个组件一个 CSS 文件，`src/styles.css` 中 `@import` 汇总
- 内联 `style` 仅限 `visibility` / `position` 等布局控制，不写像素值

| 类别 | 可用变量 |
|------|---------|
| 颜色 | `--text-*`、`--bg-*`、`--border-*`、`--accent-*` |
| 圆角 | `--radius-sm/md/lg/xl/2xl/full`（4/6/8/10/12/999px） |
| 间距 | `--spacing-xs/sm/md/lg/xl/2xl/3xl`（4→32px） |
| 字体 | `--font-size-xs/sm/base/lg/xl/section` |

---

## 5. 组件规范

- 单个组件 ≤ **300 行**，超出提取子组件或 Hook
- 标准骨架：`imports → Props 类型 → 常量 → 组件函数`
- 异步操作必须 `try/catch`，catch 中 `toast()` 提示用户
- **禁止** `console.error`，前端统一用 `useToast()`

---

## 6. 服务层 & Hook

- IPC 调用封装在 `services/tauri.ts`，组件不直接调 `invoke()`
- 跨组件复用的业务逻辑抽到独立 `services/*.ts` 文件
- 通用 Hook 放 `src/hooks/`，所有 API 函数禁 `any`

---

## 7. Worker 规范

- 一个 handler 对应一种任务类型，只做业务，不直接改实体状态
- 实体状态由 `task-runner` 通过 `transitionEntityStatus()` 统一管理
- 日志用 `l()` / `lw()` / `le()`，**禁止**打印完整模型输出
- 绝对路径只输出最后两段（如 `data/muse.db`）

---

## 8. Rust 规范

- 业务事件日志 → `project_log::append_log()`（唯一入口）
- 系统级事件（进程启停）→ `log::info!()`
- 同一条消息禁止同时写两种日志
- SQL 使用参数化查询，禁止字符串拼接

---

## 9. 提交检查清单

- [ ] `npx tsc --noEmit` / `worker npm run build` / `cargo check` 通过
- [ ] 无 `console.error` / 无 CSS 硬编码 `px` / 无 `any` 类型
- [ ] 公共函数有 JSDoc/`///` 注释
- [ ] 异步操作有 try/catch + toast
- [ ] 日志无敏感信息（绝对路径、完整模型输出）
