import { APP_NAME } from "../../config/muse";
import type { ProjectInfo } from "../../types/project";
import { ProjectList } from "./ProjectList";

type ProjectSidebarProps = {
  projects: ProjectInfo[];
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onDeleteProject: (project: ProjectInfo) => void;
  onGoHome: () => void;
};

/**
 * 项目侧边栏
 *
 * 管理页面左侧导航栏，包含项目列表、创建/刷新操作与底部导航。
 *
 */
export function ProjectSidebar({
  projects,
  selectedProjectId,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onGoHome,
}: ProjectSidebarProps) {
  return (
    <aside className="project-sidebar">
      {/* 头部 */}
      <div className="sidebar-header">
        <h2 className="sidebar-title">{APP_NAME}</h2>
      </div>

      {/* 操作区：创建 */}
      <div className="sidebar-actions">
        <button type="button" className="primary-button btn-sm sidebar-create-btn" onClick={onCreateProject}>
          + 新建项目
        </button>
      </div>

      {/* 项目列表 */}
      <div className="project-list">
        <ProjectList
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelect={onSelectProject}
          onRequestDelete={onDeleteProject}
        />
      </div>

      {/* 底部操作栏 */}
      <div className="sidebar-footer">
        <button type="button" className="sidebar-back-btn" onClick={onGoHome}>
          返回首页
        </button>
      </div>
    </aside>
  );
}
