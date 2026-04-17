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
  const updatedAt = new Date().toISOString();
  useProjectStore.getState().updateProject(projectId, { nodeCount: count, updatedAt });
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
          if (isFocusOnInput()) {
            (document.activeElement as HTMLElement)?.blur();
          }
        } else if (selectedCardIds.size > 0) {
          useCanvasStore.getState().clearSelection();
        } else if (useUIStore.getState().agentPanelVisible) {
          useUIStore.getState().toggleAgentPanel();
        }
        return;
      }

      // ── Ctrl+A: select all cards OR select all text ──
      if (mod && e.key === "a") {
        if (isFocusOnInput()) return;
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

      // ── Ctrl+C: copy selected cards (not while focus on text input) ──
      if (mod && e.key === "c") {
        if (isFocusOnInput()) return;
        if (selectedCardIds.size === 0) return;
        e.preventDefault();
        void copyCards(selectedCardIds);
        return;
      }

      // ── Ctrl+V: paste cards (not while focus on text input) ──
      if (mod && e.key === "v") {
        if (isFocusOnInput()) return;
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

      // ── Delete: delete selected cards or connections ──
      if (e.key === "Delete" && !mod) {
        if (isFocusOnInput()) {
          const el = document.activeElement as HTMLElement | null;
          if (el) {
            const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
            const hasText = "value" in el
              ? inputEl.value.length > 0
              : (el.textContent ?? "").length > 0;
            if (hasText) return;
          }
        }

        e.preventDefault();

        if (selectedCardIds.size === 0) {
          const connId = useConnectionStore.getState().selectedConnectionId;
          if (!connId) return;
          useConnectionStore.getState().removeConnection(connId);
          autoSave.markDirty();
          return;
        }

        exitEditingMode();
        void deleteSelected();
        return;
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
}
