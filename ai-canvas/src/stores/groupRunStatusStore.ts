import { create } from "zustand";

/**
 * 组运行的运行时态(不持久化)。
 *
 * ─── 为什么独立 store ──────────────────────────────────────────
 *  • 跟 groupStore(持久化)解耦 —— 跑动作不该 bump groupStore.version
 *    导致 GroupLayer 的 useMemo 重算 bounds;
 *  • 跟 tasksStore(单卡任务)平级 —— 那里管"卡片级"任务状态机,这里管
 *    "组级"调度态(哪个组在跑、跑到第几个、是否有失败)。
 *
 * ─── 状态机 ────────────────────────────────────────────────────
 *   idle  —— 未在跑(默认,不在 Map 里就是 idle)
 *   running —— 组运行中,doneCount / totalCount 反映进度
 *   failed  —— 至少一个子卡失败,后续中止;failedCardId 指出哪个
 *   completed —— 全部完成(短暂态,2 秒后由 groupRunner 自动调 finish 清除)
 */

export type GroupRunPhase = "running" | "failed" | "completed";

export interface GroupRunStatus {
  groupId: string;
  phase: GroupRunPhase;
  totalCount: number;
  doneCount: number;
  /** 当前正在跑的卡片 id 集合(并发时可能多个)。 */
  currentCardIds: Set<string>;
  /** 失败的卡片 id(phase==='failed' 时填)。 */
  failedCardId?: string;
  /** 失败原因(给 toast 用)。 */
  failedReason?: string;
  startedAt: number;
}

interface GroupRunStatusState {
  runningGroups: Map<string, GroupRunStatus>;

  start(groupId: string, totalCount: number): void;
  setCurrent(groupId: string, currentCardIds: Iterable<string>): void;
  incrementDone(groupId: string): void;
  fail(groupId: string, failedCardId: string, reason: string): void;
  complete(groupId: string): void;
  /** 清除运行态(成功 / 失败 / 用户手动清):不再显示徽章。 */
  clear(groupId: string): void;
}

export const useGroupRunStatusStore = create<GroupRunStatusState>((set, get) => ({
  runningGroups: new Map(),

  start(groupId, totalCount) {
    set((s) => {
      const next = new Map(s.runningGroups);
      next.set(groupId, {
        groupId,
        phase: "running",
        totalCount,
        doneCount: 0,
        currentCardIds: new Set(),
        startedAt: Date.now(),
      });
      return { runningGroups: next };
    });
  },

  setCurrent(groupId, currentCardIds) {
    const cur = get().runningGroups.get(groupId);
    if (!cur) return;
    set((s) => {
      const next = new Map(s.runningGroups);
      next.set(groupId, { ...cur, currentCardIds: new Set(currentCardIds) });
      return { runningGroups: next };
    });
  },

  incrementDone(groupId) {
    const cur = get().runningGroups.get(groupId);
    if (!cur) return;
    set((s) => {
      const next = new Map(s.runningGroups);
      next.set(groupId, { ...cur, doneCount: cur.doneCount + 1 });
      return { runningGroups: next };
    });
  },

  fail(groupId, failedCardId, reason) {
    const cur = get().runningGroups.get(groupId);
    if (!cur) return;
    set((s) => {
      const next = new Map(s.runningGroups);
      next.set(groupId, {
        ...cur,
        phase: "failed",
        failedCardId,
        failedReason: reason,
        currentCardIds: new Set(),
      });
      return { runningGroups: next };
    });
  },

  complete(groupId) {
    const cur = get().runningGroups.get(groupId);
    if (!cur) return;
    set((s) => {
      const next = new Map(s.runningGroups);
      next.set(groupId, {
        ...cur,
        phase: "completed",
        currentCardIds: new Set(),
        doneCount: cur.totalCount,
      });
      return { runningGroups: next };
    });
  },

  clear(groupId) {
    set((s) => {
      if (!s.runningGroups.has(groupId)) return s;
      const next = new Map(s.runningGroups);
      next.delete(groupId);
      return { runningGroups: next };
    });
  },
}));

/** 单组订阅 selector(避免重渲全部组)。 */
export const selectGroupRunStatus =
  (groupId: string) => (s: GroupRunStatusState) =>
    s.runningGroups.get(groupId);
