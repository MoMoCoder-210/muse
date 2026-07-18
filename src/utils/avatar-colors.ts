/**
 * 片段序号头像色调 — 循环 6 色方案。
 * 用于 rail-clips-item-num 和 clip-index-avatar 的 inline style 注入。
 */
export const AVATAR_COLORS = [
  { bg: "rgba(0,122,255,0.18)",  text: "#007aff" },
  { bg: "rgba(255,149,0,0.18)",  text: "#ff9500" },
  { bg: "rgba(175,82,222,0.18)", text: "#af52de" },
  { bg: "rgba(255,69,58,0.18)",  text: "#ff453a" },
  { bg: "rgba(48,209,88,0.18)",  text: "#30d158" },
  { bg: "rgba(90,200,250,0.18)", text: "#5ac8fa" },
] as const;

/** 根据片段序号（从 1 开始）返回对应的头像颜色 */
export function avatarColor(index: number): { bg: string; text: string } {
  return AVATAR_COLORS[(index - 1) % AVATAR_COLORS.length];
}
