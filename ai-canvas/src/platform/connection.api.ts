import type { ConnectionRow } from "@/types";
import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";
import { invokeBatched } from "@/lib/ipcBatch";

export async function loadConnections(projectId: string): Promise<ConnectionRow[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<ConnectionRow[]>("load_connections", { projectId });
  }
  return lsGet<ConnectionRow[]>("connections_" + projectId, []);
}

/**
 * 批量持久化连线。强制走 [`invokeBatched`](@/lib/ipcBatch.ts) 守门，
 * 同 `saveCardsBatch` 的理由：单次 invoke 不能跨过 WebView2 ~3MB IPC 雷区。
 */
export async function saveConnections(
  projectId: string,
  connections: ConnectionRow[],
): Promise<void> {
  if (connections.length === 0) return;
  if (isTauri) {
    await invokeBatched({
      command: "save_connections_batch",
      items: connections,
      buildArgs: (chunk) => ({ connections: chunk }),
    });
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
