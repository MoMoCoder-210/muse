import type { ProjectInfo } from "../../types/project";
import { WorkflowBoard } from "./WorkflowBoard";

type ProjectWorkspaceProps = {
  project: ProjectInfo | null;
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

export function ProjectWorkspace({ project }: ProjectWorkspaceProps) {
  if (!project) {
    return (
      <div className="empty-workspace">
        <h2>选择一个项目开始工作</h2>
        <p>左侧选择项目后，这里会显示项目工作区、片段、分镜和任务流程。</p>
      </div>
    );
  }

  return (
    <>
      <div className="workspace-header">
        <div>
          <div className="workspace-kicker">项目工作区</div>
          <h2>{project.name}</h2>
          <p>{project.description || "未填写描述"}</p>
        </div>
        <div className="workspace-badges">
          <span>{project.current_step}</span>
          <span>{project.status}</span>
        </div>
      </div>

      <div className="workspace-summary">
        <div className="summary-card">
          <span>工作区目录</span>
          <strong>{project.workspace_path}</strong>
        </div>
        <div className="summary-card">
          <span>创建时间</span>
          <strong>{formatDate(project.created_at)}</strong>
        </div>
      </div>

      <WorkflowBoard currentStep={project.current_step} />

      <div className="workspace-grid">
        <section className="workspace-panel">
          <h3>当前项目概览</h3>
          <p>
            这里后续会接入剧本导入、自动拆分镜、角色场景物品生成、分镜编辑、融合生成和视频产出。
          </p>
        </section>
        <section className="workspace-panel">
          <h3>后续操作区</h3>
          <p>你可以在这里继续放置片段列表、分镜预览、任务队列和生成结果。</p>
        </section>
      </div>
    </>
  );
}
