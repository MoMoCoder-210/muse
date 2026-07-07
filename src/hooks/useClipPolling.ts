import { useEffect, useRef, useState, useCallback } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getClipScripts, listClips, listScriptSources } from "../services/tauri";
import type { Clip, ClipScriptInfo, ScriptSourceListItem } from "../types/project";

/** Worker → 前端的片段拆解完成/失败事件 */
type ClipScriptReadyEvent = {
  project_id: string;
  clip_id: string;
  status: "success" | "failed";
  error_message?: string;
};

/**
 * 片段列表数据与轮询 Hook。
 *
 * 负责初始加载、每 3 秒轮询更新 clips/clipScripts/splitStatus。
 *
 * @author yt @date 20260703
 */
export function useClipPolling(projectId: string) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[]>([]);
  const [splitStatus, setSplitStatus] = useState<ScriptSourceListItem["split_status"] | null>(null);
  const [loading, setLoading] = useState(true);
  const pollingRef = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [clipList, csList, srcList] = await Promise.all([
        listClips(projectId),
        getClipScripts(projectId),
        listScriptSources(projectId),
      ]);
      setClips(clipList);
      setClipScripts(csList);
      // 初始化剧本拆分状态
      const activeSource = srcList.find(
        (s) => s.split_status === "pending" || s.split_status === "running"
      );
      setSplitStatus(activeSource?.split_status ?? null);
      // 检测是否有运行中任务，触发持续轮询
      const hasRunning = csList.some(
        (cs) => cs.status === "pending" || cs.status === "running"
      ) || clipList.some((c) => c.status === "running")
        || !!activeSource;
      if (hasRunning) pollingRef.current = true;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [projectId]);

  // 监听 Worker 推送的拆解完成事件，即时刷新片段列表（事件驱动 + 轮询兜底）
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<ClipScriptReadyEvent>("clip-script-ready", (e) => {
      if (e.payload.project_id === projectId) {
        load(true);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [projectId, load]);

  // 拆解执行中时轮询：不依赖状态触发，每次 tick 自行判断
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const [csList, clipList, srcList] = await Promise.all([
          getClipScripts(projectId),
          listClips(projectId),
          listScriptSources(projectId),
        ]);

        const hasRunning = csList.some(
          (cs) => cs.status === "pending" || cs.status === "running"
        ) || clipList.some((c) => c.status === "running");

        // 检测剧本拆分状态
        const activeSource = srcList.find(
          (s) => s.split_status === "pending" || s.split_status === "running"
        );
        setSplitStatus(activeSource?.split_status ?? null);

        // 始终更新 UI，busy 仅控制是否需要继续轮询
        setClipScripts(csList);
        setClips(clipList);

        const isBusy = hasRunning || !!activeSource;
        pollingRef.current = isBusy;
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [projectId]);

  return { clips, clipScripts, splitStatus, loading, load, setClips, setClipScripts };
}
