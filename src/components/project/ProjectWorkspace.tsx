import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectInfo, ScriptSource } from "../../types/project";
import { getProject, getScriptSource, getClipScripts } from "../../services/tauri";
import { WorkflowBoard } from "./WorkflowBoard";
import { ClipListPanel } from "./ClipListPanel";
import type { ClipScriptInfo } from "../../types/project";
import { StepPlaceholder } from "./StepPlaceholder";
import { ScriptListPanel } from "./ScriptListPanel";

type ProjectWorkspaceProps = {
  project: ProjectInfo | null;
  onProjectUpdated: (project: ProjectInfo) => void;
};

/**
 * 项目工作区主视图
 *
 * 管理步骤导航、剧本列表、片段列表的分栏布局和轮询逻辑。
 *
 * @author yt @date 20260702
 */
export function ProjectWorkspace({ project, onProjectUpdated }: ProjectWorkspaceProps) {
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[] | null>(null);
  const [hasRunning, setHasRunning] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [currentSource, setCurrentSource] = useState<ScriptSource | null>(null);

  // 切项目时重置
  useEffect(() => {
    setActiveStep(0);
    setSelectedSourceId(null);
    setCurrentSource(null);
  }, [project?.id]);

  // 初始加载 clipScripts
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    getClipScripts(project.id).then((cs) => {
      if (!cancelled) {
        setClipScripts(cs);
        setHasRunning(cs.some((c) => c.status === "pending" || c.status === "running"));
      }
    }).catch(() => {
      if (!cancelled) setClipScripts([]);
    });
    return () => { cancelled = true; };
  }, [project?.id]);

  // 拆解进行中时轮询（仅在存在 running/pending 任务时启动）
  useEffect(() => {
    if (!project || !hasRunning) return;
    const timer = setInterval(() => {
      getClipScripts(project.id).then((cs) => {
        setClipScripts(cs);
        setHasRunning(cs.some((c) => c.status === "pending" || c.status === "running"));
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [project?.id, hasRunning]);

  // 选中剧本变化时加载详情
  useEffect(() => {
    if (!project || !selectedSourceId) {
      setCurrentSource(null);
      return;
    }
    let cancelled = false;
    getScriptSource(project.id).then((src) => {
      if (!cancelled && src?.id === selectedSourceId) {
        setCurrentSource(src);
      } else if (!cancelled && src === null) {
        setCurrentSource(null);
      }
    }).catch(() => {
      if (!cancelled) setCurrentSource(null);
    });
    return () => { cancelled = true; };
  }, [project?.id, selectedSourceId]);

  // 计算禁用步骤
  const disabledSteps = useMemo(() => {
    if (clipScripts === null) return null;
    const anyDisassembled = clipScripts.some((cs) => cs.status === "success");
    if (anyDisassembled) return new Set<number>();
    return new Set([1, 2, 3, 4]);
  }, [clipScripts]);

  const handleSourcesChanged = useCallback(async () => {
    if (!project) return;
    try {
      const updated = await getProject(project.id);
      onProjectUpdated(updated);
    } catch {
      // ignore
    }
  }, [project, onProjectUpdated]);

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
      {activeStep === 0 ? (
        <div className="workspace-split-layout">
          <ScriptListPanel
            project={project}
            selectedSourceId={selectedSourceId}
            onSelectSource={setSelectedSourceId}
            onSourcesChanged={handleSourcesChanged}
          />
          <div className="workspace-right-panel">
            {selectedSourceId ? (
              <ClipListPanel
                project={project}
                sourceId={selectedSourceId}
                source={currentSource}
              />
            ) : (
              <div className="clip-list-panel">
                <div className="panel-header">
                  <h3>片段列表</h3>
                </div>
                <div className="empty-clip-list">
                  <p>请从左侧选择一本剧本查看其片段</p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <StepPlaceholder stepIndex={activeStep} projectName={project.name} />
      )}
    </div>
  );
}
