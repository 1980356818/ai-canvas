import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, FolderOpen, Layers, ChevronRight, Plus } from "lucide-react";
import AIPromptInput from "@/features/home/AIPromptInput";
import WorkflowGrid from "@/features/home/WorkflowGrid";
import { ConfirmDialog } from "@/features/overlays/ConfirmDialog";
import { useProjectStore, type ProjectInfo } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { listProjects, deleteProject, loadCards, createProject } from "@/lib/tauri";
import { getDisplayUrl } from "@/lib/media";
import { cn } from "@/lib/utils";

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
  index,
  onRequestDelete,
}: {
  project: ProjectInfo;
  images: string[];
  index: number;
  onRequestDelete: (project: ProjectInfo) => void;
}) {
  const openProject = useProjectStore((s) => s.openProject);
  const setAppView = useUIStore((s) => s.setAppView);

  const handleOpen = () => {
    openProject(project.id);
    setAppView("canvas");
  };

  return (
    <button
      onClick={handleOpen}
      className="animate-fade-in-up group relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="image-collage aspect-[3/2] w-full">
        <ImageCollage images={images} />
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-foreground">
            {project.title}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {project.nodeCount} 张卡片 · {formatRelativeTime(project.updatedAt)}
          </p>
        </div>
        <div
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete(project);
          }}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </div>
      </div>
    </button>
  );
}

function RecentProjects() {
  const projects = useProjectStore((s) => s.projects);
  const removeProject = useProjectStore((s) => s.removeProject);
  const setProjects = useProjectStore((s) => s.setProjects);
  const setAppView = useUIStore((s) => s.setAppView);
  const addToast = useUIStore((s) => s.addToast);
  const [projectImages, setProjectImages] = useState<Record<string, string[]>>(
    {},
  );
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);
  const imagesCacheRef = useRef<Record<string, string[]>>({});

  useEffect(() => {
    listProjects().then(setProjects).catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const top4 = projects.slice(0, 4);
    if (top4.length === 0) return;

    const toLoad = top4.filter((p) => !(p.id in imagesCacheRef.current));
    if (toLoad.length === 0) {
      const map: Record<string, string[]> = {};
      for (const p of top4) map[p.id] = imagesCacheRef.current[p.id] ?? [];
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
      for (const p of top4) map[p.id] = imagesCacheRef.current[p.id] ?? [];
      setProjectImages(map);
    });

    return () => {
      cancelled = true;
    };
  }, [projects]);

  const handleConfirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    delete imagesCacheRef.current[id];
    removeProject(id);
    deleteProject(id).catch(() =>
      addToast({ type: "error", title: "删除失败，请重试", duration: 4000 }),
    );
    addToast({ type: "success", title: "已移入回收站", duration: 3000 });
  }, [pendingDelete, removeProject, addToast]);

  const openProject = useProjectStore((s) => s.openProject);
  const addProject = useProjectStore((s) => s.addProject);

  const handleCreateBlank = async () => {
    try {
      const project = await createProject("未命名项目");
      addProject(project);
      openProject(project.id);
      setAppView("canvas");
    } catch (err) {
      addToast({
        type: "error",
        title: "创建项目失败",
        description: String(err),
        duration: 4000,
      });
    }
  };

  const top4 = projects.slice(0, 4);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-foreground">最近项目</h2>
        {projects.length > 4 && (
          <button
            onClick={() => setAppView("projects")}
            className="flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            查看全部
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-4 gap-3">
        {projects.length === 0 ? (
          <button
            onClick={handleCreateBlank}
            className="animate-fade-in-up group relative flex flex-col overflow-hidden rounded-xl border border-dashed border-border/80 bg-card text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
          >
            <div className="flex aspect-[3/2] w-full items-center justify-center bg-gradient-to-br from-muted/60 to-muted/30">
              <Plus className="h-8 w-8 text-muted-foreground/30 transition-colors group-hover:text-primary/50" />
            </div>
            <div className="flex items-start gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-muted-foreground">
                  空白项目
                </p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground/60">
                  从空白画布开始创作
                </p>
              </div>
            </div>
          </button>
        ) : (
          top4.map((p, i) => (
            <ProjectCard
              key={p.id}
              project={p}
              images={projectImages[p.id] ?? []}
              index={i}
              onRequestDelete={setPendingDelete}
            />
          ))
        )}
      </div>
      <ConfirmDialog
        open={!!pendingDelete}
        title={`确定删除「${pendingDelete?.title ?? ""}」？`}
        description="项目将移入回收站，你可以在「我的项目」中找回。"
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-background">
      {/* Hero */}
      <div className="hero-glow flex flex-col items-center justify-center px-6 pt-16 pb-12">
        <h1 className="text-gradient mb-3 text-5xl font-bold tracking-tight">
          AI 无限画布
        </h1>
        <p className="mb-10 max-w-md text-center text-base tracking-wide text-muted-foreground/80">
          创意，从这里开始
        </p>

        <AIPromptInput />
      </div>

      {/* Recent Projects + Quick Start */}
      <div className="space-y-10 px-8 pt-4 pb-10">
        <RecentProjects />
        <WorkflowGrid />
      </div>
    </div>
  );
}
