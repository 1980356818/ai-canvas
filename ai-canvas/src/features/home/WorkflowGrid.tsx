import {
  MessageSquare,
  ImageIcon,
  Layers,
  User,
  LucideIcon,
} from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { createProject, updateProjectMeta } from "@/lib/tauri";
import { autoSave } from "@/lib/autoSave";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { cn } from "@/lib/utils";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@/shared/constants";

const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare,
  ImageIcon,
  Layers,
  User,
};

const CATEGORY_COLOR: Record<WorkflowTemplate["category"], string> = {
  chat: "bg-blue-500/10 text-blue-500",
  image: "bg-purple-500/10 text-purple-500",
  composite: "bg-amber-500/10 text-amber-500",
};

function WorkflowCard({ workflow }: { workflow: WorkflowTemplate }) {
  const Icon = ICON_MAP[workflow.icon] ?? Layers;

  const handleClick = async () => {
    try {
      const project = await createProject(workflow.name);
      useProjectStore.getState().addProject(project);
      useProjectStore.getState().openProject(project.id);

      instantiateWorkflowTemplate(workflow, project.id, 320, 80);

      await autoSave.forceSave();
      const meta = { nodeCount: workflow.cards.length };
      useProjectStore.getState().updateProject(project.id, meta);
      await updateProjectMeta(project.id, meta);
      useUIStore.getState().setAppView("canvas");
    } catch (err) {
      useUIStore.getState().addToast({
        type: "error",
        title: "创建项目失败",
        description: String(err),
        duration: 4000,
      });
    }
  };

  return (
    <button
      onClick={handleClick}
      className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-lg",
          CATEGORY_COLOR[workflow.category],
        )}
      >
        <Icon className="h-5 w-5" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">
          {workflow.name}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {workflow.description}
        </p>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center rounded-b-xl bg-primary py-1.5 text-xs font-medium text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100">
        立即使用
      </div>
    </button>
  );
}

export default function WorkflowGrid() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h2 className="mb-4 text-sm font-semibold text-foreground">
        快速开始
      </h2>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {WORKFLOW_TEMPLATES.map((wf) => (
          <WorkflowCard key={wf.id} workflow={wf} />
        ))}
      </div>
    </div>
  );
}
