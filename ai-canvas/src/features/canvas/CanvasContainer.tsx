import { useRef, useMemo, useState, useCallback, useEffect } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useViewport } from "./hooks/useViewport";
import { useSelection } from "./hooks/useSelection";
import CardShell from "@/features/cards/CardShell";
import CardContent from "@/features/cards/CardContent";
import FloatingEditor from "@/features/editor/FloatingEditor";
import ZoomControls from "./ZoomControls";
import QuickCreateMenu, { type QuickMenuPosition } from "./QuickCreateMenu";
import type { RefImageEntry } from "@/config/model-ref-images";

export default function CanvasContainer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    viewport,
    isPanning,
    onWheel,
    onPointerDown: vpPointerDown,
    onPointerMove: vpPointerMove,
    onPointerUp: vpPointerUp,
    screenToCanvas,
  } = useViewport(containerRef);

  const {
    selectionBox,
    onCanvasPointerDown,
    onCanvasPointerMove,
    onCanvasPointerUp,
  } = useSelection();

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const cards = useCardStore((s) => s.cards);
  const selectedCardIds = useCanvasStore((s) => s.selectedCardIds);
  const showContextMenu = useUIStore((s) => s.showContextMenu);

  const pickMode = useCanvasStore((s) => s.pickMode);

  const [quickMenu, setQuickMenu] = useState<QuickMenuPosition | null>(null);
  const closeQuickMenu = useCallback(() => setQuickMenu(null), []);

  useEffect(() => {
    if (!pickMode?.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useCanvasStore.getState().exitPickMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickMode?.active]);

  const projectCards = useMemo(() => {
    if (!currentProjectId) return [];
    return Array.from(cards.values())
      .filter((c) => c.projectId === currentProjectId)
      .sort((a, b) => a.zIndex - b.zIndex);
  }, [cards, currentProjectId]);

  const visibleCards = useMemo(() => {
    if (viewport.width === 0 || viewport.height === 0) return projectCards;
    const MARGIN = 200;
    const worldLeft = -viewport.x / viewport.zoom - MARGIN;
    const worldTop = -viewport.y / viewport.zoom - MARGIN;
    const worldRight = worldLeft + viewport.width / viewport.zoom + MARGIN * 2;
    const worldBottom = worldTop + viewport.height / viewport.zoom + MARGIN * 2;
    return projectCards.filter(
      (c) =>
        c.x + c.width > worldLeft &&
        c.x < worldRight &&
        c.y + c.height > worldTop &&
        c.y < worldBottom,
    );
  }, [projectCards, viewport]);

  const handlePointerDown = (e: React.PointerEvent) => {
    vpPointerDown(e);
    const target = e.target as HTMLElement;
    const isCanvasBg =
      target === containerRef.current ||
      target.dataset.canvasBackground !== undefined;
    onCanvasPointerDown(e, isCanvasBg);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    vpPointerMove(e);
    onCanvasPointerMove(e);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    vpPointerUp();
    onCanvasPointerUp(e);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, "canvas");
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (
      e.target === containerRef.current ||
      (e.target as HTMLElement).dataset.canvasBackground !== undefined
    ) {
      if (useCanvasStore.getState().pickMode?.active) {
        useCanvasStore.getState().exitPickMode();
        return;
      }
      useCanvasStore.getState().clearSelection();
    }
  };

  const refLines = useMemo(() => {
    const lines: Array<{ from: CanvasCard; to: CanvasCard; key: string }> = [];
    for (const card of projectCards) {
      const refs = (card.data as { refImages?: Record<string, RefImageEntry> }).refImages;
      if (!refs) continue;
      for (const [slotKey, entry] of Object.entries(refs)) {
        if (!entry.sourceCardId) continue;
        const src = cards.get(entry.sourceCardId);
        if (src) lines.push({ from: src, to: card, key: `${src.id}-${card.id}-${slotKey}` });
      }
    }
    return lines;
  }, [projectCards, cards]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isCanvasBg =
      target === containerRef.current ||
      target.dataset.canvasBackground !== undefined;
    if (!isCanvasBg || !currentProjectId) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    setQuickMenu({
      screenX: e.clientX - rect.left,
      screenY: e.clientY - rect.top,
      canvasX: canvasPos.x,
      canvasY: canvasPos.y,
    });
  };

  return (
    <div
      ref={containerRef}
      data-canvas-viewport
      className="relative flex-1 overflow-hidden bg-background"
      style={{
        cursor: isPanning ? "grabbing" : "grab",
        backgroundImage:
          "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
        backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onWheel={onWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={handleContextMenu}
      onClick={handleCanvasClick}
      onDoubleClick={handleDoubleClick}
    >
      <div
        data-canvas-background
        className="absolute inset-0 origin-top-left"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        }}
      >
        {visibleCards.map((card) => (
          <CardShell
            key={card.id}
            card={card}
            selected={selectedCardIds.has(card.id)}
          >
            <CardContent card={card} />
          </CardShell>
        ))}

        {refLines.length > 0 && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            <defs>
              <marker id="ref-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6" fill="none" stroke="var(--color-primary)" strokeWidth="1" opacity="0.4" />
              </marker>
            </defs>
            {refLines.map(({ from, to, key }) => {
              const x1 = from.x + from.width / 2;
              const y1 = from.y + from.height / 2;
              const x2 = to.x + to.width / 2;
              const y2 = to.y + to.height / 2;
              return (
                <line
                  key={key}
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="var(--color-primary)"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  opacity={0.3}
                  markerEnd="url(#ref-arrow)"
                />
              );
            })}
          </svg>
        )}
      </div>

      {pickMode?.active && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary backdrop-blur-sm">
          点击一个含图片的卡片以选取为参考图 · 按 Esc 取消
        </div>
      )}

      {selectionBox && (
        <div
          className="pointer-events-none absolute border border-blue-500 bg-blue-500/10"
          style={{
            left: selectionBox.x,
            top: selectionBox.y,
            width: selectionBox.width,
            height: selectionBox.height,
          }}
        />
      )}

      {!currentProjectId && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-lg text-muted-foreground">
            请创建或选择一个项目开始
          </p>
        </div>
      )}

      <ZoomControls zoom={viewport.zoom} />

      {quickMenu && currentProjectId && (
        <QuickCreateMenu
          position={quickMenu}
          projectId={currentProjectId}
          onClose={closeQuickMenu}
        />
      )}

      <FloatingEditor />
    </div>
  );
}
