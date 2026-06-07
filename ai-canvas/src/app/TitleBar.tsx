import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Square, X, PanelLeft, Plus, Pencil, MessageSquare, Download, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { NewProjectDialog } from "@/features/overlays/NewProjectDialog";
import { useUIStore } from "@/stores/uiStore";
import type { SaveStatus } from "@/types";
import { useProjectStore } from "@/stores/projectStore";
import { renameProject } from "@/platform";
import { exportProjectToFile } from "@/lib/projectTransfer";
import { cn } from "@/lib/utils";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const isMac = /mac|iphone|ipad/i.test(navigator.platform);

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
  onExport: () => void;
  onClose: () => void;
  onCloseTab: () => void;
}

function TabContextMenu({ x, y, onRename, onExport, onClose, onCloseTab }: TabContextMenuProps) {
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
      <button
        type="button"
        onClick={() => { onExport(); onClose(); }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Download className="h-3.5 w-3.5" />
        另存为…
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

interface OverflowMenuProps {
  anchor: DOMRect;
  items: { id: string; title: string }[];
  activeId: string | null;
  onPick: (id: string) => void;
  onCloseTab: (id: string) => void;
  onClose: () => void;
}

function OverflowMenu({ anchor, items, activeId, onPick, onCloseTab, onClose }: OverflowMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: anchor.right, y: anchor.bottom + 4 });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let nx = anchor.right - rect.width; // 右对齐到按钮
    let ny = anchor.bottom + 4;
    if (nx < pad) nx = pad;
    if (nx + rect.width > window.innerWidth - pad) nx = Math.max(pad, window.innerWidth - rect.width - pad);
    if (ny + rect.height > window.innerHeight - pad) ny = Math.max(pad, window.innerHeight - rect.height - pad);
    setPos({ x: nx, y: ny });
  }, [anchor]);

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
      className="scrollbar-none fixed z-50 max-h-[60vh] w-60 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
    >
      {items.map((it) => {
        const active = it.id === activeId;
        return (
          <div
            key={it.id}
            role="menuitem"
            tabIndex={0}
            onClick={() => { onPick(it.id); onClose(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { onPick(it.id); onClose(); } }}
            className={cn(
              "group/ov flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              active
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", active ? "bg-primary" : "bg-transparent")} />
            <span className="flex-1 truncate">{it.title}</span>
            <button
              type="button"
              title="关闭标签"
              onClick={(e) => { e.stopPropagation(); onCloseTab(it.id); }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/0 transition-colors hover:bg-background hover:text-foreground group-hover/ov:text-muted-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
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

  // ── 标签栏溢出处理(滚动/箭头/下拉) ──
  const tabStripRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLElement>>(new Map());
  const setTabRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) tabRefs.current.set(id, el);
      else tabRefs.current.delete(id);
    },
    [],
  );
  const [overflowing, setOverflowing] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [overflowMenu, setOverflowMenu] = useState<DOMRect | null>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);

  const recomputeScroll = useCallback(() => {
    const c = tabStripRef.current;
    if (!c) return;
    const max = c.scrollWidth - c.clientWidth;
    setOverflowing(max > 1);
    setCanScrollLeft(c.scrollLeft > 1);
    setCanScrollRight(c.scrollLeft < max - 1);
  }, []);

  const scrollTabs = useCallback((dir: -1 | 1) => {
    tabStripRef.current?.scrollBy({ left: dir * 240, behavior: "smooth" });
  }, []);

  const handleTabWheel = useCallback((e: React.WheelEvent) => {
    const c = tabStripRef.current;
    if (!c || e.deltaY === 0) return;
    if (c.scrollWidth <= c.clientWidth) return;
    c.scrollLeft += e.deltaY; // 竖向滚轮转成横向滚动(passive 安全,不 preventDefault)
  }, []);

  // 进入画布 / 标签集合变化后重算溢出状态,并监听滚动与尺寸变化
  useEffect(() => {
    const c = tabStripRef.current;
    if (!c || !isCanvas) return;
    const onScroll = () => recomputeScroll();
    c.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => recomputeScroll());
    ro.observe(c);
    recomputeScroll();
    return () => {
      c.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [isCanvas, recomputeScroll]);

  useLayoutEffect(() => {
    recomputeScroll();
  }, [openProjectIds, isCanvas, recomputeScroll]);

  // 不再溢出时收起下拉菜单(避免悬空的 portal)
  useEffect(() => {
    if (!overflowing) setOverflowMenu(null);
  }, [overflowing]);

  // 切换/打开项目时把激活标签滚入可视区(只滚动标签条本身)
  useLayoutEffect(() => {
    if (!currentProjectId) return;
    const c = tabStripRef.current;
    const el = tabRefs.current.get(currentProjectId);
    if (!c || !el) return;
    const cRect = c.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.left < cRect.left) c.scrollBy({ left: eRect.left - cRect.left - 12, behavior: "smooth" });
    else if (eRect.right > cRect.right) c.scrollBy({ left: eRect.right - cRect.right + 12, behavior: "smooth" });
  }, [currentProjectId, openProjectIds]);

  const closeTabById = useCallback(
    (id: string) => {
      const remaining = openProjectIds.filter((pid) => pid !== id);
      closeProject(id);
      if (remaining.length === 0) setAppView("projects");
    },
    [openProjectIds, closeProject, setAppView],
  );

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
    closeTabById(id);
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
      <span className={cn("shrink-0 pr-3 text-base font-semibold tracking-wide text-foreground/80", isMac ? "pl-[76px]" : "pl-8")}>AI猫</span>

      {isCanvas ? (
        <>
          <div className="flex shrink-0 items-center">
            <div className="mr-1.5 h-4 w-px bg-border" />
            <button
              onClick={toggleSidebar}
              title={sidebarVisible ? "收起侧边栏" : "展开侧边栏"}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                sidebarVisible && "bg-accent text-foreground",
              )}
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </button>
            <div className="ml-1.5 h-4 w-px bg-border" />
          </div>

          <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center">
            {overflowing && (
              <button
                type="button"
                data-tauri-drag-region="false"
                onClick={() => scrollTabs(-1)}
                disabled={!canScrollLeft}
                title="向左滚动"
                className={cn(
                  "mb-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  !canScrollLeft && "pointer-events-none opacity-30",
                )}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}

          <div
            ref={tabStripRef}
            data-tauri-drag-region
            onWheel={handleTabWheel}
            className="scrollbar-none flex min-w-0 flex-1 items-end gap-px overflow-x-auto px-1 pt-1"
          >
            {openProjectIds.map((id) => {
              const proj = projects.find((p) => p.id === id);
              if (!proj) return null;
              const isActive = id === currentProjectId;
              const isEditing = editingTabId === id;
              return (
                <div
                  key={id}
                  ref={setTabRef(id)}
                  data-tauri-drag-region="false"
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
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {isEditing ? (
                    <input
                      ref={renameInputRef}
                      data-tauri-drag-region="false"
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
              data-tauri-drag-region="false"
              onClick={() => setNewProjectOpen(true)}
              title="新建项目"
              className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

            {overflowing && (
              <button
                type="button"
                data-tauri-drag-region="false"
                onClick={() => scrollTabs(1)}
                disabled={!canScrollRight}
                title="向右滚动"
                className={cn(
                  "mb-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  !canScrollRight && "pointer-events-none opacity-30",
                )}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            )}

            {overflowing && (
              <button
                ref={overflowBtnRef}
                type="button"
                data-tauri-drag-region="false"
                onClick={() =>
                  setOverflowMenu((prev) =>
                    prev ? null : (overflowBtnRef.current?.getBoundingClientRect() ?? null),
                  )
                }
                title="所有打开的项目"
                className={cn(
                  "mb-0.5 ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  overflowMenu && "bg-accent text-foreground",
                )}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            )}
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
          {!isMac && (
            <>
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
            </>
          )}
        </div>
      )}
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={() => {
          addToast({ type: "success", title: "项目创建成功", duration: 3000 });
        }}
      />
      {overflowMenu && createPortal(
        <OverflowMenu
          anchor={overflowMenu}
          items={openProjectIds
            .map((id) => {
              const p = projects.find((x) => x.id === id);
              return p ? { id, title: p.title } : null;
            })
            .filter((x): x is { id: string; title: string } => x !== null)}
          activeId={currentProjectId}
          onPick={(id) => openProject(id)}
          onCloseTab={(id) => closeTabById(id)}
          onClose={() => setOverflowMenu(null)}
        />,
        document.body,
      )}
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
          onExport={() => {
            const proj = projects.find((p) => p.id === ctxMenu.projectId);
            if (proj) void exportProjectToFile({ id: proj.id, title: proj.title });
          }}
          onCloseTab={() => closeTabById(ctxMenu.projectId)}
          onClose={() => setCtxMenu(null)}
        />,
        document.body,
      )}
    </div>
  );
}
