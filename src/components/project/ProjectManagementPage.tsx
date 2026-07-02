import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { useProjects } from "../../hooks/useProjects";
import { ProjectSidebar } from "./ProjectSidebar";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { CreateProjectModal } from "./CreateProjectModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";

type ProjectManagementPageProps = {
  onGoHome: () => void;
  onOpenSettings: () => void;
};

/**
 * 项目管理页
 *
 * 集成侧边栏、工作区与弹窗的项目管理主界面。
 *
 * @author yt @date 20260702
 */
export function ProjectManagementPage({ onGoHome, onOpenSettings }: ProjectManagementPageProps) {
  const { projects, loading, load } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectInfo | null>(null);
  const [projectOverrides, setProjectOverrides] = useState<Record<string, ProjectInfo>>({});

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
    <section className="projects-screen">
      <ProjectSidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        loading={loading}
        onSelectProject={(id) => {
          setSelectedProjectId(id);
          setProjectOverrides((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }}
        onCreateProject={() => setModalOpen(true)}
        onDeleteProject={(project) => setDeleteTarget(project)}
        onRefresh={() => {
          setProjectOverrides({});
          load();
        }}
        onGoHome={onGoHome}
        onOpenSettings={onOpenSettings}
      />

      <main className="project-workspace">
        <ProjectWorkspace
          project={selectedProject}
          onProjectUpdated={handleProjectUpdated}
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
