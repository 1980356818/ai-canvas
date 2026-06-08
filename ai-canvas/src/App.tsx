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
import TaskRecordDialog from "@/features/tasks/TaskRecordDialog";
import PriceListDialog from "@/features/overlays/PriceListDialog";
import { CropDialog } from "@/features/overlays/CropDialog";
import SideCapsule from "@/features/overlays/SideCapsule";
import LoginWindow from "@/features/auth/LoginWindow";
import RedeemWindow from "@/features/auth/RedeemWindow";
import UpdateDialog from "@/features/overlays/UpdateDialog";
import FfmpegSetupDialog from "@/features/overlays/FfmpegSetupDialog";
import UpgradeDialog from "@/features/auth/UpgradeDialog";

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

  useEffect(() => {
    const handler = (e: Event) => {
      const keyName = (e as CustomEvent).detail?.keyName;
      if (keyName) {
        useUIStore.getState().addToast({
          type: "warning",
          title: `API Key 已自动切换到「${keyName}」`,
          description: "前一个 Key 不可用，已自动轮转到下一个",
          duration: 5000,
        });
      }
    };
    window.addEventListener("ai-key-rotated", handler);
    return () => window.removeEventListener("ai-key-rotated", handler);
  }, []);

  return (
    <ErrorBoundary>
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
        {/* Toast 不能放进 ErrorBoundary：它本身就是错误兜底的展示出口，
            要是它自己崩了，至少别把整个 app 一起带走 */}
        <Toast />
        <ErrorBoundary fallback={null}>
          <ContextMenu />
        </ErrorBoundary>
        <ErrorBoundary fallback={null}>
          <SettingsDialog />
        </ErrorBoundary>
        <ErrorBoundary fallback={null}>
          <TaskRecordDialog />
        </ErrorBoundary>
        <ErrorBoundary fallback={null}>
          <PriceListDialog />
        </ErrorBoundary>
        <ErrorBoundary fallback={null}>
          <CropDialog />
        </ErrorBoundary>
        {/* 启动后台查更新; 命中新版本弹自身,否则 render null。出错静默吞掉。 */}
        <ErrorBoundary fallback={null}>
          <UpdateDialog />
        </ErrorBoundary>
        {/* 启动后台查 ffmpeg; 本地缺则弹安装提示,否则 render null。 */}
        <ErrorBoundary fallback={null}>
          <FfmpegSetupDialog />
        </ErrorBoundary>
        {/* App 内升级弹窗; 试用用户点到被锁功能时打开,输正式版激活码热解锁。 */}
        <ErrorBoundary fallback={null}>
          <UpgradeDialog />
        </ErrorBoundary>
      </div>
    </ErrorBoundary>
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
