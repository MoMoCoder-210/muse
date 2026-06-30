import type { ProjectInfo } from "../../types/project";

type ProjectListProps = {
  projects: ProjectInfo[];
  selectedProjectId: string;
  onSelect: (id: string) => void;
};

export function ProjectList({ projects, selectedProjectId, onSelect }: ProjectListProps) {
  if (projects.length === 0) {
    return <div className="empty-panel">还没有项目，先创建一个吧。</div>;
  }

  return (
    <>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          className={`project-item ${project.id === selectedProjectId ? "active" : ""}`}
          onClick={() => onSelect(project.id)}
        >
          <div className="project-item-title">
            <strong>{project.name}</strong>
            <span>{project.status}</span>
          </div>
          <p>{project.description || "未填写描述"}</p>
          <small>{project.workspace_path}</small>
        </button>
      ))}
    </>
  );
}
