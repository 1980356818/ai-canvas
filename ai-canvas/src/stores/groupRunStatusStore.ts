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
  /**
   * 已完成(成功 / 跳过)的卡片 id 集合 — CardShell 用它在卡片右上角挂绿✓。
   * 注意:failed 的卡不计入这里,而是单独由 failedCardId 表示(角标为红 ⚠)。
   */
  doneCardIds: Set<string>;
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
  /**
   * 标记单张卡完成。`cardId` 加入 doneCardIds、doneCount + 1,并从 currentCardIds 移除。
   */
  incrementDone(groupId: string, cardId: string): void;
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
        doneCardIds: new Set(),
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

  incrementDone(groupId, cardId) {
    const cur = get().runningGroups.get(groupId);
    if (!cur) return;
    set((s) => {
      const next = new Map(s.runningGroups);
      const doneCardIds = new Set(cur.doneCardIds);
      doneCardIds.add(cardId);
      // 从 currentCardIds 移除 — 这张卡跑完了不再是"正在跑"
      const currentCardIds = new Set(cur.currentCardIds);
      currentCardIds.delete(cardId);
      next.set(groupId, {
        ...cur,
        doneCount: cur.doneCount + 1,
        doneCardIds,
        currentCardIds,
      });
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

/**
 * 单卡运行态(用于 CardShell spotlight)。
 *
 * 反查所有正在跑的组,看 cardId 处于哪一阶段:
 *   - 'failed'  → 该卡是某个失败组的 failedCardId
 *   - 'running' → 该卡在某个组的 currentCardIds 里
 *   - 'done'    → 该卡在某个组的 doneCardIds 里
 *   - null      → 不在任何组运行中
 *
 * 返回 primitive(string|null),selector 工厂每次返回新函数也不会
 * 导致额外重渲染 — zustand 用 Object.is 比较返回值。
 */
export type CardRunPhaseInGroup = "running" | "done" | "failed";
export const selectCardRunPhaseInGroup =
  (cardId: string) =>
  (s: GroupRunStatusState): CardRunPhaseInGroup | null => {
    for (const status of s.runningGroups.values()) {
      if (status.failedCardId && status.failedCardId === cardId) {
        return "failed";
      }
      if (status.currentCardIds.has(cardId)) return "running";
      if (status.doneCardIds.has(cardId)) return "done";
    }
    return null;
  };

/**
 * 单卡是否"正被某个组运行处理"(命中任一运行组的 currentCardIds)。
 *
 * 编辑器据此在组运行经过本卡的整个窗口内禁用「生成」按钮:该窗口从
 * groupRunner.setCurrent 持续到 incrementDone,完整覆盖"准备参考图 → 调
 * provider → 任务 polling"全过程,补上 uiStore.generatingCards(仅 task
 * polling 阶段才有值)前后的空档,避免用户对正被组运行的卡重复点「生成」。
 *
 * 返回 boolean primitive,Object.is 比较稳定 —— 工厂每次新建闭包无碍。
 */
export const selectCardRunningInGroup =
  (cardId: string) =>
  (s: GroupRunStatusState): boolean => {
    for (const status of s.runningGroups.values()) {
      if (status.currentCardIds.has(cardId)) return true;
    }
    return false;
  };
