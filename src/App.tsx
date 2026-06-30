import { useCallback, useEffect, useState } from "react";
import { getAppVersion } from "./services/tauri";
import { DynamicBackdrop } from "./components/layout/DynamicBackdrop";
import { HomePage } from "./components/home/HomePage";
import { ProjectManagementPage } from "./components/project/ProjectManagementPage";

type ViewMode = "home" | "projects";

export default function App() {
  const [view, setView] = useState<ViewMode>("home");
  const [version, setVersion] = useState("unknown");
  const [createModalTrigger, setCreateModalTrigger] = useState(false);

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(console.error);
  }, []);

  // 首页点"创建项目"：切到项目管理页并立即弹出创建弹窗
  const handleHomeCreate = useCallback(() => {
    setView("projects");
    setCreateModalTrigger(true);
  }, []);

  // 弹窗触发一次后立即重置，避免重复触发
  const handleModalTriggerConsumed = useCallback(() => {
    setCreateModalTrigger(false);
  }, []);

  return (
    <div className="app-shell">
      <DynamicBackdrop />

      {view === "home" ? (
        <HomePage
          version={version}
          onCreateProject={handleHomeCreate}
          onGoToProjects={() => setView("projects")}
        />
      ) : (
        <ProjectManagementPage
          onGoHome={() => setView("home")}
          autoOpenCreate={createModalTrigger}
          onAutoOpenConsumed={handleModalTriggerConsumed}
        />
      )}
    </div>
  );
}
