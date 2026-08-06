/**
 * 安全策略：工具权限判定与确认流程规则
 */
import type { ToolCategory, ToolPermission } from "../../types/agent";

/** 根据类别判定权限级别 */
export function categoryPermission(category: ToolCategory): ToolPermission {
  switch (category) {
    case "查询":
      return "auto";
    case "删除":
      return "danger";
    default:
      return "confirm";
  }
}

/** 是否需要用户确认 */
export function needConfirm(permission: ToolPermission): boolean {
  return permission !== "auto";
}

/** 是否需要二次确认（危险操作） */
export function needDangerConfirm(permission: ToolPermission): boolean {
  return permission === "danger";
}
