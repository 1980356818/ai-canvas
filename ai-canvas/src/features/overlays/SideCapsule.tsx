import { Home, FolderOpen, LayoutDashboard, Settings } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { cn } from "@/lib/utils";

export default function SideCapsule() {
  const appView = useUIStore((s) => s.appView);
  const setAppView = useUIStore((s) => s.setAppView);
  const addToast = useUIStore((s) => s.addToast);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
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

  const navItems = [
    { key: "home" as const, icon: Home, title: "首页", onClick: () => setAppView("home") },
    { key: "projects" as const, icon: FolderOpen, title: "我的项目", onClick: () => setAppView("projects") },
    { key: "canvas" as const, icon: LayoutDashboard, title: "画布", onClick: handleCanvasClick },
  ];

  return (
    <div
      className="fixed top-1/2 z-50 -translate-y-1/2 transition-[left] duration-200"
      style={{ left: sidebarPush ? 278 : 0 }}
    >
      <div className="ml-1.5 flex flex-col gap-1 rounded-full border border-border bg-card/80 p-1 shadow-lg backdrop-blur-md">
        {navItems.map((item) => (
          <button
            key={item.key}
            onClick={item.onClick}
            title={item.title}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
              appView === item.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <item.icon className="h-4 w-4" />
          </button>
        ))}

        <div className="mx-1.5 border-t border-border" />

        <button
          onClick={toggleSettings}
          title="设置"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
