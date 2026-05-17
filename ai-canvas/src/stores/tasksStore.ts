import { create } from "zustand";
import type { AsyncTask, TaskStatus } from "@/types";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "@/types";
import {
  upsertTask as persistTask,
  deleteTask as persistDelete,
  listPendingTasks,
  listTasksByCard,
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

export function isTaskTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
