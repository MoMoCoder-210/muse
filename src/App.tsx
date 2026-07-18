import { useCallback, useEffect, useState } from "react";
import { getAppVersion } from "./services/tauri";
import { DynamicBackdrop } from "./components/layout/DynamicBackdrop";
import { TitleBar } from "./components/layout/TitleBar";


import { HomePage } from "./components/home/HomePage";
import { ProjectManagementPage } from "./components/project/ProjectManagementPage";
import { CreateProjectModal } from "./components/project/CreateProjectModal";
import { SettingsPage } from "./components/settings/SettingsPage";
import { ToastProvider, useToast } from "./hooks/useToast";
import { useWorkerStatus } from "./hooks/useWorkerStatus";
import type { WorkerStatusPayload } from "./hooks/useWorkerStatus";
import { StartupScreen } from "./components/layout/StartupScreen";

type ViewMode = "home" | "projects";

/**
 * 内部组件：监听 Worker 生命周期事件并通过 Toast 提示用户。
 * 必须放在 ToastProvider 内部。
 */
function WorkerStatusMonitor() {
  const { toast } = useToast();

  useWorkerStatus((payload: WorkerStatusPayload) => {
    switch (payload.status) {
      case "restarting":
        toast(payload.message, "warning");
        break;
      case "restarted":
        toast(payload.message, "success");
        break;
      case "start_failed":
        toast(payload.message, "error");
        break;
      case "max_restarts":
        toast(payload.message, "error");
        break;
      default:
        toast(payload.message, "warning");
    }
  });

  return null;
}

/**
 * 应用根组件
 *
 * 启动流程：显示 StartupScreen 等待后端健康检测 → 全部通过后进入主界面。
 *
 */
export default function App() {
  const [startupReady, setStartupReady] = useState(false);
  const [view, setView] = useState<ViewMode>("home");
  const [version, setVersion] = useState("unknown");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);


  useEffect(() => {
    getAppVersion().then(setVersion).catch(() => {
      // 版本号获取失败，保持默认 "unknown"，不打扰用户
    });
  }, []);

  const handleCreated = useCallback(() => {
    setCreateModalOpen(false);
    setView("projects");
  }, []);

  const handleStartupReady = useCallback(() => {
    setStartupReady(true);
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
        />


        {view === "home" ? (
          <HomePage
            version={version}
            onCreateProject={() => setCreateModalOpen(true)}
            onGoToProjects={() => setView("projects")}
          />
        ) : (
          <ProjectManagementPage
            onGoHome={() => setView("home")}
          />
        )}

        {createModalOpen ? (
          <CreateProjectModal
            onClose={() => setCreateModalOpen(false)}
            onCreated={handleCreated}
          />
        ) : null}

        {settingsOpen ? (
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        ) : null}

      </div>
    </ToastProvider>
  );
}
