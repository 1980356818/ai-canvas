import { useCallback, useEffect, useMemo, useState } from "react";
import { X, Layers, RefreshCw, Loader2 } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useTasksStore } from "@/stores/tasksStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { taskManager } from "@/services/taskManager";
import { runCard } from "@/services/cardRunner";
import type { AsyncTask, CardType } from "@/types";
import AttemptCard from "./AttemptCard";

const REGENERATABLE: ReadonlySet<CardType> = new Set([
  "ai_image",
  "ai_multiangle",
  "ai_tryon",
  "ai_video",
] as CardType[]);

export default function CardTaskPanel() {
  const cardId = useUIStore((s) => s.cardTaskPanelCardId);
  const close = useUIStore((s) => s.closeCardTaskPanel);
  const tasksMap = useTasksStore((s) => s.tasks);
  const card = useCardStore((s) => (cardId ? s.cards.get(cardId) : undefined));

  const [hydrating, setHydrating] = useState(false);

  // 打开 / 切卡时拉该卡历史(含终态)进内存,之后靠订阅实时刷新(后台保活任务出图即冒泡)。
  useEffect(() => {
    if (!cardId) return;
    let cancelled = false;
    setHydrating(true);
    void useTasksStore
      .getState()
      .hydrateForCard(cardId)
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  // Esc 关闭
  useEffect(() => {
    if (!cardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardId, close]);

  const attempts = useMemo(() => {
    if (!cardId) return [];
    const list: AsyncTask[] = [];
    for (const t of tasksMap.values()) if (t.cardId === cardId) list.push(t);
    list.sort(
      (a, b) => b.attemptNo - a.attemptNo || b.createdAt.localeCompare(a.createdAt),
    );
    return list;
  }, [tasksMap, cardId]);

  const handleLocate = useCallback(
    (cid: string) => {
      const c = useCardStore.getState().getCard(cid);
      if (!c) return;
      const vp = useCanvasStore.getState().viewport;
      const cx = c.x + c.width / 2;
      const cy = c.y + c.height / 2;
      useCanvasStore.getState().setViewport({
        x: -cx * vp.zoom + window.innerWidth / 2,
        y: -cy * vp.zoom + window.innerHeight / 2,
      });
      useCanvasStore.getState().setSelectedCardIds([cid]);
    },
    [],
  );

  const handleRetry = useCallback((taskId: string) => {
    void taskManager.retry(taskId);
  }, []);

  const handleRegenerate = useCallback(() => {
    if (cardId) void runCard(cardId);
  }, [cardId]);

  if (!cardId) return null;

  const canRegen = !!card && REGENERATABLE.has(card.type);

  return (
    <div className="fixed right-0 top-0 z-50 flex h-full w-[380px] max-w-[92vw] flex-col border-l border-border bg-background shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" />
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold leading-tight">生成记录</h2>
            <span className="text-[11px] text-muted-foreground">
              {attempts.length} 次尝试
            </span>
          </div>
        </div>
        <button
          onClick={close}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 重新生成 */}
      {canRegen && (
        <div className="border-b border-border px-4 py-2.5">
          <button
            onClick={handleRegenerate}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            重新生成
          </button>
          <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
            生成中也可再次生成;已提交的旧任务会在后台跑完并保留在此,可逐张保存。
          </p>
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
        {hydrating && attempts.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : attempts.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Layers className="h-10 w-10 opacity-30" />
            <p className="text-sm">还没有生成记录</p>
            <p className="text-center text-xs">点击「重新生成」开始,每次尝试都会列在这里</p>
          </div>
        ) : (
          attempts.map((task) => (
            <AttemptCard
              key={task.id}
              task={task}
              isCurrent={!task.supersededAt}
              onLocate={handleLocate}
              onRetry={handleRetry}
            />
          ))
        )}
      </div>
    </div>
  );
}
