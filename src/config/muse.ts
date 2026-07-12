export const APP_NAME = "Muse";
// 默认项目根目录留空，由后端在创建项目时回退到应用数据目录下的默认路径，
// 避免硬编码平台相关绝对路径（如 D:\projects）在非目标环境下失效。
export const DEFAULT_PROJECT_ROOT = "";

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

/** 风格名称 → 提示词值 映射 */
export const STYLE_VALUE_MAP: Record<StyleMode, string> = {
  国漫: "国漫风格",
  动漫: "动漫风格",
  日漫: "日本动漫风格",
  韩漫: "韩国动漫风格",
  二次元: "二次元动画风格",
  真人: "真人写真风格",
};

/**
 * 工作流阶段定义。
 *
 * @author yt @date 20260702
 */
export const WORKFLOW_STEPS = [
  { id: "script", label: "片段管理" },
  { id: "asset", label: "资产管理" },
  { id: "storyboard", label: "分镜管理" },
  { id: "video", label: "视频编辑" },
] as const;

export type WorkflowStepId = (typeof WORKFLOW_STEPS)[number]["id"];

/**
 * 视频分辨率选项 — 用户在设置页按模型配置「支持的分辨率」。
 *
 * 分镜页选择某模型后，分辨率下拉仅渲染该模型在设置里配置支持的分辨率。
 *
 * @author yt @date 20260712
 */
export const VIDEO_RESOLUTION_OPTIONS = ["420", "720", "1080", "2k", "4k"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTION_OPTIONS)[number];

export const VIDEO_DURATION_MIN = 4;
export const VIDEO_DURATION_MAX = 15;
export const VIDEO_ASPECT_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;

// 默认值仅作回退；实际模型 / 分辨率以用户在设置中的配置为准。
export const VIDEO_DEFAULT_MODEL = "";
export const VIDEO_DEFAULT_DURATION = 5;
export const VIDEO_DEFAULT_RESOLUTION = "720";
export const VIDEO_DEFAULT_ASPECT = "16:9";
