/** Agent canvas page: project hierarchy plus the existing demo chat. */
import { useState, useRef, useEffect, useCallback, type PointerEvent as ReactPointerEvent } from "react";
import type { Edge, Node, NodeChange, ReactFlowInstance, Viewport } from "reactflow";
import { ControlButton, Controls, ReactFlow, applyNodeChanges, useEdgesState, useNodesState } from "reactflow";
import type { ProjectInfo } from "../../types/project";
import { getProjectCanvasReadModel, listProjects, type ProjectCanvasReadModel } from "../../services/tauri";
import { ProjectSidebar } from "../project/ProjectSidebar";
import { AgentChatDrawer } from "./AgentChatDrawer";
import { CanvasInspector } from "./CanvasInspector";
import { adaptCanvasDisclosure, agentExecutingCanvasExpandedIds, agentNodeTypes, buildCanvas, debugCanvas, defaultCanvasExpandedIds, summarizeCanvasNodes, summarizeCanvasNode, CanvasInteractionProvider } from "../../agent/canvas";
import type { CanvasFlowNodeData, CanvasNodeData, ReleaseOutputNodeData, ReleaseSummaryNodeData, StoryboardAssetReference } from "../../agent/canvas";
import { CANVAS_MAX_POSITION, movableCanvasNode, nodeGroupId, persistedCanvasPosition, restoreCachedCanvasPositions, solveGroupPositions, solveSinglePosition } from "./agent-canvas-constraints";
import type { CanvasNodePosition } from "./agent-canvas-constraints";
import { createCanvasProjectLayout, readCanvasLayoutCache, writeCanvasLayoutCache } from "./agent-canvas-layout-cache";
import type { CanvasLayoutCache } from "./agent-canvas-layout-cache";
import "reactflow/dist/style.css";

let toolsRegistered = false;
type CanvasDragSnapshot = {
  nodeId: string;
  movingIds: string[];
  startPositions: Record<string, CanvasNodePosition>;
  lastValidPositions: Record<string, CanvasNodePosition>;
};
type PendingCanvasResolver = { requestToken: number; resolve: (applied: boolean) => void };
type ManualCanvasPanSnapshot = {
  pointerId: number;
  startX: number;
  startY: number;
  viewport: Viewport;
};
const CANVAS_REFRESH_MS = 15_000;
const PROJECT_LIST_REFRESH_MS = 10_000;
const FIT_VIEW_OPTIONS = { padding: 0.16, maxZoom: 0.9 };
const CANVAS_MIN_ZOOM = 0.25;
const CANVAS_MAX_ZOOM = 1.8;
function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function findCanvasCenterAtPoint(clientX: number, clientY: number): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return Array.from(document.querySelectorAll<HTMLElement>(".cn-center"))
    .find((center) => pointInRect(clientX, clientY, center.getBoundingClientRect())) ?? null;
}

function findBlankSubcanvasAtPoint(clientX: number, clientY: number): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(".react-flow__node"))
    .map((element, index) => ({ element, index, rect: element.getBoundingClientRect(), zIndex: Number.parseInt(getComputedStyle(element).zIndex, 10) || 0 }))
    .filter(({ rect }) => pointInRect(clientX, clientY, rect))
    .sort((left, right) => left.zIndex - right.zIndex || left.index - right.index);
  const topNode = candidates[candidates.length - 1]?.element;
  if (!topNode) return null;
  const subcanvas = topNode.querySelector<HTMLElement>(".cn-center, .cn-category");
  if (!subcanvas || !pointInRect(clientX, clientY, subcanvas.getBoundingClientRect())) return null;
  const header = subcanvas.querySelector<HTMLElement>(".cn-center__header, .cn-category__header");
  return header && pointInRect(clientX, clientY, header.getBoundingClientRect()) ? null : subcanvas;
}

type Props = { project: ProjectInfo | null; onSelectProject: (project: ProjectInfo) => void; onGoHome: () => void };

export function AgentPage({ project, onSelectProject, onGoHome }: Props) {
  const [nodes, setNodes] = useNodesState<CanvasFlowNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [canvasLoading, setCanvasLoading] = useState(Boolean(project));
  const [canvasReady, setCanvasReady] = useState(!project);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node<CanvasNodeData | ReleaseSummaryNodeData | ReleaseOutputNodeData> | null>(null);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [expandedByProject, setExpandedByProject] = useState<Record<string, string[]>>({});
  const projectRef = useRef<ProjectInfo | null>(project);
  const readModelRef = useRef<ProjectCanvasReadModel | null>(null);
  const expandedByProjectRef = useRef<Record<string, string[]>>({});
  const [initialLayoutRead] = useState(() => readCanvasLayoutCache());
  const layoutCacheRef = useRef<CanvasLayoutCache>(initialLayoutRead.cache);
  const pendingLayoutFormatProjectIdsRef = useRef(new Set(initialLayoutRead.projectsNeedingFormat));
  const selectedNodeIdRef = useRef<string | null>(null);
  const canvasGenerationRef = useRef(0);
  const canvasRequestTokenRef = useRef(0);
  const loadingRequestRef = useRef<string | null>(null);
  const loadedProjectIdRef = useRef<string | null>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const viewportRestoreFrameRef = useRef<number | null>(null);
  const pendingCanvasResolverRef = useRef<PendingCanvasResolver | null>(null);
  const canvasNodesRef = useRef<Node<CanvasFlowNodeData>[]>([]);
  const canvasDragRef = useRef<CanvasDragSnapshot | null>(null);
  const manualCanvasPanRef = useRef<ManualCanvasPanSnapshot | null>(null);
  const manualCanvasPanCleanupRef = useRef<(() => void) | null>(null);
  const dragCommitPendingRef = useRef(false);
  const draggingCanvasRef = useRef(false);
  const formattingRef = useRef(false);
  const [formatting, setFormatting] = useState(false);

  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => () => {
    manualCanvasPanCleanupRef.current?.();
    manualCanvasPanCleanupRef.current = null;
  }, []);
  useEffect(() => { expandedByProjectRef.current = expandedByProject; }, [expandedByProject]);
  useEffect(() => { if (!toolsRegistered) { toolsRegistered = true; import("../../agent/tools"); } }, []);

  const clearSelectedNode = useCallback(() => { selectedNodeIdRef.current = null; setSelectedNode(null); }, []);
  const clearVideoPlayer = useCallback(() => { setActiveVideoId(null); }, []);
  const openVideoPlayer = useCallback((videoId: string) => { clearSelectedNode(); setActiveVideoId(videoId); }, [clearSelectedNode]);
  const clearCanvasSelection = useCallback(() => { clearSelectedNode(); clearVideoPlayer(); }, [clearSelectedNode, clearVideoPlayer]);
  const cancelViewportRestore = useCallback(() => {
    if (viewportRestoreFrameRef.current != null) {
      cancelAnimationFrame(viewportRestoreFrameRef.current);
      viewportRestoreFrameRef.current = null;
    }
    const pending = pendingCanvasResolverRef.current;
    if (pending) {
      pendingCanvasResolverRef.current = null;
      pending.resolve(false);
    }
  }, []);
  const scheduleViewportRestore = useCallback((callback: () => void) => {
    // The caller cancels and replaces the pending resolver before scheduling.
    // React Flow first commits the new nodes, then measures them asynchronously.
    // Wait through two paint frames so fitView cannot use the previous bounds.
    viewportRestoreFrameRef.current = requestAnimationFrame(() => {
      viewportRestoreFrameRef.current = requestAnimationFrame(() => {
        viewportRestoreFrameRef.current = null;
        callback();
      });
    });
  }, []);
  const expandedIdsFor = useCallback((model: ProjectCanvasReadModel) => {
    const expanded = new Set(expandedByProjectRef.current[model.project.id] ?? [...defaultCanvasExpandedIds(model)]);
    for (const id of agentExecutingCanvasExpandedIds(model)) expanded.add(id);
    return expanded;
  }, []);

  const applyCanvas = useCallback((nextNodes: Node<CanvasFlowNodeData>[], nextEdges: Edge[], isInitialLoad: boolean, centerNodeId?: string, restoreViewport = true, fitViewAfterCommit = false, requestToken = canvasRequestTokenRef.current): Promise<boolean> => new Promise<boolean>((resolve) => {
    if (requestToken !== canvasRequestTokenRef.current || draggingCanvasRef.current || dragCommitPendingRef.current) { resolve(false); return; }
    // A transient empty projection or React Flow measurement must never erase
    // the last usable graph for the active project.
    if (nextNodes.length === 0 && canvasNodesRef.current.length > 0) { resolve(false); return; }
    const previousViewport = isInitialLoad ? undefined : flowRef.current?.getViewport();
    const selectedNodeId = selectedNodeIdRef.current;
    const projectId = nextNodes[0]?.data.projectId;
    const projectLayout = projectId ? layoutCacheRef.current.projects[projectId] : undefined;
    const savedPositions = projectLayout?.positions ?? {};
    const projectedNodes = restoreCachedCanvasPositions(nextNodes, savedPositions).map((node) => ({
      ...node,
      draggable: isCanvasContentDraggable(node),
      selectable: !isCanvasStructureNode(node),
      focusable: !isCanvasStructureNode(node),
      selected: node.id === selectedNodeId,
    }));
    // The projection is already a complete flat scene. React Flow receives only
    // absolute positions; business grouping is carried in node.data.canvasGroupId.
    const flatNodes = projectedNodes.map((node) => {
      const flatNode = { ...node };
      delete flatNode.parentId;
      delete flatNode.parentNode;
      delete flatNode.extent;
      return flatNode;
    });
    const selectedProjection = selectedNodeId ? flatNodes.find((node) => node.id === selectedNodeId) : null;
    setSelectedNode(() => {
      if (!selectedProjection || !isBusinessCanvasNode(selectedProjection)) {
        if (selectedNodeId) selectedNodeIdRef.current = null;
        return null;
      }
      return selectedProjection;
    });
    canvasNodesRef.current = flatNodes;
    setNodes(flatNodes);
    setEdges(nextEdges);
    cancelViewportRestore();
    const pendingResolver: PendingCanvasResolver = { requestToken, resolve };
    pendingCanvasResolverRef.current = pendingResolver;
    const settle = (applied: boolean) => {
      if (pendingCanvasResolverRef.current !== pendingResolver) return;
      pendingCanvasResolverRef.current = null;
      resolve(applied);
    };
    const reportReady = (action: string) => {
      debugCanvas("canvas:ready", {
        projectId: projectId ?? null,
        requestToken,
        nodeCount: flatNodes.length,
        action,
        viewport: flowRef.current?.getViewport() ?? null,
        nodes: flowRef.current ? summarizeCanvasNodes(flowRef.current.getNodes() as Node<CanvasFlowNodeData>[]) : null,
      });
      settle(true);
    };
    if (!restoreViewport && !fitViewAfterCommit) {
      reportReady("none");
      return;
    }
    scheduleViewportRestore(() => {
      if (requestToken !== canvasRequestTokenRef.current) {
        debugCanvas("viewport:restore-stale-skipped", { projectId: projectId ?? null, requestToken });
        settle(false);
        return;
      }
      let action = "none";
      if (fitViewAfterCommit) {
        action = "fit-formatted";
        flowRef.current?.fitView(FIT_VIEW_OPTIONS);
      } else if (centerNodeId && flatNodes.some((node) => node.id === centerNodeId)) {
        action = "fit-center";
        flowRef.current?.fitView({ nodes: [{ id: centerNodeId }], padding: 0.65, maxZoom: 1.1, duration: 260 });
      } else if (isInitialLoad) {
        if (projectLayout?.viewport) {
          action = "restore-project-viewport";
          flowRef.current?.setViewport(projectLayout.viewport);
        } else {
          action = "fit-initial";
          flowRef.current?.fitView(FIT_VIEW_OPTIONS);
        }
      } else if (previousViewport) {
        action = "restore-previous-viewport";
        flowRef.current?.setViewport(previousViewport);
      }
      reportReady(action);
    });
  }), [cancelViewportRestore, scheduleViewportRestore, setEdges, setNodes]);

  const refreshCanvas = useCallback(async (projectId: string, generation: number, showLoading: boolean, centerNodeId?: string, fitViewAfterRefresh = false, force = false): Promise<boolean> => {
    if (force) loadingRequestRef.current = null;
    if (formattingRef.current) return false;
    const requestKey = `${generation}:${projectId}`;
    if (loadingRequestRef.current === requestKey) return false;
    if (projectRef.current?.id !== projectId) return false;
    if (draggingCanvasRef.current || dragCommitPendingRef.current) return false;
    const requestToken = ++canvasRequestTokenRef.current;
    loadingRequestRef.current = requestKey;
    if (showLoading) setCanvasLoading(true);
    try {
      // The canvas makes exactly one project-scoped IPC request per refresh.
      const model = await getProjectCanvasReadModel(projectId);
      if (requestToken !== canvasRequestTokenRef.current || canvasGenerationRef.current !== generation || projectRef.current?.id !== projectId || draggingCanvasRef.current || dragCommitPendingRef.current) return false;
      const projection = buildCanvas(model, expandedIdsFor(model));
      if (projection.nodes.length === 0 && canvasNodesRef.current.length > 0) return false;
      const previousCache = layoutCacheRef.current;
      const currentLayout = previousCache.projects[projectId];
      const shouldFormatLayout = !currentLayout || pendingLayoutFormatProjectIdsRef.current.has(projectId);
      const cacheForRender = shouldFormatLayout
        ? {
            ...previousCache,
            projects: {
              ...previousCache.projects,
              [projectId]: {
                ...(currentLayout ?? createCanvasProjectLayout()),
                positions: {},
                viewport: undefined,
                mode: "formatted" as const,
                updatedAt: Date.now(),
              },
            },
          }
        : previousCache;
      if (shouldFormatLayout) {
        layoutCacheRef.current = cacheForRender;
        debugCanvas("layout:format-missing-fields", { projectId, hadExistingLayout: Boolean(currentLayout) });
      }
      const applied = await applyCanvas(
        projection.nodes,
        projection.edges,
        loadedProjectIdRef.current !== projectId,
        centerNodeId,
        !fitViewAfterRefresh && !shouldFormatLayout,
        fitViewAfterRefresh || shouldFormatLayout,
        requestToken,
      );
      if (!applied) {
        if (shouldFormatLayout && layoutCacheRef.current === cacheForRender) layoutCacheRef.current = previousCache;
        return false;
      }
      if (shouldFormatLayout) {
        pendingLayoutFormatProjectIdsRef.current.delete(projectId);
        writeCanvasLayoutCache(layoutCacheRef.current);
      }
      readModelRef.current = model;
      loadedProjectIdRef.current = projectId;
      setCanvasError(null);
      return true;
    } catch {
      // Keep the most recent successful graph, selection, and viewport usable.
      if (requestToken === canvasRequestTokenRef.current && canvasGenerationRef.current === generation && projectRef.current?.id === projectId) setCanvasError("画布数据暂时无法刷新，正在保留最近一次成功结果。");
      return false;
    } finally {
      if (requestToken === canvasRequestTokenRef.current) {
        if (loadingRequestRef.current === requestKey) loadingRequestRef.current = null;
        if (canvasGenerationRef.current === generation && projectRef.current?.id === projectId) setCanvasLoading(false);
      }
    }
  }, [applyCanvas, expandedIdsFor]);

  useEffect(() => {
    // Invalidate staged commits from the previous project before resetting the
    // controlled node list. A stale animation frame must never reattach old children.
    canvasRequestTokenRef.current += 1;
    const generation = ++canvasGenerationRef.current;
    dragCommitPendingRef.current = false;
    draggingCanvasRef.current = false;
    formattingRef.current = false;
    setFormatting(false);
    canvasNodesRef.current = [];
    loadedProjectIdRef.current = null;
    readModelRef.current = null;
    clearSelectedNode();
    setCanvasReady(false);
    if (!project) {
      setNodes([]);
      setEdges([]);
      setCanvasError(null);
      setCanvasLoading(false);
      setCanvasReady(true);
      return () => {};
    }
    void refreshCanvas(project.id, generation, true).then(() => {
      if (canvasGenerationRef.current === generation && projectRef.current?.id === project.id) {
        setCanvasReady(true);
      }
    });
    const timer = window.setInterval(() => void refreshCanvas(project.id, generation, false), CANVAS_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      manualCanvasPanCleanupRef.current?.();
      canvasRequestTokenRef.current += 1;
      cancelViewportRestore();
    };
  }, [cancelViewportRestore, clearSelectedNode, project?.id, refreshCanvas, setEdges, setNodes]);

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
    clearVideoPlayer();
    if (node.data.entityType === "video") {
      clearSelectedNode();
      setActiveVideoId(node.id);
      return;
    }
    if (node.data.entityType === "release-summary" || node.data.entityType === "release-output") {
      selectedNodeIdRef.current = node.id;
      setSelectedNode(node as Node<CanvasNodeData | ReleaseSummaryNodeData | ReleaseOutputNodeData>);
      return;
    }
    if (node.data.entityType === "clip") {
      clearSelectedNode();
      return;
    }
    if (!isBusinessCanvasNode(node)) {
      clearSelectedNode();
      return;
    }
    selectedNodeIdRef.current = node.id;
    setSelectedNode(node);
  }, [clearSelectedNode, clearVideoPlayer]);
  const handleCanvasNodesChange = useCallback((changes: NodeChange[]) => {
    const effectiveChanges = draggingCanvasRef.current ? changes.filter((change) => change.type !== "position") : changes;
    if (effectiveChanges.length === 0) return;
    const before = canvasNodesRef.current;
    const beforeById = new Map(before.map((node) => [node.id, node]));
    const nextNodes = applyNodeChanges(effectiveChanges, before);
    canvasNodesRef.current = nextNodes;
    setNodes(nextNodes);
    const changeCounts: Record<string, number> = {};
    for (const change of effectiveChanges) changeCounts[change.type] = (changeCounts[change.type] ?? 0) + 1;
    const positionChanges = effectiveChanges
      .filter((change) => change.type === "position")
      .map((change) => {
        const item = change as NodeChange & { id: string; position?: { x: number; y: number }; dragging?: boolean };
        const afterNode = nextNodes.find((node) => node.id === item.id);
        return {
          id: item.id,
          dragging: item.dragging ?? null,
          requested: item.position ?? null,
          before: beforeById.has(item.id) ? summarizeCanvasNode(beforeById.get(item.id)!) : null,
          after: afterNode ? summarizeCanvasNode(afterNode) : null,
        };
      });
    if (positionChanges.length === 0) return;
    debugCanvas("nodes:position-change", {
      changeCounts,
      positionChangeCount: positionChanges.length,
      positionChanges: positionChanges.slice(0, 12),
      positionChangeOverflow: Math.max(0, positionChanges.length - 12),
      nodeCount: nextNodes.length,
    });
  }, [setNodes]);
  const persistCanvasNodePosition = useCallback((node: Node<CanvasFlowNodeData>) => {
    const activeProject = projectRef.current;
    if (!activeProject || formattingRef.current || !isCanvasContentDraggable(node)) return;
    const sourceNodes = canvasNodesRef.current;
    const draggedNode = sourceNodes.find((item) => item.id === node.id);
    if (!draggedNode) return;
    const currentLayout = layoutCacheRef.current.projects[activeProject.id] ?? createCanvasProjectLayout();
    const positions = { ...currentLayout.positions };
    for (const item of sourceNodes) {
      if (item.data.entityType === "center" || item.id === draggedNode.id) {
        positions[item.id] = persistedCanvasPosition(item, sourceNodes);
      }
    }
    const nextCache: CanvasLayoutCache = {
      ...layoutCacheRef.current,
      projects: {
        ...layoutCacheRef.current.projects,
        [activeProject.id]: { ...currentLayout, positions, mode: "custom", updatedAt: Date.now() },
      },
    };
    layoutCacheRef.current = nextCache;
    writeCanvasLayoutCache(nextCache);
  }, []);

  const startCanvasDrag = useCallback((_: unknown, node: Node<CanvasFlowNodeData>) => {
    canvasRequestTokenRef.current += 1;
    loadingRequestRef.current = null;
    draggingCanvasRef.current = true;
    dragCommitPendingRef.current = false;
    const sourceNodes = canvasNodesRef.current;
    const movingIds = node.data.entityType === "center"
      ? sourceNodes.filter((item) => item.id === node.id || item.data.canvasGroupId === node.id).map((item) => item.id)
      : [node.id];
    const startPositions = Object.fromEntries(movingIds.map((id) => {
      const item = sourceNodes.find((candidate) => candidate.id === id);
      return [id, { ...(item?.position ?? node.position) }];
    }));
    canvasDragRef.current = { nodeId: node.id, movingIds, startPositions, lastValidPositions: startPositions };
    debugCanvas("drag:start", { id: node.id, groupId: nodeGroupId(node), movingCount: movingIds.length });
  }, []);

  const handleCanvasNodeDrag = useCallback((_: unknown, node: Node<CanvasFlowNodeData>) => {
    const snapshot = canvasDragRef.current;
    if (!snapshot || snapshot.nodeId !== node.id) return;
    const startPosition = snapshot.startPositions[node.id] ?? node.position;
    const proposedDelta = { x: node.position.x - startPosition.x, y: node.position.y - startPosition.y };
    const sourceNodes = canvasNodesRef.current;
    const movingIds = new Set(snapshot.movingIds);
    let solvedPositions = snapshot.lastValidPositions;
    if (node.data.entityType === "center") {
      const candidate = solveGroupPositions(sourceNodes, snapshot.movingIds, snapshot.startPositions, proposedDelta, snapshot.lastValidPositions);
      if (Object.keys(candidate).length > 0) solvedPositions = candidate;
    } else {
      const solved = solveSinglePosition(
        node,
        { x: startPosition.x + proposedDelta.x, y: startPosition.y + proposedDelta.y },
        snapshot.lastValidPositions[node.id] ?? startPosition,
        sourceNodes,
        movingIds,
      );
      if (solved) solvedPositions = { ...snapshot.lastValidPositions, [node.id]: solved };
    }
    snapshot.lastValidPositions = solvedPositions;
    const nextNodes = sourceNodes.map((item) => solvedPositions[item.id] ? { ...item, position: solvedPositions[item.id] } : item);
    canvasNodesRef.current = nextNodes;
    setNodes(nextNodes);
  }, [setNodes]);

  const stopCanvasDrag = useCallback((_: unknown, node: Node<CanvasFlowNodeData>) => {
    if (!draggingCanvasRef.current) return;
    dragCommitPendingRef.current = true;
    const draggedNode = canvasNodesRef.current.find((item) => item.id === node.id);
    if (draggedNode) persistCanvasNodePosition(draggedNode);
    requestAnimationFrame(() => {
      canvasDragRef.current = null;
      draggingCanvasRef.current = false;
      dragCommitPendingRef.current = false;
    });
  }, [persistCanvasNodePosition]);

  const formatCanvas = useCallback(() => {
    const activeProject = projectRef.current;
    const model = readModelRef.current;
    debugCanvas("format:button-click", {
      projectId: activeProject?.id ?? null,
      nodeCount: canvasNodesRef.current.length,
      formatting: formattingRef.current,
      canvasLoading,
    });
    const skipReason = !activeProject
      ? "no-project"
      : !model
        ? "model-not-ready"
        : formattingRef.current
          ? "already-formatting"
          : canvasLoading
            ? "canvas-loading"
            : canvasNodesRef.current.length === 0
              ? "no-nodes"
              : null;
    if (skipReason) {
      debugCanvas("format:skip", {
        reason: skipReason,
        projectId: activeProject?.id ?? null,
        nodeCount: canvasNodesRef.current.length,
        formatting: formattingRef.current,
        canvasLoading,
      });
      return;
    }
    if (!activeProject || !model) return;
    formattingRef.current = true;
    setFormatting(true);
    const previousCache = layoutCacheRef.current;
    const currentLayout = previousCache.projects[activeProject.id] ?? createCanvasProjectLayout();
    const nextCache: CanvasLayoutCache = {
      ...previousCache,
      projects: {
        ...previousCache.projects,
        [activeProject.id]: {
          ...currentLayout,
          positions: {},
          viewport: undefined,
          mode: "formatted",
          updatedAt: Date.now(),
        },
      },
    };
    layoutCacheRef.current = nextCache;
    const requestToken = ++canvasRequestTokenRef.current;
    loadingRequestRef.current = null;
    setCanvasLoading(false);
    void Promise.resolve().then(() => {
      const projection = buildCanvas(model, expandedIdsFor(model));
      return applyCanvas(
        projection.nodes,
        projection.edges,
        loadedProjectIdRef.current !== activeProject.id,
        undefined,
        false,
        true,
        requestToken,
      ).then((applied) => {
        if (applied) writeCanvasLayoutCache(layoutCacheRef.current);
        else if (layoutCacheRef.current === nextCache) layoutCacheRef.current = previousCache;
      });
    }).catch(() => {
      if (layoutCacheRef.current === nextCache) layoutCacheRef.current = previousCache;
    }).finally(() => {
      formattingRef.current = false;
      setFormatting(false);
    });
  }, [applyCanvas, canvasLoading, expandedIdsFor]);
  const persistCanvasViewport = useCallback((_: unknown, viewport: Viewport) => {
    debugCanvas("viewport:move-end", { viewport, nodeCount: canvasNodesRef.current.length });
    const activeProject = projectRef.current;
    if (!activeProject) return;
    const currentLayout = layoutCacheRef.current.projects[activeProject.id] ?? createCanvasProjectLayout();
    const positions = { ...currentLayout.positions };
    const nextCache: CanvasLayoutCache = {
      ...layoutCacheRef.current,
      projects: {
        ...layoutCacheRef.current.projects,
        [activeProject.id]: { ...currentLayout, positions, viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom }, updatedAt: Date.now() },
      },
    };
    layoutCacheRef.current = nextCache;
    writeCanvasLayoutCache(nextCache);
  }, []);

  const handleCanvasPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const formatButton = event.target instanceof Element
      ? event.target.closest(".agent-canvas__format") as HTMLButtonElement | null
      : null;
    if (formatButton) {
      debugCanvas("format:button-pointerdown", {
        projectId: projectRef.current?.id ?? null,
        disabled: formatButton.disabled,
        nodeCount: canvasNodesRef.current.length,
        formatting: formattingRef.current,
        canvasLoading,
        requestToken: canvasRequestTokenRef.current,
      });
      return;
    }
    const center = findCanvasCenterAtPoint(event.clientX, event.clientY);
    if (center && (activeVideoId || selectedNodeIdRef.current)) {
      clearCanvasSelection();
      return;
    }
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (!findBlankSubcanvasAtPoint(event.clientX, event.clientY)) return;
    const instance = flowRef.current;
    if (!instance) return;
    manualCanvasPanCleanupRef.current?.();
    const target = event.currentTarget;
    manualCanvasPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewport: instance.getViewport(),
    };
    const movePan = (pointerEvent: globalThis.PointerEvent) => {
      const snapshot = manualCanvasPanRef.current;
      if (!snapshot || snapshot.pointerId !== pointerEvent.pointerId) return;
      instance.setViewport({
        x: snapshot.viewport.x + pointerEvent.clientX - snapshot.startX,
        y: snapshot.viewport.y + pointerEvent.clientY - snapshot.startY,
        zoom: snapshot.viewport.zoom,
      });
    };
    const stopPan = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", movePan);
      window.removeEventListener("pointerup", stopPan);
      window.removeEventListener("pointercancel", stopPan);
      if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture?.(event.pointerId);
      if (manualCanvasPanCleanupRef.current === cleanup) manualCanvasPanCleanupRef.current = null;
      manualCanvasPanRef.current = null;
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", movePan);
      window.removeEventListener("pointerup", stopPan);
      window.removeEventListener("pointercancel", stopPan);
      if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture?.(event.pointerId);
      if (manualCanvasPanCleanupRef.current === cleanup) manualCanvasPanCleanupRef.current = null;
      manualCanvasPanRef.current = null;
    };
    manualCanvasPanCleanupRef.current = cleanup;
    window.addEventListener("pointermove", movePan);
    window.addEventListener("pointerup", stopPan);
    window.addEventListener("pointercancel", stopPan);
    target.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, [activeVideoId, canvasLoading, clearCanvasSelection]);

  const [sidebarOpen, setSidebarOpen] = useState(project === null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  useEffect(() => { setSidebarOpen(project === null); }, [project?.id]);
  useEffect(() => {
    const refreshProjects = () => { void listProjects().then(setProjects).catch(() => {}); };
    refreshProjects();
    const timer = window.setInterval(refreshProjects, PROJECT_LIST_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const onSelectProjectWrapped = useCallback((nextProject: ProjectInfo) => { onSelectProject(nextProject); setSidebarOpen(false); }, [onSelectProject]);
  const sidebarVisible = project === null || sidebarOpen;

  const [drawerOpen, setDrawerOpen] = useState(true);
  const activeExpanded = readModelRef.current ? expandedIdsFor(readModelRef.current) : new Set<string>();
  const formatButtonDisabled = !project || formatting || canvasLoading || nodes.length === 0;
  useEffect(() => {
    debugCanvas("format:button-state", {
      projectId: project?.id ?? null,
      disabled: formatButtonDisabled,
      reasons: {
        noProject: !project,
        formatting,
        canvasLoading,
        noNodes: nodes.length === 0,
      },
      nodeCount: nodes.length,
    });
  }, [canvasLoading, formatButtonDisabled, formatting, nodes.length, project?.id]);

  return <div className={`agent-page${sidebarVisible ? " agent-page--sidebar-open" : ""}`}><div className="agent-main">
    {project && <div className={`sidebar-edge-hotzone agent-sidebar-edge-hotzone${sidebarVisible ? " sidebar-edge-hotzone--open" : ""}`}>
      <button className="sidebar-grabber" onClick={() => setSidebarOpen((open) => !open)} type="button" title={sidebarVisible ? "收起作品列表" : "展开作品列表"} aria-label={sidebarVisible ? "收起作品列表" : "展开作品列表"}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          {sidebarVisible ? <path d="M5 5L11 11M11 5L5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /> : <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </button>
    </div>}
    <div className={`sidebar-drawer${sidebarVisible ? " sidebar-drawer--open" : ""}`}><ProjectSidebar projects={projects} selectedProjectId={project?.id ?? ""} onSelectProject={(projectId) => { const nextProject = projects.find((item) => item.id === projectId); if (nextProject) onSelectProjectWrapped(nextProject); }} onCreateProject={() => {}} onDeleteProject={() => {}} onGoHome={onGoHome} /></div>
    <div className="agent-canvas" onPointerDownCapture={handleCanvasPointerDownCapture}>
      <CanvasInteractionProvider expandedIds={activeExpanded} onToggleExpanded={toggleExpanded} onAssetPillClick={revealReferencedAsset} activeVideoId={activeVideoId} onVideoClick={openVideoPlayer} onVideoPlayerClose={clearVideoPlayer}>
        <ReactFlow nodes={nodes} edges={edges} onNodesChange={handleCanvasNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_, node) => selectCanvasNode(node)} onNodeDragStart={startCanvasDrag} onNodeDrag={handleCanvasNodeDrag} onNodeDragStop={stopCanvasDrag} onMoveEnd={persistCanvasViewport} onPaneClick={clearCanvasSelection} onInit={(instance) => { flowRef.current = instance; debugCanvas("reactflow:init", { viewport: instance.getViewport(), nodes: summarizeCanvasNodes(instance.getNodes() as Node<CanvasFlowNodeData>[]) }); }} nodeTypes={agentNodeTypes} nodesConnectable={false} nodesDraggable={!formatting} panOnDrag nodeExtent={[[-CANVAS_MAX_POSITION, -CANVAS_MAX_POSITION], [CANVAS_MAX_POSITION, CANVAS_MAX_POSITION]]} minZoom={CANVAS_MIN_ZOOM} maxZoom={CANVAS_MAX_ZOOM} proOptions={{ hideAttribution: true }}>
          <Controls className="agent-canvas__controls" showZoom={false} showFitView={false} showInteractive={false}>
            <ControlButton className="agent-canvas__zoom-button" onClick={() => flowRef.current?.zoomIn()} title="放大" aria-label="放大">
              <span className="agent-canvas__zoom-symbol" aria-hidden="true">+</span>
            </ControlButton>
            <ControlButton className="agent-canvas__zoom-button" onClick={() => flowRef.current?.zoomOut()} title="缩小" aria-label="缩小">
              <span className="agent-canvas__zoom-symbol" aria-hidden="true">−</span>
            </ControlButton>
            <ControlButton className="agent-canvas__format" onClick={formatCanvas} disabled={formatButtonDisabled} title="格式化布局" aria-label="格式化布局">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h4v4h-4zM9.5 3.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z" /><path d="M6.5 5.5h3M5.5 6.5v3M10.5 7.5v2M6.5 10.5h3" /></svg>
            </ControlButton>
          </Controls>
        </ReactFlow>
      </CanvasInteractionProvider>
      {!canvasReady && <div className="agent-canvas__initializing" role="status"><span className="agent-canvas__loading-spin" />加载画布数据…</div>}
      {canvasLoading && canvasReady && <div className="agent-canvas__loading"><span className="agent-canvas__loading-spin" />加载画布数据…</div>}
      {canvasError && <div className="agent-canvas__notice" role="status">{canvasError}</div>}
    </div>
    {selectedNode && <CanvasInspector node={selectedNode} className={drawerOpen ? " agent-inspector--with-chat" : ""} onClose={clearSelectedNode} />}
    {!drawerOpen && <button className="agent-fab" onClick={() => setDrawerOpen(true)} type="button" title="展开对话" aria-label="展开对话"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="8" cy="13" r="1.2" fill="currentColor" /><circle cx="12" cy="13" r="1.2" fill="currentColor" /><circle cx="16" cy="13" r="1.2" fill="currentColor" /></svg></button>}
    <AgentChatDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
  </div></div>;
}

function isCanvasContentDraggable(node: Node<CanvasFlowNodeData>): boolean {
  return movableCanvasNode(node);
}
function isCanvasStructureNode(node: Node<CanvasFlowNodeData>): boolean {
  return ["center", "material-category", "shot-track", "shot-anchor"].includes(node.data.entityType);
}
function isBusinessCanvasNode(node: Node<CanvasFlowNodeData>): node is Node<CanvasNodeData | ReleaseSummaryNodeData | ReleaseOutputNodeData> {
  return ["project", "clip", "asset", "storyboard", "video", "task", "release-summary", "release-output"].includes(node.data.entityType);
}
