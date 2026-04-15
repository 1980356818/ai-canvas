import { useEffect, useRef, startTransition } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useCardStore } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore, type Connection } from "@/stores/connectionStore";
import { isTauri, loadCards, loadConnections, saveConnections, saveProjectViewport, loadProjectViewport, migrateApiConfig } from "@/lib/tauri";
import { autoSave } from "@/lib/autoSave";
import { history } from "@/lib/history";
import { startDataFlowWatcher, removeRefImageForSource, removeUpstreamTextForSource } from "@/lib/dataFlow";
import { initMediaService } from "@/lib/media";

import { useKeyboardShortcuts } from "@/features/canvas/hooks/useKeyboardShortcuts";
import TitleBar from "@/app/TitleBar";
import ErrorBoundary from "@/app/ErrorBoundary";
import HomePage from "@/features/home/HomePage";
import ProjectsPage from "@/features/projects/ProjectsPage";
import CanvasContainer from "@/features/canvas/CanvasContainer";
import { SidebarContainer } from "@/features/sidebar/SidebarContainer";
import AgentPanel from "@/features/agent/AgentPanel";
import { Toast } from "@/features/overlays/Toast";
import { ContextMenu } from "@/features/overlays/ContextMenu";
import SettingsDialog from "@/features/overlays/SettingsDialog";
import SideCapsule from "@/features/overlays/SideCapsule";
import type { CardType } from "@/shared/types";

export default function App() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const appView = useUIStore((s) => s.appView);
  const dataFlowCleanup = useRef<(() => void) | null>(null);
  const agentPanelVisible = useUIStore((s) => s.agentPanelVisible);
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
        saveConnections(
          prevId,
          conns.map((c) => ({
            id: c.id,
            project_id: c.projectId,
            source_card_id: c.sourceCardId,
            target_card_id: c.targetCardId,
            created_at: c.createdAt,
          })),
        );
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

    loadCards(currentProjectId)
      .then((rows) => {
        const cards = rows.map((r) => ({
          id: r.id,
          projectId: r.project_id,
          type: r.type as CardType,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          zIndex: r.z_index,
          locked: r.locked,
          collapsed: r.collapsed,
          color: r.color ?? undefined,
          title: r.title ?? undefined,
          data: JSON.parse(r.data),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }));
        startTransition(() => {
          useCardStore.getState().setCards(cards);
        });

        const connRows = loadConnections(currentProjectId);
        const conns: Connection[] = connRows.map((r) => ({
          id: r.id,
          projectId: r.project_id,
          sourceCardId: r.source_card_id,
          targetCardId: r.target_card_id,
          createdAt: r.created_at,
        }));
        useConnectionStore.getState().setConnections(conns);

        dataFlowCleanup.current?.();
        dataFlowCleanup.current = startDataFlowWatcher();
      })
      .catch(console.error);

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

      // Skip per-connection cleanup when all connections were cleared (project switch/delete).
      // The card store is already cleared in that case, so the cleanup is unnecessary.
      if (state.connections.size > 0 || pid) {
        for (const [id, conn] of prev.connections) {
          if (!state.connections.has(id)) {
            removeRefImageForSource(conn.targetCardId, conn.sourceCardId);
            removeUpstreamTextForSource(conn.targetCardId, conn.sourceCardId);
          }
        }
      }

      if (!pid) return;
      const rows = Array.from(state.connections.values())
        .filter((c) => c.projectId === pid)
        .map((c) => ({
          id: c.id,
          project_id: c.projectId,
          source_card_id: c.sourceCardId,
          target_card_id: c.targetCardId,
          created_at: c.createdAt,
        }));
      saveConnections(pid, rows);
    });
    return unsub;
  }, []);

  useKeyboardShortcuts();

  useEffect(() => {
    const saveBeforeExit = async () => {
      const pid = useProjectStore.getState().currentProjectId;
      if (!pid) return;

      const vp = useCanvasStore.getState().viewport;
      saveProjectViewport(pid, { x: vp.x, y: vp.y, zoom: vp.zoom });

      const conns = useConnectionStore.getState().getConnectionsByProject(pid);
      saveConnections(
        pid,
        conns.map((c) => ({
          id: c.id,
          project_id: c.projectId,
          source_card_id: c.sourceCardId,
          target_card_id: c.targetCardId,
          created_at: c.createdAt,
        })),
      );

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
