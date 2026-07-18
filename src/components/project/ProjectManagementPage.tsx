import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { useProjects } from "../../hooks/useProjects";
import { ProjectSidebar } from "./ProjectSidebar";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { CreateProjectModal } from "./CreateProjectModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";

type ProjectManagementPageProps = {
  onGoHome: () => void;
};

/**
 * 项目管理页
 *
 * 集成侧边栏、工作区与弹窗的项目管理主界面。
 *
 */
export function ProjectManagementPage({ onGoHome }: ProjectManagementPageProps) {
  const { projects, load } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectInfo | null>(null);
  const [projectOverrides, setProjectOverrides] = useState<Record<string, ProjectInfo>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    load();
  }, [load]);

  const selectedProject = (() => {
    if (!selectedProjectId) return null;
    return projectOverrides[selectedProjectId]
      ?? projects.find((p) => p.id === selectedProjectId)
      ?? null;
  })();

  const handleCreated = useCallback((project: ProjectInfo) => {
    setModalOpen(false);
    setProjectOverrides((prev) => ({ ...prev, [project.id]: project }));
    load().then((items) => {
      if (items.some((p) => p.id === project.id)) {
        setSelectedProjectId(project.id);
      }
    });
  }, [load]);

  const handleProjectUpdated = useCallback((updated: ProjectInfo) => {
    setProjectOverrides((prev) => ({ ...prev, [updated.id]: updated }));
  }, []);

  const handleDeleted = useCallback((projectId: string) => {
    if (selectedProjectId === projectId) {
      setSelectedProjectId("");
    }
    setProjectOverrides((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setDeleteTarget(null);
    load();
  }, [selectedProjectId, load]);

  return (
    <section className={`projects-screen${sidebarOpen ? " projects-screen--sidebar-open" : ""}`}>
      {/* 侧边栏收起时的窄把手 — 点击展开 */}
      <div
        className="sidebar-grabber"
        onClick={() => setSidebarOpen(true)}
        title="展开项目列表"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M6 4L10 8L6 12"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div className={`sidebar-drawer${sidebarOpen ? " sidebar-drawer--open" : ""}`}>
        <ProjectSidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={(id) => {
            setSelectedProjectId(id);
            setSidebarOpen(false);
            setProjectOverrides((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
          }}
          onCreateProject={() => setModalOpen(true)}
          onDeleteProject={(project) => setDeleteTarget(project)}
          onGoHome={onGoHome}
        />
      </div>

      <main className="project-workspace">
        <ProjectWorkspace
          project={selectedProject}
        />
      </main>

      {modalOpen ? (
        <CreateProjectModal
          onClose={() => setModalOpen(false)}
          onCreated={handleCreated}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteConfirmModal
          project={deleteTarget}
          onDeleted={handleDeleted}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </section>
  );
}
