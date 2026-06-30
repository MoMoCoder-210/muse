import { useCallback, useEffect, useState } from "react";
import { getAppVersion } from "./services/tauri";
import { DynamicBackdrop } from "./components/layout/DynamicBackdrop";
import { HomePage } from "./components/home/HomePage";
import { ProjectManagementPage } from "./components/project/ProjectManagementPage";
import { CreateProjectModal } from "./components/project/CreateProjectModal";
import type { ProjectInfo } from "./types/project";

type ViewMode = "home" | "projects";

export default function App() {
  const [view, setView] = useState<ViewMode>("home");
  const [version, setVersion] = useState("unknown");
  const [createModalOpen, setCreateModalOpen] = useState(false);

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(console.error);
  }, []);

  const handleCreated = useCallback((project: ProjectInfo) => {
    setCreateModalOpen(false);
    setView("projects");
  }, []);

  return (
    <div className="app-shell">
      <DynamicBackdrop />

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
    </div>
  );
}
