import { useCallback, useEffect, useState } from "react";
import { getAppVersion } from "./services/tauri";
import { DynamicBackdrop } from "./components/layout/DynamicBackdrop";
import { HomePage } from "./components/home/HomePage";
import { ProjectManagementPage } from "./components/project/ProjectManagementPage";
import { CreateProjectModal } from "./components/project/CreateProjectModal";
import { SettingsPage } from "./components/settings/SettingsPage";
import { ToastProvider } from "./hooks/useToast";

type ViewMode = "home" | "projects";

/**
 * 应用根组件
 *
 * 管理页面路由（首页/项目管理）、版本信息、弹窗状态。
 *
 * @author yt @date 20260702
 */
export default function App() {
  const [view, setView] = useState<ViewMode>("home");
  const [version, setVersion] = useState("unknown");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(console.error);
  }, []);

  const handleCreated = useCallback(() => {
    setCreateModalOpen(false);
    setView("projects");
  }, []);

  return (
    <ToastProvider>
      <div className="app-shell">
        <DynamicBackdrop />

        {view === "home" ? (
          <HomePage
            version={version}
            onCreateProject={() => setCreateModalOpen(true)}
            onGoToProjects={() => setView("projects")}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <ProjectManagementPage
            onGoHome={() => setView("home")}
            onOpenSettings={() => setSettingsOpen(true)}
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
