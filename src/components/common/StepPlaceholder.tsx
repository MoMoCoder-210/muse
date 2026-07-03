import { WORKFLOW_STEPS } from "../../config/muse";

type StepPlaceholderProps = {
  stepIndex: number;
  projectName: string;
};

/**
 * 尚未实现的工作流阶段占位页面。
 * 后续实现对应阶段时将替换为实际组件。
 *
 * @author yt @date 20260703
 */
export function StepPlaceholder({ stepIndex, projectName }: StepPlaceholderProps) {
  const step = WORKFLOW_STEPS[stepIndex];
  return (
    <div className="step-placeholder">
      <h2>{step?.label ?? "未知阶段"}</h2>
      <p>
        项目「{projectName}」的 {step?.label ?? "该阶段"} 功能正在开发中，敬请期待。
      </p>
    </div>
  );
}
