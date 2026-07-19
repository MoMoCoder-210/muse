import { useEffect, useMemo, useState } from "react";
import { APP_NAME } from "../../config/muse";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import { useServiceStatus, type ServiceHealth } from "../../hooks/useServiceStatus";

const HELP_URL = "https://gitee.com/yangtao210/muse";

type TitleBarProps = {
  onOpenSettings: () => void;
};

// 浏览器预览环境（非 Tauri 运行时）下禁用窗口控制，避免调用报错
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * 自定义窗口标题栏
 *
 * 关闭原生装饰后由前端接管：左侧品牌（可拖拽），
 * 右侧设置 / 帮助 与窗口控制（最小化 / 最大化 / 关闭）。
 * 拖拽由 onMouseDown 手动调用 startDragging 实现，双击空白处最大化。
 */
export function TitleBar({ onOpenSettings }: TitleBarProps) {
  const [isMax, setIsMax] = useState(false);
  const services = useServiceStatus();
  const serviceIndicator = useMemo(() => {
    const entries: Array<[string, ServiceHealth]> = [
      ["后端", services.backend],
      ["数据库", services.database],
      ["FFmpeg", services.ffmpeg],
      ["Worker", services.worker],
    ];
    const isLoading = entries.some(([, health]) => health === null);
    const hasError = entries.some(([, health]) => health === false);
    const state = hasError ? "error" : isLoading ? "loading" : "ok";
    const label = state === "ok" ? "全部服务已就绪" : state === "error" ? "服务异常" : "服务检测中";
    const details = entries
      .map(([name, health]) => `${name}：${health === true ? "已就绪" : health === false ? "异常" : "检测中"}`)
      .join("\n");
    return { state, title: `${label}\n${details}` };
  }, [services]);

  useEffect(() => {
    if (!isTauri) return;
    getCurrentWindow().isMaximized().then(setIsMax).catch((e) => console.error("[TitleBar] 读取最大化状态失败:", e));
  }, []);

  const minimize = () => {
    if (!isTauri) return;
    getCurrentWindow().minimize().catch((e) => console.error("[TitleBar] 最小化窗口失败:", e));
  };
  const toggleMax = () => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    win
      .toggleMaximize()
      .then(() => win.isMaximized())
      .then(setIsMax)
      .catch((e) => console.error("[TitleBar] 切换最大化失败:", e));
  };
  const close = () => {
    if (!isTauri) return;
    getCurrentWindow().close().catch((e) => console.error("[TitleBar] 关闭窗口失败:", e));
  };

  // 手动接管拖拽：在标题栏按下左键且非按钮区时启动窗口拖拽，
  // 比 data-tauri-drag-region 更可靠（不受子元素嵌套影响）。
  const onTitleMouseDown = (e: React.MouseEvent) => {
    if (!isTauri) return;
    if (e.button !== 0) return; // 仅响应左键
    if ((e.target as HTMLElement).closest(".tb-actions")) return; // 工具栏按钮区不拖拽
    getCurrentWindow().startDragging().catch((e) => console.error("[TitleBar] 开始拖拽失败:", e));
  };

  const onTitleDoubleClick = (e: React.MouseEvent) => {
    if (!isTauri) return;
    if ((e.target as HTMLElement).closest(".tb-actions")) return;
    toggleMax();
  };

  return (
    <header
      className="app-titlebar"
      onMouseDown={onTitleMouseDown}
      onDoubleClick={onTitleDoubleClick}
    >
      <div className="tb-brand">
        <span className="tb-logo">◆</span>
        <span className="tb-title">{APP_NAME}</span>
      </div>

      <div className="tb-spacer" />

      <div className="tb-actions">
        {/* 单一服务状态标志：悬浮时展示后端、数据库、FFmpeg 与 Worker 明细。 */}
        <span
          className={`tb-status-dot-indicator is-${serviceIndicator.state}`}
          title={serviceIndicator.title}
          aria-label={serviceIndicator.title.replaceAll("\n", "，")}
        />

        <button
          type="button"
          className="tb-btn"
          onClick={onOpenSettings}
          title="设置"
          aria-label="打开设置"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        <button
          type="button"
          className="tb-btn"
          onClick={() => open(HELP_URL).catch(console.error)}
          title="帮助"
          aria-label="打开帮助"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>

        <div className="tb-window-controls">
          <button
            type="button"
            className="tb-btn tb-btn--win"
            onClick={minimize}
            title="最小化"
            aria-label="最小化"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="tb-btn tb-btn--win"
            onClick={toggleMax}
            title={isMax ? "向下还原" : "最大化"}
            aria-label={isMax ? "向下还原" : "最大化"}
          >
            {isMax ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="3.5" y="4.5" width="5.5" height="5.5" />
                <path d="M2 8V2.5h5.5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="2" y="2" width="8" height="8" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="tb-btn tb-btn--win tb-btn--close"
            onClick={close}
            title="关闭"
            aria-label="关闭"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
