/**
 * 应用入口
 *
 * 初始化主题并挂载 App 组件。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme } from "./config/theme";

// 在渲染前注入主题 CSS 变量，避免页面闪烁
applyTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
