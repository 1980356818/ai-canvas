import { useEffect, useRef } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { Connection } from "@/types";
import { isTauri, loadCards, loadConnections, saveConnections, saveProjectViewport, loadProjectViewport, migrateApiConfig } from "@/lib/tauri";
import { rebuildMissingConnections } from "@/lib/connectionRecovery";
import { autoSave } from "@/lib/autoSave";
import { history } from "@/lib/history";
import { startDataFlowWatcher, removeRefImageForSource, removeUpstreamTextForSource, removeVideoFrameForSource } from "@/lib/dataFlow";
import { initMediaService } from "@/lib/media";
import { rowToCard, connectionToRow, rowToConnection } from "@/lib/mappers";

import { useKeyboardShortcuts } from "@/features/canvas/hooks/useKeyboardShortcuts";
import TitleBar from "@/app/TitleBar";
import ErrorBoundary from "@/app/ErrorBoundary";
import HomePage from "@/features/home/HomePage";
import ProjectsPage from "@/features/projects/ProjectsPage";
import CanvasContainer from "@/features/canvas/CanvasContainer";
import { SidebarContainer } from "@/features/sidebar/SidebarContainer";
import AgentPanel from "@/features/agent/AgentPanel";
import ChatPanel from "@/features/chat/ChatPanel";
import { Toast } from "@/features/overlays/Toast";
import { ContextMenu } from "@/features/overlays/ContextMenu";
import SettingsDialog from "@/features/overlays/SettingsDialog";
import SideCapsule from "@/features/overlays/SideCapsule";

export default function App() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const appView = useUIStore((s) => s.appView);
  const dataFlowCleanup = useRef<(() => void) | null>(null);
  const agentPanelVisible = useUIStore((s) => s.agentPanelVisible);
  const chatPanelVisible = useUIStore((s) => s.chatPanelVisible);
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
      // Only save if the project still exists (skip on project deletion)
      const pid = useProjectStore.getState().currentProjectId;
      if (pid) autoSave.forceSave();
    };
  }, [currentProjectId]);

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

  // Debounced auto-save viewport on every pan/zoom
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

  useKeyboardShortcuts();

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        autoSave.forceSave().then(() => {
          useUIStore.getState().addToast({
            type: "success",
            title: "项目已保存",
            duration: 2000,
          });
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TitleBar />
      <ErrorBoundary>
        {appView === "home" ? (
          <HomePage />
        ) : appView === "projects" ? (
          <ProjectsPage />
        ) : (
          <div className="relative flex flex-1 overflow-hidden">
            <CanvasContainer />
            <SidebarContainer />
            {agentPanelVisible && <AgentPanel />}
            {chatPanelVisible && <ChatPanel />}
          </div>
        )}
      </ErrorBoundary>
      <SideCapsule />
      <Toast />
      <ContextMenu />
      <SettingsDialog />
    </div>
  );
}
