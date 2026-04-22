import { useEffect, useRef } from "react";
import { Bot, MessageSquare } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import { ProjectPanel } from "./ProjectPanel";

const AUTO_CLOSE_MS = 30_000;

export function SidebarContainer() {
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const toggleAgentPanel = useUIStore((s) => s.toggleAgentPanel);
  const toggleChatPanel = useUIStore((s) => s.toggleChatPanel);

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoveringRef = useRef(false);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (sidebarVisible && !hoveringRef.current) {
      timerRef.current = setTimeout(() => {
        if (!hoveringRef.current) {
          useUIStore.getState().toggleSidebar();
        }
      }, AUTO_CLOSE_MS);
    }
    return () => clearTimeout(timerRef.current);
  }, [sidebarVisible]);

  const resetTimer = () => {
    clearTimeout(timerRef.current);
    if (sidebarVisible) {
      timerRef.current = setTimeout(() => {
        if (!hoveringRef.current) {
          useUIStore.getState().toggleSidebar();
        }
      }, AUTO_CLOSE_MS);
    }
  };

  const handleMouseEnter = () => {
    hoveringRef.current = true;
    clearTimeout(timerRef.current);
  };

  const handleMouseLeave = () => {
    hoveringRef.current = false;
    resetTimer();
  };

  return (
    <aside
      className={cn(
        "absolute left-3 top-3 bottom-3 z-40 flex w-[260px] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/80 shadow-lg backdrop-blur-xl transition-all duration-200 ease-out",
        sidebarVisible
          ? "translate-x-0 opacity-100"
          : "-translate-x-[calc(100%+12px)] opacity-0 pointer-events-none",
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <ProjectPanel />
      </div>

      <div className="flex items-center gap-1 border-t border-border px-3 py-2">
        <button
          onClick={toggleAgentPanel}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="AI 助手 (画布操作)"
        >
          <Bot className="h-3.5 w-3.5" />
          AI 助手
        </button>
        <button
          onClick={toggleChatPanel}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="AI 聊天 (对话+生图+生视频)"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          AI 聊天
        </button>
      </div>
    </aside>
  );
}
