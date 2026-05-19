import { isTauri, ensureTauriAPIs, getInvoke } from "./runtime";
import { lsGet, lsSet } from "./storage";
import {
  type AsyncTask,
  type AsyncTaskRow,
  rowToTask,
  taskToRow,
} from "@/types/asyncTask";

const BROWSER_LS_KEY = "ai_canvas_tasks_v1";

/** 写入或更新一个任务（覆盖式 upsert，每次状态转换都调一次）。 */
export async function upsertTask(task: AsyncTask): Promise<void> {
  const row = taskToRow(task);
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("tasks_upsert", { task: row });
    return;
  }
  // 浏览器降级：localStorage 兜底，仅用于没有 Tauri 的开发场景
  const all = lsGet<AsyncTaskRow[]>(BROWSER_LS_KEY, []);
  const idx = all.findIndex((t) => t.id === row.id);
  if (idx >= 0) all[idx] = row;
  else all.push(row);
  lsSet(BROWSER_LS_KEY, all);
}

export async function getTask(id: string): Promise<AsyncTask | null> {
  if (isTauri) {
    await ensureTauriAPIs();
    const row = await getInvoke()<AsyncTaskRow | null>("tasks_get", { id });
    return row ? rowToTask(row) : null;
  }
  const all = lsGet<AsyncTaskRow[]>(BROWSER_LS_KEY, []);
  const row = all.find((t) => t.id === id);
  return row ? rowToTask(row) : null;
}

/**
 * 列出所有未到终态的任务。
 * App 启动 / 项目切换 / 网络恢复时调，喂给 TaskManager.resumeAll()。
 */
export async function listPendingTasks(
  projectId?: string,
): Promise<AsyncTask[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const rows = await getInvoke()<AsyncTaskRow[]>("tasks_list_pending", {
      projectId: projectId ?? null,
    });
    return rows.map(rowToTask);
  }
  const all = lsGet<AsyncTaskRow[]>(BROWSER_LS_KEY, []);
  const active = new Set(["queued", "submitting", "polling"]);
  return all
    .filter((t) => active.has(t.status))
    .filter((t) => !projectId || t.project_id === projectId)
    .map(rowToTask);
}

/** 列出某张卡片相关的所有任务，最近的在前。UI 用它找最近一次活动任务 / 显示历史。 */
export async function listTasksByCard(cardId: string): Promise<AsyncTask[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const rows = await getInvoke()<AsyncTaskRow[]>("tasks_list_by_card", {
      cardId,
    });
    return rows.map(rowToTask);
  }
  const all = lsGet<AsyncTaskRow[]>(BROWSER_LS_KEY, []);
  return all
    .filter((t) => t.card_id === cardId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(rowToTask);
}

/**
 * 列出某个项目下的所有任务（含终态），按 created_at DESC。
 * 任务记录页面打开时调一次，把历史任务灌入 tasksStore 内存 Map。
 */
export async function listTasksByProject(
  projectId: string,
): Promise<AsyncTask[]> {
  if (isTauri) {
    await ensureTauriAPIs();
    const rows = await getInvoke()<AsyncTaskRow[]>("tasks_list_by_project", {
      projectId,
    });
    return rows.map(rowToTask);
  }
  const all = lsGet<AsyncTaskRow[]>(BROWSER_LS_KEY, []);
  return all
    .filter((t) => t.project_id === projectId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(rowToTask);
}

export async function deleteTask(id: string): Promise<void> {
  if (isTauri) {
    await ensureTauriAPIs();
    await getInvoke()("tasks_delete", { id });
    return;
  }
  const all = lsGet<AsyncTaskRow[]>(BROWSER_LS_KEY, []);
  lsSet(
    BROWSER_LS_KEY,
    all.filter((t) => t.id !== id),
  );
}

/**
 * 清理超过 `days` 天的终态任务记录。建议 App 启动时调一次（days=30 起）。
 */
export async function cleanupTerminalTasks(days: number): Promise<number> {
  if (isTauri) {
    await ensureTauriAPIs();
    return getInvoke()<number>("tasks_cleanup_terminal", { days });
  }
  const all = lsGet<AsyncTaskRow[]>(BROWSER_LS_KEY, []);
  const cutoff = Date.now() - days * 86_400_000;
  const terminal = new Set(["success", "failed", "canceled", "orphaned"]);
  const kept = all.filter(
    (t) => !terminal.has(t.status) || Date.parse(t.updated_at) >= cutoff,
  );
  lsSet(BROWSER_LS_KEY, kept);
  return all.length - kept.length;
}
