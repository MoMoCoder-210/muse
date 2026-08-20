/** Deterministic geometry for the Agent production canvas. */

export const CANVAS_LAYOUT = {
  clipX: 24,
  materialX: 250,
  materialWidth: 500,
  shotsX: 790,
  shotsWidth: 700,
  releaseX: 1530,
  releaseWidth: 602,
  top: 24,
  rowGap: 34,
  centerHeaderHeight: 42,
  centerContentTop: 58,
  centerContentPadding: 12,
  categoryHeaderHeight: 36,
  categoryContentTop: 48,
  materialCategoryGap: 32,
  materialCategoryInset: 64,
  materialAssetInsetX: 20,
  materialAssetRightPadding: 20,
  materialAssetStartY: 48,
  shotsSidePadding: 64,
  shotCardWidth: 258,
  shotTrackX: 64,
  shotTrackWidth: 545,
  shotAnchorX: 180,
  shotColumnStep: 330,
  releaseContentX: 64,
  releaseOutputX: 292,
  releaseHistoryX: 292,
  releaseOutputHeight: 164,
  releaseHistoryTop: 180,
  releaseHistoryGap: 12,
  releaseContentBottomPadding: 12,
  videoCardHeight: 154,
  taskCardHeight: 58,
  shotDetailGap: 8,
} as const;

export interface ProductionRowMetric {
  clipId: string;
  y: number;
  height: number;
}

/** Allocate one stable vertical band per clip for all three centers. */
export function createProductionRows(
  clips: readonly { id: string }[],
  rowHeights: ReadonlyMap<string, number>,
  startY: number = CANVAS_LAYOUT.top,
): Map<string, ProductionRowMetric> {
  let cursor = startY;
  const rows = new Map<string, ProductionRowMetric>();
  for (const clip of clips) {
    const height = Math.max(112, rowHeights.get(clip.id) ?? 112);
    rows.set(clip.id, { clipId: clip.id, y: cursor, height });
    cursor += height + CANVAS_LAYOUT.rowGap;
  }
  return rows;
}
