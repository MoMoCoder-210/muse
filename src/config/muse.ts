export const APP_NAME = "Muse";
export const DEFAULT_PROJECT_ROOT = "D:\\projects";

export const CREATE_MODES = {
  manual: "manual",
  script: "script",
} as const;

export type CreateMode = (typeof CREATE_MODES)[keyof typeof CREATE_MODES];

export const CREATE_MODE_OPTIONS = [
  { label: "手动", value: CREATE_MODES.manual },
  { label: "剧本", value: CREATE_MODES.script },
] as const;

export const STYLE_OPTIONS = ["国漫", "动漫", "日漫", "韩漫", "二次元", "真人"] as const;
export type StyleMode = (typeof STYLE_OPTIONS)[number];

export const WORKFLOW_STEPS = [
  "剧本导入",
  "自动拆分镜",
  "角色场景物品图生成",
  "分镜编辑",
  "融合生成分镜图",
  "视频生成/编辑",
  "导出交付",
] as const;
