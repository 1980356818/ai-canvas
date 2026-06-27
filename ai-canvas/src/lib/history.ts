import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useConnectionStore, type Connection } from "@/stores/connectionStore";
import { useGroupStore } from "@/stores/groupStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import {
  deleteCard as deleteCardFromDb,
  deleteGroup as deleteGroupFromDb,
  saveGroupsBatch,
} from "@/platform";
import { groupToRow } from "@/lib/mappers";
import { reconcileFrameMembership } from "@/lib/frameMembership";
import { autoSave } from "@/lib/autoSave";
import { disconnectConnectionsForCardAndCleanup } from "@/lib/referenceConsistency";
import type { CardGroup } from "@/types";

/**
 * 撤销 / 重做模型。
 *
 * ─── 卡片 vs 组(Frame)的分工 ──────────────────────────────────
 * 历史只记录「几何与存在」:卡片的增 / 删 / 坐标,组的增 / 删 / 边界。
 * **成员名单(group.cardIds)是几何的派生物,不进历史** —— 撤销 / 重做把几何还原到
 * 过去某态后,由 undo()/redo() 末尾的 reconcileFrameMembership 从「卡坐标 + 框边界」
 * 重算成员。这样历史模型最小,且天然不会出现「cardIds 与几何不同步」。
 *
 * ─── 原子多步:transact ────────────────────────────────────────
 * 一个用户动作常同时动卡片和组(粘贴 = 建卡 + 建组;移框 = 移卡 + 移框边界)。
 * 用 `history.transact(fn)` 把 fn 内的多次 record 合并成**一次** batch,保证一次
 * Ctrl+Z 整体回滚。transact 可嵌套(内层直接并入外层)。transact 只拦截历史 push,
 * 真正的 store 写入照常在 fn 内 / 外进行。
 */

export type UndoAction =
  | { type: "delete"; card: CanvasCard; connections: Connection[] }
  | { type: "create"; cardId: string }
  | { type: "update"; cardId: string; prev: Partial<CanvasCard> }
  | { type: "group-create"; groupId: string }
  | { type: "group-delete"; group: CardGroup }
  | { type: "group-update"; groupId: string; prev: Partial<CardGroup> }
  | { type: "batch"; actions: UndoAction[] };

const MAX_STACK = 50;

function describeAction(action: UndoAction): string {
  switch (action.type) {
    case "delete": return "删除";
    case "create": return "创建";
    case "update": return "修改";
    case "group-create": return "创建组";
    case "group-delete": return "删除组";
    case "group-update": return "调整组";
    case "batch": {
      const inner = action.actions[0];
      if (!inner) return "操作";
      if (inner.type === "delete") return `删除 ${action.actions.length} 项`;
      if (inner.type === "create") return `创建 ${action.actions.length} 项`;
      return `${action.actions.length} 项变更`;
    }
  }
}

class HistoryManager {
  private undoStack: UndoAction[] = [];
  private redoStack: UndoAction[] = [];
  /** 非 null 表示正处于 transact 事务中,push 改为累积到这里、事务结束合并成一个 batch。 */
  private batchBuffer: UndoAction[] | null = null;

  push(action: UndoAction) {
    if (this.batchBuffer) {
      this.batchBuffer.push(action);
      return;
    }
    this.undoStack.push(action);
    if (this.undoStack.length > MAX_STACK) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /**
   * 把 fn 内的多次 record 合并成一次原子撤销(batch)。可嵌套:嵌套时直接并入外层事务。
   * fn 内只需照常调用 record* / 写 store;历史侧自动合并。空事务不入栈。
   */
  transact(fn: () => void) {
    if (this.batchBuffer) {
      // 已在事务中 → 复用外层缓冲,内层的 record 并入同一个 batch。
      fn();
      return;
    }
    const buffer: UndoAction[] = [];
    this.batchBuffer = buffer;
    try {
      fn();
    } finally {
      this.batchBuffer = null;
      if (buffer.length === 1) this.push(buffer[0]!);
      else if (buffer.length > 1) this.push({ type: "batch", actions: buffer });
    }
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const action = this.undoStack.pop();
    if (!action) {
      useUIStore.getState().addToast({ type: "info", title: "没有可撤销的操作", duration: 1500 });
      return;
    }
    const reverse = this.apply(action);
    if (reverse) this.redoStack.push(reverse);
    this.reconcileAfter();
    useUIStore.getState().addToast({
      type: "info",
      title: `已撤销: ${describeAction(action)}`,
      duration: 1500,
    });
  }

  redo() {
    const action = this.redoStack.pop();
    if (!action) {
      useUIStore.getState().addToast({ type: "info", title: "没有可重做的操作", duration: 1500 });
      return;
    }
    const reverse = this.apply(action);
    if (reverse) this.undoStack.push(reverse);
    this.reconcileAfter();
    useUIStore.getState().addToast({
      type: "info",
      title: `已重做: ${describeAction(action)}`,
      duration: 1500,
    });
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.batchBuffer = null;
  }

  /**
   * 撤销 / 重做把卡坐标 + 框边界还原后,从几何重算框成员 —— membership 是派生物,不进
   * 历史。尤其覆盖「只动框、不动卡」的撤销(移框 / 缩放框 / 成组 / 解组),这类不会 bump
   * cardStore.layoutVersion,自动校准订阅看不见,必须在这里显式重算一次。
   */
  private reconcileAfter() {
    const pid = useProjectStore.getState().currentProjectId;
    if (pid) reconcileFrameMembership(pid);
  }

  private apply(action: UndoAction): UndoAction | null {
    const store = useCardStore.getState();
    const connStore = useConnectionStore.getState();
    switch (action.type) {
      case "delete": {
        store.addCard(action.card);
        // 批量恢复连线:逐条加会让 onConnectionsAdded 的兜底清理在「只看到部分连线」时把卡上
        // 尚未恢复连线的参考图当悬挂误删 → 撤销删卡后参考图/视频顺序被打乱。批量加只清理一次。
        connStore.addConnections(action.connections);
        autoSave.markDirty(action.card.id);
        return { type: "create", cardId: action.card.id };
      }
      case "create": {
        const card = store.getCard(action.cardId);
        if (!card) return null;
        const savedConns = collectConnectionsForCard(action.cardId);
        disconnectConnectionsForCardAndCleanup(action.cardId);
        store.removeCard(action.cardId);
        void deleteCardFromDb(action.cardId).catch(() => {});
        autoSave.markDirty();
        return { type: "delete", card, connections: savedConns };
      }
      case "update": {
        const card = store.getCard(action.cardId);
        if (!card) return null;
        const prev: Partial<CanvasCard> = {};
        for (const key of Object.keys(action.prev) as (keyof CanvasCard)[]) {
          (prev as Record<string, unknown>)[key] = card[key];
        }
        store.updateCard(action.cardId, action.prev);
        autoSave.markDirty(action.cardId);
        return { type: "update", cardId: action.cardId, prev };
      }
      case "group-create": {
        // 反演 = 删除这个组(成员卡不动;成员关系由 reconcileAfter 重算)。
        const groupStore = useGroupStore.getState();
        const group = groupStore.getGroup(action.groupId);
        if (!group) return null;
        const snapshot: CardGroup = { ...group, cardIds: [...group.cardIds] };
        groupStore.removeGroup(action.groupId);
        void deleteGroupFromDb(action.groupId).catch(() => {});
        autoSave.markDirty();
        return { type: "group-delete", group: snapshot };
      }
      case "group-delete": {
        // 反演 = 把组按快照原样建回(含原 cardIds / 边界 / 颜色 / 折叠态)。
        const groupStore = useGroupStore.getState();
        const restored: CardGroup = {
          ...action.group,
          cardIds: [...action.group.cardIds],
        };
        groupStore.addGroup(restored);
        void saveGroupsBatch([groupToRow(restored)]).catch(() => {});
        autoSave.markDirty();
        return { type: "group-create", groupId: restored.id };
      }
      case "group-update": {
        // 仅几何(x/y/width/height)。先抓当前值作反演,再写回 prev。
        const groupStore = useGroupStore.getState();
        const group = groupStore.getGroup(action.groupId);
        if (!group) return null;
        const prev: Partial<CardGroup> = {};
        for (const key of Object.keys(action.prev) as (keyof CardGroup)[]) {
          (prev as Record<string, unknown>)[key] = group[key];
        }
        groupStore.updateGroup(action.groupId, action.prev);
        const updated = groupStore.getGroup(action.groupId);
        if (updated) void saveGroupsBatch([groupToRow(updated)]).catch(() => {});
        autoSave.markDirty();
        return { type: "group-update", groupId: action.groupId, prev };
      }
      case "batch": {
        const reverseActions: UndoAction[] = [];
        for (let i = action.actions.length - 1; i >= 0; i--) {
          const r = this.apply(action.actions[i]!);
          if (r) reverseActions.push(r);
        }
        return reverseActions.length > 0
          ? { type: "batch", actions: reverseActions }
          : null;
      }
    }
  }
}

export const history = new HistoryManager();

function collectConnectionsForCard(cardId: string): Connection[] {
  const conns: Connection[] = [];
  for (const c of useConnectionStore.getState().connections.values()) {
    if (c.sourceCardId === cardId || c.targetCardId === cardId) {
      conns.push({ ...c });
    }
  }
  return conns;
}

export function recordDelete(card: CanvasCard) {
  const connections = collectConnectionsForCard(card.id);
  history.push({ type: "delete", card: { ...card }, connections });
}

export function recordCreate(cardId: string) {
  history.push({ type: "create", cardId });
}

export function recordUpdate(cardId: string, prev: Partial<CanvasCard>) {
  history.push({ type: "update", cardId, prev: { ...prev } });
}

export function recordBatchDelete(cards: CanvasCard[]) {
  if (cards.length === 1) {
    recordDelete(cards[0]!);
  } else if (cards.length > 1) {
    const allConns = new Map<string, Connection>();
    for (const c of cards) {
      for (const conn of collectConnectionsForCard(c.id)) {
        allConns.set(conn.id, conn);
      }
    }
    const connsByCard = (cardId: string) =>
      [...allConns.values()].filter(
        (c) => c.sourceCardId === cardId || c.targetCardId === cardId,
      );
    history.push({
      type: "batch",
      actions: cards.map((c) => ({
        type: "delete" as const,
        card: { ...c },
        connections: connsByCard(c.id),
      })),
    });
  }
}

export function recordBatchCreate(cardIds: string[]) {
  if (cardIds.length === 1) {
    recordCreate(cardIds[0]!);
  } else if (cardIds.length > 1) {
    history.push({
      type: "batch",
      actions: cardIds.map((id) => ({ type: "create" as const, cardId: id })),
    });
  }
}

/**
 * 记录一次「移动」(剪切 → 粘贴):新建了 newCardIds、删除了 deletedCards。
 * 合成单条 batch undo —— 一次 Ctrl+Z 即整体还原(移除新卡 + 复原原卡及其连线)。
 * **必须在原卡连线仍存在时调用**(内部要把它们收集进 delete 动作)。
 */
export function recordMove(newCardIds: string[], deletedCards: CanvasCard[]) {
  const actions: UndoAction[] = [];
  for (const id of newCardIds) {
    actions.push({ type: "create", cardId: id });
  }
  for (const c of deletedCards) {
    actions.push({
      type: "delete",
      card: { ...c },
      connections: collectConnectionsForCard(c.id),
    });
  }
  if (actions.length > 0) {
    history.push({ type: "batch", actions });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 组(Frame)历史 —— 只记几何与存在,成员名单不入历史(见文件头契约)。
// ───────────────────────────────────────────────────────────────────────────

/** 记录「新建了一个组」(粘贴 / 成组):撤销会删掉它。须在 addGroup 之后调用。 */
export function recordGroupCreate(groupId: string) {
  history.push({ type: "group-create", groupId });
}

/** 记录「删除了一个组」(解组):撤销会按快照建回。须在 removeGroup 之前 / 用快照调用。 */
export function recordGroupDelete(group: CardGroup) {
  history.push({
    type: "group-delete",
    group: { ...group, cardIds: [...group.cardIds] },
  });
}

/**
 * 记录组的「几何」变化(边界 x/y/width/height),用于移框 / 缩放框。
 * prev 传变更前的边界;成员名单不要传(membership 是派生物,撤销后由 reconcile 重算)。
 */
export function recordGroupUpdate(groupId: string, prev: Partial<CardGroup>) {
  history.push({ type: "group-update", groupId, prev: { ...prev } });
}
