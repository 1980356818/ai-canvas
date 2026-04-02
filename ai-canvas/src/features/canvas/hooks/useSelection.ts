import { useState, useCallback, useRef } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";

interface SelectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function useSelection() {
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const dragging = useRef(false);
  const start = useRef({ x: 0, y: 0 });

  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent, isCanvasBackground: boolean) => {
      if (!isCanvasBackground || e.button !== 0 || !e.shiftKey) return;

      dragging.current = true;
      start.current = { x: e.clientX, y: e.clientY };
      setSelectionBox({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
    },
    [],
  );

  const onCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;

    const x = Math.min(start.current.x, e.clientX);
    const y = Math.min(start.current.y, e.clientY);
    const width = Math.abs(e.clientX - start.current.x);
    const height = Math.abs(e.clientY - start.current.y);
    setSelectionBox({ x, y, width, height });
  }, []);

  const onCanvasPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;

      const box = {
        x: Math.min(start.current.x, e.clientX),
        y: Math.min(start.current.y, e.clientY),
        width: Math.abs(e.clientX - start.current.x),
        height: Math.abs(e.clientY - start.current.y),
      };

      if (box.width < 5 && box.height < 5) {
        if (!e.ctrlKey) useCanvasStore.getState().clearSelection();
        setSelectionBox(null);
        return;
      }

      const vp = useCanvasStore.getState().viewport;
      const containerEl = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const worldBox = {
        x: (box.x - containerEl.left - vp.x) / vp.zoom,
        y: (box.y - containerEl.top - vp.y) / vp.zoom,
        width: box.width / vp.zoom,
        height: box.height / vp.zoom,
      };

      const projectId = useProjectStore.getState().currentProjectId;
      const cards = useCardStore.getState().cards;
      const hits: string[] = [];

      for (const card of cards.values()) {
        if (card.projectId !== projectId) continue;
        if (
          card.x < worldBox.x + worldBox.width &&
          card.x + card.width > worldBox.x &&
          card.y < worldBox.y + worldBox.height &&
          card.y + card.height > worldBox.y
        ) {
          hits.push(card.id);
        }
      }

      if (e.ctrlKey) {
        const prev = useCanvasStore.getState().selectedCardIds;
        const merged = [...new Set([...prev, ...hits])];
        useCanvasStore.getState().setSelectedCardIds(merged);
      } else {
        useCanvasStore.getState().setSelectedCardIds(hits);
      }

      setSelectionBox(null);
    },
    [],
  );

  return {
    selectionBox,
    onCanvasPointerDown,
    onCanvasPointerMove,
    onCanvasPointerUp,
  };
}
