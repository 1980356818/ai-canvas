import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { createProject, updateProjectMeta } from "@/platform";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { scheduleFitCardsToViewport } from "@/lib/viewport";
import { WORKFLOW_TEMPLATES } from "@/config/workflows";
import type { WorkflowTemplate } from "@/shared/constants";

const FEATURED_IDS = ["wf-white-bg", "wf-tryon", "wf-pose-fission", "wf-scene-replace", "wf-face-merge", "wf-look-fission", "wf-multimodal-fusion", "wf-multimodal-fusion-6", "wf-multimodal-fusion-2", "wf-studio-look", "wf-mirror-selfie-1", "wf-mirror-selfie"];

function FeatureCard({ workflow }: { workflow: WorkflowTemplate }) {
  const handleClick = async () => {
    try {
      console.log("[诊断] 1.开始创建", { id: workflow.id, name: workflow.name, cardCount: workflow.cards.length });
      const project = await createProject(workflow.name);
      console.log("[诊断] 2.项目创建成功", { projectId: project.id });
      useProjectStore.getState().addProject(project);

      const cardIds = await instantiateWorkflowTemplate(workflow, project.id, 320, 80);
      console.log("[诊断] 3.模板实例化完成", { cardIds, expected: workflow.cards.length });

      const meta = { nodeCount: workflow.cards.length };
      useProjectStore.getState().updateProject(project.id, meta);
      await updateProjectMeta(project.id, meta);

      useProjectStore.getState().openProject(project.id);
      useUIStore.getState().setAppView("canvas");
      scheduleFitCardsToViewport(project.id);
      console.log("[诊断] 4.已切换到画布", { projectId: project.id });
    } catch (err) {
      console.error("[诊断] X.创建失败", err);
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
      <div className="w-full overflow-hidden">
        {workflow.coverImage ? (
          <img
            src={workflow.coverImage}
            alt={workflow.name}
            className="block w-full transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex aspect-[3/2] items-center justify-center bg-gradient-to-br from-muted to-muted/60">
            <span className="text-xs text-muted-foreground/40">{workflow.name}</span>
          </div>
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
