import { useEffect } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { saveProjectViewport } from "@/platform";

export function useAutoSaveViewport() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastX = 0, lastY = 0, lastZoom = 0;
    const unsub = useCanvasStore.subscribe((state, prev) => {
      const { x, y, zoom, width } = state.viewport;
      if (width === 0) return;
      if (x === lastX && y === lastY && zoom === lastZoom) return;
      if (x === prev.viewport.x && y === prev.viewport.y && zoom === prev.viewport.zoom) return;
      lastX = x; lastY = y; lastZoom = zoom;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const pid = useProjectStore.getState().currentProjectId;
        if (pid) saveProjectViewport(pid, { x, y, zoom });
      }, 1500);
    });
    return () => { clearTimeout(timer); unsub(); };
  }, []);
}
