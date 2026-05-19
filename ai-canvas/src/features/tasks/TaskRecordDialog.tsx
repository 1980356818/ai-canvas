import { useState, useEffect, useCallback, useMemo } from "react";
import { X, ClipboardList, Loader2 } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useProjectStore } from "@/stores/projectStore";
import { useTasksStore } from "@/stores/tasksStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { taskManager } from "@/services/taskManager";
import type { AsyncTask } from "@/types";
import { ACTIVE_STATUSES } from "@/types";
import { cn } from "@/lib/utils";
import TaskRecordCard from "./TaskRecordCard";

type StatusFilter = "all" | "active" | "success" | "failed";

const STATUS_SETS: Record<StatusFilter, ReadonlySet<string> | null> = {
  all: null,
  active: ACTIVE_STATUSES,
  success: new Set(["success"]),
  failed: new Set(["failed", "canceled"]),
};

const FILTER_TABS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "success", label: "已完成" },
  { key: "failed", label: "失败" },
];

export default function TaskRecordDialog() {
  const visible = useUIStore((s) => s.taskRecordVisible);
  const toggle = useUIStore((s) => s.toggleTaskRecord);
  const projects = useProjectStore((s) => s.projects);
  const storeTasks = useTasksStore((s) => s.tasks);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [hydrating, setHydrating] = useState(false);

  const pid = projectFilter === "all" ? null : projectFilter;

  // Hydrate store from DB when dialog opens or project filter changes
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      setHydrating(true);
      try {
        if (pid) {
          await useTasksStore.getState().hydrateByProject(pid);
        } else {
          const ids = projects.map((p) => p.id);
          await Promise.all(
            ids.map((id) => useTasksStore.getState().hydrateByProject(id)),
          );
        }
      } catch {
        // store already has whatever was loaded
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, pid, projects]);

  // Compute filtered + sorted tasks and counts from the SINGLE store Map
  const { filteredTasks, counts } = useMemo(() => {
    const all: AsyncTask[] = [];
    let cAll = 0;
    let cActive = 0;
    let cSuccess = 0;
    let cFailed = 0;

    const q = search.toLowerCase();

    for (const t of storeTasks.values()) {
      if (pid && t.projectId !== pid) continue;

      // counts (before status filter)
      cAll++;
      if (ACTIVE_STATUSES.has(t.status)) cActive++;
      else if (t.status === "success") cSuccess++;
      else if (t.status === "failed" || t.status === "canceled") cFailed++;

      // status filter
      const allowed = STATUS_SETS[filter];
      if (allowed && !allowed.has(t.status)) continue;

      // search filter
      if (q) {
        const prompt = ((t.request as Record<string, unknown>)?.prompt ?? "") as string;
        if (!prompt.toLowerCase().includes(q)) continue;
      }

      all.push(t);
    }

    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      filteredTasks: all,
      counts: { all: cAll, active: cActive, success: cSuccess, failed: cFailed },
    };
  }, [storeTasks, filter, pid, search]);

  // Project name lookup
  const pMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.title);
    return m;
  }, [projects]);

  // ── Actions ──
  const handleLocate = useCallback((cardId: string) => {
    const card = useCardStore.getState().getCard(cardId);
    if (!card) return;
    toggle();
    useUIStore.getState().setAppView("canvas");
    setTimeout(() => {
      const vp = useCanvasStore.getState().viewport;
      const cx = card.x + card.width / 2;
      const cy = card.y + card.height / 2;
      useCanvasStore.getState().setViewport({
        x: -cx * vp.zoom + window.innerWidth / 2,
        y: -cy * vp.zoom + window.innerHeight / 2,
      });
      useCanvasStore.getState().setSelectedCardIds([cardId]);
    }, 100);
  }, [toggle]);

  const handleRetry = useCallback((taskId: string) => {
    void taskManager.retry(taskId);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex h-[85vh] w-[90vw] max-w-[1600px] flex-col rounded-2xl border border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2.5">
            <ClipboardList className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">任务记录</h2>
          </div>
          <button
            onClick={toggle}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-4 border-b border-border px-6 py-3">
          <div className="flex gap-1">
            {FILTER_TABS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  filter === f.key
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {f.label}
                <span className={cn(
                  "min-w-[1.25rem] rounded-full px-1 text-center text-[10px] tabular-nums",
                  filter === f.key ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground",
                  f.key === "active" && counts.active > 0 && "animate-pulse",
                )}>
                  {counts[f.key]}
                </span>
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-border" />

          <input
            type="text"
            placeholder="搜索提示词..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-48 rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />

          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-foreground focus:border-primary focus:outline-none"
          >
            <option value="all">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {hydrating && filteredTasks.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <ClipboardList className="h-12 w-12 opacity-30" />
              <p className="text-sm">暂无任务记录</p>
              <p className="text-xs">在画布或对话中生成图片/视频后，任务会显示在这里</p>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3 xl:grid-cols-6 2xl:grid-cols-8">
              {filteredTasks.map((task) => (
                <TaskRecordCard
                  key={task.id}
                  task={task}
                  projectName={pMap.get(task.projectId)}
                  onLocate={handleLocate}
                  onRetry={handleRetry}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-6 py-2.5 text-xs text-muted-foreground">
          <span>共 {counts.all} 条记录</span>
          <span>当前显示 {filteredTasks.length} 条</span>
        </div>
      </div>
    </div>
  );
}
