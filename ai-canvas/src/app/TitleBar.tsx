import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Square, X, PanelLeft, Plus, Pencil, MessageSquare } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { NewProjectDialog } from "@/features/overlays/NewProjectDialog";
import { useUIStore } from "@/stores/uiStore";
import type { SaveStatus } from "@/types";
import { useProjectStore } from "@/stores/projectStore";
import { renameProject } from "@/platform";
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

interface TabContextMenuProps {
  x: number;
  y: number;
  onRename: () => void;
  onClose: () => void;
  onCloseTab: () => void;
}

function TabContextMenu({ x, y, onRename, onClose, onCloseTab }: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x, ny = y;
    const pad = 8;
    if (nx + rect.width > window.innerWidth - pad) nx = Math.max(pad, window.innerWidth - rect.width - pad);
    if (ny + rect.height > window.innerHeight - pad) ny = Math.max(pad, window.innerHeight - rect.height - pad);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const t = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[10rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
    >
      <button
        type="button"
        onClick={() => { onRename(); onClose(); }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Pencil className="h-3.5 w-3.5" />
        重命名
      </button>
      <div className="my-1 h-px bg-border" role="separator" />
      <button
        type="button"
        onClick={() => { onCloseTab(); onClose(); }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <X className="h-3.5 w-3.5" />
        关闭标签
      </button>
    </div>
  );
}

export default function TitleBar() {
  const appView = useUIStore((s) => s.appView);
  const setAppView = useUIStore((s) => s.setAppView);
  const saveStatus = useUIStore((s) => s.saveStatus);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const chatPanelVisible = useUIStore((s) => s.chatPanelVisible);
  const toggleChatPanel = useUIStore((s) => s.toggleChatPanel);
  const isCanvas = appView === "canvas";

  const projects = useProjectStore((s) => s.projects);
  const openProjectIds = useProjectStore((s) => s.openProjectIds);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const openProject = useProjectStore((s) => s.openProject);
  const closeProject = useProjectStore((s) => s.closeProject);
  const updateProject = useProjectStore((s) => s.updateProject);
  const addToast = useUIStore((s) => s.addToast);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; projectId: string } | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  useEffect(() => {
    if (!editingTabId) return;
    const t = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [editingTabId]);

  const commitTabRename = useCallback(
    async (id: string, nextTitle: string) => {
      const trimmed = nextTitle.trim();
      setEditingTabId(null);
      if (!trimmed) return;
      const proj = projects.find((p) => p.id === id);
      if (proj && trimmed !== proj.title) {
        try {
          await renameProject(id, trimmed);
          updateProject(id, { title: trimmed });
        } catch {
          addToast({ type: "error", title: "重命名失败", duration: 4000 });
        }
      }
    },
    [projects, updateProject, addToast],
  );

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
      <span className="shrink-0 pl-8 pr-3 text-base font-semibold tracking-wide text-foreground/80">AI猫</span>

      {isCanvas ? (
        <>
          <div className="flex shrink-0 items-center">
            <div className="mr-1.5 h-4 w-px bg-border" />
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
              const isEditing = editingTabId === id;
              return (
                <div
                  key={id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (!isEditing) handleSwitchTab(id); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") handleSwitchTab(id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingTabId(id);
                    setRenameDraft(proj.title);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtxMenu({ x: e.clientX, y: e.clientY, projectId: id });
                  }}
                  className={cn(
                    "group relative flex h-7 max-w-[180px] shrink-0 cursor-pointer items-center gap-1 rounded-t-lg px-3 text-xs transition-colors",
                    isActive
                      ? "bg-background text-foreground shadow-[0_-1px_3px_0_rgba(0,0,0,0.06)]"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {isEditing ? (
                    <input
                      ref={renameInputRef}
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitTabRename(id, renameDraft);
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingTabId(null);
                        }
                      }}
                      onBlur={() => void commitTabRename(id, renameDraft)}
                      className="w-full min-w-[60px] rounded border border-border bg-background px-1 py-0 text-xs text-foreground outline-none ring-ring focus-visible:ring-1"
                    />
                  ) : (
                    <span className="truncate">{proj.title}</span>
                  )}
                  {isActive && !isEditing && (
                    <span
                      title={SAVE_LABEL[saveStatus]}
                      className={cn(
                        "ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full",
                        SAVE_DOT[saveStatus],
                      )}
                    />
                  )}
                  {!isEditing && (
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
                  )}
                </div>
              );
            })}

            <button
              type="button"
              onClick={() => setNewProjectOpen(true)}
              title="新建项目"
              className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

          <div className="flex shrink-0 items-center pr-0.5">
            <div className="mx-1 h-4 w-px bg-border" />
          </div>
        </>
      ) : (
        <div data-tauri-drag-region className="flex-1" />
      )}

      {isTauri && (
        <div className="flex">
          {isCanvas && (
            <button
              onClick={toggleChatPanel}
              title={chatPanelVisible ? "关闭 AI 聊天" : "打开 AI 聊天"}
              className={cn(
                "flex h-7 w-10 items-center justify-center rounded-sm transition-colors",
                chatPanelVisible
                  ? "text-primary hover:bg-accent"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </button>
          )}
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
            onClick={() => { if (isTauri) void invoke("quit_app"); }}
            className="flex h-7 w-10 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={() => {
          addToast({ type: "success", title: "项目创建成功", duration: 3000 });
        }}
      />
      {ctxMenu && createPortal(
        <TabContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onRename={() => {
            const proj = projects.find((p) => p.id === ctxMenu.projectId);
            if (proj) {
              setEditingTabId(ctxMenu.projectId);
              setRenameDraft(proj.title);
            }
          }}
          onCloseTab={() => {
            const remaining = openProjectIds.filter((pid) => pid !== ctxMenu.projectId);
            closeProject(ctxMenu.projectId);
            if (remaining.length === 0) setAppView("projects");
          }}
          onClose={() => setCtxMenu(null)}
        />,
        document.body,
      )}
    </div>
  );
}
