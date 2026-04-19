import { useEffect } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { saveConnections } from "@/platform";
import { removeRefImageForSource, removeUpstreamTextForSource, removeVideoFrameForSource } from "@/lib/dataFlow";
import { connectionToRow } from "@/lib/mappers";

export function useConnectionSync() {
  useEffect(() => {
    const unsub = useConnectionStore.subscribe((state, prev) => {
      if (state.connections === prev.connections) return;

      const pid = useProjectStore.getState().currentProjectId;

      if (state.connections.size > 0 || pid) {
        for (const [id, conn] of prev.connections) {
          if (!state.connections.has(id)) {
            removeRefImageForSource(conn.targetCardId, conn.sourceCardId);
            removeUpstreamTextForSource(conn.targetCardId, conn.sourceCardId);
            removeVideoFrameForSource(conn.targetCardId, conn.sourceCardId);
          }
        }
      }

      if (!pid) return;
      const rows = Array.from(state.connections.values())
        .filter((c) => c.projectId === pid)
        .map(connectionToRow);
      void saveConnections(pid, rows);
    });
    return unsub;
  }, []);
}
