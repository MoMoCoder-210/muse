import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getRuntimeStatus, type StartupStatusPayload } from "../services/tauri";
import type { WorkerStatusPayload } from "./useWorkerStatus";

export type ServiceHealth = boolean | null;

export interface ServiceStatus {
  backend: ServiceHealth;
  database: ServiceHealth;
  ffmpeg: ServiceHealth;
  worker: ServiceHealth;
}

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const INITIAL_STATUS: ServiceStatus = {
  backend: null,
  database: null,
  ffmpeg: null,
  worker: null,
};

function statusFromStartup(payload: StartupStatusPayload): ServiceStatus {
  return {
    backend: true,
    database: payload.db_ok,
    ffmpeg: payload.ffmpeg_ok,
    worker: payload.worker_ok,
  };
}

/**
 * 汇总壳级服务状态。
 *
 * 启动状态提供初始快照，Worker 生命周期事件会持续覆盖 Worker 字段；每
 * 15 秒再通过 IPC 实时检查数据库、FFmpeg 与 Sidecar 进程。
 */
export function useServiceStatus(): ServiceStatus {
  const [status, setStatus] = useState<ServiceStatus>(INITIAL_STATUS);

  useEffect(() => {
    if (!isTauri) return;

    let disposed = false;
    const refresh = async () => {
      try {
        const payload = await getRuntimeStatus();
        if (disposed) return;
        setStatus(statusFromStartup(payload));
      } catch {
        if (!disposed) {
          setStatus((current) => ({ ...current, backend: false }));
        }
      }
    };

    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(), 15_000);
    const startupUnlisten = listen<StartupStatusPayload>("startup-status", (event) => {
      if (!disposed) {
        setStatus(statusFromStartup(event.payload));
      }
    });
    const workerUnlisten = listen<WorkerStatusPayload>("worker-status", (event) => {
      if (disposed) return;
      setStatus((current) => {
        switch (event.payload.status) {
          case "ready":
          case "restarted":
            return { ...current, backend: true, worker: true };
          case "restarting":
            return { ...current, worker: null };
          case "crashed":
          case "start_failed":
          case "max_restarts":
            return { ...current, worker: false };
          default:
            return current;
        }
      });
    });

    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      startupUnlisten.then((unlisten) => unlisten());
      workerUnlisten.then((unlisten) => unlisten());
    };
  }, []);

  return useMemo(() => status, [status]);
}
