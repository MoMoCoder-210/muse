import { useCallback, useState } from "react";
import { listProjects } from "../services/tauri";
import type { ProjectInfo } from "../types/project";

export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<ProjectInfo[]> => {
    setLoading(true);
    try {
      const items = await listProjects();
      setProjects(items);
      return items;
    } finally {
      setLoading(false);
    }
  }, []);

  return { projects, loading, load };
}
