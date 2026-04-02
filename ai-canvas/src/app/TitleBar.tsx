import { Minus, Square, X, Home, PanelLeft } from "lucide-react";
import { useUIStore, type SaveStatus } from "@/stores/uiStore";
import { cn } from "@/lib/utils";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let appWindow: { minimize(): void; toggleMaximize(): void; close(): void } | null =
  null;

if (isTauri) {
  import("@tauri-apps/api/window").then((mod) => {
    appWindow = mod.getCurrentWindow();
  });
}

const SAVE_DOT: Record<SaveStatus, string> = {
  saved: "bg-emerald-500",
  unsaved: "bg-amber-500",
  saving: "bg-blue-500 animate-pulse",
  error: "bg-destructive",
};

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: "已保存",
  unsaved: "未保存",
  saving: "保存中",
  error: "保存失败",
};

export default function TitleBar() {
  const appView = useUIStore((s) => s.appView);
  const setAppView = useUIStore((s) => s.setAppView);
  const saveStatus = useUIStore((s) => s.saveStatus);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const isCanvas = appView === "canvas";

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center border-b border-border bg-muted/40 px-2 select-none"
    >
      {isCanvas && (
        <>
          <button
            onClick={() => setAppView("home")}
            title="返回首页"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1.5 h-4 w-px bg-border" />
        </>
      )}

      <span className="text-sm font-medium">AI 无限画布</span>

      {isCanvas && (
        <span
          title={SAVE_LABEL[saveStatus]}
          className={cn(
            "ml-2 h-2 w-2 shrink-0 rounded-full",
            SAVE_DOT[saveStatus],
          )}
        />
      )}

      <div data-tauri-drag-region className="flex-1" />

      {isCanvas && (
        <>
          <button
            onClick={toggleSidebar}
            title={sidebarVisible ? "收起侧边栏" : "展开侧边栏"}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              sidebarVisible && "bg-accent/60 text-foreground",
            )}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1.5 h-4 w-px bg-border" />
        </>
      )}

      {!isCanvas && (
        <button
          onClick={toggleSettings}
          title="设置"
          className="mr-2 flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          ⚙ 设置
        </button>
      )}

      {isTauri && (
        <div className="flex">
          <button
            onClick={() => appWindow?.minimize()}
            className="flex h-7 w-10 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => appWindow?.toggleMaximize()}
            className="flex h-7 w-10 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Square className="h-3 w-3" />
          </button>
          <button
            onClick={() => appWindow?.close()}
            className="flex h-7 w-10 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
