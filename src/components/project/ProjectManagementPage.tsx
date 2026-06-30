import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { useProjects } from "../../hooks/useProjects";
import { ProjectSidebar } from "./ProjectSidebar";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { CreateProjectModal } from "./CreateProjectModal";

type ProjectManagementPageProps = {
  onGoHome: () => void;
  onOpenSettings: () => void;
};

export function ProjectManagementPage({ onGoHome, onOpenSettings }: ProjectManagementPageProps) {
  const { projects, loading, load } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  // 维护一个本地的"选中项目"缓存，允许 workspace 操作后立即反映而无需重新拉列表
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
    load().then((items) => {
      if (items.some((p) => p.id === project.id)) {
        setSelectedProjectId(project.id);
      }
    });
  }, [load]);

  // workspace 内部操作（如导入剧本后 current_step 变化）触发本地更新
  const handleProjectUpdated = useCallback((updated: ProjectInfo) => {
    setProjectOverrides((prev) => ({ ...prev, [updated.id]: updated }));
  }, []);

  return (
    <section className="projects-screen">
      <ProjectSidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        loading={loading}
        onSelectProject={(id) => {
          setSelectedProjectId(id);
          // 切换项目时清除旧的 override，让列表数据重新生效
          setProjectOverrides((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }}
        onCreateProject={() => setModalOpen(true)}
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
    </section>
  );
}
