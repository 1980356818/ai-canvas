import {
  ImageIcon,
  User,
  ArrowRight,
  Sparkles,
  ScanFace,
  Shirt,
  PersonStanding,
  Mountain,
  Combine,
  Camera,
  type LucideIcon,
} from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { createProject, updateProjectMeta } from "@/platform";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { scheduleFitCardsToViewport } from "@/lib/viewport";
import { WORKFLOW_TEMPLATES } from "@/config/workflows";
import type { WorkflowTemplate } from "@/shared/constants";

const FEATURED_IDS = ["wf-white-bg", "wf-tryon", "wf-pose-fission", "wf-scene-replace", "wf-face-merge", "wf-look-fission", "wf-multimodal-fusion", "wf-multimodal-fusion-6", "wf-studio-look"];

const CARD_STYLES: Record<
  string,
  { gradient: string; icon: LucideIcon; iconRight: LucideIcon; accent: string }
> = {
  "wf-white-bg": {
    gradient: "from-violet-500/10 via-purple-500/5 to-fuchsia-500/10",
    icon: ImageIcon,
    iconRight: ImageIcon,
    accent: "text-violet-500",
  },
  "wf-tryon": {
    gradient: "from-pink-500/10 via-rose-500/5 to-fuchsia-500/10",
    icon: User,
    iconRight: Shirt,
    accent: "text-pink-500",
  },
  "wf-pose-fission": {
    gradient: "from-amber-500/10 via-orange-500/5 to-yellow-500/10",
    icon: PersonStanding,
    iconRight: ImageIcon,
    accent: "text-amber-500",
  },
  "wf-scene-replace": {
    gradient: "from-teal-500/10 via-cyan-500/5 to-emerald-500/10",
    icon: User,
    iconRight: Mountain,
    accent: "text-teal-500",
  },
  "wf-face-merge": {
    gradient: "from-indigo-500/10 via-violet-500/5 to-purple-500/10",
    icon: User,
    iconRight: ScanFace,
    accent: "text-indigo-500",
  },
  "wf-look-fission": {
    gradient: "from-rose-500/10 via-pink-500/5 to-red-500/10",
    icon: PersonStanding,
    iconRight: ImageIcon,
    accent: "text-rose-500",
  },
  "wf-multimodal-fusion": {
    gradient: "from-sky-500/10 via-blue-500/5 to-cyan-500/10",
    icon: Combine,
    iconRight: ImageIcon,
    accent: "text-sky-500",
  },
  "wf-multimodal-fusion-6": {
    gradient: "from-emerald-500/10 via-green-500/5 to-teal-500/10",
    icon: Combine,
    iconRight: ImageIcon,
    accent: "text-emerald-500",
  },
  "wf-studio-look": {
    gradient: "from-fuchsia-500/10 via-purple-500/5 to-pink-500/10",
    icon: Camera,
    iconRight: ImageIcon,
    accent: "text-fuchsia-500",
  },
};

function FeatureCard({ workflow }: { workflow: WorkflowTemplate }) {
  const style = CARD_STYLES[workflow.id] ?? CARD_STYLES["wf-white-bg"]!;
  const Icon = style.icon;
  const IconRight = style.iconRight;

  const handleClick = async () => {
    try {
      const project = await createProject(workflow.name);
      useProjectStore.getState().addProject(project);

      await instantiateWorkflowTemplate(workflow, project.id, 320, 80);

      const meta = { nodeCount: workflow.cards.length };
      useProjectStore.getState().updateProject(project.id, meta);
      await updateProjectMeta(project.id, meta);

      useProjectStore.getState().openProject(project.id);
      useUIStore.getState().setAppView("canvas");
      scheduleFitCardsToViewport(project.id);
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
        <IconRight className={`h-5 w-5 ${style.accent} opacity-60`} />
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
