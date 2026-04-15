import { useEffect } from "react";
import { useCanvasStore, lastPointerWorld } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { deleteCard, updateProjectMeta } from "@/lib/tauri";
import { autoSave } from "@/lib/autoSave";
import { history, recordBatchDelete } from "@/lib/history";
import { copyCards, pasteCards } from "@/lib/clipboard";

function syncNodeCount(projectId: string) {
  const count = useCardStore.getState().getCardsByProject(projectId).length;
  useProjectStore.getState().updateProject(projectId, { nodeCount: count });
  void updateProjectMeta(projectId, { nodeCount: count });
}

function isFocusOnInput(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
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
    useConnectionStore.getState().removeConnectionsForCard(id);
    try {
      await deleteCard(id);
    } catch {
      /* ok */
    }
  }
  useCanvasStore.getState().clearSelection();
  autoSave.markDirty();
  const pid = useProjectStore.getState().currentProjectId;
  if (pid) syncNodeCount(pid);
}

function exitEditingMode() {
  const { editingCardId } = useCanvasStore.getState();
  if (editingCardId) {
    useCanvasStore.getState().setEditingCardId(null);
  }
  if (isFocusOnInput()) {
    (document.activeElement as HTMLElement)?.blur();
  }
}

function selectAll() {
  const projectId = useProjectStore.getState().currentProjectId;
  if (!projectId) return;
  exitEditingMode();
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

      const mod = e.ctrlKey || e.metaKey;
      const { editingCardId, selectedCardIds } = useCanvasStore.getState();

      // ── Escape: exit editing → clear selection → close agent panel ──
      if (e.key === "Escape") {
        if (editingCardId) {
          useCanvasStore.getState().setEditingCardId(null);
        } else if (selectedCardIds.size > 0) {
          useCanvasStore.getState().clearSelection();
        } else if (useUIStore.getState().agentPanelVisible) {
          useUIStore.getState().toggleAgentPanel();
        }
        return;
      }

      // ── Ctrl+A: always select all (exit editing first) ──
      if (mod && e.key === "a") {
        e.preventDefault();
        selectAll();
        return;
      }

      // ── Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y: always undo/redo ──
      if (mod && e.key === "z" && !e.shiftKey) {
        if (editingCardId || isFocusOnInput()) return;
        e.preventDefault();
        history.undo();
        return;
      }
      if ((mod && e.shiftKey && e.key === "Z") || (mod && e.key === "y")) {
        if (editingCardId || isFocusOnInput()) return;
        e.preventDefault();
        history.redo();
        return;
      }

      // ── Ctrl+C: copy selected cards (not while editing text) ──
      if (mod && e.key === "c") {
        if (editingCardId) return;
        if (selectedCardIds.size === 0) return;
        e.preventDefault();
        void copyCards(selectedCardIds);
        return;
      }

      // ── Ctrl+V: paste cards (not while editing text) ──
      if (mod && e.key === "v") {
        if (editingCardId) return;
        e.preventDefault();
        const pid = useProjectStore.getState().currentProjectId;
        if (pid) {
          void pasteCards(pid, {
            worldX: lastPointerWorld.x,
            worldY: lastPointerWorld.y,
          });
        }
        return;
      }

      // ── Delete: delete selected cards ──
      if (e.key === "Delete" && !mod) {
        if (editingCardId) {
          const target = e.target as HTMLElement;
          const inCardResult = "cardResult" in target.dataset;
          if (!inCardResult) return;
        }
        if (isFocusOnInput() && !editingCardId) return;

        e.preventDefault();
        const connId = useConnectionStore.getState().selectedConnectionId;
        if (connId) {
          useConnectionStore.getState().removeConnection(connId);
          autoSave.markDirty();
          return;
        }
        exitEditingMode();
        void deleteSelected();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
