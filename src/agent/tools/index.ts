/**
 * 工具入口：统一导出 + 触发副作用注册
 *
 * 导入此文件即完成全部 Tool 的自注册。
 * 后续 Phase 2 追加创建/修改/删除类 Tool 文件并在此处导入。
 */
export { getTool, loadSchema, buildCandidates } from "./registry";
export { searchCandidates, loadSchemas, visibleTools, estimateTokens, exceedsBudget } from "./search";
export type { ToolDef } from "./registry";

// 触发副作用：自动注册全部 Tool
import "./query";
