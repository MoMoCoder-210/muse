import { STYLE_OPTIONS, type StyleMode } from "../../config/muse";
import type { ProjectInfo } from "../../types/project";

type ProjectListProps = {
  projects: ProjectInfo[];
  selectedProjectId: string;
  onSelect: (id: string) => void;
  onRequestDelete: (project: ProjectInfo) => void;
};

/** 取项目名首字作为图标文字 */
function iconLetter(name: string): string {
  const ch = name.trim().charAt(0);
  return ch || "?";
}

/**
 * 风格对应的头像色调 — 与 STYLE_OPTIONS 一一对应
 * 按数组索引映射，确保每种风格有独特的视觉标识
 */
const STYLE_COLOR_MAP: Record<StyleMode, { bg: string; text: string }> = {
  [STYLE_OPTIONS[0]]: { bg: "rgba(142,142,147,0.18)", text: "#8e8e93" },  // 国漫
  [STYLE_OPTIONS[1]]: { bg: "rgba(0,122,255,0.18)",  text: "#007aff" },  // 动漫
  [STYLE_OPTIONS[2]]: { bg: "rgba(255,149,0,0.18)",  text: "#ff9500" },  // 日漫
  [STYLE_OPTIONS[3]]: { bg: "rgba(255,204,0,0.18)",  text: "#ffcc00" },  // 韩漫
  [STYLE_OPTIONS[4]]: { bg: "rgba(175,82,222,0.18)", text: "#af52de" },  // 二次元
  [STYLE_OPTIONS[5]]: { bg: "rgba(90,200,250,0.18)", text: "#5ac8fa" },  // 真人
};

function styleColor(mode: string): { bg: string; text: string } {
  return STYLE_COLOR_MAP[mode as StyleMode] ?? { bg: "rgba(148,163,184,0.12)", text: "#cbd5e1" };
}

/**
 * 项目列表 — macOS Finder 风格
 *
 * 左侧彩色头像图标 + 主信息区 + hover 时显示删除按钮
 */
export function ProjectList({ projects, selectedProjectId, onSelect, onRequestDelete }: ProjectListProps) {
  if (projects.length === 0) {
    return <div className="empty-panel">还没有项目，先创建一个吧。</div>;
  }

  return (
    <>
      {projects.map((project) => {
        const active = project.id === selectedProjectId;
        const colors = styleColor(project.style_mode);

        return (
          <div
            key={project.id}
            className={`project-item${active ? " project-item--active" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(project.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(project.id);
            }}
          >
            {/* 左侧彩色头像 — 上下居中 */}
            <div
              className="project-item__avatar"
              style={{ background: colors.bg, color: colors.text }}
            >
              {iconLetter(project.name)}
            </div>

            {/* 中间信息区 */}
            <div className="project-item__body">
              <div className="project-item__headline">
                <span className="project-item__name">{project.name}</span>
                <span
                  className="project-item__style"
                  style={{ background: colors.bg, color: colors.text }}
                >
                  {project.style_mode}
                </span>
              </div>
              {project.description ? (
                <p className="project-item__desc">{project.description}</p>
              ) : (
                <p className="project-item__desc project-item__desc--empty">未填写描述</p>
              )}
              <span className="project-item__path" title={project.workspace_path}>
                {project.workspace_path}
              </span>
            </div>

            {/* 右上角删除 — hover 出现，垃圾桶图标 */}
            <button
              type="button"
              className="project-item__delete"
              title="删除项目"
              onClick={(e) => {
                e.stopPropagation();
                onRequestDelete(project);
              }}
              aria-label="删除项目"
            >
              <svg width="12" height="13" viewBox="0 0 12 13" fill="none">
                <path
                  d="M1.5 3.5H10.5M4.5 3V2C4.5 1.45 4.95 1 5.5 1H6.5C7.05 1 7.5 1.45 7.5 2V3M9.5 3V11C9.5 11.55 9.05 12 8.5 12H3.5C2.95 12 2.5 11.55 2.5 11V3H9.5Z"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        );
      })}
    </>
  );
}
