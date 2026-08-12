import type { Node } from "reactflow";
import { CANVAS_LAYOUT } from "../../agent/canvas";
import type { CanvasFlowNodeData } from "../../agent/canvas";

export type CanvasNodePosition = { x: number; y: number };
export type CanvasRect = { x: number; y: number; width: number; height: number };

export const CANVAS_MAX_POSITION = 100_000;
const DRAG_COLLISION_GAP = 8;

function numericDimension(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export function canvasNodeSize(node: Node<CanvasFlowNodeData>): { width: number; height: number } {
  const style = node.style as Record<string, unknown> | undefined;
  const fallback = (() => {
    switch (node.data.entityType) {
      case "center": return { width: node.data.width, height: node.data.height };
      case "clip": return { width: 184, height: 66 };
      case "material-category": return { width: 280, height: node.data.itemCount > 0 ? 96 : 38 };
      case "asset": return { width: 252, height: 152 };
      case "storyboard": return { width: 258, height: 132 };
      case "video": return { width: 208, height: 154 };
      case "task": return { width: 168, height: 58 };
      case "shot-track": return { width: node.data.width, height: 24 };
      case "shot-anchor": return { width: 26, height: 26 };
      case "release-summary":
      case "release-task": return { width: 106, height: 58 };
      case "release-output": return { width: 246, height: CANVAS_LAYOUT.releaseOutputHeight };
      default: return { width: 214, height: 62 };
    }
  })();
  return {
    width: node.width ?? numericDimension(style?.width) ?? fallback.width,
    height: node.height ?? numericDimension(style?.height) ?? fallback.height,
  };
}

export function nodeRect(node: Node<CanvasFlowNodeData>, position = node.position): CanvasRect {
  const size = canvasNodeSize(node);
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

function rectsOverlap(left: CanvasRect, right: CanvasRect, gap = DRAG_COLLISION_GAP): boolean {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

export function movableCanvasNode(node: Node<CanvasFlowNodeData>): boolean {
  return node.data.entityType === "center"
    || (node.data.canvasRole === "content" && Boolean(node.data.canvasGroupId));
}

export function nodeGroupId(node: Node<CanvasFlowNodeData>): string | null {
  return node.data.entityType === "center" ? node.id : node.data.canvasGroupId ?? null;
}

export function persistedCanvasPosition(node: Node<CanvasFlowNodeData>, nodes: readonly Node<CanvasFlowNodeData>[]): CanvasNodePosition {
  const groupId = node.data.canvasGroupId;
  const groupCenter = groupId ? nodes.find((candidate) => candidate.id === groupId) : undefined;
  return groupCenter
    ? { x: node.position.x - groupCenter.position.x, y: node.position.y - groupCenter.position.y }
    : { ...node.position };
}

export function isCollisionObstacle(node: Node<CanvasFlowNodeData>): boolean {
  return node.data.entityType === "center"
    || node.data.entityType === "clip"
    || node.data.canvasRole === "content";
}

export function contentBounds(node: Node<CanvasFlowNodeData>, nodes: readonly Node<CanvasFlowNodeData>[]): CanvasRect | null {
  const groupId = node.data.canvasGroupId;
  if (!groupId) return null;
  const visualParent = node.data.canvasParentId
    ? nodes.find((candidate) => candidate.id === node.data.canvasParentId)
    : undefined;
  if (visualParent?.data.entityType === "material-category") {
    const categoryRect = nodeRect(visualParent);
    return {
      x: categoryRect.x + CANVAS_LAYOUT.centerContentPadding,
      y: categoryRect.y + CANVAS_LAYOUT.categoryContentTop,
      width: Math.max(1, categoryRect.width - CANVAS_LAYOUT.centerContentPadding * 2),
      height: Math.max(1, categoryRect.height - CANVAS_LAYOUT.categoryContentTop - CANVAS_LAYOUT.centerContentPadding),
    };
  }
  const center = nodes.find((candidate) => candidate.id === groupId);
  if (!center) return null;
  const centerRect = nodeRect(center);
  return {
    x: centerRect.x + CANVAS_LAYOUT.centerContentPadding,
    y: centerRect.y + CANVAS_LAYOUT.centerContentTop,
    width: Math.max(1, centerRect.width - CANVAS_LAYOUT.centerContentPadding * 2),
    height: Math.max(1, centerRect.height - CANVAS_LAYOUT.centerContentTop - CANVAS_LAYOUT.centerContentPadding),
  };
}

function clampPosition(position: CanvasNodePosition, size: { width: number; height: number }, bounds: CanvasRect): CanvasNodePosition {
  return {
    x: Math.min(bounds.x + bounds.width - size.width, Math.max(bounds.x, position.x)),
    y: Math.min(bounds.y + bounds.height - size.height, Math.max(bounds.y, position.y)),
  };
}

function globalBounds(): CanvasRect {
  return { x: -CANVAS_MAX_POSITION, y: -CANVAS_MAX_POSITION, width: CANVAS_MAX_POSITION * 2, height: CANVAS_MAX_POSITION * 2 };
}

function collisionObstacles(nodes: readonly Node<CanvasFlowNodeData>[], movingIds: ReadonlySet<string>, movingNode: Node<CanvasFlowNodeData>): Node<CanvasFlowNodeData>[] {
  const groupId = nodeGroupId(movingNode);
  return nodes.filter((candidate) => {
    if (movingIds.has(candidate.id) || !isCollisionObstacle(candidate)) return false;
    if (movingNode.data.entityType !== "center" && candidate.data.entityType === "center" && candidate.id === groupId) return false;
    if (movingNode.data.entityType !== "center" && groupId && candidate.data.canvasGroupId !== groupId) return false;
    return true;
  });
}

function validSinglePosition(node: Node<CanvasFlowNodeData>, position: CanvasNodePosition, nodes: readonly Node<CanvasFlowNodeData>[], movingIds: ReadonlySet<string>): boolean {
  const size = canvasNodeSize(node);
  const bounds = contentBounds(node, nodes) ?? globalBounds();
  const clamped = clampPosition(position, size, bounds);
  if (clamped.x !== position.x || clamped.y !== position.y) return false;
  const candidate = nodeRect(node, position);
  return !collisionObstacles(nodes, movingIds, node).some((obstacle) => rectsOverlap(candidate, nodeRect(obstacle)));
}

export function solveSinglePosition(node: Node<CanvasFlowNodeData>, proposed: CanvasNodePosition, fallback: CanvasNodePosition, nodes: readonly Node<CanvasFlowNodeData>[], movingIds: ReadonlySet<string>): CanvasNodePosition | null {
  const size = canvasNodeSize(node);
  const bounds = contentBounds(node, nodes) ?? globalBounds();
  const clamped = clampPosition(proposed, size, bounds);
  if (validSinglePosition(node, clamped, nodes, movingIds)) return clamped;
  const candidates: CanvasNodePosition[] = [clamped];
  for (const obstacle of collisionObstacles(nodes, movingIds, node)) {
    const obstacleRect = nodeRect(obstacle);
    candidates.push(
      { x: obstacleRect.x - size.width - DRAG_COLLISION_GAP, y: clamped.y },
      { x: obstacleRect.x + obstacleRect.width + DRAG_COLLISION_GAP, y: clamped.y },
      { x: clamped.x, y: obstacleRect.y - size.height - DRAG_COLLISION_GAP },
      { x: clamped.x, y: obstacleRect.y + obstacleRect.height + DRAG_COLLISION_GAP },
    );
  }
  const legal = candidates
    .map((candidate) => clampPosition(candidate, size, bounds))
    .filter((candidate, index, all) => all.findIndex((item) => item.x === candidate.x && item.y === candidate.y) === index)
    .filter((candidate) => validSinglePosition(node, candidate, nodes, movingIds));
  legal.sort((left, right) => ((left.x - proposed.x) ** 2 + (left.y - proposed.y) ** 2) - ((right.x - proposed.x) ** 2 + (right.y - proposed.y) ** 2));
  if (legal[0]) return legal[0];
  const safeFallback = clampPosition(fallback, size, bounds);
  return validSinglePosition(node, safeFallback, nodes, movingIds) ? safeFallback : null;
}

function positionsBounds(nodes: readonly Node<CanvasFlowNodeData>[], positions: Readonly<Record<string, CanvasNodePosition>>, movingIds: ReadonlySet<string>): CanvasRect {
  const moving = nodes.filter((node) => movingIds.has(node.id));
  if (moving.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const rects = moving.map((node) => nodeRect(node, positions[node.id] ?? node.position));
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function solveGroupPositions(nodes: readonly Node<CanvasFlowNodeData>[], movingIds: readonly string[], startPositions: Readonly<Record<string, CanvasNodePosition>>, proposedDelta: CanvasNodePosition, fallbackPositions: Readonly<Record<string, CanvasNodePosition>>): Record<string, CanvasNodePosition> {
  const movingSet = new Set(movingIds);
  const startBounds = positionsBounds(nodes, startPositions, movingSet);
  const bounds = globalBounds();
  const minDelta = { x: bounds.x - startBounds.x, y: bounds.y - startBounds.y };
  const maxDelta = { x: bounds.x + bounds.width - (startBounds.x + startBounds.width), y: bounds.y + bounds.height - (startBounds.y + startBounds.height) };
  const clampedDelta = {
    x: Math.min(maxDelta.x, Math.max(minDelta.x, proposedDelta.x)),
    y: Math.min(maxDelta.y, Math.max(minDelta.y, proposedDelta.y)),
  };
  const obstacles = nodes.filter((node) => !movingSet.has(node.id) && isCollisionObstacle(node));
  const groupAt = (delta: CanvasNodePosition): Record<string, CanvasNodePosition> => Object.fromEntries(movingIds.map((id) => {
    const start = startPositions[id] ?? nodes.find((node) => node.id === id)?.position ?? { x: 0, y: 0 };
    return [id, { x: start.x + delta.x, y: start.y + delta.y }];
  }));
  const isLegal = (delta: CanvasNodePosition): boolean => {
    const candidate = groupAt(delta);
    return !nodes.filter((node) => movingSet.has(node.id)).some((moving) => {
      const movingRect = nodeRect(moving, candidate[moving.id]);
      return obstacles.some((obstacle) => rectsOverlap(movingRect, nodeRect(obstacle)));
    });
  };
  if (isLegal(clampedDelta)) return groupAt(clampedDelta);
  const candidates = [clampedDelta];
  for (const obstacle of obstacles) {
    const obstacleRect = nodeRect(obstacle);
    candidates.push(
      { x: obstacleRect.x - startBounds.width - DRAG_COLLISION_GAP - startBounds.x, y: clampedDelta.y },
      { x: obstacleRect.x + obstacleRect.width + DRAG_COLLISION_GAP - startBounds.x, y: clampedDelta.y },
      { x: clampedDelta.x, y: obstacleRect.y - startBounds.height - DRAG_COLLISION_GAP - startBounds.y },
      { x: clampedDelta.x, y: obstacleRect.y + obstacleRect.height + DRAG_COLLISION_GAP - startBounds.y },
    );
  }
  const legal = candidates.map((delta) => ({
    x: Math.min(maxDelta.x, Math.max(minDelta.x, delta.x)),
    y: Math.min(maxDelta.y, Math.max(minDelta.y, delta.y)),
  })).filter((delta, index, all) => all.findIndex((item) => item.x === delta.x && item.y === delta.y) === index).filter(isLegal);
  legal.sort((left, right) => ((left.x - proposedDelta.x) ** 2 + (left.y - proposedDelta.y) ** 2) - ((right.x - proposedDelta.x) ** 2 + (right.y - proposedDelta.y) ** 2));
  if (legal[0]) return groupAt(legal[0]);
  const fallbackId = movingIds[0];
  const fallbackStart = fallbackId ? startPositions[fallbackId] : undefined;
  const fallbackPosition = fallbackId ? fallbackPositions[fallbackId] : undefined;
  if (fallbackStart && fallbackPosition) {
    const fallbackDelta = { x: fallbackPosition.x - fallbackStart.x, y: fallbackPosition.y - fallbackStart.y };
    if (isLegal(fallbackDelta)) return groupAt(fallbackDelta);
  }
  return isLegal({ x: 0, y: 0 }) ? groupAt({ x: 0, y: 0 }) : {};
}

export function restoreCachedCanvasPositions(nodes: readonly Node<CanvasFlowNodeData>[], savedPositions: Readonly<Record<string, CanvasNodePosition>>): Node<CanvasFlowNodeData>[] {
  if (Object.keys(savedPositions).length === 0) return [...nodes];
  let restored = nodes.map((node) => {
    const saved = savedPositions[node.id];
    const groupCenter = node.data.canvasGroupId
      ? savedPositions[node.data.canvasGroupId] ?? nodes.find((candidate) => candidate.id === node.data.canvasGroupId)?.position
      : undefined;
    const position = saved
      ? groupCenter && node.data.canvasGroupId
        ? { x: groupCenter.x + saved.x, y: groupCenter.y + saved.y }
        : { ...saved }
      : { ...node.position };
    return { ...node, position };
  });

  for (const center of nodes.filter((node) => node.data.entityType === "center" && savedPositions[node.id])) {
    const movingIds = restored.filter((node) => node.id === center.id || node.data.canvasGroupId === center.id).map((node) => node.id);
    const startPositions = Object.fromEntries(movingIds.map((id) => {
      const source = nodes.find((node) => node.id === id);
      return [id, { ...(source?.position ?? { x: 0, y: 0 }) }];
    }));
    const fallbackPositions = { ...startPositions };
    const startCenter = startPositions[center.id] ?? center.position;
    const targetCenter = savedPositions[center.id];
    const solved = solveGroupPositions(
      restored,
      movingIds,
      startPositions,
      { x: targetCenter.x - startCenter.x, y: targetCenter.y - startCenter.y },
      fallbackPositions,
    );
    if (Object.keys(solved).length === 0) {
      restored = restored.map((node) => movingIds.includes(node.id) && startPositions[node.id]
        ? { ...node, position: startPositions[node.id] }
        : node);
      continue;
    }
    restored = restored.map((node) => solved[node.id] ? { ...node, position: solved[node.id] } : node);
  }

  const fallbackPositions = Object.fromEntries(restored.map((node) => [node.id, { ...node.position }]));
  restored = restored.map((node) => {
    const saved = savedPositions[node.id];
    const group = node.data.canvasGroupId ? restored.find((candidate) => candidate.id === node.data.canvasGroupId) : undefined;
    return saved && group ? { ...node, position: { x: group.position.x + saved.x, y: group.position.y + saved.y } } : node;
  });

  for (const node of restored.filter((candidate) => savedPositions[candidate.id] && candidate.data.canvasRole === "content")) {
    const fallbackPosition = fallbackPositions[node.id];
    const solved = solveSinglePosition(
      node,
      node.position,
      fallbackPosition ?? node.position,
      restored,
      new Set([node.id]),
    );
    const safePosition = solved ?? fallbackPosition;
    if (!safePosition) continue;
    restored = restored.map((candidate) => candidate.id === node.id ? { ...candidate, position: safePosition } : candidate);
  }
  return restored;
}
