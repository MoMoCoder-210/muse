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
  "剧本管理",
  "资产管理",
  "分镜编辑",
  "视频编辑",
  "视频合成",
] as const;
