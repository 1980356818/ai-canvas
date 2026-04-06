import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, FolderOpen, Trash2, Search } from "lucide-react";
import { NewProjectDialog } from "@/features/overlays/NewProjectDialog";
import { listProjects, deleteProject, renameProject } from "@/lib/tauri";
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

function ProjectCard({
  project,
  onRename,
}: {
  project: ProjectInfo;
  onRename: (id: string, title: string) => void;
}) {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const setCurrentProjectId = useProjectStore((s) => s.setCurrentProjectId);
  const removeProject = useProjectStore((s) => s.removeProject);
  const setAppView = useUIStore((s) => s.setAppView);
  const addToast = useUIStore((s) => s.addToast);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const active = currentProjectId === project.id;

  useEffect(() => {
    if (!editing) return;
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [editing]);

  const handleOpen = () => {
    setCurrentProjectId(project.id);
    setAppView("canvas");
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`确定删除「${project.title}」？此操作不可撤销。`)) return;
    deleteProject(project.id)
      .then(() => removeProject(project.id))
      .catch(() =>
        addToast({ type: "error", title: "删除失败", duration: 4000 }),
      );
  };

  const commitRename = (value: string) => {
    const trimmed = value.trim();
    setEditing(false);
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
      className={cn(
        "group relative flex items-start gap-4 rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md",
        active ? "border-primary/50 ring-1 ring-primary/20" : "border-border",
      )}
    >
      <div
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg",
          active
            ? "bg-primary text-primary-foreground"
            : "bg-primary/10 text-primary",
        )}
      >
        <FolderOpen className="h-5 w-5" />
      </div>

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
            className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-sm font-semibold text-foreground outline-none ring-ring focus-visible:ring-2"
          />
        ) : (
          <p
            className="truncate text-sm font-semibold text-foreground"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
              setDraft(project.title);
            }}
          >
            {project.title}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {project.nodeCount} 张卡片 · 更新于{" "}
          {formatRelativeTime(project.updatedAt)}
        </p>
      </div>

      {!editing && (
        <button
          type="button"
          aria-label="删除项目"
          onClick={handleDelete}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  const projects = useProjectStore((s) => s.projects);
  const setProjects = useProjectStore((s) => s.setProjects);
  const updateProject = useProjectStore((s) => s.updateProject);
  const addToast = useUIStore((s) => s.addToast);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch(() =>
        addToast({ type: "error", title: "加载项目失败", duration: 4000 }),
      );
  }, [addToast, setProjects]);

  const onCreated = useCallback(
    (project: ProjectInfo) => {
      useProjectStore.getState().addProject(project);
      useProjectStore.getState().setCurrentProjectId(project.id);
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
        <div className="mx-auto max-w-5xl">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onRename={(id, title) => void handleRename(id, title)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={onCreated}
      />
    </div>
  );
}
