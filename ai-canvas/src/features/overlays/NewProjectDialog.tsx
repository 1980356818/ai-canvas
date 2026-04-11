import { useEffect, useState } from "react";
import { FileText, ImageIcon, ScanFace, FolderOpen, Layers } from "lucide-react";
import { createProject, updateProjectMeta } from "@/lib/tauri";
import { useProjectStore, type ProjectInfo } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { WORKFLOW_TEMPLATES } from "@/shared/constants";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { autoSave } from "@/lib/autoSave";
import { cn } from "@/lib/utils";

const TEMPLATE_OPTIONS = [
  { id: "blank", name: "空白项目", desc: "从空白画布开始创作", icon: FileText, accent: "text-emerald-500", gradient: "from-emerald-500/10 via-emerald-500/5 to-teal-500/10" },
  { id: "wf-white-bg", name: "一键白底图", desc: "上传商品图，AI 生成白底精修图", icon: ImageIcon, accent: "text-violet-500", gradient: "from-violet-500/10 via-purple-500/5 to-fuchsia-500/10" },
  { id: "wf-face-gen", name: "AI 捏脸", desc: "上传照片，AI 生成多种风格人像", icon: ScanFace, accent: "text-sky-500", gradient: "from-sky-500/10 via-blue-500/5 to-indigo-500/10" },
] as const;

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

  useEffect(() => {
    if (open) setLoading(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleOpenProject = (id: string) => {
    openProject(id);
    setAppView("canvas");
    onClose();
  };

  const handleCreateFromTemplate = async (templateId: string) => {
    if (loading) return;
    setLoading(true);
    const tpl = TEMPLATE_OPTIONS.find((t) => t.id === templateId);
    const title = tpl?.id === "blank" ? "未命名画布" : (tpl?.name ?? "未命名画布");
    try {
      const project = await createProject(title);

      if (templateId !== "blank") {
        const workflow = WORKFLOW_TEMPLATES.find((w) => w.id === templateId);
        if (workflow) {
          useProjectStore.getState().addProject(project);
          useProjectStore.getState().openProject(project.id);
          instantiateWorkflowTemplate(workflow, project.id, 320, 80);
          await autoSave.forceSave();
          const meta = { nodeCount: workflow.cards.length };
          useProjectStore.getState().updateProject(project.id, meta);
          await updateProjectMeta(project.id, meta);
          setAppView("canvas");
          onClose();
          return;
        }
      }

      onCreated(project);
      onClose();
    } catch {
      setLoading(false);
      addToast({ type: "error", title: "创建项目失败", duration: 4000 });
    }
  };

  const recentProjects = projects.slice(0, 5);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-card shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Recent projects */}
        {recentProjects.length > 0 && (
          <div className="border-b border-border/60 px-4 pt-4 pb-3">
            <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Layers className="h-3 w-3" />
              最近项目
            </h3>
            <div className="space-y-px">
              {recentProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleOpenProject(p.id)}
                  className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all hover:bg-accent"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <FolderOpen className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {p.title}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {p.nodeCount} 张卡片 · {formatRelativeTime(p.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Templates */}
        <div className="px-4 pt-4 pb-4">
          <h3 className="mb-3 text-xs font-semibold text-muted-foreground">
            新建项目
          </h3>
          <div className="grid grid-cols-3 gap-2.5">
            {TEMPLATE_OPTIONS.map((tpl) => {
              const Icon = tpl.icon;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  disabled={loading}
                  onClick={() => void handleCreateFromTemplate(tpl.id)}
                  className={cn(
                    "group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50",
                  )}
                >
                  <div className={cn(
                    "flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br",
                    tpl.gradient,
                  )}>
                    <Icon className={cn("h-8 w-8 opacity-60", tpl.accent)} />
                  </div>
                  <div className="px-2.5 py-2">
                    <p className="text-xs font-semibold text-foreground">{tpl.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {tpl.desc}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
