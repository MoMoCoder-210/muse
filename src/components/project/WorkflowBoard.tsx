import { WORKFLOW_STEPS } from "../../config/muse";
import { stepToIndex } from "../../utils/workflow";

type WorkflowBoardProps = {
  /** 后台记录的进度（拆解完成后推进） */
  progressStep: string;
  /** 用户当前选中查看的阶段索引 */
  activeIndex: number;
  /** 禁止点击的阶段索引集合 */
  disabledSteps?: Set<number> | null;
  /** 点击 tab 切换到对应阶段 */
  onStepClick?: (index: number) => void;
};

/**
 * 工作流步骤导航板
 *
 * 显示 4 个工作流步骤，区分进度状态、选中状态和禁用状态。
 *
 */
export function WorkflowBoard({ progressStep, activeIndex, disabledSteps, onStepClick }: WorkflowBoardProps) {
  const progress = stepToIndex(progressStep);
  const ds = disabledSteps ?? new Set<number>();

  return (
    <div className="workflow-board">
      {WORKFLOW_STEPS.map((step, index) => {
        const state =
          index === activeIndex ? "active" : index < progress ? "done" : "pending";
        const disabled = ds.has(index);
        return (
          <div
            key={step.id}
            className={`workflow-step workflow-step--${state}${disabled ? " workflow-step--disabled" : ""}`}
            onClick={() => {
              if (disabled) return;
              onStepClick?.(index);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (disabled) return;
                onStepClick?.(index);
              }
            }}
            role="button"
            tabIndex={disabled ? -1 : 0}
            title={disabled ? "尚未有片段完成拆解，无法进入" : `前往「${step.label}」`}
          >
            <span className="workflow-step-index">{index + 1}</span>
            <span className="workflow-step-label">{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}
