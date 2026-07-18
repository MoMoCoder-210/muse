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
 * 项目侧边栏 — macOS 风格
 *
 * 极简侧边导航：品牌头 → 新建按钮 → 项目列表 → 底部返回
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
      {/* 品牌头部 */}
      <div className="sidebar-header">
        <h2 className="sidebar-title">{APP_NAME}</h2>
        <span className="sidebar-subtitle">项目管理</span>
      </div>

      {/* 新建按钮 — 胶囊主按钮 */}
      <div className="sidebar-actions">
        <button type="button" className="sidebar-create-btn" onClick={onCreateProject}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
          新建项目
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

      {/* 底部返回 */}
      <div className="sidebar-footer">
        <button type="button" className="sidebar-back-btn" onClick={onGoHome}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M8 3L4 7L8 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          返回首页
        </button>
      </div>
    </aside>
  );
}
