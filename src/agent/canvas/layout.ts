/** Stable production-line layout shared by the three composite canvas centers. */
import type { AssetType } from "../../types/project";
import type { CanvasFlowNodeData } from "./node-data";

export const CANVAS_LAYOUT = {
  clipX: 24,
  materialX: 250,
  materialWidth: 500,
  shotsX: 790,
  shotsWidth: 700,
  releaseX: 1530,
  releaseWidth: 660,
  top: 24,
  rowGap: 34,
  entryY: 18,
  materialContentX: 132,
  shotTrackX: 104,
  shotTrackWidth: 545,
  releaseContentX: 130,
} as const;

export interface ProductionLayoutItem {
  id: string;
  clipId: string;
  center: "materials" | "shots" | "release";
  data: CanvasFlowNodeData;
}
export interface ProductionRowMetric {
  clipId: string;
  y: number;
  height: number;
}

/**
 * Every clip is allocated one shared vertical band. Callers contribute the
 * tallest detail area for that clip, then all three centers use its same y.
 */
export function createProductionRows(clips: readonly { id: string }[], rowHeights: ReadonlyMap<string, number>, startY: number = CANVAS_LAYOUT.top): Map<string, ProductionRowMetric> {
  let cursor = startY;
  const rows = new Map<string, ProductionRowMetric>();
  for (const clip of clips) {
    const height = Math.max(112, rowHeights.get(clip.id) ?? 112);
    rows.set(clip.id, { clipId: clip.id, y: cursor, height });
    cursor += height + CANVAS_LAYOUT.rowGap;
  }
  return rows;
}

export function categoryDetailHeight(assets: readonly { id: string; type: AssetType; expanded: boolean; detailCount: number }[], type: AssetType, categoryOpen: boolean): number {
  if (!categoryOpen) return 38;
  const members = assets.filter((asset) => asset.type === type);
  if (members.length === 0) return 74;
  let height = 0;
  let compactColumn = 0;
  for (const asset of members) {
    if (asset.expanded) {
      if (compactColumn) { height += 72; compactColumn = 0; }
      height += 150 + Math.min(2, Math.max(0, asset.detailCount)) * 20;
      continue;
    }
    compactColumn += 1;
    if (compactColumn === 2) { height += 72; compactColumn = 0; }
  }
  if (compactColumn) height += 72;
  return 42 + height;
}
