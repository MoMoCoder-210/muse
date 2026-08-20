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
  projects: Record<string, CanvasProjectLayout>;
};
export type CanvasLayoutCacheRead = {
  cache: CanvasLayoutCache;
  projectsNeedingFormat: string[];
};

const CANVAS_LAYOUT_STORAGE_KEY = "muse.agent-canvas.layout";
const LEGACY_CANVAS_STORAGE_KEYS = [
  "muse.agent-canvas.layout.v8",
  "muse.agent-canvas.layout.v7",
  "muse.agent-canvas.layout.v6",
  "muse.agent-canvas.layout.v5",
  "muse.agent-canvas.layout.v4",
  "muse.agent-canvas.layout.v3",
  "muse.agent-canvas.layout.v2",
  "muse.agent-canvas.layout.v1",
  "muse.agent-canvas.positions.v2",
];
const CANVAS_MIN_ZOOM = 0.25;
const CANVAS_MAX_ZOOM = 1.8;

export function createCanvasProjectLayout(): CanvasProjectLayout {
  return { positions: {}, mode: "formatted", updatedAt: 0 };
}

export function createCanvasLayoutCache(): CanvasLayoutCache {
  return { projects: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasValidPositions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((position) => {
    if (!isRecord(position)) return false;
    const { x, y } = position;
    return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y);
  });
}

export function sanitizeCanvasPositions(value: unknown): Record<string, CanvasNodePosition> {
  if (!isRecord(value)) return {};
  const positions: Record<string, CanvasNodePosition> = {};
  for (const [nodeId, position] of Object.entries(value)) {
    if (!isRecord(position)) continue;
    const { x, y } = position as Partial<CanvasNodePosition>;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      positions[nodeId] = { x, y };
    }
  }
  return positions;
}

export function sanitizeCanvasViewport(value: unknown): CanvasViewport | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, zoom } = value as Partial<CanvasViewport>;
  return typeof x === "number" && typeof y === "number" && typeof zoom === "number"
    && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom) && zoom > 0
    ? { x, y, zoom: Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom)) }
    : undefined;
}

function normalizeCanvasProjectLayout(rawLayout: unknown): { layout: CanvasProjectLayout; needsFormatting: boolean } {
  const source = isRecord(rawLayout) ? rawLayout : {};
  const positionsValue = source.positions;
  const positions = sanitizeCanvasPositions(positionsValue);
  const hasMode = source.mode === "custom" || source.mode === "formatted";
  const hasUpdatedAt = typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt);
  const mode = hasMode ? source.mode as CanvasLayoutMode : Object.keys(positions).length ? "custom" : "formatted";

  return {
    layout: {
      positions,
      // Viewport is optional by design: formatted layouts fit the canvas on load.
      viewport: sanitizeCanvasViewport(source.viewport),
      mode,
      updatedAt: hasUpdatedAt ? source.updatedAt as number : 0,
    },
    needsFormatting: !hasValidPositions(positionsValue) || !hasMode || !hasUpdatedAt,
  };
}

export function readCanvasLayoutCache(): CanvasLayoutCacheRead {
  const empty: CanvasLayoutCacheRead = { cache: createCanvasLayoutCache(), projectsNeedingFormat: [] };
  try {
    let parsed: Record<string, unknown> | null = null;
    let sourceKey = CANVAS_LAYOUT_STORAGE_KEY;
    for (const key of [CANVAS_LAYOUT_STORAGE_KEY, ...LEGACY_CANVAS_STORAGE_KEYS]) {
      const stored = window.localStorage.getItem(key);
      if (!stored) continue;
      try {
        const candidate: unknown = JSON.parse(stored);
        if (isRecord(candidate) && isRecord(candidate.projects)) {
          parsed = candidate;
          sourceKey = key;
          break;
        }
      } catch {
        // Try the next storage key; a malformed cache should not block startup.
      }
    }
    if (!parsed) return empty;

    const cache = createCanvasLayoutCache();
    const projectsNeedingFormat: string[] = [];
    const rawProjects = isRecord(parsed.projects) ? parsed.projects : {};
    for (const [projectId, rawLayout] of Object.entries(rawProjects)) {
      const normalized = normalizeCanvasProjectLayout(rawLayout);
      cache.projects[projectId] = normalized.layout;
      if (normalized.needsFormatting) projectsNeedingFormat.push(projectId);
    }

    if (sourceKey !== CANVAS_LAYOUT_STORAGE_KEY) {
      writeCanvasLayoutCache(cache);
      for (const key of LEGACY_CANVAS_STORAGE_KEYS) window.localStorage.removeItem(key);
    }
    return { cache, projectsNeedingFormat };
  } catch {
    return empty;
  }
}

export function writeCanvasLayoutCache(cache: CanvasLayoutCache): void {
  try { window.localStorage.setItem(CANVAS_LAYOUT_STORAGE_KEY, JSON.stringify(cache)); } catch { /* Storage is optional. */ }
}
