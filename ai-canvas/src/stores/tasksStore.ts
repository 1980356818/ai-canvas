import { create } from "zustand";
import type { AsyncTask, TaskStatus } from "@/types";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "@/types";
import {
  upsertTask as persistTask,
  deleteTask as persistDelete,
  listPendingTasks,
  listTasksByCard,
  listTasksByProject,
} from "@/platform";

interface TasksState {
  tasks: Map<string, AsyncTask>;

  /**
   * 写入或更新一条任务（内存 + SQLite 一并落库）。
   *
   * TaskManager 每次状态转换调一次。返回后保证 DB 已落地；调用方按需 await。
   */
  upsert: (task: AsyncTask) => Promise<void>;

  /** 仅更新内存（用于 hydration / 减少抖动），不写 DB。 */
  upsertLocalOnly: (task: AsyncTask) => void;

  /** 硬删，连 DB 一起。CASCADE 删卡片时不要调这个，DB 那边会自动清理。 */
  remove: (id: string) => Promise<void>;

  getById: (id: string) => AsyncTask | undefined;

  /**
   * 返回该卡片最近一次"活动中"任务（queued / submitting / polling）。
   * UI 用它决定要不要显示进度条 / 是否可重试。
   */
  getActiveByCard: (cardId: string) => AsyncTask | undefined;

  /**
   * 返回该卡片最近一次任务（按 createdAt 倒序，无论终态非终态）。
   * UI 用它显示最近一次错误 / 上次结果。
   */
  getLatestByCard: (cardId: string) => AsyncTask | undefined;

  /**
   * App 启动 / 切项目时调：从 DB 拉所有未终止任务塞进内存。
   * 注意：终态任务不主动加载（用 hydrateForCard 按需拉历史即可）。
   */
  hydratePending: (projectId?: string) => Promise<AsyncTask[]>;

  /**
   * 按需拉某张卡片的全部历史任务（包括终态），用于"重试"按钮判断 / 展示历史。
   */
  hydrateForCard: (cardId: string) => Promise<AsyncTask[]>;

  /**
   * 拉某个项目下的所有任务（含终态）塞进内存。任务记录页面打开时调一次。
   * 已存在于内存中的活跃任务不会被覆盖（活跃任务的内存版本更新）。
   */
  hydrateByProject: (projectId: string) => Promise<AsyncTask[]>;

  /** 全清内存。切换项目时调，避免上个项目的任务残留。 */
  clear: () => void;
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: new Map(),

  upsert: async (task) => {
    set((s) => {
      const next = new Map(s.tasks);
      next.set(task.id, task);
      return { tasks: next };
    });
    await persistTask(task);
  },

  upsertLocalOnly: (task) =>
    set((s) => {
      const next = new Map(s.tasks);
      next.set(task.id, task);
      return { tasks: next };
    }),

  remove: async (id) => {
    set((s) => {
      const next = new Map(s.tasks);
      next.delete(id);
      return { tasks: next };
    });
    await persistDelete(id);
  },

  getById: (id) => get().tasks.get(id),

  getActiveByCard: (cardId) => {
    let latest: AsyncTask | undefined;
    for (const t of get().tasks.values()) {
      if (t.cardId !== cardId) continue;
      if (!ACTIVE_STATUSES.has(t.status)) continue;
      if (!latest || t.createdAt > latest.createdAt) latest = t;
    }
    return latest;
  },

  getLatestByCard: (cardId) => {
    let latest: AsyncTask | undefined;
    for (const t of get().tasks.values()) {
      if (t.cardId !== cardId) continue;
      if (!latest || t.createdAt > latest.createdAt) latest = t;
    }
    return latest;
  },

  hydratePending: async (projectId) => {
    const rows = await listPendingTasks(projectId);
    set((s) => {
      const next = new Map(s.tasks);
      for (const t of rows) next.set(t.id, t);
      return { tasks: next };
    });
    return rows;
  },

  hydrateForCard: async (cardId) => {
    const rows = await listTasksByCard(cardId);
    set((s) => {
      const next = new Map(s.tasks);
      for (const t of rows) next.set(t.id, t);
      return { tasks: next };
    });
    return rows;
  },

  hydrateByProject: async (projectId) => {
    const rows = await listTasksByProject(projectId);
    set((s) => {
      const next = new Map(s.tasks);
      for (const t of rows) {
        const existing = next.get(t.id);
        if (existing && ACTIVE_STATUSES.has(existing.status)) continue;
        next.set(t.id, t);
      }
      return { tasks: next };
    });
    return rows;
  },

  clear: () => set({ tasks: new Map() }),
}));

/** 便捷选择器：UI 组件可订阅以避免全 store 重渲染。 */
export const selectActiveTaskForCard =
  (cardId: string) => (s: TasksState) => {
    let latest: AsyncTask | undefined;
    for (const t of s.tasks.values()) {
      if (t.cardId !== cardId) continue;
      if (!ACTIVE_STATUSES.has(t.status)) continue;
      if (!latest || t.createdAt > latest.createdAt) latest = t;
    }
    return latest;
  };

export const selectLatestTaskForCard =
  (cardId: string) => (s: TasksState) => {
    let latest: AsyncTask | undefined;
    for (const t of s.tasks.values()) {
      if (t.cardId !== cardId) continue;
      if (!latest || t.createdAt > latest.createdAt) latest = t;
    }
    return latest;
  };

/**
 * 该卡「当前尝试」(supersededAt 为空中 createdAt 最新的那个)——
 * 它是唯一驱动画布卡进度/错误/结果的任务。被「重新生成」替换的不算。
 */
export const selectCurrentTaskForCard =
  (cardId: string) => (s: TasksState) => {
    let cur: AsyncTask | undefined;
    for (const t of s.tasks.values()) {
      if (t.cardId !== cardId || t.supersededAt) continue;
      if (!cur || t.createdAt > cur.createdAt) cur = t;
    }
    return cur;
  };

/**
 * 该卡的全部生成尝试(含被替换的),按 attemptNo 倒序 —— 每卡任务面板用。
 * 需先 hydrateForCard(cardId) 把历史灌进内存。
 */
export const selectAttemptsForCard =
  (cardId: string) => (s: TasksState) => {
    const list: AsyncTask[] = [];
    for (const t of s.tasks.values()) if (t.cardId === cardId) list.push(t);
    list.sort((a, b) => b.attemptNo - a.attemptNo || b.createdAt.localeCompare(a.createdAt));
    return list;
  };

export function isTaskTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
