import {
  ImageIcon,
  User,
  ArrowRight,
  Sparkles,
  ScanFace,
  type LucideIcon,
} from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { createProject, updateProjectMeta } from "@/platform";
import { autoSave } from "@/lib/autoSave";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@/shared/constants";

const FEATURED_IDS = ["wf-white-bg", "wf-face-gen"];

const CARD_STYLES: Record<
  string,
  { gradient: string; icon: LucideIcon; accent: string }
> = {
  "wf-white-bg": {
    gradient: "from-violet-500/10 via-purple-500/5 to-fuchsia-500/10",
    icon: ImageIcon,
    accent: "text-violet-500",
  },
  "wf-face-gen": {
    gradient: "from-sky-500/10 via-blue-500/5 to-indigo-500/10",
    icon: User,
    accent: "text-sky-500",
  },
};

function FeatureCard({ workflow }: { workflow: WorkflowTemplate }) {
  const style = CARD_STYLES[workflow.id] ?? CARD_STYLES["wf-white-bg"]!;
  const Icon = style.icon;

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
      className="group flex flex-col overflow-hidden rounded-md border border-border/60 bg-card text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md"
    >
      <div
        className={`flex aspect-[3/2] items-center justify-center gap-2 bg-gradient-to-br ${style.gradient}`}
      >
        <Icon className={`h-5 w-5 ${style.accent} opacity-60`} />
        <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
        <Sparkles className={`h-4.5 w-4.5 ${style.accent} opacity-40`} />
        <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
        {workflow.id === "wf-face-gen" ? (
          <ScanFace className={`h-5 w-5 ${style.accent} opacity-60`} />
        ) : (
          <ImageIcon className={`h-5 w-5 ${style.accent} opacity-60`} />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-0.5 px-2 py-1.5">
        <p className="text-[10px] font-semibold text-foreground">
          {workflow.name}
        </p>
        <p className="line-clamp-2 text-[9px] leading-relaxed text-muted-foreground">
          {workflow.description}
        </p>
      </div>
    </button>
  );
}

export default function WorkflowGrid() {
  const featured = WORKFLOW_TEMPLATES.filter((wf) =>
    FEATURED_IDS.includes(wf.id),
  );

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h2 className="mb-3 text-sm font-semibold text-foreground">
        快速开始
      </h2>

      <div className="grid grid-cols-6 gap-2">
        {featured.map((wf) => (
          <FeatureCard key={wf.id} workflow={wf} />
        ))}
      </div>
    </div>
  );
}
