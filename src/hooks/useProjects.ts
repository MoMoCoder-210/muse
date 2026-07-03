import { useCallback, useEffect, useRef, useState } from "react";
import { listProjects } from "../services/tauri";
import type { ProjectInfo } from "../types/project";

/**
 * 项目管理 Hook
 *
 * 提供项目列表的加载、实时轮询与缓存能力。
 * 每 3 秒自动拉取最新列表，确保列表始终为最新状态。
 *
 * @author yt @date 20260702
 */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);

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

  // 实时轮询：每 1 秒刷新一次项目列表
  useEffect(() => {
    load().then(() => { mountedRef.current = true; });
    const timer = setInterval(() => {
      listProjects()
        .then(setProjects)
        .catch(() => { /* 轮询失败静默，保留上一次数据 */ });
    }, 1000);
    return () => clearInterval(timer);
  }, [load]);

  return { projects, loading, error, load };
}
