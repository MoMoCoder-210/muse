import { useCallback, useEffect, useState } from "react";
import { getAppVersion } from "./services/tauri";
import { initGpuDetect } from "./services/gpu";
import { DynamicBackdrop } from "./components/layout/DynamicBackdrop";
import { TitleBar } from "./components/layout/TitleBar";
import { HomePage } from "./components/home/HomePage";
import { ProjectManagementPage } from "./components/project/ProjectManagementPage";
import { CreateProjectModal } from "./components/project/CreateProjectModal";
import { SettingsPage } from "./components/settings/SettingsPage";
import { AgentPage } from "./components/agent/AgentPage";
import { ToastProvider, useToast } from "./hooks/useToast";
import { useWorkerStatus } from "./hooks/useWorkerStatus";
import type { WorkerStatusPayload } from "./hooks/useWorkerStatus";
import type { ProjectInfo } from "./types/project";
import { StartupScreen } from "./components/layout/StartupScreen";

type ViewMode = "home" | "projects";

function WorkerStatusMonitor() {
  const { toast } = useToast();
  useWorkerStatus((payload: WorkerStatusPayload) => {
    switch (payload.status) {
      case "restarting": toast(payload.message, "warning"); break;
      case "restarted": toast(payload.message, "success"); break;
      case "start_failed": toast(payload.message, "error"); break;
      case "max_restarts": toast(payload.message, "error"); break;
      default: break;
    }
  });
  return null;
}

export default function App() {
  const [startupReady, setStartupReady] = useState(false);
  const [view, setView] = useState<ViewMode>("home");
  const [version, setVersion] = useState("unknown");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Agent 模式 — 随时可进入，不依赖是否选中作品
  const [isAgentMode, setIsAgentMode] = useState(false);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);

  useEffect(() => {
    getAppVersion().then(setVersion).catch(() => {});
    initGpuDetect();
  }, []);

  const handleCreated = useCallback(() => {
    setCreateModalOpen(false);
    setView("projects");
  }, []);

  const handleStartupReady = useCallback(() => setStartupReady(true), []);

  const handleEnterAgent = useCallback(() => setIsAgentMode(true), []);
  const handleExitAgent = useCallback(() => setIsAgentMode(false), []);

  const handleGoHome = useCallback(() => {
    setView("home");
    setIsAgentMode(false);
    setSelectedProject(null);
  }, []);

  if (!startupReady) {
    return <StartupScreen onReady={handleStartupReady} />;
  }

  return (
    <ToastProvider>
      <WorkerStatusMonitor />
      <div className="app-shell">
        <DynamicBackdrop />

        <TitleBar
          onOpenSettings={() => setSettingsOpen(true)}
          onEnterAgent={handleEnterAgent}
          isAgentMode={isAgentMode}
          onExitAgent={handleExitAgent}
          projectName={isAgentMode ? selectedProject?.name ?? null : null}
        />

        {isAgentMode ? (
          <AgentPage
            project={selectedProject}
            onSelectProject={setSelectedProject}
          />
        ) : view === "home" ? (
          <HomePage
            version={version}
            onCreateProject={() => setCreateModalOpen(true)}
            onGoToProjects={() => setView("projects")}
          />
        ) : (
          <ProjectManagementPage
            onGoHome={handleGoHome}
            onSelectedProjectChange={setSelectedProject}
          />
        )}

        {createModalOpen && (
          <CreateProjectModal
            onClose={() => setCreateModalOpen(false)}
            onCreated={handleCreated}
          />
        )}

        {settingsOpen && (
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        )}
      </div>
    </ToastProvider>
  );
}
