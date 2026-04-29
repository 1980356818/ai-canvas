import { useEffect } from "react";
import { useCanvasStore, lastPointerWorld } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import type { CanvasCard } from "@/types";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { deleteCard, updateProjectMeta } from "@/platform";
import { autoSave } from "@/lib/autoSave";
import { history, recordBatchDelete } from "@/lib/history";
import { copyCards, pasteCards } from "@/lib/clipboard";
import {
  disconnectConnectionAndCleanup,
  removeConnectionsForCardIdsAndCleanup,
} from "@/lib/referenceConsistency";

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

// 焦点在输入元素，且当前确实有选中文本（用于复制时让默认行为走）
function hasTextSelectionInInput(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
    const start = inputEl.selectionStart ?? 0;
    const end = inputEl.selectionEnd ?? 0;
    return end > start;
  }
  if (el.isContentEditable) {
    const sel = window.getSelection();
    return !!sel && sel.toString().length > 0;
  }
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
  removeConnectionsForCardIdsAndCleanup(ids);
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

      // ── Ctrl+C: copy selected cards ──
      // 关键：焦点即使在输入元素上，只要没选中文本，就复制卡片（解决编辑模式下复制卡片）
      if (mod && e.key.toLowerCase() === "c") {
        if (hasTextSelectionInInput()) return; // 有选中文本，让默认复制走
        if (selectedCardIds.size === 0) return;
        e.preventDefault();
        void copyCards(selectedCardIds);
        return;
      }

      // ── Ctrl+V: paste cards ──
      // 焦点在输入元素时（如卡片编辑模式 textarea）让默认粘贴文本走，否则粘贴卡片
      if (mod && e.key.toLowerCase() === "v") {
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

      // ── Delete / Backspace: delete selected cards or connections ──
      // 语义：以"DOM 焦点是否在输入元素"为唯一判据。
      //  - 焦点在 textarea/input：用户在编辑，让浏览器删字符（不管框里是否还有字）
      //  - 焦点不在：选中态，直接删卡片或连线
      // CardShell 在边距点击时会主动 blur 输入元素，保证状态过渡正确。
      if ((e.key === "Delete" || e.key === "Backspace") && !mod) {
        if (isFocusOnInput()) return;

        e.preventDefault();

        if (selectedCardIds.size === 0) {
          const connId = useConnectionStore.getState().selectedConnectionId;
          if (!connId) return;
          disconnectConnectionAndCleanup(connId);
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
