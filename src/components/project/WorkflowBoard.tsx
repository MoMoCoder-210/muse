import { WORKFLOW_STEPS } from "../../config/muse";

type WorkflowBoardProps = {
  currentStep: string;
  /** 禁止点击的阶段索引集合（null 表示加载中，空 set 表示全部可用） */
  disabledSteps?: Set<number> | null;
};

/**
 * 将 projects.current_step（英文标识）映射到工作流阶段索引。
 *
 * 映射规则（WORKFLOW_STEPS 的 id 即阶段标识）：
 *   project / split / script  → 0（剧本管理进行中：导入→拆分→看片段）
 *   asset                     → 1（资产管理进行中）
 *   storyboard                → 2（分镜编辑进行中）
 *   voice / video             → 3（视频编辑进行中）
 *   export                    → 4（视频合成进行中）
 *   未知值                    → 0（保守归到第一阶段）
 *
 * 返回的是"当前正在进行的阶段索引"。
 *
 * @author yt @date 20260702 修复中文 label 与英文 step 不匹配导致步骤板全灰；修复 script 误映射
 */
function stepToStageIndex(current: string): number {
  switch (current) {
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

export function WorkflowBoard({ currentStep, disabledSteps }: WorkflowBoardProps) {
  const activeIndex = stepToStageIndex(currentStep);
  const ds = disabledSteps ?? new Set<number>();

  return (
    <div className="workflow-board">
      {WORKFLOW_STEPS.map((step, index) => {
        const state =
          index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
        const disabled = ds.has(index);
        return (
          <div
            key={step.id}
            className={`workflow-step workflow-step--${state}${disabled ? " workflow-step--disabled" : ""}`}
            onClick={() => {
              if (disabled) return;
              // TODO: 切换到对应工作流页面
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (disabled) return;
                // TODO: 切换到对应工作流页面
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
