import { useEffect, useMemo, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { getClipScripts } from "../../services/tauri";
import { WorkflowBoard } from "./WorkflowBoard";
import { ClipListPanel } from "./ClipListPanel";
import type { ClipScriptInfo } from "../../types/project";
import { StepPlaceholder } from "../common/StepPlaceholder";
import { AssetPanel } from "./AssetPanel";
import { StoryboardPanel } from "./StoryboardPanel";
import { VideoEditorPage } from "./VideoEditorPage";
import { CreateClipModal } from "./CreateClipModal";

type ProjectWorkspaceProps = {
  project: ProjectInfo | null;
  onProjectUpdated: (project: ProjectInfo) => void;
};

/**
 * 项目工作区主视图
 *
 */
export function ProjectWorkspace({ project, onProjectUpdated: _onProjectUpdated }: ProjectWorkspaceProps) {
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[] | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [showCreateClip, setShowCreateClip] = useState(false);
  const [clipRefreshKey, setClipRefreshKey] = useState(0);

  // 切项目时重置
  useEffect(() => {
    setActiveStep(0);
    setShowCreateClip(false);
  }, [project?.id]);

  // 立即加载 + 持续轮询 clipScripts，驱动工作流 tab 状态
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      getClipScripts(project.id).then((cs) => {
        if (!cancelled) setClipScripts(cs);
      }).catch(() => {
        // 轮询失败不打扰用户，需要调试可打开后端日志
      });
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [project?.id]);

  // 计算禁用步骤
  const disabledSteps = useMemo(() => {
    if (clipScripts === null) return null;
    const anyDisassembled = clipScripts.some((cs) => cs.status === "success");
    if (anyDisassembled) return new Set<number>();
    return new Set([1, 2, 3, 4]);
  }, [clipScripts]);

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
        activeIndex={activeStep}
        disabledSteps={disabledSteps}
        onStepClick={setActiveStep}
      />
      {activeStep === 0 ? (
        <ClipListPanel
          project={project}
          refreshKey={clipRefreshKey}
          onCreateClip={() => setShowCreateClip(true)}
        />
      ) : activeStep === 1 ? (
        <AssetPanel project={project} />
      ) : activeStep === 2 ? (
        <StoryboardPanel project={project} />
      ) : activeStep === 3 ? (
        <VideoEditorPage project={project} />
      ) : (
        <StepPlaceholder stepIndex={activeStep} projectName={project.name} />
      )}

      {showCreateClip && (
        <CreateClipModal
          projectId={project.id}
          onCreated={() => {
            setShowCreateClip(false);
            setClipRefreshKey((k) => k + 1);
          }}
          onClose={() => setShowCreateClip(false)}
        />
      )}
    </div>
  );
}
