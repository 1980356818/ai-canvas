import { useEffect } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { deleteCard } from "@/lib/tauri";
import { autoSave } from "@/lib/autoSave";
import { history, recordBatchDelete } from "@/lib/history";

const CLIPBOARD_KIND = "ai-canvas-card/v1";

function isEditing(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((e.target as HTMLElement)?.isContentEditable) return true;
  return false;
}

async function deleteSelected() {
  const ids = useCanvasStore.getState().selectedCardIds;
  if (ids.size === 0) return;
  const cards: CanvasCard[] = [];
  for (const id of ids) {
    const c = useCardStore.getState().getCard(id);
    if (c) cards.push({ ...c });
  }
  recordBatchDelete(cards);
  for (const id of ids) {
    useCardStore.getState().removeCard(id);
    try {
      await deleteCard(id);
    } catch {
      /* ok */
    }
  }
  useCanvasStore.getState().clearSelection();
  autoSave.markDirty();
}

async function copySelected() {
  const ids = useCanvasStore.getState().selectedCardIds;
  if (ids.size === 0) return;
  const cards: CanvasCard[] = [];
  for (const id of ids) {
    const c = useCardStore.getState().getCard(id);
    if (c) cards.push(c);
  }
  if (cards.length === 0) return;
  const payload =
    cards.length === 1
      ? JSON.stringify({ kind: CLIPBOARD_KIND, card: cards[0] })
      : JSON.stringify({ kind: CLIPBOARD_KIND, cards });
  try {
    await navigator.clipboard.writeText(payload);
    useUIStore.getState().addToast({
      type: "info",
      title: `已复制 ${cards.length} 张卡片`,
      duration: 1500,
    });
  } catch {
    /* denied */
  }
}

async function pasteCards() {
  const projectId = useProjectStore.getState().currentProjectId;
  if (!projectId) return;
  try {
    const text = await navigator.clipboard.readText();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const card = createTextCard(projectId, text);
      useCardStore.getState().addCard(card);
      autoSave.markDirty(card.id);
      return;
    }
    if (parsed.kind !== CLIPBOARD_KIND) {
      const card = createTextCard(projectId, text);
      useCardStore.getState().addCard(card);
      autoSave.markDirty(card.id);
      return;
    }

    const sources: CanvasCard[] = parsed.cards
      ? (parsed.cards as CanvasCard[])
      : parsed.card
        ? [parsed.card as CanvasCard]
        : [];

    const now = new Date().toISOString();
    const offset = 30;
    for (const src of sources) {
      const { maxZIndex } = useCardStore.getState();
      const card: CanvasCard = {
        ...src,
        id: crypto.randomUUID(),
        projectId,
        x: src.x + offset,
        y: src.y + offset,
        zIndex: maxZIndex + 1,
        createdAt: now,
        updatedAt: now,
      };
      useCardStore.getState().addCard(card);
      autoSave.markDirty(card.id);
    }
  } catch {
    /* clipboard denied */
  }
}

function createTextCard(projectId: string, content: string): CanvasCard {
  const vp = useCanvasStore.getState().viewport;
  const cx = (-vp.x + vp.width / 2) / vp.zoom;
  const cy = (-vp.y + vp.height / 2) / vp.zoom;
  const { maxZIndex } = useCardStore.getState();
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId,
    type: "text",
    x: cx - 160,
    y: cy - 120,
    width: 320,
    height: 240,
    zIndex: maxZIndex + 1,
    locked: false,
    collapsed: false,
    data: { content },
    createdAt: now,
    updatedAt: now,
  };
}

function selectAll() {
  const projectId = useProjectStore.getState().currentProjectId;
  if (!projectId) return;
  const cards = useCardStore.getState().getCardsByProject(projectId);
  useCanvasStore
    .getState()
    .setSelectedCardIds(cards.map((c) => c.id));
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const appView = useUIStore.getState().appView;
      if (appView !== "canvas") return;

      if (e.key === "Escape") {
        const { editingCardId, selectedCardIds } = useCanvasStore.getState();
        if (editingCardId) {
          useCanvasStore.getState().setEditingCardId(null);
        } else if (selectedCardIds.size > 0) {
          useCanvasStore.getState().clearSelection();
        } else if (useUIStore.getState().agentPanelVisible) {
          useUIStore.getState().toggleAgentPanel();
        }
        return;
      }

      if (isEditing(e)) return;

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        void deleteSelected();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        void copySelected();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        e.preventDefault();
        void pasteCards();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        selectAll();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        history.undo();
        return;
      }

      if (
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Z") ||
        ((e.ctrlKey || e.metaKey) && e.key === "y")
      ) {
        e.preventDefault();
        history.redo();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
