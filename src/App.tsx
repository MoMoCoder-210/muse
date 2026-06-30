import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import {
  APP_NAME,
  CREATE_MODES,
  CREATE_MODE_OPTIONS,
  DEFAULT_PROJECT_ROOT,
  STYLE_OPTIONS,
  type CreateMode,
  type StyleMode,
  WORKFLOW_STEPS,
} from "./config/muse";
import { getCssVar } from "./config/theme";

type ViewMode = "home" | "projects";

type ProjectInfo = {
  id: string;
  name: string;
  description: string;
  workspace_path: string;
  status: string;
  current_step: string;
  created_at: string;
};

type CreateProjectInput = {
  name: string;
  description?: string;
  workspace_path: string;
  input_mode?: string;
  style_mode?: string;
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compareStep(current: string, target: string) {
  const workflowSteps = WORKFLOW_STEPS as readonly string[];
  const currentIndex = workflowSteps.indexOf(current);
  const targetIndex = workflowSteps.indexOf(target);
  if (currentIndex === -1 || targetIndex === -1) return false;
  return targetIndex <= currentIndex;
}

function DynamicBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const particles = Array.from({ length: 34 }, (_, index) => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00045,
      vy: (Math.random() - 0.5) * 0.00045,
      size: 1 + (index % 3),
    }));

    const resize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    let frame = 0;
    let rafId = 0;

    const drawGlow = (
      x: number,
      y: number,
      radius: number,
      innerColor: string,
      outerColor: string,
    ) => {
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, innerColor);
      gradient.addColorStop(1, outerColor);
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    };

    const render = () => {
      frame += 1;
      const width = window.innerWidth;
      const height = window.innerHeight;

      // 从主题 token 读取 canvas 颜色，每帧读取以响应主题切换
      const bgCanvas = getCssVar("bgCanvas");
      const glow1 = getCssVar("canvasGlow1");
      const glow2 = getCssVar("canvasGlow2");
      const glow3 = getCssVar("canvasGlow3");
      const glow4 = getCssVar("canvasGlow4");
      const particleColor = getCssVar("canvasParticleColor");
      const lineRgb = getCssVar("canvasLineColor");

      context.clearRect(0, 0, width, height);
      context.fillStyle = bgCanvas;
      context.fillRect(0, 0, width, height);

      const baseX = width * 0.5;
      const baseY = height * 0.5;

      drawGlow(
        baseX + Math.sin(frame * 0.003) * width * 0.2,
        baseY + Math.cos(frame * 0.0027) * height * 0.18,
        Math.min(width, height) * 0.42,
        `rgba(${glow1}, 0.33)`,
        `rgba(${glow1}, 0)`,
      );
      drawGlow(
        baseX - Math.cos(frame * 0.0022) * width * 0.24,
        baseY - Math.sin(frame * 0.0024) * height * 0.2,
        Math.min(width, height) * 0.34,
        `rgba(${glow2}, 0.28)`,
        `rgba(${glow2}, 0)`,
      );
      drawGlow(
        baseX + Math.sin(frame * 0.002) * width * 0.12,
        baseY + Math.sin(frame * 0.0032) * height * 0.12,
        Math.min(width, height) * 0.24,
        `rgba(${glow3}, 0.22)`,
        `rgba(${glow3}, 0)`,
      );
      drawGlow(
        width * 0.18 + Math.sin(frame * 0.0018) * width * 0.12,
        height * 0.2 + Math.cos(frame * 0.0025) * height * 0.1,
        Math.min(width, height) * 0.18,
        `rgba(${glow4}, 0.18)`,
        `rgba(${glow4}, 0)`,
      );

      context.save();
      context.globalCompositeOperation = "lighter";

      particles.forEach((particle, index) => {
        particle.x += particle.vx;
        particle.y += particle.vy;

        if (particle.x < -0.05) particle.x = 1.05;
        if (particle.x > 1.05) particle.x = -0.05;
        if (particle.y < -0.05) particle.y = 1.05;
        if (particle.y > 1.05) particle.y = -0.05;

        const px = particle.x * width;
        const py = particle.y * height;
        context.fillStyle = particleColor;
        context.beginPath();
        context.arc(px, py, particle.size, 0, Math.PI * 2);
        context.fill();

        for (let otherIndex = index + 1; otherIndex < particles.length; otherIndex += 1) {
          const other = particles[otherIndex];
          const ox = other.x * width;
          const oy = other.y * height;
          const dx = ox - px;
          const dy = oy - py;
          const distance = Math.hypot(dx, dy);
          if (distance > 160) continue;

          const alpha = (1 - distance / 160) * 0.18;
          context.strokeStyle = `rgba(${lineRgb}, ${alpha})`;
          context.beginPath();
          context.moveTo(px, py);
          context.lineTo(ox, oy);
          context.stroke();
        }
      });

      context.restore();
      rafId = window.requestAnimationFrame(render);
    };

    rafId = window.requestAnimationFrame(render);
    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(rafId);
    };
  }, []);

  return <canvas ref={canvasRef} className="backdrop-canvas" aria-hidden="true" />;
}

export default function App() {
  const styleDropdownRef = useRef<HTMLDivElement | null>(null);
  const [version, setVersion] = useState("unknown");
  const [view, setView] = useState<ViewMode>("home");
  const [loading, setLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectDirectory, setProjectDirectory] = useState(DEFAULT_PROJECT_ROOT);
  const [createMode, setCreateMode] = useState<CreateMode>(CREATE_MODES.script);
  const [styleMode, setStyleMode] = useState<StyleMode>(STYLE_OPTIONS[0]);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const items = await invoke<ProjectInfo[]>("list_projects");
      setProjects(items);
      setSelectedProjectId((prev) => {
        if (!prev && items.length > 0) return items[0].id;
        if (prev && !items.some((item) => item.id === prev) && items.length > 0) return items[0].id;
        return prev;
      });
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        const appVersion = await invoke<string>("get_app_version");
        if (!active) return;
        setVersion(appVersion);
        await loadProjects();
      } catch (error) {
        if (!active) return;
        console.error(error);
      }
    }

    bootstrap();
    return () => {
      active = false;
    };
  }, [loadProjects]);

  useEffect(() => {
    if (!styleMenuOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (!styleDropdownRef.current?.contains(event.target as Node)) {
        setStyleMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setStyleMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [styleMenuOpen]);

  const handlePickWorkspace = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: DEFAULT_PROJECT_ROOT,
      title: "选择项目目录",
    });

    if (typeof selected === "string" && selected.trim()) {
      setProjectDirectory(selected);
    }
  }, []);

  function openCreateModal() {
    setProjectName("");
    setProjectDescription("");
    setProjectDirectory(DEFAULT_PROJECT_ROOT);
    setCreateMode(CREATE_MODES.script);
    setStyleMode(STYLE_OPTIONS[0]);
    setStyleMenuOpen(false);
    setCreateModalOpen(true);
  }

  const handleCreateProject = useCallback(async () => {
    if (!projectName.trim()) {
      await message("请先输入项目名。", { title: APP_NAME, kind: "warning" });
      return;
    }

    setLoading(true);
    try {
      const payload: CreateProjectInput = {
        name: projectName.trim(),
        description: projectDescription.trim() || undefined,
        workspace_path: projectDirectory.trim() || DEFAULT_PROJECT_ROOT,
        input_mode: createMode,
        style_mode: styleMode,
      };

      const project = await invoke<ProjectInfo>("create_project", { input: payload });
      setCreateModalOpen(false);
      setView("projects");
      await loadProjects();
      setSelectedProjectId(project.id);
      await message(`项目已创建：${project.name}`, { title: APP_NAME, kind: "info" });
    } catch (error) {
      console.error(error);
      await message("创建项目失败，请检查目录权限或后端日志。", {
        title: APP_NAME,
        kind: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [projectName, projectDescription, projectDirectory, createMode, styleMode, loadProjects]);

  return (
    <div className="app-shell">
      <DynamicBackdrop />

      {view === "home" ? (
        <section className="home-screen">
          <div className="home-card">
            <div className="brand-badge">{APP_NAME}</div>
            <h1>{APP_NAME}</h1>
            <p>为剧本到完整视频产出的AI工作台</p>

            <div className="home-actions">
              <button type="button" className="primary-button" onClick={openCreateModal}>
                创建项目
              </button>
              <button type="button" className="secondary-button" onClick={() => setView("projects")}>
                项目管理
              </button>
            </div>

            <div className="home-meta">
              <span>版本：{version}</span>
            </div>
          </div>
        </section>
      ) : (
        <section className="projects-screen">
          <aside className="project-sidebar">
            <div className="sidebar-header">
              <div>
                <div className="sidebar-kicker">项目管理</div>
                <h2>{APP_NAME}</h2>
              </div>
              <button type="button" className="ghost-button" onClick={() => setView("home")}>
                返回首页
              </button>
            </div>

            <div className="sidebar-actions">
              <button type="button" className="primary-button" onClick={openCreateModal}>
                创建项目
              </button>
              <button type="button" className="secondary-button" onClick={loadProjects} disabled={projectsLoading}>
                {projectsLoading ? "刷新中..." : "刷新列表"}
              </button>
            </div>

            <div className="project-list">
              {projects.length ? (
                projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className={`project-item ${project.id === selectedProjectId ? "active" : ""}`}
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    <div className="project-item-title">
                      <strong>{project.name}</strong>
                      <span>{project.status}</span>
                    </div>
                    <p>{project.description || "未填写描述"}</p>
                    <small>{project.workspace_path}</small>
                  </button>
                ))
              ) : (
                <div className="empty-panel">还没有项目，先创建一个吧。</div>
              )}
            </div>
          </aside>

          <main className="project-workspace">
            {selectedProject ? (
              <>
                <div className="workspace-header">
                  <div>
                    <div className="workspace-kicker">项目工作区</div>
                    <h2>{selectedProject.name}</h2>
                    <p>{selectedProject.description || "未填写描述"}</p>
                  </div>
                  <div className="workspace-badges">
                    <span>{selectedProject.current_step}</span>
                    <span>{selectedProject.status}</span>
                  </div>
                </div>

                <div className="workspace-summary">
                  <div className="summary-card">
                    <span>工作区目录</span>
                    <strong>{selectedProject.workspace_path}</strong>
                  </div>
                  <div className="summary-card">
                    <span>创建时间</span>
                    <strong>{formatDate(selectedProject.created_at)}</strong>
                  </div>
                </div>

                <div className="workflow-board">
                  {WORKFLOW_STEPS.map((step) => (
                    <div
                      key={step}
                      className={`workflow-step ${compareStep(selectedProject.current_step, step) ? "done" : ""}`}
                    >
                      <span>{step}</span>
                    </div>
                  ))}
                </div>

                <div className="workspace-grid">
                  <section className="workspace-panel">
                    <h3>当前项目概览</h3>
                    <p>
                      这里后续会接入剧本导入、自动拆分镜、角色场景物品生成、分镜编辑、融合生成和视频产出。
                    </p>
                  </section>
                  <section className="workspace-panel">
                    <h3>后续操作区</h3>
                    <p>你可以在这里继续放置片段列表、分镜预览、任务队列和生成结果。</p>
                  </section>
                </div>
              </>
            ) : (
              <div className="empty-workspace">
                <h2>选择一个项目开始工作</h2>
                <p>左侧选择项目后，这里会显示项目工作区、片段、分镜和任务流程。</p>
              </div>
            )}
          </main>
        </section>
      )}

      {createModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-project-title"
          onClick={() => setCreateModalOpen(false)}
        >
          <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2 id="create-project-title" style={{ margin: 0, fontSize: 20 }}>创建新项目</h2>
              <button
                type="button"
                className="icon-button modal-close-button"
                aria-label="关闭创建项目弹窗"
                onClick={() => setCreateModalOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="modal-form">
              <label className="field">
                <span>项目名</span>
                <input
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="请输入项目名"
                />
              </label>

              <label className="field">
                <span>项目目录</span>
                <div className="inline-input">
                  <input
                    value={projectDirectory}
                    onChange={(event) => setProjectDirectory(event.target.value)}
                    placeholder={DEFAULT_PROJECT_ROOT}
                  />
                  <button type="button" className="ghost-button" onClick={handlePickWorkspace}>
                    选择目录
                  </button>
                </div>
              </label>

              <label className="field">
                <span>创建模式</span>
                <div className="segmented">
                  <button
                    type="button"
                    className={createMode === CREATE_MODES.manual ? "active" : ""}
                    onClick={() => setCreateMode(CREATE_MODES.manual)}
                  >
                    {CREATE_MODE_OPTIONS[0].label}
                  </button>
                  <button
                    type="button"
                    className={createMode === CREATE_MODES.script ? "active" : ""}
                    onClick={() => setCreateMode(CREATE_MODES.script)}
                  >
                    {CREATE_MODE_OPTIONS[1].label}
                  </button>
                </div>
              </label>

              <label className="field">
                <span>创作风格</span>
                <div className="select-shell" ref={styleDropdownRef}>
                  <button
                    type="button"
                    className={`select-trigger ${styleMenuOpen ? "open" : ""}`}
                    aria-haspopup="listbox"
                    aria-expanded={styleMenuOpen}
                    onClick={() => setStyleMenuOpen((openState) => !openState)}
                  >
                    <span>{styleMode}</span>
                    <span className="select-caret" aria-hidden="true" />
                  </button>

                  {styleMenuOpen ? (
                    <div className="select-menu" role="listbox" aria-label="创作风格">
                      {STYLE_OPTIONS.map((option) => (
                        <button
                          key={option}
                          type="button"
                          role="option"
                          className={`select-option ${option === styleMode ? "active" : ""}`}
                          aria-selected={option === styleMode}
                          onClick={() => {
                            setStyleMode(option);
                            setStyleMenuOpen(false);
                          }}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </label>
            </div>

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setCreateModalOpen(false)}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={handleCreateProject} disabled={loading}>
                {loading ? "创建中..." : "确认创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
