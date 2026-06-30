# 模块实现文档索引

这组文档按"拿到就能开发"的标准来写，每个模块都包含以下内容：

- 模块职责
- 设计约束（从业务规律提炼，以新架构表述）
- 数据结构（TypeScript 类型定义）
- 详细流程（任务流转的完整步骤）
- 接口定义（Tauri IPC 命令 + 前端查询接口）
- 校验规则（前置校验 + 后置校验）
- 失效与重算规则（上游变更对下游的影响）
- 异常和恢复策略
- UI 交互要求
- 最低落地清单

模块列表：

1. [项目与工作区模块](./01-project-and-workspace.md)
2. [剧本导入与片段拆分模块](./02-script-import-and-clip-splitting.md)
3. [剧本理解与资源抽取模块](./03-script-generation-and-resource-extraction.md)
4. [资产管理与资产生图模块](./04-asset-management-and-image-generation.md)
5. [分镜生成与分镜编辑模块](./05-storyboard-generation-and-editing.md)
6. [语音生成模块](./06-voice-generation.md)
7. [视频生成与导出模块](./07-video-generation-and-export.md)
8. [任务运行时与状态恢复模块](./08-task-runtime-state-and-recovery.md)
9. [数据存储与文件布局模块](./09-data-schema-and-local-storage.md)
10. [桌面端页面与交互工作台模块](./10-desktop-ui-workbench.md)

建议先阅读模块 08（任务运行时）和模块 09（数据存储），它们定义了所有模块共用的基础设施：统一任务模板、状态机、逻辑锁、SQLite 表结构和 JSON 字段规范。其余模块按 01-07 和 10 的顺序阅读，对应从项目创建到导出的主链路。
