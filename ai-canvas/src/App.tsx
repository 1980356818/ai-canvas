import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUIStore } from "@/stores/uiStore";
import { useProviderStore } from "@/stores/providerStore";
import { useAuthStore } from "@/stores/authStore";
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
import { CropDialog } from "@/features/overlays/CropDialog";
import SideCapsule from "@/features/overlays/SideCapsule";
import LoginWindow from "@/features/auth/LoginWindow";
import RedeemWindow from "@/features/auth/RedeemWindow";

function AuthenticatedApp() {
  const appView = useUIStore((s) => s.appView);
  const agentPanelVisible = useUIStore((s) => s.agentPanelVisible);
  const chatPanelVisible = useUIStore((s) => s.chatPanelVisible);

  const providerInitialized = useProviderStore((s) => s.initialized);

  useEffect(() => {
    if (!providerInitialized) {
      useProviderStore.getState().initialize();
    }
  }, [providerInitialized]);

  useEffect(() => {
    invoke("resize_window", {
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      resizable: true,
    });
  }, []);

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
      <CropDialog />
    </div>
  );
}

export default function App() {
  const authInitialized = useAuthStore((s) => s.initialized);
  const authenticated = useAuthStore((s) => s.authenticated);
  const restricted = useAuthStore((s) => s.restricted);

  useEffect(() => {
    if (!authInitialized) {
      useAuthStore.getState().initialize();
    }
  }, [authInitialized]);

  if (!authInitialized) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (!authenticated) {
    return <LoginWindow />;
  }

  if (restricted) {
    return <RedeemWindow />;
  }

  return <AuthenticatedApp />;
}
