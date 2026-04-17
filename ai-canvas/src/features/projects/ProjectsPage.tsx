import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, FolderOpen, Trash2, Search, Undo2, Trash, ChevronDown, ChevronRight, Pencil, Layers } from "lucide-react";
import { NewProjectDialog } from "@/features/overlays/NewProjectDialog";
import { ConfirmDialog } from "@/features/overlays/ConfirmDialog";
import {
  listProjects,
  deleteProject,
  renameProject,
  listDeletedProjects,
  restoreProject,
  permanentlyDeleteProject,
  loadCards,
} from "@/lib/tauri";
import { getDisplayUrl } from "@/lib/media";
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
  const dayDiff = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
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

function ImageCollage({ images }: { images: string[] }) {
  const count = images.length;

  if (count === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-gradient-to-br from-muted to-muted/60">
        <Layers className="h-7 w-7 text-muted-foreground/25" />
      </div>
    );
  }

  if (count === 1) {
    return (
      <img src={images[0]} alt="" className="h-full w-full object-cover" />
    );
  }

  if (count === 2) {
    return (
      <div className="grid h-full grid-cols-2 gap-px bg-border/40">
        {images.slice(0, 2).map((src, i) => (
          <img key={i} src={src} alt="" className="h-full w-full object-cover" />
        ))}
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="grid h-full grid-cols-2 gap-px bg-border/40">
        <img src={images[0]} alt="" className="row-span-2 h-full w-full object-cover" />
        <div className="grid grid-rows-2 gap-px bg-border/40">
          <img src={images[1]} alt="" className="h-full w-full object-cover" />
          <img src={images[2]} alt="" className="h-full w-full object-cover" />
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-2 grid-rows-2 gap-px bg-border/40">
      {images.slice(0, 4).map((src, i) => (
        <img key={i} src={src} alt="" className="h-full w-full object-cover" />
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  images,
  onRename,
  onRequestDelete,
  onContextMenu,
  externalEditing,
  onEditingDone,
}: {
  project: ProjectInfo;
  images: string[];
  onRename: (id: string, title: string) => void;
  onRequestDelete: (project: ProjectInfo) => void;
  onContextMenu: (e: React.MouseEvent, project: ProjectInfo) => void;
  externalEditing?: boolean;
  onEditingDone?: () => void;
}) {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const openProject = useProjectStore((s) => s.openProject);
  const setAppView = useUIStore((s) => s.setAppView);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const active = currentProjectId === project.id;

  useEffect(() => {
    if (externalEditing && !editing) {
      setEditing(true);
      setDraft(project.title);
    }
  }, [externalEditing, editing, project.title]);

  useEffect(() => {
    if (!editing) return;
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [editing]);

  const handleOpen = () => {
    openProject(project.id);
    setAppView("canvas");
  };

  const commitRename = (value: string) => {
    const trimmed = value.trim();
    setEditing(false);
    onEditingDone?.();
    if (trimmed && trimmed !== project.title) {
      onRename(project.id, trimmed);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleOpen();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, project);
      }}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md",
        active ? "border-primary/50 ring-1 ring-primary/20" : "border-border/60",
      )}
    >
      <div className="aspect-[3/2] w-full overflow-hidden">
        <ImageCollage images={images} />
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename(draft);
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              onBlur={() => commitRename(draft)}
              className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-xs font-semibold text-foreground outline-none ring-ring focus-visible:ring-2"
            />
          ) : (
            <p
              className="truncate text-xs font-semibold text-foreground"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(true);
                setDraft(project.title);
              }}
            >
              {project.title}
            </p>
          )}
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {project.nodeCount} 张卡片 · {formatRelativeTime(project.updatedAt)}
          </p>
        </div>

        {!editing && (
          <button
            type="button"
            aria-label="删除项目"
            onClick={(e) => {
              e.stopPropagation();
              onRequestDelete(project);
            }}
            className="shrink-0 rounded-md p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function DeletedProjectCard({
  project,
  onRestore,
  onPermanentDelete,
}: {
  project: ProjectInfo;
  onRestore: (project: ProjectInfo) => void;
  onPermanentDelete: (project: ProjectInfo) => void;
}) {
  return (
    <div className="group flex items-start gap-4 rounded-xl border border-border/60 bg-card/60 p-4 text-left shadow-sm opacity-70">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Trash className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">
          {project.title}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {project.nodeCount} 张卡片
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          aria-label="恢复项目"
          title="恢复"
          onClick={() => onRestore(project)}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="彻底删除"
          title="彻底删除"
          onClick={() => onPermanentDelete(project)}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const projects = useProjectStore((s) => s.projects);
  const deletedProjects = useProjectStore((s) => s.deletedProjects);
  const setProjects = useProjectStore((s) => s.setProjects);
  const setDeletedProjects = useProjectStore((s) => s.setDeletedProjects);
  const removeProject = useProjectStore((s) => s.removeProject);
  const updateProject = useProjectStore((s) => s.updateProject);
  const storeRestoreProject = useProjectStore((s) => s.restoreProject);
  const storePermanentlyRemove = useProjectStore((s) => s.permanentlyRemoveProject);
  const addToast = useUIStore((s) => s.addToast);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);
  const [pendingPermanentDelete, setPendingPermanentDelete] = useState<ProjectInfo | null>(null);
  const [trashExpanded, setTrashExpanded] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; project: ProjectInfo } | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [projectImages, setProjectImages] = useState<Record<string, string[]>>({});
  const imagesCacheRef = useRef<Record<string, string[]>>({});

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch(() =>
        addToast({ type: "error", title: "加载项目失败", duration: 4000 }),
      );
    listDeletedProjects()
      .then(setDeletedProjects)
      .catch(console.error);
  }, [addToast, setProjects, setDeletedProjects]);

  useEffect(() => {
    if (projects.length === 0) return;
    const toLoad = projects.filter((p) => !(p.id in imagesCacheRef.current));
    if (toLoad.length === 0) {
      const map: Record<string, string[]> = {};
      for (const p of projects) map[p.id] = imagesCacheRef.current[p.id] ?? [];
      setProjectImages(map);
      return;
    }
    let cancelled = false;
    Promise.all(
      toLoad.map(async (p) => {
        try {
          const cards = await loadCards(p.id);
          const urls: string[] = [];
          for (const c of cards) {
            if (c.type !== "ai_image") continue;
            try {
              const d = JSON.parse(c.data);
              if (d.imageUrl) urls.push(getDisplayUrl(d.imageUrl));
            } catch { /* skip */ }
          }
          return { id: p.id, urls };
        } catch {
          return { id: p.id, urls: [] as string[] };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      for (const r of results) imagesCacheRef.current[r.id] = r.urls;
      const map: Record<string, string[]> = {};
      for (const p of projects) map[p.id] = imagesCacheRef.current[p.id] ?? [];
      setProjectImages(map);
    });
    return () => { cancelled = true; };
  }, [projects]);

  const onCreated = useCallback(
    (project: ProjectInfo) => {
      useProjectStore.getState().addProject(project);
      useProjectStore.getState().openProject(project.id);
      useUIStore.getState().setAppView("canvas");
      addToast({ type: "success", title: "项目创建成功", duration: 3000 });
    },
    [addToast],
  );

  const handleRename = useCallback(
    async (id: string, title: string) => {
      try {
        await renameProject(id, title);
        updateProject(id, { title });
      } catch {
        addToast({ type: "error", title: "重命名失败", duration: 4000 });
      }
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

  const handleRestore = useCallback(
    (project: ProjectInfo) => {
      storeRestoreProject(project.id);
      restoreProject(project.id).catch(() =>
        addToast({ type: "error", title: "恢复失败，请重试", duration: 4000 }),
      );
      addToast({ type: "success", title: "项目已恢复", duration: 3000 });
    },
    [storeRestoreProject, addToast],
  );

  const handleConfirmPermanentDelete = useCallback(() => {
    if (!pendingPermanentDelete) return;
    const id = pendingPermanentDelete.id;
    setPendingPermanentDelete(null);
    storePermanentlyRemove(id);
    permanentlyDeleteProject(id).catch(() =>
      addToast({ type: "error", title: "删除失败，请重试", duration: 4000 }),
    );
  }, [pendingPermanentDelete, storePermanentlyRemove, addToast]);

  const filtered = search.trim()
    ? projects.filter((p) =>
        p.title.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : projects;

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b border-border px-8 py-6">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-foreground">我的项目</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                共 {projects.length} 个项目
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              新建项目
            </button>
          </div>

          {projects.length > 3 && (
            <div className="relative mt-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索项目…"
                className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus-visible:ring-2"
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-5xl space-y-8">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <FolderOpen className="mb-4 h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm font-medium text-muted-foreground">
                {search.trim() ? "没有匹配的项目" : "还没有项目"}
              </p>
              {!search.trim() && (
                <button
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  className="mt-4 text-sm font-medium text-primary hover:underline"
                >
                  创建第一个项目
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {filtered.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  images={projectImages[p.id] ?? []}
                  onRename={(id, title) => void handleRename(id, title)}
                  onRequestDelete={setPendingDelete}
                  onContextMenu={(e, proj) => setCtxMenu({ x: e.clientX, y: e.clientY, project: proj })}
                  externalEditing={editingCardId === p.id}
                  onEditingDone={() => setEditingCardId(null)}
                />
              ))}
            </div>
          )}

          {deletedProjects.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setTrashExpanded((v) => !v)}
                className="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {trashExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                <Trash className="h-4 w-4" />
                回收站（{deletedProjects.length}）
              </button>
              {trashExpanded && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {deletedProjects.map((p) => (
                    <DeletedProjectCard
                      key={p.id}
                      project={p}
                      onRestore={handleRestore}
                      onPermanentDelete={setPendingPermanentDelete}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={onCreated}
      />
      <ConfirmDialog
        open={!!pendingDelete}
        title={`确定删除「${pendingDelete?.title ?? ""}」？`}
        description="项目将移入回收站，你可以随时找回。"
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={!!pendingPermanentDelete}
        title={`彻底删除「${pendingPermanentDelete?.title ?? ""}」？`}
        description="此操作不可撤销，项目内的所有卡片将一并删除。"
        confirmLabel="彻底删除"
        variant="danger"
        onConfirm={handleConfirmPermanentDelete}
        onCancel={() => setPendingPermanentDelete(null)}
      />
      {ctxMenu && createPortal(
        <ProjectContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onRename={() => setEditingCardId(ctxMenu.project.id)}
          onDelete={() => setPendingDelete(ctxMenu.project)}
          onClose={() => setCtxMenu(null)}
        />,
        document.body,
      )}
    </div>
  );
}
