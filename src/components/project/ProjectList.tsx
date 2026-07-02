import type { ProjectInfo } from "../../types/project";

type ProjectListProps = {
  projects: ProjectInfo[];
  selectedProjectId: string;
  onSelect: (id: string) => void;
  onRequestDelete: (project: ProjectInfo) => void;
};

export function ProjectList({ projects, selectedProjectId, onSelect, onRequestDelete }: ProjectListProps) {
  if (projects.length === 0) {
    return <div className="empty-panel">还没有项目，先创建一个吧。</div>;
  }

  return (
    <>
      {projects.map((project) => (
        <div
          key={project.id}
          className={`project-item ${project.id === selectedProjectId ? "active" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(project.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onSelect(project.id);
          }}
        >
          <div className="project-item-title">
            <strong>{project.name}</strong>
          </div>
          <p>{project.description || "未填写描述"}</p>
          <div className="project-item-footer">
            <small>{project.workspace_path}</small>
            <button
              type="button"
              className="project-delete-btn"
              title="删除项目"
              onClick={(e) => {
                e.stopPropagation();
                onRequestDelete(project);
              }}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
