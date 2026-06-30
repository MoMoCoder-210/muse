import { WORKFLOW_STEPS } from "../../config/muse";

type WorkflowBoardProps = {
  currentStep: string;
};

function compareStep(current: string, target: string): boolean {
  const steps = WORKFLOW_STEPS as readonly string[];
  const currentIndex = steps.indexOf(current);
  const targetIndex = steps.indexOf(target);
  if (currentIndex === -1 || targetIndex === -1) return false;
  return targetIndex <= currentIndex;
}

export function WorkflowBoard({ currentStep }: WorkflowBoardProps) {
  return (
    <div className="workflow-board">
      {WORKFLOW_STEPS.map((step) => (
        <div
          key={step}
          className={`workflow-step ${compareStep(currentStep, step) ? "done" : ""}`}
        >
          <span>{step}</span>
        </div>
      ))}
    </div>
  );
}
