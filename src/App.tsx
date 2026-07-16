import { useCallback, useEffect, useState } from "react";
import { getAppVersion } from "./services/tauri";
import { DynamicBackdrop } from "./components/layout/DynamicBackdrop";
import { TitleBar } from "./components/layout/TitleBar";
import { HelpModal } from "./components/layout/HelpModal";
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
 */
export default function App() {
  const [view, setView] = useState<ViewMode>("home");
  const [version, setVersion] = useState("unknown");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    getAppVersion().then(setVersion).catch(() => {
      // 版本号获取失败，保持默认 "unknown"，不打扰用户
    });
  }, []);

  const handleCreated = useCallback(() => {
    setCreateModalOpen(false);
    setView("projects");
  }, []);

  return (
    <ToastProvider>
      <div className="app-shell">
        <DynamicBackdrop />

        <TitleBar
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
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

        {helpOpen ? (
          <HelpModal version={version} onClose={() => setHelpOpen(false)} />
        ) : null}
      </div>
    </ToastProvider>
  );
}
