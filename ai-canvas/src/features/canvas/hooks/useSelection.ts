import { useState, useCallback, useRef } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { groupsFullyInRect } from "@/lib/groupBounds";

interface SelectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function useSelection(
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const dragging = useRef(false);
  const start = useRef({ x: 0, y: 0 });

  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent, isCanvasBackground: boolean) => {
      if (!isCanvasBackground || e.button !== 0) return;
      startSelection(e.clientX, e.clientY);
    },
    [],
  );

  const startSelection = useCallback(
    (clientX: number, clientY: number) => {
      dragging.current = true;
      start.current = { x: clientX, y: clientY };
      setSelectionBox({ x: clientX, y: clientY, width: 0, height: 0 });
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

  const finishSelection = useCallback(
    (clientX: number, clientY: number, ctrlKey: boolean) => {
      if (!dragging.current) return;
      dragging.current = false;

      const box = {
        x: Math.min(start.current.x, clientX),
        y: Math.min(start.current.y, clientY),
        width: Math.abs(clientX - start.current.x),
        height: Math.abs(clientY - start.current.y),
      };

      if (box.width < 5 && box.height < 5) {
        if (!ctrlKey) useCanvasStore.getState().clearSelection();
        setSelectionBox(null);
        return;
      }

      const vp = useCanvasStore.getState().viewport;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        setSelectionBox(null);
        return;
      }

      const worldBox = {
        x: (box.x - rect.left - vp.x) / vp.zoom,
        y: (box.y - rect.top - vp.y) / vp.zoom,
        width: box.width / vp.zoom,
        height: box.height / vp.zoom,
      };

      const projectId = useProjectStore.getState().currentProjectId;
      const cards = useCardStore.getState().cards;
      const hits = new Set<string>();

      for (const card of cards.values()) {
        if (card.projectId !== projectId) continue;
        if (
          card.x < worldBox.x + worldBox.width &&
          card.x + card.width > worldBox.x &&
          card.y < worldBox.y + worldBox.height &&
          card.y + card.height > worldBox.y
        ) {
          hits.add(card.id);
        }
      }

      // 框选感知组:bounds 完全落在框内的组,把其全部 cardIds 加入 hits。
      // 折叠组(只有胶囊)只要胶囊在框内就生效——由 groupsFullyInRect 内部处理。
      if (projectId) {
        const fullyIn = groupsFullyInRect(projectId, worldBox);
        for (const g of fullyIn) {
          for (const cid of g.cardIds) hits.add(cid);
        }
      }

      if (ctrlKey) {
        const prev = useCanvasStore.getState().selectedCardIds;
        const merged = new Set([...prev, ...hits]);
        useCanvasStore.getState().setSelectedCardIds([...merged]);
      } else {
        useCanvasStore.getState().setSelectedCardIds([...hits]);
      }

      setSelectionBox(null);
    },
    [containerRef],
  );

  return {
    selectionBox,
    onCanvasPointerDown,
    onCanvasPointerMove,
    finishSelection,
    startSelection,
  };
}
