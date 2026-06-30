import { useCallback, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { getProject } from "../../services/tauri";
import { WorkflowBoard } from "./WorkflowBoard";
import { ScriptImportPanel } from "./ScriptImportPanel";
import { ClipListPanel } from "./ClipListPanel";

type ProjectWorkspaceProps = {
  project: ProjectInfo | null;
  onProjectUpdated: (project: ProjectInfo) => void;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ProjectWorkspace({ project, onProjectUpdated }: ProjectWorkspaceProps) {
  if (!project) {
    return (
      <div className="empty-workspace">
        <h2>选择一个项目开始工作</h2>
        <p>左侧选择项目后，这里会显示项目工作区、片段、分镜和任务流程。</p>
      </div>
    );
  }

  return (
    <div className="workspace-inner">
      <WorkspaceHeader project={project} />
      <WorkflowBoard currentStep={project.current_step} />
      <WorkspaceContent project={project} onProjectUpdated={onProjectUpdated} />
    </div>
  );
}

function WorkspaceHeader({ project }: { project: ProjectInfo }) {
  return (
    <div className="workspace-header-row">
      <div className="workspace-header">
        <div>
          <div className="workspace-kicker">项目工作区</div>
          <h2>{project.name}</h2>
          {project.description && <p>{project.description}</p>}
        </div>
        <div className="workspace-badges">
          <span>{project.current_step}</span>
          <span>{project.status}</span>
        </div>
      </div>
      <div className="workspace-summary">
        <div className="summary-card">
          <span>工作区目录</span>
          <strong title={project.workspace_path}>
            {project.workspace_path.split(/[\\/]/).pop()}
          </strong>
        </div>
        <div className="summary-card">
          <span>创建时间</span>
          <strong>{formatDate(project.created_at)}</strong>
        </div>
      </div>
    </div>
  );
}

function WorkspaceContent({
  project,
  onProjectUpdated,
}: {
  project: ProjectInfo;
  onProjectUpdated: (p: ProjectInfo) => void;
}) {
  const handleImported = useCallback(async () => {
    // 导入成功后重新拉取项目信息（current_step 可能已变）
    try {
      const updated = await getProject(project.id);
      onProjectUpdated(updated);
    } catch {
      // 即使更新失败，也切换到片段视图
      onProjectUpdated({ ...project, current_step: "script" });
    }
  }, [project, onProjectUpdated]);

  // project 步骤 = "project"：显示剧本导入入口
  if (project.current_step === "project") {
    return <ScriptImportPanel project={project} onImported={handleImported} />;
  }

  // 其余步骤：显示片段列表（后续各步骤在此扩展）
  return <ClipListPanel project={project} />;
}
