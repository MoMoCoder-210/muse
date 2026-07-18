import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export interface StartupStatusPayload {
  status: "ready" | "error";
  db_ok: boolean;
  ffmpeg_ok: boolean;
  worker_ok: boolean;
  message: string;
}

type Props = {
  onReady: () => void;
};

/**
 * 启动检测页面。
 *
 * 挂载后主动查询后端启动状态，同时监听 `startup-status` 事件。
 * - 检测中：显示品牌 Logo 和旋转动画
 * - 失败：显示错误信息
 * - 就绪后自动调用 onReady 进入主界面
 */
export function StartupScreen({ onReady }: Props) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    invoke<StartupStatusPayload | null>("get_startup_status")
      .then((result) => {
        if (cancelled) return;
        if (result) {
          handlePayload(result);
        }
      })
      .catch(() => {});

    const unlisten = listen<StartupStatusPayload>("startup-status", (event) => {
      if (cancelled) return;
      handlePayload(event.payload);
    });

    function handlePayload(p: StartupStatusPayload) {
      if (p.status === "ready") {
        setTimeout(() => onReady(), 400);
      } else if (p.status === "error") {
        setErrorMessage(p.message);
      }
    }

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [onReady]);

  return (
    <section className="startup-screen">
      <div className="startup-card">
        <h1 className="startup-title">Muse</h1>

        {errorMessage ? (
          <div className="startup-error">
            <p className="startup-error-title">启动失败</p>
            <p className="startup-error-detail">{errorMessage}</p>
            <p className="startup-error-hint">
              请检查日志文件或确认运行环境完整后重启应用。
            </p>
          </div>
        ) : (
          <div className="startup-loading">
            <span className="startup-spinner" />
            <span className="startup-loading-text">正在启动…</span>
          </div>
        )}
      </div>
    </section>
  );
}
