import { Home, LayoutDashboard } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { cn } from "@/lib/utils";

export default function SideCapsule() {
  const appView = useUIStore((s) => s.appView);
  const setAppView = useUIStore((s) => s.setAppView);
  const addToast = useUIStore((s) => s.addToast);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const sidebarPush = appView === "canvas" && sidebarVisible;

  const handleCanvasClick = () => {
    if (currentProjectId) {
      setAppView("canvas");
    } else {
      addToast({
        type: "info",
        title: "请先选择或创建一个项目",
        duration: 2500,
      });
    }
  };

  return (
    <div
      className="fixed top-1/2 z-50 -translate-y-1/2 transition-[left] duration-200"
      style={{ left: sidebarPush ? 278 : 0 }}
    >
      <div className="ml-1.5 flex flex-col gap-1 rounded-full border border-border bg-card/80 p-1 shadow-lg backdrop-blur-md">
        <button
          onClick={() => setAppView("home")}
          title="首页"
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
            appView === "home"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Home className="h-4 w-4" />
        </button>

        <button
          onClick={handleCanvasClick}
          title="画布"
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
            appView === "canvas"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <LayoutDashboard className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
