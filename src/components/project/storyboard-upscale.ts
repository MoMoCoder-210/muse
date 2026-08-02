import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelUpscaleJob,
  detectGpuSupport,
  enqueueUpscale,
  listUpscaleJobs,
  type UpscaleChangedEvent,
  type UpscaleDoneEvent,
  type UpscaleJob,
} from "../../services/tauri";

/**
 * 镜头视频超分 hook。
 *
 * 架构：后端 UpscaleManager 是超分任务的唯一事实来源（队列/状态/进度/持久化/续跑）。
 * 前端只做两件事：
 * 1. 订阅 `upscale-changed` / `upscale-done` 事件更新本地任务列表；
 * 2. 调用 `enqueue_upscale` / `cancel_upscale_job` / `list_upscale_jobs` 触发或查询。
 * 前端不再维护自己的队列/状态机，重启后通过 list_upscale_jobs 恢复全量状态。
 */
export function useStoryboardUpscale() {
  const [jobs, setJobs] = useState<UpscaleJob[]>([]);
  const [gpuOk, setGpuOk] = useState<boolean | null>(null);
  // 防止事件闭包读取过期 jobs：始终用最新列表
  const jobsRef = useRef<UpscaleJob[]>([]);
  jobsRef.current = jobs;

  // 初始：查询全量任务（含上次异常退出后由后端续跑恢复的任务）
  useEffect(() => {
    let disposed = false;
    listUpscaleJobs()
      .then((list) => {
        if (!disposed) setJobs(list);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  // 订阅任务状态变化（upscale-changed：单任务变更，按 id 合并）
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<UpscaleChangedEvent>("upscale-changed", ({ payload }) => {
      if (disposed) return;
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === payload.id);
        if (idx < 0) {
          return [
            ...prev,
            {
              id: payload.id,
              storyboard_id: payload.storyboard_id,
              video_id: payload.video_id,
              input_path: "",
              output_path: "",
              model: "",
              scale: 4,
              status: payload.status,
              percent: payload.percent,
              stage: payload.stage,
              error: payload.error,
              created_at: "",
            },
          ];
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...payload };
        return next;
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 打开镜头页时探测 GPU（无 GPU 则不可超分）
  useEffect(() => {
    let disposed = false;
    detectGpuSupport()
      .then((ok) => {
        if (!disposed) setGpuOk(ok);
      })
      .catch(() => {
        if (!disposed) setGpuOk(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  /** 发起超分：入队（空闲直接执行，忙碌排队）。返回创建的任务或 null */
  const startUpscale = useCallback(async (
    storyboardId: string,
    videoId: string,
    opts?: { model?: string; scale?: number },
  ) => {
    return await enqueueUpscale({
      storyboard_id: storyboardId,
      video_id: videoId,
      model: opts?.model,
      scale: opts?.scale,
    });
  }, []);

  /** 取消指定超分任务 */
  const cancelUpscale = useCallback(async (jobId: string) => {
    try {
      await cancelUpscaleJob(jobId);
    } catch {
      // 尽力而为
    }
  }, []);

  /** 取消正在进行的超分（无参版本，兼容旧调用方） */
  const cancelCurrentUpscale = useCallback(async () => {
    const running = jobsRef.current.find((j) => j.status === "running");
    if (running) {
      await cancelUpscale(running.id);
    }
  }, [cancelUpscale]);

  return {
    jobs,
    gpuOk,
    startUpscale,
    cancelUpscale,
    cancelCurrentUpscale,
  };
}

export type { UpscaleDoneEvent };
