import { useCallback, useState } from "react";
import { listProjects } from "../services/tauri";
import type { ProjectInfo } from "../types/project";

/**
 * 项目管理 Hook
 *
 * 提供项目列表的加载、缓存与刷新能力。
 *
 * @author yt @date 20260702
 */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<ProjectInfo[]> => {
    setLoading(true);
    setError(null);
    try {
      const items = await listProjects();
      setProjects(items);
      return items;
    } catch (err) {
      const message = err instanceof Error ? err.message : "项目列表加载失败";
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { projects, loading, error, load };
}
