import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useConnectionStore, type Connection } from "@/stores/connectionStore";
import { useUIStore } from "@/stores/uiStore";
import { deleteCard as deleteCardFromDb } from "@/platform";
import { autoSave } from "@/lib/autoSave";
import { disconnectConnectionsForCardAndCleanup } from "@/lib/referenceConsistency";

export type UndoAction =
  | { type: "delete"; card: CanvasCard; connections: Connection[] }
  | { type: "create"; cardId: string }
  | { type: "update"; cardId: string; prev: Partial<CanvasCard> }
  | { type: "batch"; actions: UndoAction[] };

const MAX_STACK = 50;

function describeAction(action: UndoAction): string {
  switch (action.type) {
    case "delete": return "删除";
    case "create": return "创建";
    case "update": return "修改";
    case "batch": {
      const inner = action.actions[0];
      if (!inner) return "操作";
      if (inner.type === "delete") return `删除 ${action.actions.length} 张卡片`;
      if (inner.type === "create") return `创建 ${action.actions.length} 张卡片`;
      return `修改 ${action.actions.length} 张卡片`;
    }
  }
}

class HistoryManager {
  private undoStack: UndoAction[] = [];
  private redoStack: UndoAction[] = [];

  push(action: UndoAction) {
    this.undoStack.push(action);
    if (this.undoStack.length > MAX_STACK) {
      this.undoStack.shift();
    }
    this.redoStack = [];
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
    useUIStore.getState().addToast({
      type: "info",
      title: `已重做: ${describeAction(action)}`,
      duration: 1500,
    });
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  private apply(action: UndoAction): UndoAction | null {
    const store = useCardStore.getState();
    const connStore = useConnectionStore.getState();
    switch (action.type) {
      case "delete": {
        store.addCard(action.card);
        for (const conn of action.connections) {
          connStore.addConnection(conn);
        }
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
