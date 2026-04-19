import type { ConnectionRow } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";

export async function loadConnections(projectId: string): Promise<ConnectionRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<ConnectionRow[]>("load_connections", { projectId });
  }
  return lsGet<ConnectionRow[]>("connections_" + projectId, []);
}

export async function saveConnections(
  projectId: string,
  connections: ConnectionRow[],
): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("save_connections_batch", { connections });
    return;
  }
  lsSet("connections_" + projectId, connections);
}

export async function clearProjectConnections(projectId: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("clear_project_connections", { projectId });
    return;
  }
  lsSet("connections_" + projectId, []);
}
