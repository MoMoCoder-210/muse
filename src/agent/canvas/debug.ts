import type { Node } from "reactflow";
import type { CanvasFlowNodeData } from "./node-data";

type XY = { x: number; y: number };
type RuntimeNode = Node<CanvasFlowNodeData> & { positionAbsolute?: XY; width?: number; height?: number };

type CanvasDebugEntry = { id: number; event: string; time: string; details: Record<string, unknown> };
type CanvasDebugApi = { get: () => CanvasDebugEntry[]; clear: () => void };

let sequence = 0;
const entries: CanvasDebugEntry[] = [];

declare global {
  interface Window { __agentCanvasDebug?: CanvasDebugApi; }
}

function installDebugApi(): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  window.__agentCanvasDebug = {
    get: () => [...entries],
    clear: () => { entries.length = 0; sequence = 0; },
  };
}
installDebugApi();

/** Development-only timeline for diagnosing canvas projection and React Flow mutations. */
export function debugCanvas(event: string, details: Record<string, unknown> = {}): void {
  if (!import.meta.env.DEV) return;
  const id = ++sequence;
  const entry = { id, event, time: new Date().toISOString(), details };
  entries.push(entry);
  if (entries.length > 500) entries.shift();
  console.log(`[AgentCanvas ${String(id).padStart(4, "0")}] ${event}`, { time: entry.time, ...details });
}

export function summarizeCanvasNode(node: Node<CanvasFlowNodeData>): Record<string, unknown> {
  const runtimeNode = node as RuntimeNode;
  return {
    id: node.id,
    entityType: node.data.entityType,
    canvasGroupId: node.data.canvasGroupId ?? null,
    position: { x: round(node.position.x), y: round(node.position.y) },
    positionAbsolute: runtimeNode.positionAbsolute
      ? { x: round(runtimeNode.positionAbsolute.x), y: round(runtimeNode.positionAbsolute.y) }
      : null,
    size: runtimeNode.width != null || runtimeNode.height != null
      ? { width: runtimeNode.width ?? node.width ?? null, height: runtimeNode.height ?? node.height ?? null }
      : null,
  };
}

export function summarizeCanvasNodes(nodes: readonly Node<CanvasFlowNodeData>[]): Record<string, unknown> {
  const xs = nodes.map((node) => node.position.x).filter(Number.isFinite);
  const ys = nodes.map((node) => node.position.y).filter(Number.isFinite);
  const typeCounts: Record<string, number> = {};
  for (const node of nodes) typeCounts[node.data.entityType] = (typeCounts[node.data.entityType] ?? 0) + 1;
  const keyNodes = nodes
    .filter((node) => ["clip", "center", "material-category", "shot-track", "shot-anchor", "release-output"].includes(node.data.entityType))
    .slice(0, 12)
    .map(summarizeCanvasNode);
  return {
    count: nodes.length,
    types: typeCounts,
    bounds: xs.length > 0 && ys.length > 0
      ? { minX: round(Math.min(...xs)), maxX: round(Math.max(...xs)), minY: round(Math.min(...ys)), maxY: round(Math.max(...ys)) }
      : null,
    keyNodes,
  };
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}
