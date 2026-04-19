import { useEffect, useRef } from "react";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { Connection } from "@/types";
import { loadCards, loadConnections, saveConnections, saveProjectViewport, loadProjectViewport, migrateApiConfig } from "@/platform";
import { rebuildMissingConnections } from "@/lib/connectionRecovery";
import { autoSave } from "@/lib/autoSave";
import { history } from "@/lib/history";
import { startDataFlowWatcher } from "@/lib/dataFlow";
import { initMediaService } from "@/lib/media";
import { rowToCard, connectionToRow, rowToConnection } from "@/lib/mappers";

export function useProjectLifecycle() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const dataFlowCleanup = useRef<(() => void) | null>(null);
  const prevProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    useSettingsStore.getState().applyTheme();
    void initMediaService();
    void migrateApiConfig();

    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    document.addEventListener("dragover", prevent);
    document.addEventListener("drop", prevent);
    return () => {
      document.removeEventListener("dragover", prevent);
      document.removeEventListener("drop", prevent);
    };
  }, []);

  useEffect(() => {
    const prevId = prevProjectIdRef.current;
    if (prevId) {
      const stillExists = useProjectStore.getState().projects.some((p) => p.id === prevId);
      if (stillExists) {
        const vp = useCanvasStore.getState().viewport;
        saveProjectViewport(prevId, { x: vp.x, y: vp.y, zoom: vp.zoom });

        const conns = useConnectionStore.getState().getConnectionsByProject(prevId);
        void saveConnections(prevId, conns.map(connectionToRow));
      }
    }
    prevProjectIdRef.current = currentProjectId;

    if (!currentProjectId) {
      useCardStore.getState().clear();
      useConnectionStore.getState().clear();
      history.clear();
      return;
    }
    history.clear();

    const savedViewport = loadProjectViewport(currentProjectId);
    if (savedViewport) {
      useCanvasStore.getState().setViewport(savedViewport);
    } else {
      useCanvasStore.getState().setViewport({ x: 0, y: 0, zoom: 1 });
    }

    (async () => {
      const rows = await loadCards(currentProjectId);
      const cards = rows.map(rowToCard);
      useCardStore.getState().setCards(cards);

      const connRows = await loadConnections(currentProjectId);
      const conns: Connection[] = connRows.map(rowToConnection);

      const rebuilt = rebuildMissingConnections(currentProjectId, cards, conns);
      useConnectionStore.getState().setConnections(rebuilt);

      dataFlowCleanup.current?.();
      dataFlowCleanup.current = startDataFlowWatcher();
    })().catch(console.error);

    return () => {
      dataFlowCleanup.current?.();
      dataFlowCleanup.current = null;
      const pid = useProjectStore.getState().currentProjectId;
      if (pid) autoSave.forceSave();
    };
  }, [currentProjectId]);
}
