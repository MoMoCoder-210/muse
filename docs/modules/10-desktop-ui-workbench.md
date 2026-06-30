# 模块 10：桌面端页面与工作台

这份文档按当前前端实现来写，不再把完整三栏工作台当成已经开发完成。

## 1. 当前页面结构

当前页面代码集中在：

- [src/App.tsx](D:/xm/backend/desktop-lite/src/App.tsx)
- [src/styles.css](D:/xm/backend/desktop-lite/src/styles.css)
- [src/config/muse.ts](D:/xm/backend/desktop-lite/src/config/muse.ts)

当前只有两级主视图：

1. 首页 `home`
2. 项目管理页 `projects`

## 2. 首页

首页是当前已经可操作的 Tauri 起始页。

### 2.1 页面内容

- 动态背景画布
- 中央品牌区 `Muse`
- `创建项目` 按钮
- `项目管理` 按钮
- 版本号展示

### 2.2 交互

- 点击 `创建项目`：打开创建项目弹窗
- 点击 `项目管理`：切换到项目管理页

## 3. 项目管理页

项目管理页当前是“项目入口 + 工作区骨架”。

### 3.1 左侧栏

当前包含：

- `Muse` 标题
- 返回首页按钮
- 创建项目按钮
- 刷新列表按钮
- 项目列表

项目列表每项显示：

- 项目名
- 项目状态
- 项目描述
- 工作区路径

### 3.2 右侧工作区

当前显示：

- 项目名
- 项目描述
- 当前步骤
- 项目状态
- 工作区路径
- 创建时间
- 一条流程步骤板
- 两个说明性占位面板

当前这部分还是工作区骨架，不是完整生产工作台。

## 4. 创建项目弹窗

### 4.1 当前字段

- 项目名
- 项目目录
- 创建模式
- 创作风格

### 4.2 当前交互

- 关闭方式
  - 点击右上角关闭按钮
  - 点击遮罩
  - 点击取消按钮
- 项目目录
  - 可手填
  - 可打开目录选择器
- 创建模式
  - `手动`
  - `剧本`
- 创作风格
  - 自定义下拉
  - 选项为 `国漫 / 动漫 / 日漫 / 韩漫 / 二次元 / 真人`

### 4.3 当前视觉状态

当前弹窗已经完成这些样式调整：

- 统一按钮体系
- 右上角简化关闭按钮
- 透明度降低，面板更实
- 创作风格下拉改为自定义组件
- 选项 hover 颜色可控

## 5. 当前前端状态模型

当前 `App.tsx` 使用本地状态管理页面：

```ts
view: "home" | "projects"
projects: ProjectInfo[]
selectedProjectId: string
createModalOpen: boolean
projectName: string
projectDescription: string
projectDirectory: string
createMode: CreateMode
styleMode: StyleMode
styleMenuOpen: boolean
```

目前还没有拆到：

- Query hooks
- Zustand store
- 页面级组件目录

这意味着当前页面是一个“可运行的起始壳”，不是最终结构。

## 6. 当前与规划稿的差异

原先规划中的这些内容目前还未落地：

- 三栏完整工作台
- 片段树
- 分镜列表
- 右侧任务中心
- Query 层封装
- Zustand 工作台状态仓库
- 事件流任务订阅
- 日志中心
- 导出页

因此在继续开发时，文档应按下面的节奏推进，而不是一次性照完整大图铺开。

## 7. 建议的前端拆分顺序

建议下一步按这个顺序拆：

1. `AppShell`
2. `HomePage`
3. `ProjectManagementPage`
4. `CreateProjectModal`
5. `ProjectList`
6. `ProjectWorkspaceSummary`
7. `WorkflowBoard`
8. `src/types`
9. `src/services/tauri`
10. `src/stores` 或 `src/hooks`

这样做的好处是：

- 先把当前大组件拆小
- 再接项目模块接口
- 后面追加片段 / 分镜 / 任务区时不会继续堆回 `App.tsx`

## 8. 当前可直接开发的下一步

如果继续沿当前代码往下做，优先级建议是：

1. 项目详情页结构拆组件
2. 增加 `open_project`
3. 增加剧本导入入口
4. 增加项目设置面板
5. 为 `script` 模式补充剧本输入方式
6. 接入模块 02 的片段拆分页

这样能从现在这个起始壳平滑走向真正的工作台。
