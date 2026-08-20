/** Strict adapter for an Agent disclosure into the production canvas. */
import type { ProjectCanvasReadModel } from "../../services/tauri";
import { canvasCenterId, canonicalAssetId, canonicalStoryboardId, canonicalTaskId, canonicalVideoId, createCanvasHierarchy, type CanvasHierarchy } from "./sync";

export type CanvasDisclosureTarget = { kind: "asset"; id: string } | { kind: "storyboard"; id: string } | { kind: "video"; id: string } | { kind: "task"; id: string };
export interface CanvasDisclosure { projectId: string; target: CanvasDisclosureTarget; }
export interface CanvasDisclosureEffect { expandedCanonicalIds: string[]; selectedCanonicalId: string; centerCanonicalId: string; }

/** Returns null unless the project and concrete canonical target both exist. */
export function adaptCanvasDisclosure(disclosure: CanvasDisclosure, model: ProjectCanvasReadModel, hierarchy: CanvasHierarchy = createCanvasHierarchy(model)): CanvasDisclosureEffect | null {
  if (disclosure.projectId !== model.project.id || hierarchy.projectId !== disclosure.projectId) return null;
  const targetId = disclosure.target.kind === "asset" ? canonicalAssetId(disclosure.target.id)
    : disclosure.target.kind === "storyboard" ? canonicalStoryboardId(disclosure.target.id)
      : disclosure.target.kind === "video" ? canonicalVideoId(disclosure.target.id) : canonicalTaskId(disclosure.target.id);
  const target = hierarchy.byId.get(targetId);
  if (!target) return null;

  const path: string[] = [];
  let current = target;
  let clipId: string | null = null;
  let material = false;
  while (current.parentId) {
    path.push(current.parentId);
    if (current.data.entityType === "asset" || current.data.entityType === "material-category") material = true;
    const parent = hierarchy.byId.get(current.parentId);
    if (!parent) return null;
    if (parent.data.entityType === "clip") clipId = parent.data.entityId;
    current = parent;
  }
  if (target.data.entityType === "asset") material = true;
  const center = canvasCenterId(material ? "materials" : "shots", clipId);
  const expansions = new Set(path.reverse());
  expansions.add(center);
  return { expandedCanonicalIds: [...expansions], selectedCanonicalId: targetId, centerCanonicalId: center };
}
