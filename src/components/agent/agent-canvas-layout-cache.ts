import type { CanvasNodePosition } from "./agent-canvas-constraints";

export type CanvasViewport = { x: number; y: number; zoom: number };
export type CanvasLayoutMode = "formatted" | "custom";
export type CanvasProjectLayout = {
  positions: Record<string, CanvasNodePosition>;
  viewport?: CanvasViewport;
  mode: CanvasLayoutMode;
  updatedAt: number;
};
export type CanvasLayoutCache = {
  schemaVersion: 8;
  projects: Record<string, CanvasProjectLayout>;
};

const CANVAS_LAYOUT_STORAGE_KEY = "muse.agent-canvas.layout.v8";
const LEGACY_CANVAS_LAYOUT_STORAGE_KEY = "muse.agent-canvas.layout.v1";
const LEGACY_CANVAS_LAYOUT_V2_STORAGE_KEY = "muse.agent-canvas.layout.v2";
const LEGACY_CANVAS_LAYOUT_V3_STORAGE_KEY = "muse.agent-canvas.layout.v3";
const LEGACY_CANVAS_LAYOUT_V4_STORAGE_KEY = "muse.agent-canvas.layout.v4";
const LEGACY_CANVAS_LAYOUT_V5_STORAGE_KEY = "muse.agent-canvas.layout.v5";
const LEGACY_CANVAS_LAYOUT_V6_STORAGE_KEY = "muse.agent-canvas.layout.v6";
const LEGACY_CANVAS_LAYOUT_V7_STORAGE_KEY = "muse.agent-canvas.layout.v7";
const LEGACY_CANVAS_POSITION_STORAGE_KEY = "muse.agent-canvas.positions.v2";
const CANVAS_LAYOUT_SCHEMA_VERSION = 8;
const CANVAS_MIN_ZOOM = 0.25;
const CANVAS_MAX_ZOOM = 1.8;

export function createCanvasProjectLayout(): CanvasProjectLayout {
  return { positions: {}, mode: "formatted", updatedAt: 0 };
}

export function createCanvasLayoutCache(): CanvasLayoutCache {
  return { schemaVersion: CANVAS_LAYOUT_SCHEMA_VERSION, projects: {} };
}

export function sanitizeCanvasPositions(value: unknown): Record<string, CanvasNodePosition> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const positions: Record<string, CanvasNodePosition> = {};
  for (const [nodeId, position] of Object.entries(value as Record<string, unknown>)) {
    if (!position || typeof position !== "object" || Array.isArray(position)) continue;
    const { x, y } = position as Partial<CanvasNodePosition>;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) positions[nodeId] = { x, y };
  }
  return positions;
}

export function sanitizeCanvasViewport(value: unknown): CanvasViewport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { x, y, zoom } = value as Partial<CanvasViewport>;
  return typeof x === "number" && typeof y === "number" && typeof zoom === "number"
    && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom) && zoom > 0
    ? { x, y, zoom: Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom)) }
    : undefined;
}

export function readCanvasLayoutCache(): CanvasLayoutCache {
  try {
    // All previous versions used incompatible coordinate or parent semantics.
    // v8 keeps center positions in absolute coordinates and grouped child
    // positions relative to their center, so group movement remains stable.
    for (const key of [
      LEGACY_CANVAS_LAYOUT_STORAGE_KEY,
      LEGACY_CANVAS_LAYOUT_V2_STORAGE_KEY,
      LEGACY_CANVAS_LAYOUT_V3_STORAGE_KEY,
      LEGACY_CANVAS_LAYOUT_V4_STORAGE_KEY,
      LEGACY_CANVAS_LAYOUT_V5_STORAGE_KEY,
      LEGACY_CANVAS_LAYOUT_V6_STORAGE_KEY,
      LEGACY_CANVAS_LAYOUT_V7_STORAGE_KEY,
      LEGACY_CANVAS_POSITION_STORAGE_KEY,
    ]) window.localStorage.removeItem(key);
    const stored = window.localStorage.getItem(CANVAS_LAYOUT_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const candidate = parsed as Partial<CanvasLayoutCache>;
        if (candidate.schemaVersion === CANVAS_LAYOUT_SCHEMA_VERSION && candidate.projects && typeof candidate.projects === "object" && !Array.isArray(candidate.projects)) {
          const cache = createCanvasLayoutCache();
          for (const [projectId, rawLayout] of Object.entries(candidate.projects as Record<string, unknown>)) {
            if (!rawLayout || typeof rawLayout !== "object" || Array.isArray(rawLayout)) continue;
            const layout = rawLayout as Partial<CanvasProjectLayout>;
            const positions = sanitizeCanvasPositions(layout.positions);
            const mode = layout.mode === "custom" || layout.mode === "formatted" ? layout.mode : Object.keys(positions).length ? "custom" : "formatted";
            cache.projects[projectId] = {
              positions,
              viewport: sanitizeCanvasViewport(layout.viewport),
              mode,
              updatedAt: typeof layout.updatedAt === "number" && Number.isFinite(layout.updatedAt) ? layout.updatedAt : 0,
            };
          }
          return cache;
        }
      }
    }
    return createCanvasLayoutCache();
  } catch {
    return createCanvasLayoutCache();
  }
}

export function writeCanvasLayoutCache(cache: CanvasLayoutCache): void {
  try { window.localStorage.setItem(CANVAS_LAYOUT_STORAGE_KEY, JSON.stringify(cache)); } catch { /* Storage is optional. */ }
}
