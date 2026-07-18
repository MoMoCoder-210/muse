import { WORKFLOW_STEPS } from "../../config/muse";

type WorkflowBoardProps = {
  /** 用户当前选中查看的阶段索引 */
  activeIndex: number;
  /** 禁止点击的阶段索引集合 */
  disabledSteps?: Set<number> | null;
  /** 点击 tab 切换到对应阶段 */
  onStepClick?: (index: number) => void;
};

/**
 * 工作流步骤导航 — macOS Segmented Control 风格
 *
 * 水平排列的圆角胶囊条，选中项带滑块高亮效果。
 */
export function WorkflowBoard({ activeIndex, disabledSteps, onStepClick }: WorkflowBoardProps) {
  const ds = disabledSteps ?? new Set<number>();

  return (
    <div className="workflow-board" role="tablist" aria-label="工作流导航">
      {WORKFLOW_STEPS.map((step, index) => {
        const isActive = index === activeIndex;
        const disabled = ds.has(index);
        return (
          <button
            key={step.id}
            className={`workflow-segment${isActive ? " workflow-segment--active" : ""}${disabled ? " workflow-segment--disabled" : ""}`}
            role="tab"
            aria-selected={isActive}
            aria-disabled={disabled}
            tabIndex={isActive && !disabled ? 0 : -1}
            title={disabled ? "尚未有片段完成拆解，无法进入" : `前往「${step.label}」`}
            onClick={() => {
              if (disabled || isActive) return;
              onStepClick?.(index);
            }}
          >
            <span className="workflow-segment-label">{step.label}</span>
          </button>
        );
      })}
    </div>
  );
}
