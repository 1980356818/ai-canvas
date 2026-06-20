import { create } from "zustand";

export type { CardType, CanvasCard } from "@/types";
import type { CanvasCard } from "@/types";

/**
 * 两个版本号 + 一个变更集合，给下游订阅者用，**禁止直接订阅 `cards` Map**
 * （v5 规范，见 docs/性能与IPC规范.md）。
 *
 * ─── 信号语义 ───────────────────────────────────────
 * `layoutVersion` —— 仅在卡片的**几何属性**（x / y / width / height / zIndex）
 *  或**增减**（addCard / removeCard / setCards / clear）变化时自增。
 *  订阅几何（空间索引 / 视口剔除 / 缩略图 / 鸟瞰图）的下游 **必须** 订它。
 *
 * `dataVersion` —— 仅在卡片的 **data 字段** 真有改动时自增（updateCardData
 *  的 changed 短路之后；或 updateCard(partial.data)；或 setCards / addCard
 *  注入新卡片初始 data）。订阅 data 派生（数据流传播 / 引用列表）的下游必须订它。
 *
 * `lastMutatedDataIds` —— 与 `dataVersion` 一一对应：每次 `dataVersion` +1
 *  的同一次 set 调用里，把"本次改动涉及的 cardId"原子地写进这个 Set。
 *  dataFlow watcher 拿到这个集合**只对这几张卡跑 propagate**，杜绝"任意卡
 *  片改 data → 全卡 JSON.stringify 比较"的累积卡顿（v4 历史性能黑洞）。
 *
 *  下次 dataVersion 变化时这个 Set 会被原子替换；listener 必须在同步阶段
 *  消费完，不能 stash 到下一帧。
 *
 * ─── 反例（违反 v5 规范）─────────────────────────────
 *   // ❌ cards Map 每次 mutation 都换引用，等于"任何写都重渲"
 *   const cards = useCardStore((s) => s.cards);
 *
 * ─── 正例 ───────────────────────────────────────────
 *   // ✅ 几何相关
 *   const layoutVersion = useCardStore((s) => s.layoutVersion);
 *   useEffect(() => { const cards = useCardStore.getState().cards; ... },
 *     [layoutVersion]);
 *
 *   // ✅ 单卡渲染
 *   const card = useCardStore((s) => s.cards.get(id));
 */
interface CardState {
  cards: Map<string, CanvasCard>;
  maxZIndex: number;
  layoutVersion: number;
  dataVersion: number;
  lastMutatedDataIds: ReadonlySet<string>;

  setCards: (cards: CanvasCard[]) => void;
  addCard: (card: CanvasCard) => void;
  removeCard: (id: string) => void;
  /**
   * Update geometry (x/y/width/height) or top-level card fields.
   * **禁止用 `{ data: { ...data, ... } }` 改 data** — 闭包里的 data 可能是旧快照,
   * 会覆盖其他 handler 刚写的字段。改 data 一律用 `updateCardData(id, patch)`。
   */
  updateCard: (id: string, partial: Partial<CanvasCard>) => void;
  /**
   * Atomically shallow-merge `dataPatch` into the LATEST card.data in the
   * store. Use this in editors instead of `updateCard({ data: { ...data, ...patch } })`
   * to avoid stale-closure overwrites (e.g. when reference-cleanup runs between
   * render and click). Fields whose value is `undefined` are removed.
   */
  updateCardData: (id: string, dataPatch: Record<string, unknown>) => void;
  bringToFront: (id: string) => void;
  sendToBack: (id: string) => void;
  getCard: (id: string) => CanvasCard | undefined;
  getCardsByProject: (projectId: string) => CanvasCard[];
  clear: () => void;
}

const EMPTY_MUTATED_IDS: ReadonlySet<string> = new Set();

export const useCardStore = create<CardState>((set, get) => ({
  cards: new Map(),
  maxZIndex: 0,
  layoutVersion: 0,
  dataVersion: 0,
  lastMutatedDataIds: EMPTY_MUTATED_IDS,

  setCards: (cards) => {
    const map = new Map<string, CanvasCard>();
    const mutated = new Set<string>();
    let maxZ = 0;
    for (const card of cards) {
      map.set(card.id, card);
      mutated.add(card.id);
      if (card.zIndex > maxZ) maxZ = card.zIndex;
    }
    set((s) => ({
      cards: map,
      maxZIndex: maxZ,
      layoutVersion: s.layoutVersion + 1,
      dataVersion: s.dataVersion + 1,
      lastMutatedDataIds: mutated,
    }));
  },

  addCard: (card) =>
    set((s) => {
      const next = new Map(s.cards);
      next.set(card.id, card);
      return {
        cards: next,
        maxZIndex: Math.max(s.maxZIndex, card.zIndex),
        layoutVersion: s.layoutVersion + 1,
        dataVersion: s.dataVersion + 1,
        lastMutatedDataIds: new Set([card.id]),
      };
    }),

  removeCard: (id) =>
    set((s) => {
      const next = new Map(s.cards);
      next.delete(id);
      // 移除卡片不需要 propagate 其 data（卡片都没了），仅 layoutVersion +1。
      return {
        cards: next,
        layoutVersion: s.layoutVersion + 1,
      };
    }),

  updateCard: (id, partial) =>
    set((s) => {
      const card = s.cards.get(id);
      if (!card) return s;
      const next = new Map(s.cards);
      const updated = { ...card, ...partial, updatedAt: new Date().toISOString() };
      next.set(id, updated);
      const layoutChanged =
        updated.x !== card.x ||
        updated.y !== card.y ||
        updated.width !== card.width ||
        updated.height !== card.height;
      // data 字段被替换时（partial.data 存在且与旧 data 引用不同）也算 data 改动。
      const dataChanged = partial.data !== undefined && partial.data !== card.data;
      return {
        cards: next,
        layoutVersion: layoutChanged ? s.layoutVersion + 1 : s.layoutVersion,
        dataVersion: dataChanged ? s.dataVersion + 1 : s.dataVersion,
        lastMutatedDataIds: dataChanged ? new Set([id]) : s.lastMutatedDataIds,
      };
    }),

  updateCardData: (id, dataPatch) =>
    set((s) => {
      const card = s.cards.get(id);
      if (!card) return s;
      const currentData = (card.data ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...currentData };
      let changed = false;
      for (const key of Object.keys(dataPatch)) {
        const next = dataPatch[key];
        if (next === undefined) {
          if (key in merged) {
            delete merged[key];
            changed = true;
          }
        } else if (merged[key] !== next) {
          merged[key] = next;
          changed = true;
        }
      }
      if (!changed) return s;
      const nextCards = new Map(s.cards);
      nextCards.set(id, { ...card, data: merged, updatedAt: new Date().toISOString() });
      return {
        cards: nextCards,
        dataVersion: s.dataVersion + 1,
        lastMutatedDataIds: new Set([id]),
      };
    }),

  bringToFront: (id) =>
    set((s) => {
      const card = s.cards.get(id);
      if (!card) return s;
      const newZ = s.maxZIndex + 1;
      const next = new Map(s.cards);
      next.set(id, { ...card, zIndex: newZ });
      // zIndex 变化影响 CardLayer.visibleCards 的排序输出，
      // 因此也走 layoutVersion 通道；useSpatialIndex 内部按几何 diff 判，
      // 不会因层级变化重建 rbush 节点。
      return { cards: next, maxZIndex: newZ, layoutVersion: s.layoutVersion + 1 };
    }),

  sendToBack: (id) =>
    set((s) => {
      const card = s.cards.get(id);
      if (!card) return s;
      let minZ = Infinity;
      for (const c of s.cards.values()) {
        if (c.zIndex < minZ) minZ = c.zIndex;
      }
      const next = new Map(s.cards);
      next.set(id, { ...card, zIndex: minZ - 1 });
      return { cards: next, layoutVersion: s.layoutVersion + 1 };
    }),

  getCard: (id) => get().cards.get(id),

  getCardsByProject: (projectId) =>
    Array.from(get().cards.values()).filter((c) => c.projectId === projectId),

  clear: () =>
    set((s) => ({
      cards: new Map(),
      maxZIndex: 0,
      layoutVersion: s.layoutVersion + 1,
      // 清空时 dataVersion 不再 +1：dataFlow watcher 无需对"空集合"跑 propagate。
      lastMutatedDataIds: EMPTY_MUTATED_IDS,
    })),
}));
