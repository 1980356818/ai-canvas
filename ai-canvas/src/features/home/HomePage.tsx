import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Layers, ChevronRight, Plus } from "lucide-react";
import AIPromptInput from "@/features/home/AIPromptInput";
import WorkflowGrid from "@/features/home/WorkflowGrid";
import { ConfirmDialog } from "@/features/overlays/ConfirmDialog";
import { NameProjectDialog } from "@/features/overlays/NameProjectDialog";
import { useProjectStore } from "@/stores/projectStore";
import type { ProjectInfo } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useChatStore } from "@/stores/chatStore";
import { listProjects, deleteProject, loadCards, createProject } from "@/platform";
import { getDisplayUrl } from "@/lib/media";
import { importProjectFromFile } from "@/lib/projectTransfer";
import catPawImg from "@/assets/cat-paw.jpg";


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
      <img src={images[0]} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
    );
  }

  if (count === 2) {
    return (
      <div className="grid h-full grid-cols-2 gap-px bg-border/40">
        {images.slice(0, 2).map((src, i) => (
          <img key={i} src={src} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
        ))}
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="grid h-full grid-cols-2 gap-px bg-border/40">
        <img src={images[0]} alt="" className="row-span-2 h-full w-full object-cover" loading="lazy" decoding="async" />
        <div className="grid grid-rows-2 gap-px bg-border/40">
          <img src={images[1]} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
          <img src={images[2]} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-2 grid-rows-2 gap-px bg-border/40">
      {images.slice(0, 4).map((src, i) => (
        <img key={i} src={src} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
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
      className="animate-fade-in-up group relative flex flex-col overflow-hidden rounded-md border border-border/60 bg-card text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="image-collage aspect-[3/2] w-full">
        <ImageCollage images={images} />
      </div>

      <div className="flex items-start gap-1 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-semibold text-foreground">
            {project.title}
          </p>
          <p className="mt-0.5 truncate text-[9px] text-muted-foreground">
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
          <Trash2 className="h-2.5 w-2.5" />
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
  const [showNameDialog, setShowNameDialog] = useState(false);
  const imagesCacheRef = useRef<Record<string, string[]>>({});

  useEffect(() => {
    listProjects().then(setProjects).catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const topN = projects.slice(0, 5);
    if (topN.length === 0) return;

    const toLoad = topN.filter((p) => !(p.id in imagesCacheRef.current));
    if (toLoad.length === 0) {
      const map: Record<string, string[]> = {};
      for (const p of topN) map[p.id] = imagesCacheRef.current[p.id] ?? [];
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
      for (const p of topN) map[p.id] = imagesCacheRef.current[p.id] ?? [];
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

  const handleCreateBlank = useCallback(
    async (name: string) => {
      setShowNameDialog(false);
      try {
        const project = await createProject(name);
        useProjectStore.getState().addProject(project);
        useProjectStore.getState().openProject(project.id);
        setAppView("canvas");
        const ui = useUIStore.getState();
        if (!ui.chatPanelVisible) ui.toggleChatPanel();
        await useChatStore.getState().openProjectChat(project.id);
        void useChatStore.getState().createSession();
      } catch (err) {
        addToast({
          type: "error",
          title: "创建项目失败",
          description: String(err),
          duration: 4000,
        });
      }
    },
    [setAppView, addToast],
  );

  const handleImport = useCallback(async () => {
    const project = await importProjectFromFile();
    if (!project) return; // 用户取消或导入失败(失败已在 helper 内 toast)
    useProjectStore.getState().openProject(project.id);
    setAppView("canvas");
  }, [setAppView]);

  const top5 = projects.slice(0, 5);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">最近项目</h2>
        {projects.length > 5 && (
          <button
            onClick={() => setAppView("projects")}
            className="flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            查看全部
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-6 gap-2">
        {/* 空白项目入口 */}
        <button
          onClick={() => setShowNameDialog(true)}
          className="animate-fade-in-up group relative flex flex-col overflow-hidden rounded-md border border-dashed border-border/80 bg-card text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
        >
          <div className="image-collage flex aspect-[3/2] w-full items-center justify-center bg-gradient-to-br from-muted/60 to-muted/30">
            <Plus className="h-6 w-6 text-muted-foreground/30 transition-colors group-hover:text-primary/50" />
          </div>
          <div className="flex items-start gap-1 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[10px] font-semibold text-foreground">
                新建空白项目
              </p>
              <p className="mt-0.5 truncate text-[9px] text-muted-foreground">
                从空白画布开始创作
              </p>
            </div>
          </div>
        </button>

        {top5.map((p, i) => (
          <ProjectCard
            key={p.id}
            project={p}
            images={projectImages[p.id] ?? []}
            index={i + 1}
            onRequestDelete={setPendingDelete}
          />
        ))}
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
      <NameProjectDialog
        open={showNameDialog}
        onConfirm={handleCreateBlank}
        onCancel={() => setShowNameDialog(false)}
        onImport={() => {
          setShowNameDialog(false);
          void handleImport();
        }}
      />
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-background">
      {/* Hero */}
      <div className="hero-glow flex flex-[8] flex-col items-center justify-center px-6 pt-20 pb-4">
        <h1 className="-mt-20 mb-4 flex items-end gap-3 text-5xl font-bold tracking-tight">
          <img src={catPawImg} alt="" className="h-16 w-16 object-contain dark:invert" decoding="async" />
          <span className="text-shimmer tracking-[0.15em]">致力于解决电商行业的所有需求</span>
        </h1>
        <p className="mt-4 mb-12 max-w-md text-center text-base tracking-wide text-muted-foreground/80">
          效率，从这里起飞
        </p>

        <div className="w-full max-w-4xl">
          <AIPromptInput />
        </div>
      </div>

      {/* Recent Projects + Quick Start */}
      <div className="shrink-0 space-y-6 px-8 pt-0 pb-6">
        <RecentProjects />
        <WorkflowGrid />
      </div>

      <div className="flex-1" />
    </div>
  );
}
