import { Minus, Square, X, LayoutGrid, PanelLeft, Plus } from "lucide-react";
import { useUIStore, type SaveStatus } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
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
  const isCanvas = appView === "canvas";

  const projects = useProjectStore((s) => s.projects);
  const openProjectIds = useProjectStore((s) => s.openProjectIds);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const openProject = useProjectStore((s) => s.openProject);
  const closeProject = useProjectStore((s) => s.closeProject);

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const remaining = openProjectIds.filter((pid) => pid !== id);
    closeProject(id);
    if (remaining.length === 0) {
      setAppView("projects");
    }
  };

  const handleSwitchTab = (id: string) => {
    if (id !== currentProjectId) {
      openProject(id);
    }
  };

  const isHome = appView === "home";

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-9 shrink-0 items-center select-none",
        isHome
          ? "bg-transparent"
          : "border-b border-border bg-muted/40",
      )}
    >
      {isCanvas ? (
        <>
          <div className="flex shrink-0 items-center pl-1.5">
            <button
              onClick={() => setAppView("projects")}
              title="项目列表"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <div className="ml-1.5 h-4 w-px bg-border" />
          </div>

          <div
            data-tauri-drag-region
            className="scrollbar-none flex min-w-0 flex-1 items-end gap-px overflow-x-auto px-1.5 pt-1"
          >
            {openProjectIds.map((id) => {
              const proj = projects.find((p) => p.id === id);
              if (!proj) return null;
              const isActive = id === currentProjectId;
              return (
                <div
                  key={id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSwitchTab(id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") handleSwitchTab(id);
                  }}
                  className={cn(
                    "group relative flex h-7 max-w-[180px] shrink-0 cursor-pointer items-center gap-1 rounded-t-lg px-3 text-xs transition-colors",
                    isActive
                      ? "bg-background text-foreground shadow-[0_-1px_3px_0_rgba(0,0,0,0.06)]"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="truncate">{proj.title}</span>
                  {isActive && (
                    <span
                      title={SAVE_LABEL[saveStatus]}
                      className={cn(
                        "ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full",
                        SAVE_DOT[saveStatus],
                      )}
                    />
                  )}
                  <button
                    type="button"
                    onClick={(e) => handleCloseTab(e, id)}
                    className={cn(
                      "ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors",
                      isActive
                        ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                        : "text-transparent group-hover:text-muted-foreground group-hover:hover:bg-accent group-hover:hover:text-foreground",
                    )}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              onClick={() => setAppView("projects")}
              title="打开项目"
              className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

          <div className="flex shrink-0 items-center pr-0.5">
            <div className="mx-1 h-4 w-px bg-border" />
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
            <div className="mx-1 h-4 w-px bg-border" />
          </div>
        </>
      ) : (
        <>
          {!isHome && (
            <span className="px-3 text-sm font-medium">AI 无限画布</span>
          )}
          <div data-tauri-drag-region className="flex-1" />
        </>
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
