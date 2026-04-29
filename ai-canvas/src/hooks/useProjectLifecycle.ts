import { useEffect, useRef } from "react";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { Connection } from "@/types";
import {
  loadCards,
  loadConnections,
  saveCardsBatch,
  saveConnections,
  saveProjectViewport,
  loadProjectViewport,
  migrateApiConfig,
} from "@/platform";
import { rebuildMissingConnections } from "@/lib/connectionRecovery";
import { cleanupDanglingReferencesInCards } from "@/lib/referenceConsistency";
import { autoSave } from "@/lib/autoSave";
import { history } from "@/lib/history";
import { startDataFlowWatcher } from "@/lib/dataFlow";
import { initMediaService } from "@/lib/media";
import { cardToRow, rowToCard, connectionToRow, rowToConnection } from "@/lib/mappers";

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
      console.log("[生命周期诊断] 切换项目，开始 loadCards", { projectId: currentProjectId });
      const rows = await loadCards(currentProjectId);
      const loadedCards = rows.map(rowToCard);
      console.log("[生命周期诊断] loadCards 返回", { count: loadedCards.length, projectId: currentProjectId });

      const connRows = await loadConnections(currentProjectId);
      const persistedConnections: Connection[] = connRows.map(rowToConnection);

      const validConnections = rebuildMissingConnections(currentProjectId, loadedCards, persistedConnections);
      const { cards, changedCardIds } = cleanupDanglingReferencesInCards(loadedCards, validConnections);
      console.log("[生命周期诊断] setCards", { final: cards.length, dropped: loadedCards.length - cards.length });

      useCardStore.getState().setCards(cards);
      useConnectionStore.getState().setConnections(validConnections);

      const persistenceTasks: Promise<unknown>[] = [];
      if (validConnections.length !== persistedConnections.length) {
        persistenceTasks.push(saveConnections(currentProjectId, validConnections.map(connectionToRow)));
      }
      if (changedCardIds.length > 0) {
        const changedCards = cards.filter((card) => changedCardIds.includes(card.id));
        persistenceTasks.push(saveCardsBatch(changedCards.map(cardToRow)));
      }
      if (persistenceTasks.length > 0) {
        await Promise.all(persistenceTasks);
      }

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
