import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { getProject, getScriptSource, getClipScripts } from "../../services/tauri";
import { WorkflowBoard } from "./WorkflowBoard";
import { ScriptImportPanel } from "./ScriptImportPanel";
import { ClipListPanel } from "./ClipListPanel";
import type { ClipScriptInfo } from "../../types/project";
import { StepPlaceholder } from "./StepPlaceholder";

type ProjectWorkspaceProps = {
  project: ProjectInfo | null;
  onProjectUpdated: (project: ProjectInfo) => void;
};

export function ProjectWorkspace({ project, onProjectUpdated }: ProjectWorkspaceProps) {
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[] | null>(null);
  const [activeStep, setActiveStep] = useState(0);

  // 切项目时重置选中 tab
  useEffect(() => {
    setActiveStep(0);
  }, [project?.id]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    getClipScripts(project.id).then((cs) => {
      if (!cancelled) setClipScripts(cs);
    }).catch(() => {
      if (!cancelled) setClipScripts([]);
    });
    return () => { cancelled = true; };
  }, [project?.id]);

  // 拆解进行中时轮询
  useEffect(() => {
    if (!project) return;
    const timer = setInterval(() => {
      getClipScripts(project.id).then(setClipScripts).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [project?.id]);

  // 计算禁用步骤：没有拆解成功的片段时，步骤1（资产管理）及以上全部禁用
  let disabledSteps: Set<number> | null = null;
  if (clipScripts !== null) {
    const anyDisassembled = clipScripts.some((cs) => cs.status === "success");
    disabledSteps = new Set<number>();
    if (!anyDisassembled) {
      for (let i = 1; i <= 4; i++) disabledSteps.add(i);
    }
  }

  if (!project) {
    return (
      <div className="empty-workspace">
        <h2>选择或创建一个项目开始工作</h2>
      </div>
    );
  }

  return (
    <div className="workspace-inner">
      <WorkflowBoard
        progressStep={project.current_step}
        activeIndex={activeStep}
        disabledSteps={disabledSteps}
        onStepClick={setActiveStep}
      />
      <WorkspaceContent
        project={project}
        onProjectUpdated={onProjectUpdated}
        activeStep={activeStep}
      />
    </div>
  );
}

function WorkspaceContent({
  project,
  onProjectUpdated,
  activeStep,
}: {
  project: ProjectInfo;
  onProjectUpdated: (p: ProjectInfo) => void;
  activeStep: number;
}) {
  const [hasScript, setHasScript] = useState<boolean | null>(null);

  const checkScript = useCallback(async () => {
    try {
      const src = await getScriptSource(project.id);
      setHasScript(src !== null);
    } catch {
      setHasScript(false);
    }
  }, [project.id]);

  useEffect(() => {
    checkScript();
  }, [checkScript]);

  // 拆分进行中时轮询 project 让步骤板和状态实时更新
  const isSplitting = project.current_step === "project" || project.current_step === "split";
  useEffect(() => {
    if (!hasScript || !isSplitting) return;
    const timer = window.setInterval(async () => {
      try {
        const updated = await getProject(project.id);
        onProjectUpdated(updated);
      } catch {
        // 轮询失败忽略
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [hasScript, isSplitting, project.id, onProjectUpdated]);

  const handleImported = useCallback(async () => {
    await checkScript();
    try {
      const updated = await getProject(project.id);
      onProjectUpdated(updated);
    } catch {
      // 刷新失败不影响视图切换
    }
  }, [checkScript, project.id, onProjectUpdated]);

  // step 0: 剧本管理
  if (activeStep === 0) {
    if (hasScript === null) {
      return (
        <div className="clip-list-panel">
          <div className="panel-loading">加载中…</div>
        </div>
      );
    }
    if (!hasScript) {
      return <ScriptImportPanel project={project} onImported={handleImported} />;
    }
    return <ClipListPanel project={project} />;
  }

  // step 1-4: 占位页面
  return <StepPlaceholder stepIndex={activeStep} projectName={project.name} />;
}
