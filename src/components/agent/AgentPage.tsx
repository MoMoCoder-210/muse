/**
 * AgentPage：AI Agent 画布 + 对话抽屉 + 复用 ProjectSidebar
 *
 * Demo 版本：UI 先行。
 */
import { useState, useRef, useEffect } from "react";
import type { ProjectInfo } from "../../types/project";
import { listProjects } from "../../services/tauri";
import { ProjectSidebar } from "../project/ProjectSidebar";
import {
  ReactFlow, Controls, MiniMap,
  useNodesState, useEdgesState,
} from "reactflow";
import type { Node } from "reactflow";
import "reactflow/dist/style.css";

let toolsRegistered = false;

type DemoMessage = { role: "user" | "assistant"; content: string };

const WELCOME = `我是 Muse Agent，你的创作助手。

• 查询作品、分集、素材状态
• 生成素材图片 / 镜头视频
• AI 超分素材或镜头
• 管理镜头与导出设置

请选择作品后输入你的需求。`;

type Props = {
  project: ProjectInfo | null;
  onSelectProject: (p: ProjectInfo) => void;
};

export function AgentPage({ project, onSelectProject }: Props) {
  // ── 画布 ───────────────────────────────────────
  const [nodes, , onNodesChange] = useNodesState([] as Node[]);
  const [edges, , onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    if (!toolsRegistered) {
      toolsRegistered = true;
      import("../../agent/tools");
    }
  }, []);

  // ── 侧边栏（复用 ProjectSidebar + grabber）───────
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  useEffect(() => {
    listProjects().then(setProjects).catch(() => {});
    const t = setInterval(() => listProjects().then(setProjects).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, []);

  // ── 对话 ───────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [input, setInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [...prev,
      { role: "user", content: text },
      { role: "assistant", content: `收到："${text}"\n\n这是 Demo 阶段，真实调用将在后续接入。` },
    ]);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={`agent-page${sidebarOpen ? " agent-page--sidebar-open" : ""}`}>
      <div className="agent-main">
        {/* 侧边栏收起时的窄把手 — 与手动模式完全一致 */}
        {!sidebarOpen && (
          <div
            className="sidebar-grabber"
            onClick={() => setSidebarOpen(true)}
            title="展开作品列表"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}

        {/* 复用现有 ProjectSidebar 抽屉 */}
        <div className={`sidebar-drawer${sidebarOpen ? " sidebar-drawer--open" : ""}`}>
          <ProjectSidebar
            projects={projects}
            selectedProjectId={project?.id ?? ""}
            onSelectProject={(id) => {
              const found = projects.find((p) => p.id === id);
              if (found) {
                onSelectProject(found);
                setSidebarOpen(false);
              }
            }}
            onCreateProject={() => {}}
            onDeleteProject={() => {}}
            onGoHome={() => {}}
          />
        </div>

        {/* 画布 */}
        <div className="agent-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Controls className="agent-canvas__controls" showInteractive={false} />
            {nodes.length > 0 && (
              <MiniMap
                className="agent-canvas__minimap"
                nodeColor="rgba(79,195,247,0.3)"
                maskColor="rgba(0,0,0,0.6)"
                style={{ background: "rgba(20,20,40,0.9)" }}
              />
            )}
          </ReactFlow>


        </div>

        {/* 右下角悬浮聊天气泡按钮 — 仅对话关闭时显示 */}
        {!drawerOpen && (
        <button
          className="agent-fab"
          onClick={() => setDrawerOpen(true)}
          type="button"
          title="展开对话"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="18" height="13" rx="2" />
            <circle cx="8" cy="13" r="1.2" fill="currentColor" />
            <circle cx="12" cy="13" r="1.2" fill="currentColor" />
            <circle cx="16" cy="13" r="1.2" fill="currentColor" />
          </svg>
        </button>
        )}

        {/* 右侧对话抽屉 */}
        <div className={`agent-drawer${drawerOpen ? " agent-drawer--open" : ""}`}>
          <div className="agent-drawer__inner">
            <div className="agent-drawer__messages">
              {messages.length === 0 && (
                <div className="agent-drawer__welcome">
                  {WELCOME.split("\n").map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`agent-bubble${msg.role === "user" ? " agent-bubble--user" : ""}`}>
                  <p>{msg.content}</p>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="agent-drawer__input">
              <div className="agent-drawer__input-box">
                <textarea
                  className="agent-drawer__textarea"
                  rows={2}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入指令… (Enter 发送，Shift+Enter 换行)"
                />
                <div className="agent-drawer__input-bar">
                  <span className="agent-drawer__token-info" title="上下文用量">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    <span>0/128K</span>
                  </span>
                  <button className="agent-drawer__send" onClick={handleSend} disabled={!input.trim()} type="button">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
