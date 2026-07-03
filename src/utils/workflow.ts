/**
 * 将 projects.current_step 映射到阶段索引（表示"已进展到哪一步"）。
 *
 * @param step 工作流步骤名称
 * @returns 对应的索引；未知步骤返回 0
 * @author yt @date 20260703
 */
export function stepToIndex(step: string): number {
  switch (step) {
    case "project":
    case "split":
    case "script":
      return 0;
    case "asset":
      return 1;
    case "storyboard":
      return 2;
    case "voice":
    case "video":
      return 3;
    case "export":
      return 4;
    default:
      return 0;
  }
}
