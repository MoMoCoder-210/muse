import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Worker 生命周期事件载荷
 */
export interface WorkerStatusPayload {
  status: "crashed" | "restarting" | "restarted" | "max_restarts" | "start_failed";
  worker_id: string;
  message: string;
  attempt: number | null;
  max_attempts: number | null;
}

type WorkerStatusHandler = (payload: WorkerStatusPayload) => void;

/**
 * 监听后端推送的 Worker 生命周期事件。
 *
 * - "restarting"：Worker 崩溃，正在尝试重启
 * - "restarted"：重启成功
 * - "start_failed"：重启失败（单次尝试失败，后续可能继续重试）
 * - "max_restarts"：已达最大重启次数，不再自动恢复
 *
 * @param onStatus 收到状态事件时的回调
 * @returns unlisten 函数（组件卸载时自动调用）
 */
export function useWorkerStatus(onStatus: WorkerStatusHandler) {
  const handlerRef = useRef(onStatus);
  handlerRef.current = onStatus;

  useEffect(() => {
    const unlisten = listen<WorkerStatusPayload>("worker-status", (event) => {
      handlerRef.current(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
