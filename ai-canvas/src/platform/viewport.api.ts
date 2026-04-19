import type { SavedViewport } from "@/types";
import { lsGet, lsSet, lsRemove } from "./storage";

export function saveProjectViewport(
  projectId: string,
  viewport: SavedViewport,
): void {
  lsSet("viewport_" + projectId, viewport);
}

export function loadProjectViewport(
  projectId: string,
): SavedViewport | null {
  return lsGet<SavedViewport | null>("viewport_" + projectId, null);
}

export function removeProjectViewport(projectId: string): void {
  lsRemove("viewport_" + projectId);
}
