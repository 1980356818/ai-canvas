import { Bot, Settings } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import { ProjectPanel } from "./ProjectPanel";

export function SidebarContainer() {
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const toggleAgentPanel = useUIStore((s) => s.toggleAgentPanel);
  const toggleSettings = useUIStore((s) => s.toggleSettings);

  return (
    <aside
      className={cn(
        "absolute left-3 top-3 bottom-3 z-30 flex w-[260px] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/80 shadow-lg backdrop-blur-xl transition-all duration-200 ease-out",
        sidebarVisible
          ? "translate-x-0 opacity-100"
          : "-translate-x-[calc(100%+12px)] opacity-0 pointer-events-none",
      )}
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <ProjectPanel />
      </div>

      <div className="flex items-center gap-1 border-t border-border px-3 py-2">
        <button
          onClick={toggleAgentPanel}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="AI 助手"
        >
          <Bot className="h-3.5 w-3.5" />
          AI 助手
        </button>
        <button
          onClick={toggleSettings}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="设置"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>
    </aside>
  );
}
