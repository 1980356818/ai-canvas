import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, Pencil } from "lucide-react";
import { NewProjectDialog } from "@/features/overlays/NewProjectDialog";
import { ConfirmDialog } from "@/features/overlays/ConfirmDialog";
import {
  deleteProject,
  listProjects,
  renameProject,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useProjectStore, type ProjectInfo } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 0) return "刚刚";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;

  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round(
    (todayStart.getTime() - dStart.getTime()) / 86_400_000,
  );
  if (dayDiff === 1) return "昨天";
  return `${dayDiff}天前`;
}

interface ProjectContextMenuProps {
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function ProjectContextMenu({ x, y, onRename, onDelete, onClose }: ProjectContextMenuProps) {
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
        onClick={() => { onDelete(); onClose(); }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
        删除
      </button>
    </div>
  );
}

export function ProjectPanel() {
  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const openProject = useProjectStore((s) => s.openProject);
  const setProjects = useProjectStore((s) => s.setProjects);
  const addProject = useProjectStore((s) => s.addProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const updateProject = useProjectStore((s) => s.updateProject);

  const addToast = useUIStore((s) => s.addToast);
  const setAppView = useUIStore((s) => s.setAppView);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; project: ProjectInfo } | null>(null);

  useEffect(() => {
    void listProjects()
      .then((list) => setProjects(list))
      .catch(() => {
        addToast({
          type: "error",
          title: "加载项目失败",
          duration: 4000,
        });
      });
  }, [addToast, setProjects]);

  useEffect(() => {
    if (!editingId) return;
    const t = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [editingId]);

  const commitRename = useCallback(
    async (id: string, nextTitle: string) => {
      const trimmed = nextTitle.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      try {
        await renameProject(id, trimmed);
        updateProject(id, { title: trimmed });
      } catch {
        addToast({
          type: "error",
          title: "重命名失败",
          duration: 4000,
        });
      }
      setEditingId(null);
    },
    [addToast, updateProject],
  );

  const handleConfirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    removeProject(id);
    deleteProject(id).catch(() =>
      addToast({ type: "error", title: "删除失败，请重试", duration: 4000 }),
    );
    addToast({ type: "success", title: "已移入回收站", duration: 3000 });
  }, [pendingDelete, removeProject, addToast]);

  const onCreated = useCallback(
    (project: ProjectInfo) => {
      addProject(project);
      openProject(project.id);
      setAppView("canvas");
      addToast({
        type: "success",
        title: "项目创建成功",
        duration: 3000,
      });
    },
    [addProject, addToast, openProject, setAppView],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-foreground">我的项目</h2>
        <button
          type="button"
          aria-label="新建项目"
          onClick={() => setDialogOpen(true)}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto p-1">
        {projects.map((p) => {
          const active = currentProjectId === p.id;
          const editing = editingId === p.id;
          return (
            <li key={p.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  openProject(p.id);
                  setAppView("canvas");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openProject(p.id);
                    setAppView("canvas");
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxMenu({ x: e.clientX, y: e.clientY, project: p });
                }}
                className={cn(
                  "group relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent",
                  active && "bg-accent",
                )}
              >
                <div className="min-w-0 flex-1">
                  {editing ? (
                    <input
                      ref={renameInputRef}
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitRename(p.id, renameDraft);
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => void commitRename(p.id, renameDraft)}
                      className="w-full rounded border border-border bg-background px-1 py-0.5 text-sm text-foreground outline-none ring-ring focus-visible:ring-2"
                    />
                  ) : (
                    <div
                      className="truncate text-sm font-medium text-foreground"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(p.id);
                        setRenameDraft(p.title);
                      }}
                    >
                      {p.title}
                    </div>
                  )}
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {p.nodeCount}张卡片 · {formatRelativeTime(p.updatedAt)}
                  </div>
                </div>
                {!editing && (
                  <button
                    type="button"
                    aria-label="删除项目"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDelete(p);
                    }}
                    className={cn(
                      "shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100",
                    )}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <NewProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={onCreated}
      />
      <ConfirmDialog
        open={!!pendingDelete}
        title={`确定删除「${pendingDelete?.title ?? ""}」？`}
        description="项目将移入回收站，你可以在「我的项目」中找回。"
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      {ctxMenu && createPortal(
        <ProjectContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onRename={() => {
            setEditingId(ctxMenu.project.id);
            setRenameDraft(ctxMenu.project.title);
          }}
          onDelete={() => setPendingDelete(ctxMenu.project)}
          onClose={() => setCtxMenu(null)}
        />,
        document.body,
      )}
    </div>
  );
}
