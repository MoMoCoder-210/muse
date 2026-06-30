import { useEffect, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { useProjects } from "../../hooks/useProjects";
import { ProjectSidebar } from "./ProjectSidebar";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { CreateProjectModal } from "./CreateProjectModal";

type ProjectManagementPageProps = {
  onGoHome: () => void;
  /** 首页点"创建项目"后传入 true，页面打开时自动弹出创建弹窗 */
  autoOpenCreate?: boolean;
  /** 消费 autoOpenCreate 信号后回调，重置父组件状态 */
  onAutoOpenConsumed?: () => void;
};

export function ProjectManagementPage({
  onGoHome,
  autoOpenCreate,
  onAutoOpenConsumed,
}: ProjectManagementPageProps) {
  const { projects, loading, load } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [modalOpen, setModalOpen] = useState(false);

  // 首次加载项目列表
  useEffect(() => {
    load();
  }, [load]);

  // 响应来自首页的"创建项目"触发
  useEffect(() => {
    if (!autoOpenCreate) return;
    setModalOpen(true);
    onAutoOpenConsumed?.();
  }, [autoOpenCreate, onAutoOpenConsumed]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;

  function handleCreated(project: ProjectInfo) {
    setModalOpen(false);
    load().then((items) => {
      if (items.some((p) => p.id === project.id)) {
        setSelectedProjectId(project.id);
      }
    });
  }

  return (
    <section className="projects-screen">
      <ProjectSidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        loading={loading}
        onSelectProject={setSelectedProjectId}
        onCreateProject={() => setModalOpen(true)}
        onRefresh={load}
        onGoHome={onGoHome}
      />

      <main className="project-workspace">
        <ProjectWorkspace project={selectedProject} />
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
