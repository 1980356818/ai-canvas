import { useEffect } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useCardStore } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { loadCards } from "@/lib/tauri";
import { autoSave } from "@/lib/autoSave";
import { history } from "@/lib/history";
import { CARD_DEFAULTS } from "@/shared/constants";
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
  const agentPanelVisible = useUIStore((s) => s.agentPanelVisible);

  useEffect(() => {
    useSettingsStore.getState().applyTheme();
  }, []);

  useEffect(() => {
    if (!currentProjectId) {
      useCardStore.getState().clear();
      history.clear();
      return;
    }
    history.clear();

    loadCards(currentProjectId)
      .then((rows) => {
        const cards = rows.map((r) => {
          const defaults = CARD_DEFAULTS[r.type as CardType];
          return {
            id: r.id,
            projectId: r.project_id,
            type: r.type as CardType,
            x: r.x,
            y: r.y,
            width: defaults?.width ?? r.width,
            height: defaults?.height ?? r.height,
            zIndex: r.z_index,
            locked: r.locked,
            collapsed: r.collapsed,
            color: r.color ?? undefined,
            title: r.title ?? undefined,
            data: JSON.parse(r.data),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          };
        });
        useCardStore.getState().setCards(cards);
      })
      .catch(console.error);

    return () => {
      autoSave.forceSave();
    };
  }, [currentProjectId]);

  useKeyboardShortcuts();

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
