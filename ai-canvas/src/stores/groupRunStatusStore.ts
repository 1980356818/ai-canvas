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
 *   idle      —— 未在跑(默认,不在 Map 里就是 idle)
 *   running   —— 组运行中,doneCount / totalCount 反映进度
 *   stopping  —— 用户已点「停止」,在途卡仍在跑(currentCardIds 保留),不再派发新卡
 *   stopped   —— 在途卡收尾完毕,运行已排空式停止(短暂态,稍后自动清)
 *   failed    —— 至少一个子卡失败,后续中止;failedCardId 指出哪个
 *   completed —— 全部完成(短暂态,稍后由门面自动 clear)
 *
 *   stopping/stopped 与 failed 的区别:前者是**用户主动**排空式停止(在途已付费的
 *   结果会落卡 + 盖溯源戳,「继续」时跳过它们只补未派发的),不是错误,不染红。
 */

export type GroupRunPhase =
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "completed";

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
  /**
   * 标记单张卡「开始运行」:加入 currentCardIds(幂等)。
   * 数据流调度按节点逐个派发,每个节点起跑时调一次 —— 取代旧的「整层一次性 setCurrent」。
   */
  addCurrent(groupId: string, cardId: string): void;
  /**
   * 标记单张卡完成。`cardId` 加入 doneCardIds、doneCount + 1,并从 currentCardIds 移除。
   */
  incrementDone(groupId: string, cardId: string): void;
  /**
   * 标记单张卡「不再运行」但**不计入 done**:仅从 currentCardIds 移除。
   * 失败卡落定用 —— 让它即时停止「正在跑」高亮;失败锚点由终态 {@link fail} 统一标红。
   * 维持不变量:currentCardIds = 当前真正在途的卡。
   */
  removeCurrent(groupId: string, cardId: string): void;
  /** 用户点「停止」:转 stopping,保留 currentCardIds(在途卡仍在跑、仍显示)。 */
  markStopping(groupId: string): void;
  /** 在途收尾完毕:转 stopped,清 currentCardIds,doneCount 保留(已完成进度)。 */
  markStopped(groupId: string): void;
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

  addCurrent(groupId, cardId) {
    const cur = get().runningGroups.get(groupId);
    if (!cur || cur.currentCardIds.has(cardId)) return; // 幂等
    set((s) => {
      const next = new Map(s.runningGroups);
      const currentCardIds = new Set(cur.currentCardIds);
      currentCardIds.add(cardId);
      next.set(groupId, { ...cur, currentCardIds });
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

  removeCurrent(groupId, cardId) {
    const cur = get().runningGroups.get(groupId);
    if (!cur || !cur.currentCardIds.has(cardId)) return;
    set((s) => {
      const next = new Map(s.runningGroups);
      const currentCardIds = new Set(cur.currentCardIds);
      currentCardIds.delete(cardId);
      next.set(groupId, { ...cur, currentCardIds });
      return { runningGroups: next };
    });
  },

  markStopping(groupId) {
    const cur = get().runningGroups.get(groupId);
    if (!cur) return;
    set((s) => {
      const next = new Map(s.runningGroups);
      // 保留 currentCardIds —— 在途卡还在跑,徽章/卡片高亮继续显示
      next.set(groupId, { ...cur, phase: "stopping" });
      return { runningGroups: next };
    });
  },

  markStopped(groupId) {
    const cur = get().runningGroups.get(groupId);
    if (!cur) return;
    set((s) => {
      const next = new Map(s.runningGroups);
      next.set(groupId, { ...cur, phase: "stopped", currentCardIds: new Set() });
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
 * groupRun 的 addCurrent 持续到 incrementDone,完整覆盖"准备参考图 → 调
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
