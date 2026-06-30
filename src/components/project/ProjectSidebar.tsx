import { APP_NAME } from "../../config/muse";
import type { ProjectInfo } from "../../types/project";
import { ProjectList } from "./ProjectList";

type ProjectSidebarProps = {
  projects: ProjectInfo[];
  selectedProjectId: string;
  loading: boolean;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onRefresh: () => void;
  onGoHome: () => void;
};

export function ProjectSidebar({
  projects,
  selectedProjectId,
  loading,
  onSelectProject,
  onCreateProject,
  onRefresh,
  onGoHome,
}: ProjectSidebarProps) {
  return (
    <aside className="project-sidebar">
      <div className="sidebar-header">
        <div>
          <div className="sidebar-kicker">项目管理</div>
          <h2>{APP_NAME}</h2>
        </div>
        <button type="button" className="ghost-button" onClick={onGoHome}>
          返回首页
        </button>
      </div>

      <div className="sidebar-actions">
        <button type="button" className="primary-button" onClick={onCreateProject}>
          创建项目
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "刷新中..." : "刷新列表"}
        </button>
      </div>

      <div className="project-list">
        <ProjectList
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelect={onSelectProject}
        />
      </div>
    </aside>
  );
}
