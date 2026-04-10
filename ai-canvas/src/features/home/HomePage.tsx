import { useEffect } from "react";
import { Trash2, FolderOpen } from "lucide-react";
import AIPromptInput from "@/features/home/AIPromptInput";
import WorkflowGrid from "@/features/home/WorkflowGrid";
import { useProjectStore, type ProjectInfo } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { listProjects, deleteProject } from "@/lib/tauri";
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

function ProjectCard({ project }: { project: ProjectInfo }) {
  const openProject = useProjectStore((s) => s.openProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const setAppView = useUIStore((s) => s.setAppView);
  const addToast = useUIStore((s) => s.addToast);

  const handleOpen = () => {
    openProject(project.id);
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

  return (
    <button
      onClick={handleOpen}
      className="group relative flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <FolderOpen className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">
          {project.title}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {project.nodeCount}张卡片 · {formatRelativeTime(project.updatedAt)}
        </p>
      </div>
      <div
        role="button"
        tabIndex={-1}
        onClick={handleDelete}
        className={cn(
          "shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100",
        )}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </div>
    </button>
  );
}

function RecentProjects() {
  const projects = useProjectStore((s) => s.projects);
  const setProjects = useProjectStore((s) => s.setProjects);

  useEffect(() => {
    if (projects.length === 0) {
      listProjects().then(setProjects).catch(console.error);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (projects.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <h2 className="mb-4 text-sm font-semibold text-foreground">我的项目</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-background">
      <div className="flex flex-col items-center justify-center px-6 py-16">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-2xl font-bold text-foreground">AI 无限画布</span>
        </div>
        <p className="mb-10 text-sm text-muted-foreground">
          告诉我你想创作什么，一键生成画布工作流
        </p>

        <AIPromptInput />
      </div>

      <div className="border-t border-border" />

      <div className="flex-1 space-y-8 px-6 py-8">
        <RecentProjects />
        <WorkflowGrid />
      </div>
    </div>
  );
}
