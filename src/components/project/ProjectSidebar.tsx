import { APP_NAME } from "../../config/muse";
import type { ProjectInfo } from "../../types/project";
import { ProjectList } from "./ProjectList";

type ProjectSidebarProps = {
  projects: ProjectInfo[];
  selectedProjectId: string;
  loading: boolean;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onDeleteProject: (project: ProjectInfo) => void;
  onRefresh: () => void;
  onGoHome: () => void;
  onOpenSettings: () => void;
};

/**
 * 项目侧边栏
 *
 * 管理页面左侧导航栏，包含项目列表、创建/刷新操作与底部导航。
 *
 * @author yt @date 20260702
 */
export function ProjectSidebar({
  projects,
  selectedProjectId,
  loading,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onRefresh,
  onGoHome,
  onOpenSettings,
}: ProjectSidebarProps) {
  return (
    <aside className="project-sidebar">
      {/* 头部：应用名居中 */}
      <div className="sidebar-header">
        <h2 className="sidebar-title">{APP_NAME}</h2>
      </div>

      {/* 操作区：创建 + 刷新 */}
      <div className="sidebar-actions">
        <button type="button" className="primary-button btn-sm sidebar-create-btn" onClick={onCreateProject}>
          + 新建项目
        </button>
        <button
          type="button"
          className="ghost-button btn-icon-sm"
          onClick={onRefresh}
          disabled={loading}
          aria-label="刷新列表"
          title="刷新列表"
        >
          {loading ? "…" : "↻"}
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
        <button
          type="button"
          className="sidebar-settings-btn"
          onClick={onOpenSettings}
          aria-label="打开设置"
          title="设置"
        >
          ⚙
        </button>
      </div>
    </aside>
  );
}
