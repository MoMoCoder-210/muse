import { useEffect, useState } from "react";

export default function App() {
  const [dbStatus, setDbStatus] = useState<string>("checking...");

  useEffect(() => {
    // 检查 Tauri 环境是否可用
    if (typeof window !== "undefined" && "__TAURI__" in window) {
      setDbStatus("Tauri 环境已就绪");
    } else {
      setDbStatus("浏览器模式（Tauri 未启动）");
    }
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Desktop Lite</h1>
        <p>桌面端轻量版视频创作工具</p>
      </header>
      <main className="app-main">
        <p>状态: {dbStatus}</p>
        <p>项目初始化完成，等待功能开发。</p>
      </main>
    </div>
  );
}
