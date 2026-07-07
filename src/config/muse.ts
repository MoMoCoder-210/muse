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

/** 风格名称 → 提示词值 映射 */
export const STYLE_VALUE_MAP: Record<StyleMode, string> = {
  国漫: "中国风动画美学风格",
  动漫: "动画美学美学风格",
  日漫: "日本动画美学风格",
  韩漫: "韩国动画美学风格",
  二次元: "二次元动画风格",
  真人: "真人写真风格",
};

/**
 * 工作流阶段定义。
 *
 * id 对应 projects.current_step 的英文标识（部分聚合到同一阶段），
 * label 为 UI 展示中文。
 *
 * 阶段索引与 current_step 的映射见 utils/workflow.stepToIndex。
 *
 * @author yt @date 20260702 改为 {id,label} 结构，解决中英文不匹配导致步骤板全灰
 */
export const WORKFLOW_STEPS = [
  { id: "script", label: "剧本管理" },
  { id: "asset", label: "资产管理" },
  { id: "storyboard", label: "分镜编辑" },
  { id: "video", label: "视频编辑" },
  { id: "export", label: "视频合成" },
] as const;

export type WorkflowStepId = (typeof WORKFLOW_STEPS)[number]["id"];
