import { useEffect } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useProviderStore } from "@/stores/providerStore";
import { useProjectLifecycle } from "@/hooks/useProjectLifecycle";
import { useConnectionSync } from "@/hooks/useConnectionSync";
import { useAutoSaveViewport } from "@/hooks/useAutoSaveViewport";
import { useBeforeUnload } from "@/hooks/useBeforeUnload";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useKeyboardShortcuts } from "@/features/canvas/hooks/useKeyboardShortcuts";
import "@/providers";

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
  const appView = useUIStore((s) => s.appView);
  const agentPanelVisible = useUIStore((s) => s.agentPanelVisible);
  const chatPanelVisible = useUIStore((s) => s.chatPanelVisible);

  const providerInitialized = useProviderStore((s) => s.initialized);

  useEffect(() => {
    if (!providerInitialized) {
      useProviderStore.getState().initialize();
    }
  }, [providerInitialized]);

  useProjectLifecycle();
  useConnectionSync();
  useAutoSaveViewport();
  useBeforeUnload();
  useGlobalShortcuts();
  useKeyboardShortcuts();

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
