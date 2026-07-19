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
  { label: "默认", value: CREATE_MODES.manual },
  { label: "剧本", value: CREATE_MODES.script },
] as const;

export const STYLE_OPTIONS = ["国漫", "动漫", "日漫", "韩漫", "二次元", "真人"] as const;
export type StyleMode = (typeof STYLE_OPTIONS)[number];

/** 风格名称 → 图片生成提示词值 映射 */
export const STYLE_VALUE_MAP: Record<StyleMode, string> = {
  国漫: "国漫风，二次元画风",
  动漫: "动漫画风",
  日漫: "日漫画风，日本动漫风",
  韩漫: "韩国动漫画风",
  二次元: "二次元画风",
  真人: "真人风格，写实风格",
};

/**
 * 风格名称 → 视频生成前缀提示词映射
 *
 * 在大模型返回分镜存库时，自动拼接到 video_prompt 头部，
 * 并追加到 video_prompt 末尾的"画面风格"说明行。
 * 格式：{ prefix: 视频开头风格描述, suffix: 末尾画面风格说明 }
 */
export const VIDEO_STYLE_PROMPT_MAP: Record<StyleMode, { prefix: string; suffix: string }> = {
  国漫: {
    prefix: "国漫动画风格，流畅手绘线条，鲜艳色彩，电影感光影。",
    suffix: "画面风格：国漫动画，流畅线条，鲜艳色彩，电影感光影，2K高清，视频无任何字幕。",
  },
  动漫: {
    prefix: "动漫风格，精致手绘，细腻色彩，电影感光影。",
    suffix: "画面风格：动漫，精致手绘，细腻色彩，电影感光影，2K高清，视频无任何字幕。",
  },
  日漫: {
    prefix: "日本动漫风格短剧片段，赛璐璞上色，电影感光影。",
    suffix: "画面风格：日本动漫，赛璐璞上色，精致线条，电影感光影，2K高清，视频无任何字幕。",
  },
  韩漫: {
    prefix: "韩国动漫风格，简洁线条，柔和色调，电影感光影。",
    suffix: "画面风格：韩国动漫，简洁线条，柔和色调，电影感光影，2K高清，视频无任何字幕。",
  },
  二次元: {
    prefix: "二次元日系动漫风格短剧片段，赛璐璞上色，电影感光影。",
    suffix: "画面风格：二次元日系动漫，赛璐璞上色，精致线条，电影感光影，2K高清，视频无任何字幕。",
  },
  真人: {
    prefix: "真人电影风格，背景虚化，浅景深，电影感光影。",
    suffix: "画面风格：真人电影，背景虚化，浅景深，电影感光影，2K高清，视频无任何字幕。",
  },
};

/**
 * 工作流阶段定义。
 *
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
 */
/** API 请求使用的标准分辨率值；Worker 同时兼容历史存储的 420/720/1080。 */
export const VIDEO_RESOLUTION_OPTIONS = ["480p", "720p", "1080p", "2k", "4k"] as const;
export const VIDEO_DURATION_MIN = 4;
export const VIDEO_DURATION_MAX = 15;
export const VIDEO_ASPECT_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;

// 默认值仅作回退；实际模型 / 分辨率以用户在设置中的配置为准。
export const VIDEO_DEFAULT_MODEL = "";
export const VIDEO_DEFAULT_DURATION = 5;
export const VIDEO_DEFAULT_RESOLUTION = "720p";
export const VIDEO_DEFAULT_ASPECT = "16:9";
