import { useEffect } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { saveConnections } from "@/platform";
import { connectionToRow } from "@/lib/mappers";

/**
 * Persists connection changes to the backend. Reference consistency (cleaning
 * up dangling refImages / upstreamTexts / refFrames / refAudios / refVideos /
 * directMedia / inlineRefs when a connection disappears) is handled
 * synchronously via the connection-store lifecycle hooks registered in
 * `referenceConsistency.ts`. Doing it there means we cannot lose the cleanup
 * to a stale-closure overwrite from any editor.
 */
export function useConnectionSync() {
  useEffect(() => {
    const unsub = useConnectionStore.subscribe((state, prev) => {
      if (state.connections === prev.connections) return;
      const pid = useProjectStore.getState().currentProjectId;
      if (!pid) return;
      const rows = Array.from(state.connections.values())
        .filter((c) => c.projectId === pid)
        .map(connectionToRow);
      void saveConnections(pid, rows);
    });
    return unsub;
  }, []);
}
