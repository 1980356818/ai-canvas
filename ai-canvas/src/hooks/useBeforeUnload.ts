import { useEffect } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { isTauri, saveConnections, saveProjectViewport } from "@/platform";
import { autoSave } from "@/lib/autoSave";
import { connectionToRow } from "@/lib/mappers";

export function useBeforeUnload() {
  useEffect(() => {
    const saveBeforeExit = async () => {
      const pid = useProjectStore.getState().currentProjectId;
      if (!pid) return;

      const vp = useCanvasStore.getState().viewport;
      saveProjectViewport(pid, { x: vp.x, y: vp.y, zoom: vp.zoom });

      const conns = useConnectionStore.getState().getConnectionsByProject(pid);
      await saveConnections(pid, conns.map(connectionToRow));

      await autoSave.forceSave();
    };

    if (isTauri) {
      let unlisten: (() => void) | undefined;
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        win.onCloseRequested(async (event) => {
          event.preventDefault();
          await saveBeforeExit();
          await win.destroy();
        }).then((fn) => { unlisten = fn; });
      });
      return () => unlisten?.();
    }

    const handleBeforeUnload = () => { void saveBeforeExit(); };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);
}
