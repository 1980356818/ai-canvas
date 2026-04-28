import { useRef, useEffect, useCallback, useState } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import type { Viewport } from "@/types";
import { useCardStore } from "@/stores/cardStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { drawCards, drawConnections, drawSelectionBox, drawGrid, CardImageCache } from "@/lib/canvas-renderer";
import { spatialIndex } from "@/lib/spatial-index";
import { autoSave } from "@/lib/autoSave";

interface CanvasBirdViewProps {
  viewport: Viewport;
  screenToCanvas: (clientX: number, clientY: number) => { x: number; y: number };
}

export default function CanvasBirdView({
  viewport,
  screenToCanvas,
}: CanvasBirdViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const [imgVersion, setImgVersion] = useState(0);
  const imageCacheRef = useRef<CardImageCache | null>(null);
  if (!imageCacheRef.current) {
    imageCacheRef.current = new CardImageCache(() => {
      setImgVersion((v) => v + 1);
    });
  }

  const cards = useCardStore((s) => s.cards);
  const layoutVersion = useCardStore((s) => s.layoutVersion);
  const connections = useConnectionStore((s) => s.connections);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const projectId = useProjectStore((s) => s.currentProjectId);

  const [selBox, setSelBox] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);

  const spaceHeld = useRef(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) spaceHeld.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // --- draw loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !projectId) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = viewport.width;
      const h = viewport.height;
      if (w === 0 || h === 0) return;

      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      ctx.save();
      ctx.translate(viewport.x, viewport.y);
      ctx.scale(viewport.zoom, viewport.zoom);

      drawGrid(ctx, viewport);
      drawConnections(ctx, connections, cards, projectId, selectedConnectionId, viewport.zoom);
      drawCards(ctx, cards, selectedCardIds, viewport.zoom, projectId, imageCacheRef.current ?? undefined);

      if (selBox) {
        const bx = Math.min(selBox.startX, selBox.endX);
        const by = Math.min(selBox.startY, selBox.endY);
        const bw = Math.abs(selBox.endX - selBox.startX);
        const bh = Math.abs(selBox.endY - selBox.startY);
        drawSelectionBox(ctx, { x: bx, y: by, width: bw, height: bh });
      }

      ctx.restore();
      rafRef.current = 0;
    };

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, cards, connections, selectedCardIds, selectedConnectionId, projectId, selBox, layoutVersion, imgVersion]);

  // --- pointer interactions ---
  // Matches original CanvasContainer behavior:
  //   left-drag on empty = PAN
  //   space + left-drag on empty = BOX SELECT
  //   left-click on card = select, left-drag on card = move
  //   middle-drag = PAN
  const dragging = useRef<{
    mode: "pan" | "select" | "drag-cards";
    startClientX: number;
    startClientY: number;
    startWorldX: number;
    startWorldY: number;
    startVpX: number;
    startVpY: number;
    draggedIds?: string[];
    cardStarts?: Map<string, { x: number; y: number }>;
    didMove?: boolean;
  } | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!projectId) return;
      const world = screenToCanvas(e.clientX, e.clientY);

      // Middle button → always pan
      if (e.button === 1) {
        dragging.current = {
          mode: "pan",
          startClientX: e.clientX,
          startClientY: e.clientY,
          startWorldX: world.x,
          startWorldY: world.y,
          startVpX: viewport.x,
          startVpY: viewport.y,
        };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }

      if (e.button !== 0) return;

      const hitId = spatialIndex.hitTest(world.x, world.y);

      if (hitId) {
        // Clicked on a card → select + prepare drag
        const selected = useCanvasStore.getState().selectedCardIds;
        const isMulti = selected.has(hitId) && selected.size > 1;
        const ids = isMulti ? Array.from(selected) : [hitId];

        if (!e.ctrlKey && !selected.has(hitId)) {
          useCanvasStore.getState().setSelectedCardIds([hitId]);
        } else if (e.ctrlKey) {
          useCanvasStore.getState().addSelectedCardId(hitId);
        }

        const cardStarts = new Map<string, { x: number; y: number }>();
        for (const id of ids) {
          const c = useCardStore.getState().getCard(id);
          if (c) cardStarts.set(id, { x: c.x, y: c.y });
        }

        dragging.current = {
          mode: "drag-cards",
          startClientX: e.clientX,
          startClientY: e.clientY,
          startWorldX: world.x,
          startWorldY: world.y,
          startVpX: viewport.x,
          startVpY: viewport.y,
          draggedIds: ids,
          cardStarts,
          didMove: false,
        };
      } else if (spaceHeld.current) {
        // Space held + click on empty → box select
        useCanvasStore.getState().clearSelection();
        dragging.current = {
          mode: "select",
          startClientX: e.clientX,
          startClientY: e.clientY,
          startWorldX: world.x,
          startWorldY: world.y,
          startVpX: viewport.x,
          startVpY: viewport.y,
        };
        setSelBox({ startX: world.x, startY: world.y, endX: world.x, endY: world.y });
      } else {
        // Click on empty (no space) → pan
        useCanvasStore.getState().clearSelection();
        dragging.current = {
          mode: "pan",
          startClientX: e.clientX,
          startClientY: e.clientY,
          startWorldX: world.x,
          startWorldY: world.y,
          startVpX: viewport.x,
          startVpY: viewport.y,
        };
      }

      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    [projectId, viewport, screenToCanvas],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragging.current;
      if (!d) return;

      if (d.mode === "pan") {
        const dx = e.clientX - d.startClientX;
        const dy = e.clientY - d.startClientY;
        useCanvasStore.getState().setViewport({
          x: d.startVpX + dx,
          y: d.startVpY + dy,
        });
        return;
      }

      const world = screenToCanvas(e.clientX, e.clientY);

      if (d.mode === "select") {
        setSelBox((prev) =>
          prev ? { ...prev, endX: world.x, endY: world.y } : null,
        );
        return;
      }

      if (d.mode === "drag-cards" && d.cardStarts) {
        d.didMove = true;
        const dx = world.x - d.startWorldX;
        const dy = world.y - d.startWorldY;
        const store = useCardStore.getState();
        for (const [id, start] of d.cardStarts) {
          store.updateCard(id, { x: start.x + dx, y: start.y + dy });
        }
      }
    },
    [screenToCanvas],
  );

  const handlePointerUp = useCallback(
    (_e: React.PointerEvent) => {
      const d = dragging.current;
      if (!d) return;
      dragging.current = null;

      if (d.mode === "select" && selBox) {
        const left = Math.min(selBox.startX, selBox.endX);
        const top = Math.min(selBox.startY, selBox.endY);
        const right = Math.max(selBox.startX, selBox.endX);
        const bottom = Math.max(selBox.startY, selBox.endY);

        if (Math.abs(right - left) > 5 || Math.abs(bottom - top) > 5) {
          const ids = spatialIndex.query(left, top, right, bottom);
          useCanvasStore.getState().setSelectedCardIds(ids);
        }
        setSelBox(null);
      }

      if (d.mode === "drag-cards" && d.draggedIds && d.didMove) {
        for (const id of d.draggedIds) {
          autoSave.markDirty(id);
        }
      }
    },
    [selBox],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const world = screenToCanvas(e.clientX, e.clientY);
      const hitId = spatialIndex.hitTest(world.x, world.y);
      if (hitId) {
        useCanvasStore.getState().setSelectedCardIds([hitId]);
        useUIStore.getState().showContextMenu(e.clientX, e.clientY, "card", hitId);
      } else {
        useUIStore.getState().showContextMenu(
          e.clientX, e.clientY, "canvas", undefined, world.x, world.y,
        );
      }
    },
    [screenToCanvas],
  );

  const isPanning = dragging.current?.mode === "pan";

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0"
      style={{
        width: "100%",
        height: "100%",
        cursor: isPanning ? "grabbing" : "crosshair",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={handleContextMenu}
    />
  );
}
