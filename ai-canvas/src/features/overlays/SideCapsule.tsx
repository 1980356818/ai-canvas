import { Home, FolderOpen, LayoutDashboard, Settings, Sun, Moon } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { cn } from "@/lib/utils";

function ThemeToggle() {
  const theme = useSettingsStore((s) => s.theme);
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <button
      onClick={() => useSettingsStore.getState().toggleTheme()}
      title={dark ? "切换到日间模式" : "切换到夜间模式"}
      className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}

export default function SideCapsule() {
  const appView = useUIStore((s) => s.appView);
  const setAppView = useUIStore((s) => s.setAppView);
  const addToast = useUIStore((s) => s.addToast);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const isCanvas = appView === "canvas";

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

  const handleProjectsClick = () => {
    if (isCanvas) {
      toggleSidebar();
    } else {
      setAppView("projects");
    }
  };

  const navItems = [
    { key: "home" as const, icon: Home, title: "首页", onClick: () => setAppView("home") },
    { key: "projects" as const, icon: FolderOpen, title: "我的项目", onClick: handleProjectsClick },
    { key: "canvas" as const, icon: LayoutDashboard, title: "画布", onClick: handleCanvasClick },
  ];

  return (
    <div
      className="fixed top-1/2 z-50 -translate-y-1/2 transition-[left] duration-200"
      style={{ left: 0 }}
    >
      <div className="ml-2 flex flex-col gap-1.5 rounded-full border border-border bg-card/80 p-1.5 shadow-lg backdrop-blur-md">
        {navItems.map((item) => (
          <button
            key={item.key}
            onClick={item.onClick}
            title={item.title}
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-full transition-colors",
              item.key === "projects" && isCanvas && sidebarVisible
                ? "bg-primary text-primary-foreground"
                : appView === item.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <item.icon className="h-5 w-5" />
          </button>
        ))}

        <div className="mx-2 border-t border-border" />

        <ThemeToggle />

        <button
          onClick={toggleSettings}
          title="设置"
          className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Settings className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
