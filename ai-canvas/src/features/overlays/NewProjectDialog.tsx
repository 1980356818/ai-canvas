import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Layers, Lock, Play } from "lucide-react";
import { createProject, updateProjectMeta, loadCards } from "@/platform";
import { importProjectFromFile } from "@/lib/projectTransfer";
import { NameProjectDialog } from "@/features/overlays/NameProjectDialog";
import { getDisplayUrl } from "@/lib/media";
import { useProjectStore } from "@/stores/projectStore";
import type { ProjectInfo, WorkflowTemplate } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useChatStore } from "@/stores/chatStore";
import { useTemplateStore } from "@/stores/templateStore";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { scheduleFitCardsToViewport } from "@/lib/viewport";
import { cn } from "@/lib/utils";
import { useEntitlements } from "@/hooks/useEntitlements";
import { canUseTemplate, canSeeTemplate } from "@/lib/entitlements";
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_ORDER } from "@/config/templateCategories";

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
      <img src={images[0]} alt="" className="block w-full" loading="lazy" decoding="async" />
    );
  }

  if (count === 2) {
    return (
      <div className="grid grid-cols-2 gap-px bg-border/40">
        {images.slice(0, 2).map((src, i) => (
          <img key={i} src={src} alt="" className="block w-full object-cover" loading="lazy" decoding="async" />
        ))}
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="grid grid-cols-2 gap-px bg-border/40">
        <img src={images[0]} alt="" className="row-span-2 h-full w-full object-cover" loading="lazy" decoding="async" />
        <div className="grid grid-rows-2 gap-px bg-border/40">
          <img src={images[1]} alt="" className="block w-full object-cover" loading="lazy" decoding="async" />
          <img src={images[2]} alt="" className="block w-full object-cover" loading="lazy" decoding="async" />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-px bg-border/40">
      {images.slice(0, 4).map((src, i) => (
        <img key={i} src={src} alt="" className="block w-full object-cover" loading="lazy" decoding="async" />
      ))}
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
  const openUpgrade = useUIStore((s) => s.openUpgrade);
  const ent = useEntitlements();
  const [loading, setLoading] = useState(false);
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [projectImages, setProjectImages] = useState<Record<string, string[]>>({});
  const imagesCacheRef = useRef<Record<string, string[]>>({});

  useEffect(() => {
    if (open) setLoading(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // 进弹窗也拉一次服务端模板(首页可能还没拉过)
    void useTemplateStore.getState().load();
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

  const templates = useTemplateStore((s) => s.templates);

  // 按分类分组(顺序按 TEMPLATE_CATEGORIES,只留有模板的分类)
  const groups = useMemo(() => {
    const byCat = new Map<string, WorkflowTemplate[]>();
    for (const wf of templates) {
      if (!canSeeTemplate(ent, wf)) continue; // trial 模板只对非正式版展示:正式版有完整模板,藏掉重复的试用副本
      const list = byCat.get(wf.category) ?? [];
      list.push(wf);
      byCat.set(wf.category, list);
    }
    return [...byCat.entries()]
      .map(([key, list]) => ({
        key,
        label: TEMPLATE_CATEGORIES.find((c) => c.key === key)?.label ?? key,
        list,
      }))
      .sort((a, b) => (TEMPLATE_CATEGORY_ORDER[a.key] ?? 99) - (TEMPLATE_CATEGORY_ORDER[b.key] ?? 99));
  }, [templates, ent]);

  const [activeCat, setActiveCat] = useState<string>("");
  const activeKey = groups.some((g) => g.key === activeCat) ? activeCat : (groups[0]?.key ?? "");
  const activeGroup = groups.find((g) => g.key === activeKey);

  const handleCreateFromTemplate = async (templateId: string) => {
    if (loading) return;
    setLoading(true);
    const workflow = templates.find((w) => w.id === templateId);
    const title = workflow?.name ?? "未命名画布";
    try {
      const project = await createProject(title);
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

  const handleImport = useCallback(async () => {
    if (loading) return;
    if (!ent.allowImport) {
      openUpgrade("导入项目为正式版功能，升级会员后解锁");
      return;
    }
    setLoading(true);
    const project = await importProjectFromFile();
    if (!project) {
      setLoading(false); // 用户取消或导入失败(失败已在 helper 内 toast)
      return;
    }
    useProjectStore.getState().openProject(project.id);
    setAppView("canvas");
    onClose();
  }, [loading, setAppView, onClose, ent.allowImport, openUpgrade]);

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

        {/* Quick start — 空白项目 + 模板按分类浏览 */}
        <div className="flex min-h-0 flex-1 flex-col px-5 pt-4 pb-5">
          <h3 className="mb-3 shrink-0 text-sm font-semibold text-foreground">
            快速开始
          </h3>

          {/* 空白项目 */}
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              if (!ent.allowBlank) {
                openUpgrade("空白创作为正式版功能，升级会员后解锁");
                return;
              }
              setShowNameDialog(true);
            }}
            className="group mb-3 flex shrink-0 items-center gap-3 rounded-md border border-dashed border-border/80 bg-card px-3 py-2.5 text-left transition-all hover:border-primary/40 hover:shadow-sm disabled:opacity-50"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted/50">
              <Plus className="h-5 w-5 text-muted-foreground/50 transition-colors group-hover:text-primary/60" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">新建空白项目</p>
              <p className="truncate text-[10px] text-muted-foreground">从空白画布开始创作</p>
            </div>
            {!ent.allowBlank && (
              <span className="ml-auto flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[9px] text-muted-foreground">
                <Lock className="h-2.5 w-2.5" /> 正式版
              </span>
            )}
          </button>

          {/* 分类 Tab */}
          {groups.length > 0 && (
            <div className="mb-3 flex shrink-0 flex-wrap gap-1.5">
              {groups.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setActiveCat(g.key)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    g.key === activeKey
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                >
                  {g.label}
                  <span className="ml-1 opacity-60">{g.list.length}</span>
                </button>
              ))}
            </div>
          )}

          {/* 当前分类网格(可滚动) */}
          <div className="grid grid-cols-5 gap-2 overflow-y-auto">
            {activeGroup?.list.map((wf) => {
              const locked = !canUseTemplate(ent, wf.id);
              const cover = wf.coverImage;
              const isVideo = wf.category === "video";
              return (
                <button
                  key={wf.id}
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    if (locked) {
                      openUpgrade(`「${wf.name}」是正式版模板，升级会员后解锁`);
                      return;
                    }
                    void handleCreateFromTemplate(wf.id);
                  }}
                  className="group flex flex-col overflow-hidden rounded-md border border-border/60 bg-card text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50"
                >
                  <div className="relative w-full overflow-hidden">
                    {cover ? (
                      <img
                        src={cover}
                        alt={wf.name}
                        className={cn("block aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-105", locked && "blur-[1px] grayscale")}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-muted to-muted/60">
                        <span className="px-2 text-center text-[10px] text-muted-foreground/40">{wf.name}</span>
                      </div>
                    )}
                    {isVideo && !locked && (
                      <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/55">
                        <Play className="h-2.5 w-2.5 fill-white text-white" />
                      </div>
                    )}
                    {locked && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                        <div className="flex items-center gap-1 rounded-full bg-black/65 px-2 py-1 text-[9px] font-medium text-white/90">
                          <Lock className="h-2.5 w-2.5" /> 正式版
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-0.5 px-2 py-1.5">
                    <p className="truncate text-[13px] font-semibold text-foreground">
                      {wf.name}
                    </p>
                    <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {wf.description}
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
        onImport={() => {
          setShowNameDialog(false);
          void handleImport();
        }}
      />
    </div>
  );
}
