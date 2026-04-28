import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText,
  ImageIcon,
  ScanFace,
  Plus,
  Layers,
  User,
  PersonStanding,
  Mountain,
  Combine,
  Camera,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import { createProject, updateProjectMeta, loadCards } from "@/platform";
import { getDisplayUrl } from "@/lib/media";
import { useProjectStore } from "@/stores/projectStore";
import type { ProjectInfo } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useChatStore } from "@/stores/chatStore";
import { WORKFLOW_TEMPLATES } from "@/config/workflows";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { scheduleFitCardsToViewport } from "@/lib/viewport";
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
      <div className="flex aspect-[3/2] items-center justify-center bg-gradient-to-br from-muted to-muted/60">
        <Layers className="h-7 w-7 text-muted-foreground/25" />
      </div>
    );
  }

  if (count === 1) {
    return (
      <img src={images[0]} alt="" className="block w-full" />
    );
  }

  if (count === 2) {
    return (
      <div className="grid grid-cols-2 gap-px bg-border/40">
        {images.slice(0, 2).map((src, i) => (
          <img key={i} src={src} alt="" className="block w-full object-cover" />
        ))}
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="grid grid-cols-2 gap-px bg-border/40">
        <img src={images[0]} alt="" className="row-span-2 h-full w-full object-cover" />
        <div className="grid grid-rows-2 gap-px bg-border/40">
          <img src={images[1]} alt="" className="block w-full object-cover" />
          <img src={images[2]} alt="" className="block w-full object-cover" />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-px bg-border/40">
      {images.slice(0, 4).map((src, i) => (
        <img key={i} src={src} alt="" className="block w-full object-cover" />
      ))}
    </div>
  );
}

const TEMPLATE_OPTIONS: {
  id: string;
  name: string;
  desc: string;
  icon: LucideIcon;
  accent: string;
  gradient: string;
}[] = [
  {
    id: "blank",
    name: "空白项目",
    desc: "从空白画布开始创作",
    icon: FileText,
    accent: "text-emerald-500",
    gradient: "from-emerald-500/10 via-emerald-500/5 to-teal-500/10",
  },
  {
    id: "wf-white-bg",
    name: "一键白底图",
    desc: "上传商品图，AI 生成白底精修图",
    icon: ImageIcon,
    accent: "text-violet-500",
    gradient: "from-violet-500/10 via-purple-500/5 to-fuchsia-500/10",
  },
  {
    id: "wf-tryon",
    name: "模特换装",
    desc: "上传模特图与服装图，一键换装",
    icon: User,
    accent: "text-pink-500",
    gradient: "from-pink-500/10 via-rose-500/5 to-fuchsia-500/10",
  },
  {
    id: "wf-pose-fission",
    name: "姿态裂变",
    desc: "上传人物图，AI 裂变生成多种姿态",
    icon: PersonStanding,
    accent: "text-amber-500",
    gradient: "from-amber-500/10 via-orange-500/5 to-yellow-500/10",
  },
  {
    id: "wf-scene-replace",
    name: "场景替换",
    desc: "上传人物图与场景图，AI 融合替换场景",
    icon: Mountain,
    accent: "text-teal-500",
    gradient: "from-teal-500/10 via-cyan-500/5 to-emerald-500/10",
  },
  {
    id: "wf-face-merge",
    name: "人脸合成",
    desc: "上传两张人物照片，AI 融合生成新人像",
    icon: ScanFace,
    accent: "text-indigo-500",
    gradient: "from-indigo-500/10 via-violet-500/5 to-purple-500/10",
  },
  {
    id: "wf-look-fission",
    name: "Look全身裂变",
    desc: "锁定机位构图，仅变姿势生成变体",
    icon: PersonStanding,
    accent: "text-rose-500",
    gradient: "from-rose-500/10 via-pink-500/5 to-red-500/10",
  },
  {
    id: "wf-multimodal-fusion",
    name: "多模态融合1",
    desc: "模特+服装+场景+角度，AI 综合融合生成",
    icon: Combine,
    accent: "text-sky-500",
    gradient: "from-sky-500/10 via-blue-500/5 to-cyan-500/10",
  },
  {
    id: "wf-multimodal-fusion-6",
    name: "服装多模态融合6",
    desc: "模特+服装+影调+环境，AI 解构生成多组商业写真",
    icon: Combine,
    accent: "text-emerald-500",
    gradient: "from-emerald-500/10 via-green-500/5 to-teal-500/10",
  },
  {
    id: "wf-studio-look",
    name: "一键棚拍Look图",
    desc: "模特+服装+场景，AI 生成专业棚拍 Lookbook",
    icon: Camera,
    accent: "text-fuchsia-500",
    gradient: "from-fuchsia-500/10 via-purple-500/5 to-pink-500/10",
  },
  {
    id: "wf-mirror-selfie",
    name: "对镜自拍",
    desc: "模特+服装+场景，AI 生成电商对镜自拍图",
    icon: Smartphone,
    accent: "text-orange-500",
    gradient: "from-orange-500/10 via-red-500/5 to-amber-500/10",
  },
];


function NameProjectDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-background p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold">新建项目</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(name.trim() || "未命名项目");
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="输入项目名称..."
            className="mb-4 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-accent"
            >
              取消
            </button>
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              创建
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
}

export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: NewProjectDialogProps) {
  const projects = useProjectStore((s) => s.projects);
  const openProject = useProjectStore((s) => s.openProject);
  const setAppView = useUIStore((s) => s.setAppView);
  const addToast = useUIStore((s) => s.addToast);
  const [loading, setLoading] = useState(false);
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [projectImages, setProjectImages] = useState<Record<string, string[]>>({});
  const imagesCacheRef = useRef<Record<string, string[]>>({});

  useEffect(() => {
    if (open) setLoading(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;

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

    return () => { cancelled = true; };
  }, [open, projects]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (showNameDialog) setShowNameDialog(false);
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, showNameDialog]);

  const handleOpenProject = (id: string) => {
    openProject(id);
    setAppView("canvas");
    onClose();
  };

  const handleCreateBlank = useCallback(
    async (name: string) => {
      setShowNameDialog(false);
      if (loading) return;
      setLoading(true);
      try {
        const project = await createProject(name);
        useProjectStore.getState().addProject(project);
        useProjectStore.getState().openProject(project.id);
        setAppView("canvas");
        const ui = useUIStore.getState();
        if (!ui.chatPanelVisible) ui.toggleChatPanel();
        void useChatStore.getState().createSession();
        onCreated(project);
        onClose();
      } catch {
        setLoading(false);
        addToast({ type: "error", title: "创建项目失败", duration: 4000 });
      }
    },
    [loading, setAppView, addToast, onCreated, onClose],
  );

  const handleCreateFromTemplate = async (templateId: string) => {
    if (loading) return;
    setLoading(true);
    const tpl = TEMPLATE_OPTIONS.find((t) => t.id === templateId);
    const title = tpl?.name ?? "未命名画布";
    try {
      const project = await createProject(title);
      const workflow = WORKFLOW_TEMPLATES.find((w) => w.id === templateId);
      if (workflow) {
        useProjectStore.getState().addProject(project);
        await instantiateWorkflowTemplate(workflow, project.id, 320, 80);
        const meta = { nodeCount: workflow.cards.length };
        useProjectStore.getState().updateProject(project.id, meta);
        await updateProjectMeta(project.id, meta);
        useProjectStore.getState().openProject(project.id);
        setAppView("canvas");
        scheduleFitCardsToViewport(project.id);
        onClose();
        return;
      }

      onCreated(project);
      onClose();
    } catch {
      setLoading(false);
      addToast({ type: "error", title: "创建项目失败", duration: 4000 });
    }
  };

  if (!open) return null;

  const recentProjects = projects.slice(0, 5);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !showNameDialog) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-border/60 bg-card shadow-lg"
        style={{ maxHeight: "min(85vh, 640px)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Recent projects — card grid matching homepage style */}
        {recentProjects.length > 0 && (
          <div className="shrink-0 border-b border-border/60 px-5 pt-5 pb-4">
            <h3 className="mb-3 text-sm font-semibold text-foreground">
              最近项目
            </h3>
            <div className="grid grid-cols-5 gap-2">
              {recentProjects.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleOpenProject(p.id)}
                  className="animate-fade-in-up group relative flex flex-col overflow-hidden rounded-md border border-border/60 bg-card text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <div className="image-collage w-full">
                    <ImageCollage images={projectImages[p.id] ?? []} />
                  </div>
                  <div className="flex items-start gap-1 px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[10px] font-semibold text-foreground">
                        {p.title}
                      </p>
                      <p className="mt-0.5 truncate text-[9px] text-muted-foreground">
                        {p.nodeCount} 张卡片 · {formatRelativeTime(p.updatedAt)}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Quick start — matching homepage WorkflowGrid style */}
        <div className="shrink-0 px-5 pt-4 pb-5">
          <h3 className="mb-3 text-sm font-semibold text-foreground">
            快速开始
          </h3>
          <div className="grid grid-cols-5 gap-2">
            {TEMPLATE_OPTIONS.map((tpl) => {
              const isBlank = tpl.id === "blank";
              const workflow = WORKFLOW_TEMPLATES.find((w) => w.id === tpl.id);
              const cover = workflow?.coverImage;

              return (
                <button
                  key={tpl.id}
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    if (isBlank) {
                      setShowNameDialog(true);
                    } else {
                      void handleCreateFromTemplate(tpl.id);
                    }
                  }}
                  className={cn(
                    "group flex flex-col overflow-hidden rounded-md text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50",
                    isBlank
                      ? "border border-dashed border-border/80 bg-card hover:border-primary/40"
                      : "border border-border/60 bg-card",
                  )}
                >
                  <div className="w-full overflow-hidden">
                    {isBlank ? (
                      <div className="flex aspect-[3/2] items-center justify-center bg-gradient-to-br from-muted/60 to-muted/30">
                        <Plus className="h-6 w-6 text-muted-foreground/30 transition-colors group-hover:text-primary/50" />
                      </div>
                    ) : cover ? (
                      <img
                        src={cover}
                        alt={tpl.name}
                        className="block w-full transition-transform duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className={cn("flex aspect-[3/2] items-center justify-center bg-gradient-to-br", tpl.gradient)}>
                        <span className="text-xs text-muted-foreground/40">{tpl.name}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-0.5 px-2 py-1.5">
                    <p className="text-[10px] font-semibold text-foreground">
                      {isBlank ? "新建空白项目" : tpl.name}
                    </p>
                    <p className="line-clamp-2 text-[9px] leading-relaxed text-muted-foreground">
                      {tpl.desc}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <NameProjectDialog
        open={showNameDialog}
        onConfirm={handleCreateBlank}
        onCancel={() => setShowNameDialog(false)}
      />
    </div>
  );
}
