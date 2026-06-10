import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { createProject, updateProjectMeta } from "@/platform";
import { instantiateWorkflowTemplate } from "@/lib/templateFactory";
import { scheduleFitCardsToViewport } from "@/lib/viewport";
import { useTemplateStore } from "@/stores/templateStore";
import { useEffect, useMemo, useState } from "react";
import type { WorkflowTemplate } from "@/shared/constants";
import { Lock, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { getDisplayUrl } from "@/lib/media";
import { useEntitlements } from "@/hooks/useEntitlements";
import { canUseTemplate, canSeeTemplate } from "@/lib/entitlements";
import { useCategoryStore } from "@/stores/categoryStore";
import { categoryLabelMap, categoryOrderMap } from "@/config/templateCategories";

function FeatureCard({ workflow, locked }: { workflow: WorkflowTemplate; locked: boolean }) {
  const isVideo = workflow.category === "video";
  const handleClick = async () => {
    if (locked) {
      useUIStore.getState().openUpgrade(`「${workflow.name}」是正式版模板，升级会员后即可使用`);
      return;
    }
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
      <div className="relative w-full overflow-hidden">
        {workflow.coverImage ? (
          <img
            src={getDisplayUrl(workflow.coverImage)}
            alt={workflow.name}
            className={cn(
              "block aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-105",
              locked && "blur-[1px] grayscale",
            )}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-muted to-muted/60">
            <span className="px-2 text-center text-xs text-muted-foreground/40">{workflow.name}</span>
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
          {workflow.name}
        </p>
        <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
          {workflow.description}
        </p>
      </div>
    </button>
  );
}

export default function WorkflowGrid() {
  const ent = useEntitlements();
  const templates = useTemplateStore((s) => s.templates);
  const categories = useCategoryStore((s) => s.categories);
  useEffect(() => {
    // 进首页拉服务端模板 + 分类刷新(初始值已是缓存/内置兜底,首屏不空)
    void useTemplateStore.getState().load();
    void useCategoryStore.getState().load();
  }, []);

  // 按分类分组(只保留有模板的分类,顺序按服务端分组 sort)
  const groups = useMemo(() => {
    const labelMap = categoryLabelMap(categories);
    const orderMap = categoryOrderMap(categories);
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
        label: labelMap[key] ?? key,
        list,
      }))
      .sort((a, b) => (orderMap[a.key] ?? 99) - (orderMap[b.key] ?? 99));
  }, [templates, ent, categories]);

  const [active, setActive] = useState<string>("");
  // 默认选中第一个有模板的分类;模板加载完成后纠正一次
  const activeKey = groups.some((g) => g.key === active) ? active : (groups[0]?.key ?? "");
  const activeGroup = groups.find((g) => g.key === activeKey);

  if (groups.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h2 className="mb-3 text-sm font-semibold text-foreground">模板库</h2>

      {/* 分类 Tab */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => setActive(g.key)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
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

      {/* 当前分类网格 */}
      <div className="grid grid-cols-5 gap-2">
        {activeGroup?.list.map((wf) => (
          <FeatureCard key={wf.id} workflow={wf} locked={!canUseTemplate(ent, wf.id)} />
        ))}
      </div>
    </div>
  );
}
