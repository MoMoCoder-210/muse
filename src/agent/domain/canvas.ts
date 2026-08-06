/**
 * Canvas 纯领域逻辑：节点创建、画布操作
 *
 * 不依赖 React Flow，仅操作领域模型。
 */
import type { CanvasNode, CanvasEdge, CanvasNodeType, CanvasEdgeType } from "../../types/agent";

let _counter = 0;
function nextId(prefix: string): string {
  _counter += 1;
  return `${prefix}-${Date.now()}-${_counter}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createNode(type: CanvasNodeType, label: string, parentId?: string, data?: Record<string, unknown>): CanvasNode {
  return { id: nextId(type), type, label, parentId, data };
}

export function createEdge(source: string, target: string, type: CanvasEdgeType): CanvasEdge {
  return { id: nextId("edge"), source, target, type };
}
