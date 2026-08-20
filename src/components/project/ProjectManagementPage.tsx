import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { deleteProject } from "../../services/tauri";
import { useProjects } from "../../hooks/useProjects";
import { useToast } from "../../hooks/useToast";
import { formatDeleteResult } from "../../utils/delete-result";
import { ProjectSidebar } from "./ProjectSidebar";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { CreateProjectModal } from "./CreateProjectModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";

type ProjectManagementPageProps = {
  selectedProjectId?: string | null;
  onGoHome: () => void;
  onSelectedProjectChange?: (project: ProjectInfo | null) => void;
};

/**
 * 作品管理页
 *
 * 集成侧边栏、工作区与弹窗的作品管理主界面。
 */
export function ProjectManagementPage({ selectedProjectId: initialSelectedProjectId, onGoHome, onSelectedProjectChange }: ProjectManagementPageProps) {
  const { projects, load } = useProjects();
  const { toast } = useToast();
  const [selectedProjectId, setSelectedProjectId] = useState(initialSelectedProjectId ?? "");
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectInfo | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [projectOverrides, setProjectOverrides] = useState<Record<string, ProjectInfo>>({});
  const [sidebarOpen, setSidebarOpen] = useState(() => !initialSelectedProjectId);

  useEffect(() => {
    load()
      .then(() => setProjectsLoaded(true))
      .catch(() => setProjectsLoaded(true));
  }, [load]);

  useEffect(() => {
    if (initialSelectedProjectId !== undefined) {
      const nextSelectedProjectId = initialSelectedProjectId ?? "";
      setSelectedProjectId(nextSelectedProjectId);
      setSidebarOpen(!nextSelectedProjectId);
    }
  }, [initialSelectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSidebarOpen(true);
    }
  }, [selectedProjectId]);

  const selectedProject = (() => {
    if (!selectedProjectId) return null;
    return projectOverrides[selectedProjectId]
      ?? projects.find((project) => project.id === selectedProjectId)
      ?? null;
  })();

  // 向上同步选中作品（供 TitleBar Agent 按钮判断可用性）
  useEffect(() => {
    if (selectedProjectId && !projectsLoaded) return;
    onSelectedProjectChange?.(selectedProject);
  }, [projectsLoaded, selectedProject, onSelectedProjectChange, selectedProjectId]);

  const handleCreated = useCallback((project: ProjectInfo) => {
    setModalOpen(false);
    setProjectOverrides((prev) => ({ ...prev, [project.id]: project }));
    load().then((items) => {
      if (items.some((item) => item.id === project.id)) {
        setSelectedProjectId(project.id);
      }
    });
  }, [load]);

  const handleDeleted = useCallback((projectId: string) => {
    if (selectedProjectId === projectId) {
      setSelectedProjectId("");
      setSidebarOpen(true);
    }
    setProjectOverrides((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setDeleteTarget(null);
    load();
  }, [selectedProjectId, load]);

  const confirmProjectDeletion = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await deleteProject(deleteTarget.id, deleteFiles);
      handleDeleted(deleteTarget.id);
      const feedback = formatDeleteResult(result);
      toast(feedback.text, feedback.kind);
    } catch {
      const feedback = formatDeleteResult(undefined, true);
      toast(feedback.text, feedback.kind);
    } finally {
      setDeleting(false);
    }
  }, [deleteFiles, deleteTarget, handleDeleted, toast]);

  return (
    <section className={`projects-screen${sidebarOpen ? " projects-screen--sidebar-open" : ""}`}>
      {selectedProjectId && (
        <div className={`sidebar-edge-hotzone${sidebarOpen ? " sidebar-edge-hotzone--open" : ""}`}>
          <button
            type="button"
            className="sidebar-grabber"
            onClick={() => setSidebarOpen((open) => !open)}
            title={sidebarOpen ? "收起作品列表" : "展开作品列表"}
            aria-label={sidebarOpen ? "收起作品列表" : "展开作品列表"}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              {sidebarOpen ? (
                <path d="M5 5L11 11M11 5L5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              ) : (
                <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
        </div>
      )}

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
          onDeleteProject={(project) => {
            setDeleteFiles(false);
            setDeleteTarget(project);
          }}
          onGoHome={onGoHome}
        />
      </div>

      <main className="project-workspace">
        <ProjectWorkspace project={selectedProject} />
      </main>

      {modalOpen && (
        <CreateProjectModal
          onClose={() => setModalOpen(false)}
          onCreated={handleCreated}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title="删除作品"
          description={<>确认删除 <strong>{deleteTarget.name}</strong> 作品？</>}
          checkbox={{ label: "同时删除磁盘文件", checked: deleteFiles, onChange: setDeleteFiles }}
          confirmText={deleting ? "删除中…" : "删除"}
          onConfirm={confirmProjectDeletion}
          onCancel={() => setDeleteTarget(null)}
          disabled={deleting}
        />
      )}
    </section>
  );
}
