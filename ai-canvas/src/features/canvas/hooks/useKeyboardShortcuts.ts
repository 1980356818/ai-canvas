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

      if (
        e.key === "Delete" &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        const target = e.target as HTMLElement;
        const inCardResult = "cardResult" in target.dataset;
        if (!isEditing(e) || inCardResult) {
          e.preventDefault();
          const connId = useConnectionStore.getState().selectedConnectionId;
          if (connId) {
            useConnectionStore.getState().removeConnection(connId);
            autoSave.markDirty();
            return;
          }
          void deleteSelected();
          return;
        }
        return;
      }

      if (isEditing(e)) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        void copyCards(useCanvasStore.getState().selectedCardIds);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
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
