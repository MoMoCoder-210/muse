/** Agent canvas page: read-only project hierarchy plus the existing demo chat. */
import { useState, useRef, useEffect, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Edge, Node, ReactFlowInstance } from "reactflow";
import { Controls, MiniMap, ReactFlow, useEdgesState, useNodesState } from "reactflow";
import type { ProjectInfo } from "../../types/project";
import { getProjectCanvasReadModel, listProjects, type ProjectCanvasReadModel } from "../../services/tauri";
import { ProjectSidebar } from "../project/ProjectSidebar";
import { adaptCanvasDisclosure, agentExecutingCanvasExpandedIds, agentNodeTypes, buildCanvas, defaultCanvasExpandedIds, CanvasInteractionProvider } from "../../agent/canvas";
import type { CanvasFlowNodeData, CanvasNodeData, StoryboardAssetReference } from "../../agent/canvas";
import "reactflow/dist/style.css";

let toolsRegistered = false;
type DemoMessage = { role: "user" | "assistant"; content: string };
type CanvasNodePosition = { x: number; y: number };
type CanvasPositionOverrides = Record<string, Record<string, CanvasNodePosition>>;
const CANVAS_REFRESH_MS = 15_000;
const PROJECT_LIST_REFRESH_MS = 10_000;
const CANVAS_POSITION_STORAGE_KEY = "muse.agent-canvas.positions.v2";
const FIT_VIEW_OPTIONS = { padding: 0.16, maxZoom: 0.9 };
const WELCOME = `我是 Muse Agent，你的创作助手。

• 查询作品、分集、素材状态
• 生成素材图片 / 镜头视频
• AI 超分素材或镜头
• 管理镜头与导出设置

请选择作品后输入你的需求。`;
type Props = { project: ProjectInfo | null; onSelectProject: (project: ProjectInfo) => void };

export function AgentPage({ project, onSelectProject }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [canvasLoading, setCanvasLoading] = useState(false);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node<CanvasNodeData> | null>(null);
  const [expandedByProject, setExpandedByProject] = useState<Record<string, string[]>>({});
  const projectRef = useRef<ProjectInfo | null>(project);
  const readModelRef = useRef<ProjectCanvasReadModel | null>(null);
  const expandedByProjectRef = useRef<Record<string, string[]>>({});
  const positionsByProjectRef = useRef<CanvasPositionOverrides>(readCanvasPositionOverrides());
  const selectedNodeIdRef = useRef<string | null>(null);
  const canvasGenerationRef = useRef(0);
  const loadingRequestRef = useRef<string | null>(null);
  const loadedProjectIdRef = useRef<string | null>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const viewportRestoreFrameRef = useRef<number | null>(null);

  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { expandedByProjectRef.current = expandedByProject; }, [expandedByProject]);
  useEffect(() => { if (!toolsRegistered) { toolsRegistered = true; import("../../agent/tools"); } }, []);

  const clearSelectedNode = useCallback(() => { selectedNodeIdRef.current = null; setSelectedNode(null); }, []);
  const expandedIdsFor = useCallback((model: ProjectCanvasReadModel) => {
    const expanded = new Set(expandedByProjectRef.current[model.project.id] ?? [...defaultCanvasExpandedIds(model)]);
    for (const id of agentExecutingCanvasExpandedIds(model)) expanded.add(id);
    return expanded;
  }, []);

  const applyCanvas = useCallback((nextNodes: Node<CanvasFlowNodeData>[], nextEdges: Edge[], isInitialLoad: boolean, centerNodeId?: string) => {
    const previousViewport = isInitialLoad ? undefined : flowRef.current?.getViewport();
    const selectedNodeId = selectedNodeIdRef.current;
    const projectId = nextNodes[0]?.data.projectId;
    const savedPositions = projectId ? positionsByProjectRef.current[projectId] ?? {} : {};
    const projectedNodes = nextNodes.map((node) => ({
      ...node,
      position: isCanvasContentDraggable(node) && node.data.entityType !== "asset" ? savedPositions[node.id] ?? node.position : node.position,
      draggable: isCanvasContentDraggable(node),
      selected: node.id === selectedNodeId,
    }));
    const boundedNodes = projectedNodes.map((node) => isCanvasContentDraggable(node)
      ? { ...node, position: constrainCanvasNodePosition(node, node.position, projectedNodes) }
      : node);
    const selectedProjection = selectedNodeId ? boundedNodes.find((node) => node.id === selectedNodeId) : null;
    setNodes(boundedNodes);
    setEdges(nextEdges);
    setSelectedNode(() => {
      if (!selectedProjection || !isBusinessCanvasNode(selectedProjection)) {
        if (selectedNodeId) selectedNodeIdRef.current = null;
        return null;
      }
      return selectedProjection;
    });
    if (viewportRestoreFrameRef.current != null) cancelAnimationFrame(viewportRestoreFrameRef.current);
    viewportRestoreFrameRef.current = requestAnimationFrame(() => {
      if (centerNodeId && boundedNodes.some((node) => node.id === centerNodeId)) {
        flowRef.current?.fitView({ nodes: [{ id: centerNodeId }], padding: 0.65, maxZoom: 1.1, duration: 260 });
      } else if (isInitialLoad) {
        flowRef.current?.fitView(FIT_VIEW_OPTIONS);
      } else if (previousViewport) {
        flowRef.current?.setViewport(previousViewport);
      }
      viewportRestoreFrameRef.current = null;
    });
  }, [setEdges, setNodes]);

  const refreshCanvas = useCallback(async (projectId: string, generation: number, showLoading: boolean, centerNodeId?: string) => {
    const requestKey = `${generation}:${projectId}`;
    if (loadingRequestRef.current === requestKey) return;
    if (projectRef.current?.id !== projectId) return;
    loadingRequestRef.current = requestKey;
    if (showLoading) setCanvasLoading(true);
    try {
      // The canvas makes exactly one project-scoped IPC request per refresh.
      const model = await getProjectCanvasReadModel(projectId);
      if (canvasGenerationRef.current !== generation || projectRef.current?.id !== projectId) return;
      const projection = buildCanvas(model, expandedIdsFor(model), positionsByProjectRef.current[model.project.id] ?? {});
      readModelRef.current = model;
      applyCanvas(projection.nodes, projection.edges, loadedProjectIdRef.current !== projectId, centerNodeId);
      loadedProjectIdRef.current = projectId;
      setCanvasError(null);
    } catch {
      // Keep the most recent successful graph, selection, and viewport usable.
      if (canvasGenerationRef.current === generation && projectRef.current?.id === projectId) setCanvasError("画布数据暂时无法刷新，正在保留最近一次成功结果。");
    } finally {
      if (loadingRequestRef.current === requestKey) loadingRequestRef.current = null;
      if (canvasGenerationRef.current === generation && projectRef.current?.id === projectId) setCanvasLoading(false);
    }
  }, [applyCanvas, expandedIdsFor]);

  useEffect(() => {
    const generation = ++canvasGenerationRef.current;
    loadedProjectIdRef.current = null;
    readModelRef.current = null;
    clearSelectedNode();
    if (!project) { setNodes([]); setEdges([]); setCanvasError(null); return () => {}; }
    void refreshCanvas(project.id, generation, true);
    const timer = window.setInterval(() => void refreshCanvas(project.id, generation, false), CANVAS_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      if (viewportRestoreFrameRef.current != null) { cancelAnimationFrame(viewportRestoreFrameRef.current); viewportRestoreFrameRef.current = null; }
    };
  }, [clearSelectedNode, project?.id, refreshCanvas, setEdges, setNodes]);

  const updateExpanded = useCallback((projectId: string, nextIds: string[]) => {
    expandedByProjectRef.current = { ...expandedByProjectRef.current, [projectId]: nextIds };
    setExpandedByProject(expandedByProjectRef.current);
  }, []);
  const toggleExpanded = useCallback((canonicalId: string) => {
    const activeProject = projectRef.current;
    const model = readModelRef.current;
    if (!activeProject || !model || model.project.id !== activeProject.id) return;
    const next = expandedIdsFor(model);
    if (next.has(canonicalId)) next.delete(canonicalId); else next.add(canonicalId);
    updateExpanded(activeProject.id, [...next]);
    void refreshCanvas(activeProject.id, canvasGenerationRef.current, false);
  }, [expandedIdsFor, refreshCanvas, updateExpanded]);
  const revealReferencedAsset = useCallback((asset: StoryboardAssetReference) => {
    const activeProject = projectRef.current;
    const model = readModelRef.current;
    if (!activeProject || !model || model.project.id !== activeProject.id) return;
    const effect = adaptCanvasDisclosure({ projectId: activeProject.id, target: { kind: "asset", id: asset.assetId } }, model);
    if (!effect) return;
    const expanded = expandedIdsFor(model);
    for (const id of effect.expandedCanonicalIds) expanded.add(id);
    updateExpanded(activeProject.id, [...expanded]);
    selectedNodeIdRef.current = effect.selectedCanonicalId;
    void refreshCanvas(activeProject.id, canvasGenerationRef.current, false, effect.centerCanonicalId);
  }, [expandedIdsFor, refreshCanvas, updateExpanded]);
  const selectCanvasNode = useCallback((node: Node<CanvasFlowNodeData>) => {
    if (!isBusinessCanvasNode(node)) return;
    selectedNodeIdRef.current = node.id;
    setSelectedNode(node);
  }, []);
  const persistCanvasNodePosition = useCallback((node: Node<CanvasFlowNodeData>) => {
    const activeProject = projectRef.current;
    if (!activeProject || !isCanvasContentDraggable(node)) return;
    const visibleNodes = flowRef.current?.getNodes() as Node<CanvasFlowNodeData>[] | undefined;
    const canvasNodes = visibleNodes ?? nodes;
    const position = constrainCanvasNodePosition(node, node.position, canvasNodes);
    const storedPosition = node.data.entityType === "asset" ? relativeMaterialPosition(node, position, canvasNodes) : position;
    const positions = positionsByProjectRef.current[activeProject.id] ?? {};
    const nextPositions = { ...positionsByProjectRef.current, [activeProject.id]: { ...positions, [node.id]: storedPosition } };
    positionsByProjectRef.current = nextPositions;
    writeCanvasPositionOverrides(nextPositions);
    setNodes((current) => current.map((item) => item.id === node.id ? { ...item, position } : item));
    if (node.data.entityType === "asset") void refreshCanvas(activeProject.id, canvasGenerationRef.current, false);
  }, [nodes, refreshCanvas, setNodes]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  useEffect(() => {
    const refreshProjects = () => { void listProjects().then(setProjects).catch(() => {}); };
    refreshProjects();
    const timer = window.setInterval(refreshProjects, PROJECT_LIST_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const onSelectProjectWrapped = useCallback((nextProject: ProjectInfo) => { onSelectProject(nextProject); setSidebarOpen(false); }, [onSelectProject]);

  const [drawerOpen, setDrawerOpen] = useState(true);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [input, setInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  const handleSend = () => {
    const text = input.trim(); if (!text) return;
    setMessages((current) => [...current, { role: "user", content: text }, { role: "assistant", content: `收到：“${text}”\n\n这是 Demo 阶段，真实调用将在后续接入。` }]);
    setInput("");
  };
  const handleKeyDown = (event: React.KeyboardEvent) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); handleSend(); } };
  const activeExpanded = readModelRef.current ? expandedIdsFor(readModelRef.current) : new Set<string>();

  return <div className={`agent-page${sidebarOpen ? " agent-page--sidebar-open" : ""}`}><div className="agent-main">
    {!sidebarOpen && <button className="sidebar-grabber" onClick={() => setSidebarOpen(true)} type="button" title="展开作品列表" aria-label="展开作品列表"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
    <div className={`sidebar-drawer${sidebarOpen ? " sidebar-drawer--open" : ""}`}><ProjectSidebar projects={projects} selectedProjectId={project?.id ?? ""} onSelectProject={(projectId) => { const nextProject = projects.find((item) => item.id === projectId); if (nextProject) onSelectProjectWrapped(nextProject); }} onCreateProject={() => {}} onDeleteProject={() => {}} onGoHome={() => {}} /></div>
    <div className="agent-canvas">
      <CanvasInteractionProvider expandedIds={activeExpanded} onToggleExpanded={toggleExpanded} onAssetPillClick={revealReferencedAsset}>
        <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_, node) => selectCanvasNode(node)} onNodeDragStop={(_, node) => persistCanvasNodePosition(node)} onPaneClick={clearSelectedNode} onInit={(instance) => { flowRef.current = instance; }} nodeTypes={agentNodeTypes} nodesConnectable={false} nodesDraggable panOnDrag proOptions={{ hideAttribution: true }}>
          <Controls className="agent-canvas__controls" showInteractive={false} />
          {nodes.length > 0 && <MiniMap className="agent-canvas__minimap" nodeColor="rgba(117, 143, 164, 0.48)" maskColor="rgba(20, 25, 31, 0.7)" style={{ background: "rgba(35, 42, 50, 0.78)" }} />}
        </ReactFlow>
      </CanvasInteractionProvider>
      {canvasLoading && <div className="agent-canvas__loading"><span className="agent-canvas__loading-spin" />加载画布数据…</div>}
      {canvasError && <div className="agent-canvas__notice" role="status">{canvasError}</div>}
    </div>
    {selectedNode && <CanvasInspector node={selectedNode} className={drawerOpen ? " agent-inspector--with-chat" : ""} onClose={clearSelectedNode} />}
    {!drawerOpen && <button className="agent-fab" onClick={() => setDrawerOpen(true)} type="button" title="展开对话" aria-label="展开对话"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="8" cy="13" r="1.2" fill="currentColor" /><circle cx="12" cy="13" r="1.2" fill="currentColor" /><circle cx="16" cy="13" r="1.2" fill="currentColor" /></svg></button>}
    <div className={`agent-drawer${drawerOpen ? " agent-drawer--open" : ""}`}><div className="agent-drawer__inner"><div className="agent-drawer__header"><span>对话助手</span><button className="agent-drawer__close" onClick={() => setDrawerOpen(false)} type="button" title="关闭对话" aria-label="关闭对话">×</button></div><div className="agent-drawer__messages">{messages.length === 0 && <div className="agent-drawer__welcome">{WELCOME.split("\n").map((line, index) => <p key={index}>{line}</p>)}</div>}{messages.map((message, index) => <div key={index} className={`agent-bubble${message.role === "user" ? " agent-bubble--user" : ""}`}><p>{message.content}</p></div>)}<div ref={chatEndRef} /></div><div className="agent-drawer__input"><div className="agent-drawer__input-box"><textarea className="agent-drawer__textarea" rows={2} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} placeholder="输入指令… (Enter 发送，Shift+Enter 换行)" /><div className="agent-drawer__input-bar"><span className="agent-drawer__token-info">0/128K</span><button className="agent-drawer__send" onClick={handleSend} disabled={!input.trim()} type="button" aria-label="发送">↑</button></div></div></div></div></div>
  </div></div>;
}

function readCanvasPositionOverrides(): CanvasPositionOverrides {
  try {
    const stored = window.localStorage.getItem(CANVAS_POSITION_STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const sanitized: CanvasPositionOverrides = {};
    for (const [projectId, projectPositions] of Object.entries(parsed as Record<string, unknown>)) {
      if (!projectPositions || typeof projectPositions !== "object" || Array.isArray(projectPositions)) continue;
      const positions: Record<string, CanvasNodePosition> = {};
      for (const [nodeId, position] of Object.entries(projectPositions as Record<string, unknown>)) {
        if (!position || typeof position !== "object" || Array.isArray(position)) continue;
        const { x, y } = position as Partial<CanvasNodePosition>;
        if (Number.isFinite(x) && Number.isFinite(y)) positions[nodeId] = { x, y };
      }
      if (Object.keys(positions).length) sanitized[projectId] = positions;
    }
    return sanitized;
  } catch { return {}; }
}
function writeCanvasPositionOverrides(positions: CanvasPositionOverrides): void {
  try { window.localStorage.setItem(CANVAS_POSITION_STORAGE_KEY, JSON.stringify(positions)); } catch { /* Storage is optional. */ }
}
function isCanvasContentDraggable(node: Node<CanvasFlowNodeData>): boolean {
  return ["asset", "storyboard", "video", "task", "release-summary", "release-task", "release-output"].includes(node.data.entityType);
}
function canvasCenterForNode(node: Node<CanvasFlowNodeData>): "materials" | "shots" | "release" | null {
  const { entityType } = node.data;
  if (entityType === "asset" || entityType === "image" || (entityType === "task" && node.data.taskKind === "asset")) return "materials";
  if (entityType === "storyboard" || entityType === "video" || entityType === "shot-track" || entityType === "shot-anchor" || (entityType === "task" && node.data.taskKind !== "asset")) return "shots";
  if (entityType === "release-summary" || entityType === "release-task" || entityType === "release-output") return "release";
  if (entityType === "episode-entry") return node.data.centerKind;
  return null;
}
function numericStyleDimension(value: unknown, fallback: number): number { return typeof value === "number" ? value : fallback; }
function estimatedNodeSize(node: Node<CanvasFlowNodeData>): { width: number; height: number } {
  if (node.data.entityType === "asset") return { width: typeof node.style?.width === "number" ? node.style.width : 146, height: node.style?.width === 320 ? 190 : 64 };
  if (node.data.entityType === "storyboard") return { width: 258, height: 132 };
  if (node.data.entityType === "video") {
    const hasPreview = Boolean(node.data.filePath && (!node.data.isUpscaleOutput || node.data.isOutputReady));
    return hasPreview ? { width: 190, height: 134 } : { width: 168, height: 62 };
  }
  if (node.data.entityType === "release-output") return { width: 246, height: 92 };
  return { width: 168, height: 62 };
}
function materialCategoryForNode(node: Node<CanvasFlowNodeData>, nodes: readonly Node<CanvasFlowNodeData>[]): Node<CanvasFlowNodeData> | null {
  if (node.data.entityType !== "asset" || !node.data.parentCanonicalId) return null;
  return nodes.find((candidate) => candidate.id === node.data.parentCanonicalId && candidate.data.entityType === "material-category") ?? null;
}
function relativeMaterialPosition(node: Node<CanvasFlowNodeData>, position: CanvasNodePosition, nodes: readonly Node<CanvasFlowNodeData>[]): CanvasNodePosition {
  const category = materialCategoryForNode(node, nodes);
  return category ? { x: position.x - category.position.x, y: position.y - category.position.y } : position;
}
function constrainCanvasNodePosition(node: Node<CanvasFlowNodeData>, position: CanvasNodePosition, nodes: readonly Node<CanvasFlowNodeData>[]): CanvasNodePosition {
  const { width, height } = estimatedNodeSize(node);
  const category = materialCategoryForNode(node, nodes);
  if (category) {
    // Material categories grow from the drag result, so only their content origin is a hard boundary.
    return { x: Math.max(position.x, category.position.x + 12), y: Math.max(position.y, category.position.y + 48) };
  }
  const center = canvasCenterForNode(node);
  const centerNode = center ? nodes.find((candidate) => candidate.id === `center:${center}`) : null;
  if (!centerNode) return position;
  const centerWidth = numericStyleDimension(centerNode.style?.width, 500);
  const centerHeight = numericStyleDimension(centerNode.style?.height, 420);
  const minimumX = centerNode.position.x + 18;
  const maximumX = centerNode.position.x + Math.max(18, centerWidth - width - 18);
  const minimumY = centerNode.position.y + 54;
  const maximumY = centerNode.position.y + Math.max(54, centerHeight - height - 18);
  return { x: Math.min(Math.max(position.x, minimumX), maximumX), y: Math.min(Math.max(position.y, minimumY), maximumY) };
}

function isBusinessCanvasNode(node: Node<CanvasFlowNodeData>): node is Node<CanvasNodeData> {
  return ["project", "clip", "asset", "storyboard", "image", "video", "task"].includes(node.data.entityType);
}
function CanvasInspector({ node, className, onClose }: { node: Node<CanvasNodeData>; className: string; onClose: () => void }) {
  const data = node.data; const preview = getPreview(data);
  return <aside className={`agent-inspector${className}`} aria-label="画布对象检查器"><div className="agent-inspector__header"><div><span className="agent-inspector__kind">{entityLabel(data.entityType)}</span><h2>{data.title}</h2></div><div className="agent-inspector__actions"><button type="button" onClick={onClose} aria-label="关闭检查器">×</button></div></div>{preview && <div className="agent-inspector__preview">{preview.kind === "image" ? <img src={toMediaUrl(preview.path)} alt={data.title} /> : <video src={toMediaUrl(preview.path)} controls preload="metadata" playsInline />}</div>}<div className="agent-inspector__summary">{inspectorSummary(data)}</div><dl className="agent-inspector__facts"><div><dt>状态</dt><dd>{data.status || "可用"}</dd></div><div><dt>实体 ID</dt><dd title={data.entityId}>{data.entityId}</dd></div></dl><p className="agent-inspector__hint">检查器只展示 Tauri 权威只读投影；业务编辑和生成仍在手动工作区或确认流程中执行。</p></aside>;
}
function getPreview(data: CanvasNodeData): { kind: "image" | "video"; path: string } | null { if (data.entityType === "image") return { kind: "image", path: data.imagePath }; if (data.entityType === "video" && data.filePath && (!data.isUpscaleOutput || data.isOutputReady)) return { kind: "video", path: data.filePath }; if (data.entityType === "asset" && data.selectedImagePath) return { kind: "image", path: data.selectedImagePath }; return null; }
function toMediaUrl(path: string): string { return path.startsWith("http") ? path : convertFileSrc(path); }
function entityLabel(type: CanvasNodeData["entityType"]): string { return ({ project: "作品", clip: "分集", asset: "素材", storyboard: "镜头", image: "图片", video: "视频", task: "任务" })[type]; }
function inspectorSummary(data: CanvasNodeData): string { if (data.entityType === "asset") return data.description || "此素材尚未填写描述。"; if (data.entityType === "storyboard") return data.summary || data.dialogue || "此镜头尚未填写摘要。"; if (data.entityType === "task") return data.error ? `任务失败：${data.error}` : `目标：${data.targetName}`; if (data.entityType === "clip") return data.summary || `${data.assetCount} 个素材，${data.storyboardCount} 个镜头。`; if (data.entityType === "project") return data.description || `${data.clipCount} 个分集。`; if (data.entityType === "image") return `${data.assetName} 的图片。`; return `${data.isUpscaleOutput ? "超分产物" : data.source || "来源未标记"}视频${data.isOutputReady ? "，可在此预览。" : "，产物尚未就绪。"}`; }
